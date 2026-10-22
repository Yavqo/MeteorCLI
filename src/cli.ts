#!/usr/bin/env node
import { promises as fs } from "node:fs";
import readline from "node:readline";
import { Agent } from "./agent.js";
import { AuthError, getAccessToken, loadSession, signIn, signOut } from "./auth.js";
import { formatQuota, getQuota } from "./client.js";
import { apiUrl, HISTORY_FILE, loadProjectInstructions, type Config } from "./config.js";
import { Inbox } from "./input.js";
import { attachmentBlock, complete, findMentions } from "./mentions.js";
import { displayPath, homePath, resolvePath } from "./paths.js";
import { c, Terminal } from "./ui.js";

const VERSION = "0.3.0";

const HELP = `${c.bold("Sunlight CLI")} ${c.dim(`v${VERSION}`)}

${c.bold("Usage")}
  sunlight                      Start an interactive session
  sunlight -p "prompt"          Run one prompt and print the answer
  sunlight login                Sign in with your Yavqo account
  sunlight logout               Sign out on this computer
  sunlight whoami               Show who you're signed in as and your token use

${c.bold("Options")}
  -p, --prompt <text>           Non-interactive mode (also reads stdin when piped)
      --add-dir <path>          Add a folder to the workspace (repeatable)
  -y, --yes                     Approve every tool action without asking
  -v, --version                 Print the version
  -h, --help                    Show this help

${c.bold("Folders and files")}
  @path                         Add a folder to the workspace, or attach a file: "fix the tests in @~/code/api"
                                Tab completes paths. Write spaces as "\\ " or quote it: @"~/My Folder"
  Sunlight can change files in your workspace folders. Anything outside them asks every time.

${c.bold("In a session")}
  /add <folder>                 Add a folder to the workspace
  /folders                      List workspace folders
  /undo                         Revert the files changed by the last request
  /usage                        Your token use
  /clear  /yes  /help  /exit
  End a line with \\ to keep typing on the next line. Pasted text is sent as one message.
  Put project notes in SUNLIGHT.md and Sunlight reads them at the start.`;

