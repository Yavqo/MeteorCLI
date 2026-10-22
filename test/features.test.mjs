import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MarkdownStream } from "../dist/markdown.js";
import { trimHistory } from "../dist/history.js";
import { Checkpoints } from "../dist/checkpoints.js";
import { findMentions, attachmentBlock, complete } from "../dist/mentions.js";
import { findTool } from "../dist/tools.js";
import { Inbox } from "../dist/input.js";

const tmp = (p = "sl-f-") => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sse = (...ev) => ev.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
const delta = (c) => ({ choices: [{ delta: { content: c } }] });

// ---------- markdown ----------
const marks = { bold: (s) => `[b]${s}[/b]`, code: (s) => `[c]${s}[/c]`, dim: (s) => `[d]${s}[/d]` };
const render = (chunks) => {
  const md = new MarkdownStream(marks);
  return chunks.map((c) => md.push(c)).join("") + md.flush();
};
const plain = (s) => s.replace(/\[\/?[bcd]\]/g, "");

test("markdown: bold, inline code, headings, bullets", () => {
  assert.equal(plain(render(["# Title\nUse **npm test** and `ls -la`.\n- one\n  * two\n"])), "Title\nUse npm test and ls -la.\n• one\n  • two\n");
  const out = render(["## Setup\nrun `x`\n"]);
  assert.match(out, /\[b\]Setup\[\/b\]/);
  assert.match(out, /\[c\]x\[\/c\]/);
});

test("markdown: fenced code gets a gutter and is never restyled", () => {
  const out = plain(render(["```ts\nconst a = 2 * 3; // **not bold**\n```\nafter\n"]));
  assert.equal(out, "```ts\n│ const a = 2 * 3; // **not bold**\n```\nafter\n");
});

test("markdown: a lone * is left alone", () => {
  assert.equal(plain(render(["2 * 3 = 6\n"])), "2 * 3 = 6\n");
});

test("markdown: output looks the same however the stream is split", () => {
  const text = "# Plan\nFirst **read** the `config`.\n- step one\n```sh\nnpm run build && echo **ok**\n```\nDone, 2 * 2 is 4.\n";
  // A split can turn one styled run into two adjacent ones ([b]Pla[/b][b]n[/b]); on screen that's identical.
  const merged = (s) => s.replace(/\[\/([bcd])\]\[\1\]/g, "");
  const whole = merged(render([text]));
  for (let seed = 1; seed <= 40; seed++) {
    const chunks = [];
    let i = 0, x = seed;
    while (i < text.length) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const n = 1 + (x % 5);
      chunks.push(text.slice(i, i + n));
      i += n;
    }
    assert.equal(merged(render(chunks)), whole, `split #${seed}`);
  }
});

// ---------- history trimming ----------
test("trimHistory: leaves small conversations alone", () => {
  const m = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];
  assert.equal(trimHistory(m).trimmed, false);
});

test("trimHistory: empties old tool output first, keeps recent turns and the system prompt", () => {
  const big = "x".repeat(5000);
  const m = [{ role: "system", content: "SYS" }];
  for (let i = 0; i < 10; i++) {
    m.push({ role: "user", content: `<tool_result name="read_file" status="ok">\n${big}\n</tool_result>` });
    m.push({ role: "assistant", content: `step ${i}` });
  }
  const { messages, trimmed } = trimHistory(m, 30000);
  assert.ok(trimmed);
  assert.equal(messages[0].content, "SYS");
  assert.equal(messages.length, m.length, "nothing dropped when emptying tool output was enough");
  assert.match(messages[1].content, /removed to save space/);
  assert.equal(messages.at(-2).content, m.at(-2).content, "recent tool output kept");
  assert.ok(messages.reduce((n, x) => n + x.content.length, 0) <= 30000);
});

test("trimHistory: drops the oldest exchanges when needed and never starts with the assistant", () => {
  const m = [{ role: "system", content: "SYS" }];
  for (let i = 0; i < 30; i++) m.push({ role: "user", content: `q${i} ` + "y".repeat(1000) }, { role: "assistant", content: `a${i} ` + "z".repeat(1000) });
  const { messages } = trimHistory(m, 10000);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.match(messages.at(-1).content, /^a29/);
  assert.ok(trimHistory(m, 1e9, 20).messages.length <= 20);
});

// ---------- checkpoints / undo ----------
test("checkpoints: undo restores edited files and removes created ones, latest request only", async () => {
  const dir = tmp();
  const a = path.join(dir, "a.txt");
  writeFileSync(a, "original");
  const cp = new Checkpoints();

  cp.begin();
  await cp.record(a);
  writeFileSync(a, "first change");

  cp.begin();
  const b = path.join(dir, "new/b.txt");
  await cp.record(a);
  writeFileSync(a, "second change");
  await cp.record(a); // second snapshot in the same request is ignored
  writeFileSync(a, "second change, again");
  await cp.record(b);
  mkdirSync(path.dirname(b), { recursive: true });
  writeFileSync(b, "created");
  cp.noteCommand();
  assert.equal(cp.changedInLastTurn(), 2);

  cp.begin(); // a request that changed nothing is skipped by undo

  const r = await cp.undo();
  assert.deepEqual(r.restored, [a]);
  assert.deepEqual(r.deleted, [b]);
  assert.equal(r.ranCommands, true);
  assert.equal(readFileSync(a, "utf8"), "first change");
  assert.equal(existsSync(b), false);

  await cp.undo();
  assert.equal(readFileSync(a, "utf8"), "original");
  assert.equal(await cp.undo(), undefined);
});

