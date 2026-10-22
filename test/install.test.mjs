import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const releaseDir = path.resolve("release");
let server, base;
const overrides = {}; // path -> body, lets a test tamper with what the server returns

before(async () => {
  execFileSync("node", ["scripts/release.mjs"], { stdio: "ignore" });
  server = http.createServer((req, res) => {
    const name = req.url.slice(1);
    const body = overrides[name] ?? (existsSync(path.join(releaseDir, name)) ? readFileSync(path.join(releaseDir, name)) : null);
    if (body === null) return res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

const home = () => mkdtempSync(path.join(tmpdir(), "sl-install-"));
const version = () => JSON.parse(readFileSync("package.json", "utf8")).version;
const manifest = () => readFileSync(path.join(releaseDir, "latest"), "utf8");

function curlSh(h, { env = {}, script = `curl -fsSL ${base}/install.sh | sh` } = {}) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", script], { env: { PATH: process.env.PATH, HOME: h, SHELL: "/bin/zsh", SUNLIGHT_BASE_URL: base, ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("curl | sh installs, links the command, and it runs", async () => {
  const h = home();
  const r = await curlSh(h);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, new RegExp(`Sunlight CLI ${version()} is installed`));
  assert.match(r.out, /Next: sunlight login/);
  assert.match(r.out, /export PATH=/, "tells you how to fix PATH when ~/.local/bin isn't on it");
  assert.match(r.out, /~\/\.zshrc/);
  const bin = path.join(h, ".local/bin/sunlight");
  assert.equal(execFileSync(bin, ["--version"], { env: { ...process.env, HOME: h } }).toString().trim(), version());
  assert.equal(readlinkSync(path.join(h, ".sunlight/cli/current")), path.join(h, ".sunlight/cli", version()));
});

test("re-running updates in place and removes older versions", async () => {
  const h = home();
  mkdirSync(path.join(h, ".sunlight/cli/0.0.1/dist"), { recursive: true });
  const first = await curlSh(h);
  const second = await curlSh(h);
  assert.equal(first.code, 0, first.err);
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(readdirSync(path.join(h, ".sunlight/cli")).sort(), ["current", version()].sort());
  assert.equal(execFileSync(path.join(h, ".local/bin/sunlight"), ["--version"], { env: { ...process.env, HOME: h } }).toString().trim(), version());
});

test("does not touch ~/.sunlight/auth.json or history", async () => {
  const h = home();
  mkdirSync(path.join(h, ".sunlight"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(h, ".sunlight/auth.json"), "KEEP");
  assert.equal((await curlSh(h)).code, 0);
  assert.equal(readFileSync(path.join(h, ".sunlight/auth.json"), "utf8"), "KEEP");
});

test("a wrong checksum aborts and installs nothing", async () => {
  const h = home();
  overrides.latest = manifest().replace(/sha256=.*/, `sha256=${"0".repeat(64)}`);
  const r = await curlSh(h);
  delete overrides.latest;
  assert.notEqual(r.code, 0);
  assert.match(r.err, /Checksum mismatch/);
  assert.equal(existsSync(path.join(h, ".local/bin/sunlight")), false);
  assert.equal(existsSync(path.join(h, ".sunlight/cli/current")), false);
});

test("a download cut off halfway installs nothing", async () => {
  const h = home();
  const script = readFileSync(path.join(releaseDir, "install.sh"), "utf8");
  overrides["install.sh"] = script.slice(0, Math.floor(script.length * 0.8));
  const r = await curlSh(h);
  delete overrides["install.sh"];
  assert.notEqual(r.code, 0);
  assert.equal(existsSync(path.join(h, ".local/bin/sunlight")), false);
  assert.equal(existsSync(path.join(h, ".sunlight/cli")), false);
});

test("a hostile manifest cannot point outside the release", async () => {
  for (const bad of ["file=../evil.tgz", "file=/etc/passwd", "file=sunlight-cli-1/../../x.tgz", "version=1.0;rm -rf ~"]) {
    const h = home();
    const key = bad.split("=")[0];
    overrides.latest = manifest().replace(new RegExp(`^${key}=.*`, "m"), bad);
    const r = await curlSh(h);
    delete overrides.latest;
    assert.notEqual(r.code, 0, bad);
    assert.match(r.err, /invalid/, bad);
    assert.equal(existsSync(path.join(h, ".local/bin/sunlight")), false, bad);
  }
});

test("refuses a plain-http mirror that is not localhost", async () => {
  const r = await curlSh(home(), { env: { SUNLIGHT_BASE_URL: "http://example.com/sunlight" } });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /https/);
});

test("explains what to do when Node.js is missing", async (t) => {
  const bare = "/usr/bin:/bin";
  try {
    execFileSync("sh", ["-c", "command -v node"], { env: { PATH: bare } });
    return t.skip("node lives in /usr/bin on this machine");
  } catch { /* good: node is not on the bare PATH */ }
  const r = await curlSh(home(), { env: { PATH: bare } });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /node is required/);
});

test("warns when another sunlight earlier on PATH would win", async () => {
  const h = home();
  const other = path.join(h, "other-bin");
  mkdirSync(other);
  const { writeFileSync, chmodSync } = await import("node:fs");
  writeFileSync(path.join(other, "sunlight"), "#!/bin/sh\necho old\n");
  chmodSync(path.join(other, "sunlight"), 0o755);
  const r = await curlSh(h, { env: { PATH: `${other}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /another 'sunlight' at .*other-bin\/sunlight comes first/);
});

test("deployment config: Vercel builds and serves the release folder; installer defaults to meteorcli.yavqo.com", () => {
  const v = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.equal(v.buildCommand, "npm run release");
  assert.equal(v.outputDirectory, "release");
  assert.equal(v.installCommand, "npm ci");
  const header = (source, key) => v.headers.find((h) => h.source === source)?.headers.find((h) => h.key === key)?.value;
  assert.match(header("/install.sh", "Content-Type"), /^text\/plain/);
  assert.match(header("/latest", "Cache-Control"), /max-age=60/, "the manifest must not be cached for long, or updates won't show");
  assert.match(readFileSync("scripts/install.sh", "utf8"), /SUNLIGHT_BASE_URL:-https:\/\/meteorcli\.yavqo\.com\}/);
  assert.ok(existsSync("package-lock.json"), "npm ci needs the lockfile committed");
});
