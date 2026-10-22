import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseReply, StreamFilter } from "../dist/protocol.js";

// In-process auth tests use their own HOME; set before auth.js loads.
const authHome = mkdtempSync(path.join(tmpdir(), "sl-auth-"));
process.env.HOME = authHome;

const sse = (...ev) => ev.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
const delta = (c) => ({ choices: [{ delta: { content: c } }] });

// ---------- protocol ----------
test("parseReply takes the first call batch and drops imagined output", () => {
  const raw = 'Looking.\n<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>\n<tool_call>{"name":"list_files","arguments":{}}</tool_call>\nThe file says hello';
  const p = parseReply(raw);
  assert.equal(p.text, "Looking.");
  assert.deepEqual(p.calls.map((c) => c.name), ["read_file", "list_files"]);
  assert.equal(p.errors.length, 0);
});

test("parseReply reports bad JSON and truncated calls", () => {
  assert.equal(parseReply("<tool_call>{nope}</tool_call>").errors.length, 1);
  assert.equal(parseReply('<tool_call>{"name":"x"').errors.length, 1);
  assert.deepEqual(parseReply("plain answer").calls, []);
});

test("StreamFilter hides tool markup even when split across chunks", () => {
  const f = new StreamFilter();
  const out = ["Hi <tool", '_call>{"name"', ':"x"}</tool_call> more'].map((c) => f.push(c)).join("") + f.flush();
  assert.equal(out.trim(), "Hi");
  const g = new StreamFilter();
  assert.equal(["a < b ", "and <t", "ag>"].map((c) => g.push(c)).join("") + g.flush(), "a < b and <tag>");
});

// ---------- mock Yavqo: Supabase Auth + Sunlight API ----------
async function world({ chat } = {}) {
  const log = { auth: [], chat: [], logout: 0 };
  const defaultChat = (json) => {
    const last = json.messages.at(-1).content;
    return last.includes("<tool_result")
      ? [200, sse(delta("Done. "), delta("I saw the file."), "[DONE]")]
      : [200, sse(delta("Let me look.\n<tool"), delta('_call>{"name":"read_file","arguments":{"path":"hello.txt"}}</tool_call>'), delta("\nIt says: imagined"), "[DONE]")];
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { "content-type": typeof payload === "string" ? "text/event-stream" : "application/json", ...headers });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };
      if (url.pathname === "/auth/v1/token") {
        const json = JSON.parse(body);
        log.auth.push({ grant: url.searchParams.get("grant_type"), apikey: req.headers.apikey, json });
        if (url.searchParams.get("grant_type") === "password") {
          return json.email === "ana@yavqo.com" && json.password === "correct horse"
            ? send(200, { access_token: "tok-1", refresh_token: "ref-1", expires_in: 3600, user: { id: "u1", email: json.email } })
            : send(400, { error_code: "invalid_credentials", msg: "Invalid login credentials" });
        }
        return json.refresh_token === "ref-1"
          ? send(200, { access_token: "tok-2", refresh_token: "ref-2", expires_in: 3600, user: { id: "u1", email: "ana@yavqo.com" } })
          : send(400, { error_code: "refresh_token_not_found" });
      }
      if (url.pathname === "/auth/v1/logout") {
        log.logout++;
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === "/api/quota") {
        return send(200, { tokensUsed: 2500000, limit: 10000000, resetsAt: new Date(Date.now() + 3.5 * 3600e3).toISOString() });
      }
      if (url.pathname === "/api/chat/completions") {
        const json = JSON.parse(body);
        log.chat.push({ auth: req.headers.authorization, json });
        const [status, payload, headers] = (chat ?? defaultChat)(json, log.chat.length, req.headers.authorization);
        return send(status, payload, headers);
      }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return { server, log, port, env: { SUNLIGHT_API_URL: `http://localhost:${port}/api`, SUNLIGHT_AUTH_URL: `http://localhost:${port}` } };
}

function home(session) {
  const dir = mkdtempSync(path.join(tmpdir(), "sl-"));
  writeFileSync(path.join(dir, "hello.txt"), "hello world\n");
  if (session) {
    mkdirSync(path.join(dir, ".sunlight"));
    writeFileSync(path.join(dir, ".sunlight", "auth.json"), JSON.stringify({ access_token: "tok-valid", refresh_token: "ref-1", expires_at: Math.floor(Date.now() / 1000) + 3600, email: "ana@yavqo.com", user_id: "u1", ...session }));
  }
  return dir;
}
const authFile = (dir) => path.join(dir, ".sunlight", "auth.json");