// ---------- @-mentions ----------
function sampleTree() {
  const dir = tmp();
  mkdirSync(path.join(dir, "src"));
  mkdirSync(path.join(dir, "My Folder"));
  mkdirSync(path.join(dir, ".hidden"));
  writeFileSync(path.join(dir, "src/app.ts"), "export const x = 1;\n");
  writeFileSync(path.join(dir, "My Folder/notes.md"), "hello");
  writeFileSync(path.join(dir, "image.bin"), Buffer.from([1, 0, 2, 3]));
  return dir;
}

test("findMentions: folders, files, escaped and quoted spaces, trailing punctuation; ignores emails", async () => {
  const dir = sampleTree();
  const { mentions, missing } = await findMentions(`look at @src, @src/app.ts and @My\\ Folder plus @"My Folder/notes.md". mail me@x.com, see @nope/here`, dir);
  assert.deepEqual(
    mentions.map((m) => [path.relative(dir, m.abs), m.kind]),
    [["src", "folder"], ["src/app.ts", "file"], ["My Folder", "folder"], ["My Folder/notes.md", "file"]],
  );
  assert.deepEqual(missing, ["@nope/here"]);
  assert.deepEqual((await findMentions("ping @john about it", dir)).missing, [], "a bare name is just text");
});

test("attachmentBlock: folder tree, numbered file, binary note", async () => {
  const dir = sampleTree();
  const { mentions } = await findMentions("@src @src/app.ts @image.bin", dir);
  const block = await attachmentBlock(mentions);
  assert.match(block, new RegExp(`<folder path="${dir}/src">[\\s\\S]*app\\.ts`));
  assert.match(block, /<file path=".*app\.ts">\n\s+1  export const x = 1;/);
  assert.match(block, /binary file, 4 bytes/);
});

test("Tab completion: @paths, folders first, hidden only on request, spaces escaped, /add, commands", () => {
  const dir = sampleTree();
  assert.deepEqual(complete("fix @sr", dir), [["@src/"], "@sr"]);
  assert.deepEqual(complete("@src/", dir), [["@src/app.ts"], "@src/"]);
  assert.deepEqual(complete("@My\\ F", dir), [["@My\\ Folder/"], "@My\\ F"]);
  const all = complete("@", dir)[0];
  assert.deepEqual(all.slice(0, 2), ["@My\\ Folder/", "@src/"], "folders first");
  assert.ok(!all.includes("@.hidden/"));
  assert.ok(complete("@.", dir)[0].includes("@.hidden/"));
  assert.deepEqual(complete("/add s", dir), [["src/"], "s"]);
  assert.deepEqual(complete("/u", dir)[0].sort(), ["/undo", "/usage"]);
  assert.deepEqual(complete("plain words", dir), [[], "plain words"]);
});

// ---------- find_files ----------
test("find_files: globs, ** and plain words; skips node_modules", async () => {
  const dir = sampleTree();
  mkdirSync(path.join(dir, "node_modules/pkg"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules/pkg/app.ts"), "");
  writeFileSync(path.join(dir, "src/app.test.ts"), "");
  const find = (pattern, p) => findTool("find_files").run({ pattern, path: p }, { cwd: dir });
  assert.equal(await find("*.ts"), "src/app.test.ts\nsrc/app.ts");
  assert.equal(await find("src/**"), "src/app.test.ts\nsrc/app.ts");
  assert.equal(await find("**/*.test.ts"), "src/app.test.ts");
  assert.equal(await find("NOTES"), "My Folder/notes.md");
  assert.equal(await find("*.py"), "No files found.");
});

// ---------- paste collector ----------
test("Inbox: a paste becomes one message; separate Enters stay separate; \\ continues a line", async () => {
  const rl = new EventEmitter();
  let continued = 0;
  const inbox = new Inbox(rl, { pasteMs: 15, onContinue: () => continued++ });
  const it = inbox[Symbol.asyncIterator]();
  rl.emit("line", "line one");
  rl.emit("line", "line two");
  rl.emit("line", "line three");
  assert.deepEqual(await it.next(), { value: "line one\nline two\nline three", done: false });

  rl.emit("line", "first");
  await new Promise((r) => setTimeout(r, 40));
  rl.emit("line", "second");
  assert.equal((await it.next()).value, "first");
  assert.equal((await it.next()).value, "second");

  rl.emit("line", "keep \\");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(continued, 1);
  rl.emit("line", "going");
  assert.equal((await it.next()).value, "keep \ngoing");
  rl.emit("close");
  assert.equal((await it.next()).done, true);
});

// ---------- workspace boundary, end to end ----------
async function world(script) {
  const log = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = JSON.parse(body);
      log.push(json);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(delta(script(json, log.length)), "[DONE]"));
    });
  });
  await new Promise((r) => server.listen(0, r));
  return { server, log, env: { SUNLIGHT_API_URL: `http://localhost:${server.address().port}/api` } };
}

