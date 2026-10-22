#!/usr/bin/env node
import { promises as fs } from "node:fs";
import readline from "node:readline";
import { Agent } from "./agent.js";
import { AuthError, getAccessToken, loadSession, signIn, signOut } from "./auth.js";
import { formatQuota, getQuota } from "./client.js";
import { apiUrl, HISTORY_FILE, loadProjectInstructions, type Config } from "./config.js";
import { c, Terminal } from "./ui.js";

const VERSION = "0.2.0";

const HELP = `${c.bold("Sunlight CLI")} ${c.dim(`v${VERSION}`)}

${c.bold("Usage")}
  sunlight                      Start an interactive session
  sunlight -p "prompt"          Run one prompt and print the answer
  sunlight login                Sign in with your Yavqo account
  sunlight logout               Sign out on this computer
  sunlight whoami               Show who you're signed in as and your token use

${c.bold("Options")}
  -p, --prompt <text>           Non-interactive mode (also reads stdin when piped)
  -y, --yes                     Approve every tool action without asking
  -v, --version                 Print the version
  -h, --help                    Show this help

${c.bold("In a session")}
  /help  /clear  /usage  /yes  /exit
  Put project notes in SUNLIGHT.md and Sunlight reads them at the start.`;

interface Flags {
  prompt?: string;
  yes: boolean;
  help: boolean;
  version: boolean;
  command?: string;
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = { yes: false, help: false, version: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--prompt") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      f.prompt = v;
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

async function interactive(autoApprove: boolean) {
  const cwd = process.cwd();
  const session = await loadSession();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: await loadHistory(),
    historySize: 500,
    prompt: `${c.blue("›")} `,
  });
  const term = new Terminal(rl, { autoApprove, interactive: true });
  term.banner(VERSION, session?.email, cwd);
  if (!session) {
    rl.close();
    return;
  }
  const cfg = config();
  const agent = new Agent(cfg, term, cwd, await loadProjectInstructions(cwd));

  let controller: AbortController | undefined;
  rl.on("SIGINT", () => {
    if (controller) controller.abort();
    else {
      term.write(c.dim("\n(press ctrl+c again or type /exit to quit)\n"));
      rl.once("SIGINT", () => rl.close());
    }
  });

  const saveLine = (line: string) => fs.appendFile(HISTORY_FILE, line + "\n").catch(() => {});
  await fs.mkdir(HISTORY_FILE.replace(/\/[^/]+$/, ""), { recursive: true, mode: 0o700 }).catch(() => {});

  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      continue;
    }
    saveLine(line);

    if (line.startsWith("/")) {
      const cmd = line.slice(1).split(/\s+/)[0];
      if (cmd === "exit" || cmd === "quit") break;
      if (cmd === "help") term.info(HELP);
      else if (cmd === "clear") {
        agent.reset();
        term.info(c.dim("Conversation cleared."));
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
      await agent.run(line, controller.signal);
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

async function oneShot(prompt: string, autoApprove: boolean) {
  if (!process.stdin.isTTY && !prompt) {
    prompt = await new Promise<string>((r) => {
      let d = "";
      process.stdin.on("data", (x) => (d += x)).on("end", () => r(d));
    });
  }
  const cwd = process.cwd();
  const term = new Terminal(undefined, { autoApprove, interactive: false });
  const agent = new Agent(config(), term, cwd, await loadProjectInstructions(cwd));
  await agent.run(prompt, new AbortController().signal);
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
    return oneShot(flags.prompt ?? "", flags.yes);
  }
  return interactive(flags.yes);
}

main().catch((e) => {
  console.error(`${c.red("✕")} ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