interface Flags {
  prompt?: string;
  addDirs: string[];
  yes: boolean;
  help: boolean;
  version: boolean;
  command?: string;
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = { addDirs: [], yes: false, help: false, version: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--prompt") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      f.prompt = v;
    } else if (a === "--add-dir") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a folder`);
      f.addDirs.push(v);
    } else if (a === "-y" || a === "--yes") f.yes = true;
    else if (a === "-h" || a === "--help") f.help = true;
    else if (a === "-v" || a === "--version") f.version = true;
    else if (a.startsWith("-")) throw new Error(`Unknown option ${a}. Try --help.`);
    else rest.push(a);
  }
  f.command = rest[0];
  if (!f.prompt && rest.length > 0 && !["login", "logout", "whoami"].includes(rest[0])) f.prompt = rest.join(" ");
  return f;
}

const config = (): Config => ({ baseUrl: apiUrl(), model: "sunlight", getToken: getAccessToken });

/** Reads a secret without echoing it. */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const k of ch) {
        if (k === "\r" || k === "\n" || k === "\u0004") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (k === "\u0003") process.exit(130);
        if (k === "\u007f") value = value.slice(0, -1);
        else value += k;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function login() {
  if (!process.stdin.isTTY) throw new Error("`sunlight login` needs an interactive terminal.");
  console.log(`${c.sun("☀")} ${c.bold("Sign in to Sunlight")}`);
  console.log(c.dim("Use your Yavqo account. No API key needed.\n"));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = (await new Promise<string>((r) => rl.question("Email › ", r))).trim();
  rl.close();
  const password = await readSecret("Password › ");
  if (!email || !password) throw new Error("Enter both your email and password.");
  const session = await signIn(email, password);
  console.log(`\n${c.green("✓")} Signed in as ${c.bold(session.email)}`);
}

async function whoami() {
  const session = await loadSession();
  if (!session) return console.log("Not signed in. Run `sunlight login`.");
  console.log(`${c.bold(session.email)}`);
  try {
    console.log(c.dim(formatQuota(await getQuota(config()))));
  } catch (e) {
    console.log(c.dim(`Could not load your token use: ${(e as Error).message}`));
  }
}

async function loadHistory(): Promise<string[]> {
  try {
    return (await fs.readFile(HISTORY_FILE, "utf8")).split("\n").filter(Boolean).slice(-500).reverse();
  } catch {
    return [];
  }
}

/** Adds --add-dir folders; fails loudly on a typo rather than silently working elsewhere. */
async function addDirs(agent: Agent, dirs: string[], cwd: string) {
  for (const d of dirs) {
    const abs = resolvePath(cwd, d);
    const stat = await fs.stat(abs).catch(() => undefined);
    if (!stat?.isDirectory()) throw new Error(`--add-dir: ${d} is not a folder.`);
    await agent.addFolder(abs);
  }
}

/** Resolves @-mentions: folders join the workspace, files are attached. Returns the message to send. */
async function prepare(line: string, agent: Agent, cwd: string, notify: (s: string) => void): Promise<string> {
  const { mentions, missing } = await findMentions(line, cwd);
  for (const m of missing) notify(c.dim(`No file or folder at ${m}; sent as text.`));
  for (const m of mentions) {
    const where = displayPath(m.abs, cwd);
    if (m.kind === "folder") {
      notify((await agent.addFolder(m.abs)) ? `${c.blue("+")} ${c.bold(where)} ${c.dim("added to your workspace")}` : c.dim(`${where} is already in your workspace`));
    } else notify(`${c.blue("+")} ${c.bold(where)} ${c.dim("attached")}`);
  }
  return line + (await attachmentBlock(mentions));
}

async function interactive(autoApprove: boolean, dirs: string[]) {
  const cwd = process.cwd();
  const session = await loadSession();
  const prompt = `${c.blue("›")} `;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: await loadHistory(),
    historySize: 500,
    prompt,
    completer: (line: string) => complete(line, cwd),
  });
  const term = new Terminal(rl, { autoApprove, interactive: true });
  term.banner(VERSION, session?.email, cwd);
  if (!session) {
    rl.close();
    return;
  }
  const cfg = config();
  const agent = new Agent(cfg, term, cwd, await loadProjectInstructions(cwd));
  await addDirs(agent, dirs, cwd);
  if (dirs.length) term.info(c.dim(`Workspace: ${agent.folders.map((f) => displayPath(f, cwd)).join(", ")}`));

  let controller: AbortController | undefined;
  rl.on("SIGINT", () => {
    if (controller) controller.abort();
    else {
      term.write(c.dim("\n(press ctrl+c again or type /exit to quit)\n"));
      rl.once("SIGINT", () => rl.close());
    }
  });

  const saveLine = (line: string) => fs.appendFile(HISTORY_FILE, line.replace(/\n/g, " ") + "\n").catch(() => {});
  await fs.mkdir(HISTORY_FILE.replace(/\/[^/]+$/, ""), { recursive: true, mode: 0o700 }).catch(() => {});

  const inbox = new Inbox(rl, {
    onContinue: () => {
      rl.setPrompt(c.dim("… "));
      rl.prompt();
    },
  });

  rl.prompt();
  for await (const raw of inbox) {
    rl.setPrompt(prompt);
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      continue;
    }
    saveLine(line);

    if (line.startsWith("/") && !line.includes("\n")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(" ").replace(/\\ /g, " ").replace(/^"(.*)"$/, "$1");
      if (cmd === "exit" || cmd === "quit") break;
      if (cmd === "help") term.info(HELP);
      else if (cmd === "clear") {
        agent.reset();
        term.info(c.dim("Conversation cleared. Your workspace folders are kept."));
      } else if (cmd === "add") {
        const abs = arg ? resolvePath(cwd, arg) : "";
        const stat = abs ? await fs.stat(abs).catch(() => undefined) : undefined;
        if (!arg) term.info(c.dim("Usage: /add <folder>. Tab completes paths."));
        else if (!stat) term.error(`No folder at ${arg}.`);
        else if (!stat.isDirectory()) term.info(c.dim(`${arg} is a file. Attach it in a message with @${arg} instead.`));
        else if (await agent.addFolder(abs)) term.info(`${c.blue("+")} ${c.bold(displayPath(abs, cwd))} ${c.dim("added to your workspace")}`);
        else term.info(c.dim(`${displayPath(abs, cwd)} is already in your workspace.`));
      } else if (cmd === "folders") {
        term.info(agent.folders.map((f, i) => `  ${homePath(f)}${i === 0 ? c.dim("  (working directory)") : ""}`).join("\n"));
      } else if (cmd === "undo") {
        const result = await agent.undo().catch((e) => {
          term.error(`Undo failed: ${(e as Error).message}`);
          return null;
        });
        if (result === undefined) term.info(c.dim("Nothing to undo."));
        else if (result) {
          const lines = [
            ...result.restored.map((f) => `  ${c.green("↺")} ${displayPath(f, cwd)}`),
            ...result.deleted.map((f) => `  ${c.green("↺")} ${displayPath(f, cwd)} ${c.dim("(removed; the AI had created it)")}`),
          ];
          term.info(`Reverted ${lines.length} file${lines.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
          if (result.ranCommands) term.info(c.sun("Commands the AI ran in that request were not undone."));
        }
      } else if (cmd === "usage") {
        try {
          term.info(formatQuota(await getQuota(cfg)));
        } catch (e) {
          term.error((e as Error).message);
        }
      } else if (cmd === "yes") {
        term.info(`Auto-approve ${term.toggleAutoApprove() ? c.sun("on") : "off"}`);
      } else term.info(c.dim(`Unknown command /${cmd}. Try /help.`));
      rl.prompt();
      continue;
    }

    controller = new AbortController();
    try {
      await agent.run(await prepare(line, agent, cwd, (s) => term.info(s)), controller.signal);
      const changed = agent.checkpoints.changedInLastTurn();
      if (changed > 0) term.info(c.dim(`${changed} file${changed === 1 ? "" : "s"} changed · /undo to revert`));
    } catch (e) {
      if ((e as Error).name === "AbortError") term.info(c.dim("Stopped."));
      else term.error((e as Error).message);
    }
    controller = undefined;
    term.write("\n");
    rl.prompt();
  }
  rl.close();
}