function signedInHome() {
  const h = tmp("sl-home-");
  mkdirSync(path.join(h, ".sunlight"));
  writeFileSync(path.join(h, ".sunlight/auth.json"), JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, email: "a@b.c", user_id: "u" }));
  mkdirSync(path.join(h, "project"));
  return h;
}

function sunlight(args, env, cwd, home) {
  return new Promise((resolve) => {
    const child = spawn("node", [path.resolve("dist/cli.js"), ...args], { cwd, env: { ...process.env, NO_COLOR: "1", HOME: home, ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const callThenDone = (call) => (json) =>
  json.messages.at(-1).content.includes("<tool_result") ? "done" : `<tool_call>${JSON.stringify(call)}</tool_call>`;

test("@folder joins the workspace: the model sees its tree and can read inside it without asking", async () => {
  const home = signedInHome();
  const other = tmp("sl-other-");
  writeFileSync(path.join(other, "secret-plan.md"), "launch on friday");
  const w = await world(callThenDone({ name: "read_file", arguments: { path: path.join(other, "secret-plan.md") } }));
  const r = await sunlight(["-p", `summarize @${other}`], w.env, path.join(home, "project"), home);
  w.server.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /added to your workspace/);
  const first = w.log[0].messages;
  assert.match(first.at(-1).content, new RegExp(`<folder path="${other}">[\\s\\S]*secret-plan\\.md`));
  assert.match(first[0].content, new RegExp(`Other workspace folders[\\s\\S]*${other}`));
  assert.match(w.log[1].messages.at(-1).content, /status="ok">[\s\S]*launch on friday/);
});

test("outside the workspace even a read needs approval, and is denied in non-interactive mode", async () => {
  const home = signedInHome();
  const other = tmp("sl-other-");
  writeFileSync(path.join(other, "x.txt"), "private");
  const w = await world(callThenDone({ name: "read_file", arguments: { path: path.join(other, "x.txt") } }));
  const r = await sunlight(["-p", "read it"], w.env, path.join(home, "project"), home);
  w.server.close();
  assert.match(r.out, /outside your folders/);
  const result = w.log[1].messages.at(-1).content;
  assert.match(result, /status="error"/);
  assert.match(result, /outside the workspace folders/);
  assert.doesNotMatch(result, /private/);
});

test("a symlink inside the workspace that points outside it does not count as inside", async () => {
  const home = signedInHome();
  const other = tmp("sl-other-");
  writeFileSync(path.join(other, "x.txt"), "private");
  symlinkSync(other, path.join(home, "project", "escape"));
  const w = await world(callThenDone({ name: "read_file", arguments: { path: "escape/x.txt" } }));
  await sunlight(["-p", "read it"], w.env, path.join(home, "project"), home);
  w.server.close();
  assert.match(w.log[1].messages.at(-1).content, /status="error"[\s\S]*outside the workspace/);
});

test("--add-dir lets the AI write in another folder (with --yes)", async () => {
  const home = signedInHome();
  const other = tmp("sl-other-");
  const w = await world(callThenDone({ name: "write_file", arguments: { path: path.join(other, "made.txt"), content: "hi" } }));
  const r = await sunlight(["-p", "make it", "--add-dir", other, "--yes"], w.env, path.join(home, "project"), home);
  w.server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(path.join(other, "made.txt"), "utf8"), "hi");
  assert.doesNotMatch(r.out, /outside your folders/);
});

test("--add-dir with a typo fails instead of silently working elsewhere", async () => {
  const home = signedInHome();
  const r = await sunlight(["-p", "x", "--add-dir", "/definitely/not/here"], {}, path.join(home, "project"), home);
  assert.equal(r.code, 1);
  assert.match(r.err, /is not a folder/);
});

test("agent.undo reverts the AI's write and tells the model on the next message", async () => {
  const home = signedInHome();
  const project = path.join(home, "project");
  const w = await world(callThenDone({ name: "write_file", arguments: { path: "new.txt", content: "made by ai" } }));
  const { Agent } = await import("../dist/agent.js");
  const { Terminal } = await import("../dist/ui.js");
  const agent = new Agent({ baseUrl: w.env.SUNLIGHT_API_URL, model: "x", getToken: async () => "t" }, new Terminal(undefined, { autoApprove: true }), project);
  await agent.run("make a file", new AbortController().signal);
  assert.equal(readFileSync(path.join(project, "new.txt"), "utf8"), "made by ai");
  const undone = await agent.undo();
  assert.deepEqual(undone.deleted, [path.join(project, "new.txt")]);
  assert.equal(existsSync(path.join(project, "new.txt")), false);
  await agent.run("what now?", new AbortController().signal).catch(() => {});
  w.server.close();
  assert.match(w.log.at(-1).messages.find((m) => m.content.includes("what now?")).content, /user undid your file changes[\s\S]*new\.txt/);
});
