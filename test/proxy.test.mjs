import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../supabase/functions/sunlight-chat/core.ts";

const sse = (...events) => events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
const delta = (c) => ({ choices: [{ delta: { content: c } }] });

function setup({ quota = { tokensUsed: 0, limit: 1000, resetsAt: new Date(Date.now() + 2 * 3600e3).toISOString() }, upstream } = {}) {
  const calls = { upstream: [], consumed: [] };
  const deps = {
    upstream: { base: "https://aihub.test/api/v1", deployment: "dep-1", key: "SERVER_SECRET" },
    verifyUser: async (t) => (t === "good" ? { id: "user-1" } : null),
    quotaStatus: async () => quota,
    quotaConsume: async (id, n) => void calls.consumed.push([id, n]),
    defer: (p) => p,
    fetchUpstream: async (url, init) => {
      calls.upstream.push({ url, init, body: JSON.parse(init.body) });
      return upstream();
    },
  };
  const post = (body, token = "good", path = "/functions/v1/sunlight-chat/chat/completions") =>
    handle(new Request(`https://x.supabase.co${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), deps);
  return { deps, calls, post };
}

const msgs = [{ role: "user", content: "hello world" }];
const okJson = () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }), { headers: { "content-type": "application/json" } });
const okStream = (body) => new Response(body, { headers: { "content-type": "text/event-stream" } });

test("rejects missing and invalid sessions", async () => {
  const { post, deps } = setup({ upstream: okJson });
  assert.equal((await handle(new Request("https://x/sunlight-chat/chat/completions", { method: "POST", body: "{}" }), deps)).status, 401);
  assert.equal((await post({ messages: msgs }, "forged")).status, 401);
});

test("forces our model, key and limits; drops everything else the client sent", async () => {
  const { post, calls } = setup({ upstream: okJson });
  const res = await post({ model: "gpt-other", messages: msgs, tools: [{ x: 1 }], max_tokens: 999999, temperature: 0.2, user: "hax" });
  assert.equal(res.status, 200);
  const sent = calls.upstream[0];
  assert.equal(sent.url, "https://aihub.test/api/v1/deployments/dep-1/chat/completions");
  assert.equal(sent.init.headers.authorization, "Bearer SERVER_SECRET");
  assert.deepEqual(sent.body, { model: "dep-1", messages: msgs, stream: false, max_tokens: 8192, temperature: 0.2 });
  assert.deepEqual(calls.consumed, [["user-1", 10]]);
});

test("blocks over-quota users before calling the model", async () => {
  const { post, calls } = setup({ quota: { tokensUsed: 1000, limit: 1000, resetsAt: new Date(Date.now() + 90 * 60e3).toISOString() }, upstream: okJson });
  const res = await post({ messages: msgs });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, "quota_exceeded");
  assert.ok(Number(res.headers.get("retry-after")) > 5000);
  assert.equal(calls.upstream.length, 0);
});

test("validates the request", async () => {
  const { post } = setup({ upstream: okJson });
  for (const bad of [{}, { messages: [] }, { messages: [{ role: "tool", content: "x" }] }, { messages: [{ role: "user", content: 5 }] }, { messages: msgs, temperature: 9 }, { messages: msgs, max_tokens: 0 }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
});

test("streams through unchanged and records AIHub's token counts once", async () => {
  const body = sse(delta("Hel"), delta("lo"), { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } }, "[DONE]");
  const { post, calls } = setup({ upstream: () => okStream(body) });
  const res = await post({ messages: msgs, stream: true });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(await res.text(), body);
  assert.deepEqual(calls.consumed, [["user-1", 25]]);
});

test("estimates tokens when AIHub reports none", async () => {
  const body = sse(delta("a".repeat(30)), "[DONE]");
  const { post, calls } = setup({ upstream: () => okStream(body) });
  await (await post({ messages: msgs, stream: true })).text();
  // (11 chars in + 30 out) / 3 = 13.67 -> 14
  assert.deepEqual(calls.consumed, [["user-1", 14]]);
});

test("still charges when the client aborts mid-stream", async () => {
  const enc = new TextEncoder();
  const upstream = () => okStream(new ReadableStream({ start(c) { c.enqueue(enc.encode(sse(delta("x".repeat(60))))); } }));
  const { post, calls } = setup({ upstream });
  const res = await post({ messages: msgs, stream: true });
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.consumed, [["user-1", 24]]);
});

test("hides our own upstream failures and never charges for them", async () => {
  for (const status of [401, 403, 404, 409]) {
    const { post, calls } = setup({ upstream: () => new Response('{"error":{"message":"bad key"}}', { status }) });
    const res = await post({ messages: msgs });
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.doesNotMatch(text, /bad key|SERVER_SECRET|dep-1/);
    assert.equal(calls.consumed.length, 0);
  }
});

test("passes a shared rate limit through so the CLI can retry", async () => {
  const { post } = setup({ upstream: () => new Response("{}", { status: 429, headers: { "retry-after": "7" } }) });
  const res = await post({ messages: msgs });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "7");
  assert.equal((await res.json()).error.code, "rate_limited");
});

test("GET /quota returns the user's own status", async () => {
  const { deps } = setup({ upstream: okJson });
  const res = await handle(new Request("https://x/functions/v1/sunlight-chat/quota", { headers: { authorization: "Bearer good" } }), deps);
  assert.deepEqual(Object.keys(await res.json()).sort(), ["limit", "resetsAt", "tokensUsed"]);
});