async function oneShot(prompt: string, autoApprove: boolean, dirs: string[]) {
  if (!process.stdin.isTTY && !prompt) {
    prompt = await new Promise<string>((r) => {
      let d = "";
      process.stdin.on("data", (x) => (d += x)).on("end", () => r(d));
    });
  }
  const cwd = process.cwd();
  const term = new Terminal(undefined, { autoApprove, interactive: false });
  const agent = new Agent(config(), term, cwd, await loadProjectInstructions(cwd));
  await addDirs(agent, dirs, cwd);
  // Keep stdout for the answer; notices about @-mentions go to stderr.
  const message = await prepare(prompt, agent, cwd, (s) => process.stderr.write(s + "\n"));
  await agent.run(message, new AbortController().signal);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) return console.log(HELP);
  if (flags.version) return console.log(VERSION);
  if (flags.command === "login") return login();
  if (flags.command === "whoami") return whoami();
  if (flags.command === "logout") {
    return console.log((await signOut()) ? `${c.green("✓")} Signed out.` : "You weren't signed in.");
  }

  if (flags.prompt !== undefined || !process.stdin.isTTY) {
    if (!(await loadSession())) throw new AuthError("You're signed out. Run `sunlight login`.");
    return oneShot(flags.prompt ?? "", flags.yes, flags.addDirs);
  }
  return interactive(flags.yes, flags.addDirs);
}

main().catch((e) => {
  console.error(`${c.red("✕")} ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