function sunlight(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn("node", [path.resolve("dist/cli.js"), ...args], { cwd, env: { ...process.env, NO_COLOR: "1", HOME: cwd, ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

// ---------- CLI behaviour ----------
test("signed in: streams, runs read_file, feeds the result back, uses the session token", async () => {
  const w = await world();
  const dir = home({});
  const r = await sunlight(["-p", "what is in hello.txt?"], w.env, dir);
  w.server.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Let me look\./);
  assert.match(r.out, /read hello\.txt/);
  assert.match(r.out, /I saw the file\./);
  assert.doesNotMatch(r.out, /tool_call|imagined/);
  assert.equal(w.log.chat.length, 2);
  assert.equal(w.log.chat[0].auth, "Bearer tok-valid");
  assert.equal(w.log.chat[0].json.stream, true);
  assert.match(w.log.chat[1].json.messages.at(-1).content, /hello world/);
  assert.doesNotMatch(JSON.stringify(w.log.chat[1].json.messages), /imagined/);
  assert.equal(w.log.auth.length, 0, "no auth traffic while the token is fresh");
});

test("signed out: asks you to log in and makes no requests", async () => {
  const w = await world();
  const r = await sunlight(["-p", "hi"], w.env, home(null));
  w.server.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /sunlight login/);
  assert.equal(w.log.chat.length, 0);
});

test("an expired access token is renewed before the request, and saved", async () => {
  const w = await world();
  const dir = home({ expires_at: Math.floor(Date.now() / 1000) - 10 });
  const r = await sunlight(["-p", "hi"], w.env, dir);
  w.server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(w.log.auth[0].grant, "refresh_token");
  assert.equal(w.log.chat[0].auth, "Bearer tok-2");
  assert.equal(JSON.parse(readFileSync(authFile(dir), "utf8")).refresh_token, "ref-2");
});

test("a 401 from the API renews the session once and retries", async () => {
  const w = await world({
    chat: (json, n, auth) => (auth === "Bearer tok-valid" ? [401, { error: { message: "stale", code: "unauthenticated" } }] : [200, sse(delta("fine"), "[DONE]")]),
  });
  const r = await sunlight(["-p", "hi"], w.env, home({}));
  w.server.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /fine/);
  assert.deepEqual(w.log.chat.map((c) => c.auth), ["Bearer tok-valid", "Bearer tok-2"]);
});

test("a dead refresh token signs you out with a clear message", async () => {
  const w = await world();
  const dir = home({ expires_at: 0, refresh_token: "ref-dead" });
  const r = await sunlight(["-p", "hi"], w.env, dir);
  w.server.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /expired.*sunlight login/);
  assert.equal(existsSync(authFile(dir)), false);
});

test("a spent quota shows the reset time and is not retried", async () => {
  const w = await world({
    chat: () => [429, { error: { message: "You've used your Sunlight tokens for this window. They reset in 2h 10m.", code: "quota_exceeded" } }, { "retry-after": "7800" }],
  });
  const t0 = Date.now();
  const r = await sunlight(["-p", "hi"], w.env, home({}));
  w.server.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /reset in 2h 10m/);
  assert.equal(w.log.chat.length, 1);
  assert.ok(Date.now() - t0 < 5000, "must not wait on retry-after");
});

test("write tools are denied without --yes, allowed with it", async () => {
  const w = await world({
    chat: (json) => [200, sse(delta(json.messages.at(-1).content.includes("<tool_result") ? "ok" : '<tool_call>{"name":"write_file","arguments":{"path":"out.txt","content":"hi"}}</tool_call>'), "[DONE]")],
  });
  const dir = home({});
  await sunlight(["-p", "write"], w.env, dir);
  assert.equal(existsSync(path.join(dir, "out.txt")), false);
  await sunlight(["-p", "write", "--yes"], w.env, dir);
  w.server.close();
  assert.equal(readFileSync(path.join(dir, "out.txt"), "utf8"), "hi");
});

test("whoami shows the account and token use", async () => {
  const w = await world();
  const r = await sunlight(["whoami"], w.env, home({}));
  w.server.close();
  assert.match(r.out, /ana@yavqo\.com/);
  assert.match(r.out, /2,500,000 of 10,000,000 tokens used \(25%\) · resets in 3h 3\dm/);
});

test("logout revokes the session and deletes the local copy", async () => {
  const w = await world();
  const dir = home({});
  const r = await sunlight(["logout"], w.env, dir);
  w.server.close();
  assert.match(r.out, /Signed out/);
  assert.equal(w.log.logout, 1);
  assert.equal(existsSync(authFile(dir)), false);
});

// ---------- sign-in (in-process: the prompt itself needs a TTY) ----------
test("signIn saves a private session; wrong password says so and saves nothing", async () => {
  const w = await world();
  process.env.SUNLIGHT_AUTH_URL = `http://localhost:${w.port}`;
  const { signIn, AuthError, loadSession } = await import("../dist/auth.js");
  await assert.rejects(signIn("ana@yavqo.com", "nope"), (e) => e instanceof AuthError && /Wrong email or password/.test(e.message));
  assert.equal(await loadSession(), undefined);
  const s = await signIn("ana@yavqo.com", "correct horse");
  w.server.close();
  assert.equal(s.email, "ana@yavqo.com");
  assert.equal(w.log.auth[0].apikey?.startsWith("sb_publishable_"), true);
  const file = path.join(authHome, ".sunlight", "auth.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).access_token, "tok-1");
  assert.doesNotMatch(readFileSync(file, "utf8"), /correct horse/);
});
