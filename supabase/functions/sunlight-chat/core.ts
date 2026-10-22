// Request handling for the Sunlight CLI proxy. No Supabase or Deno imports here:
// everything environment-specific comes in through `Deps`, so this file runs in tests too.

export interface Quota {
  tokensUsed: number;
  limit: number;
  resetsAt: string;
}

export interface Deps {
  upstream: { base: string; deployment: string; key: string };
  /** Resolves a Supabase access token to a user, or null if it is invalid or the user is banned. */
  verifyUser(token: string): Promise<{ id: string } | null>;
  quotaStatus(userId: string): Promise<Quota>;
  quotaConsume(userId: string, tokens: number): Promise<void>;
  fetchUpstream: typeof fetch;
  /** Keeps work alive after the response has been returned (EdgeRuntime.waitUntil). */
  defer(work: Promise<unknown>): void;
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_MESSAGES = 400;
const MAX_OUTPUT_TOKENS = 8192;
const ROLES = new Set(["system", "user", "assistant"]);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const fail = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  json(status, { error: { message, type: code, code } }, headers);

interface Message {
  role: string;
  content: string;
}

function validate(body: any): { messages: Message[]; stream: boolean; temperature?: number; maxTokens: number } | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return `messages must be an array of 1 to ${MAX_MESSAGES} items.`;
  }
  for (const m of messages) {
    if (!m || !ROLES.has(m.role) || typeof m.content !== "string") {
      return "Each message needs a role (system, user, assistant) and string content.";
    }
  }
  let temperature: number | undefined;
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || body.temperature < 0 || body.temperature > 2) return "temperature must be 0 to 2.";
    temperature = body.temperature;
  }
  let maxTokens = MAX_OUTPUT_TOKENS;
  if (body.max_tokens !== undefined) {
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return "max_tokens must be a positive integer.";
    maxTokens = Math.min(body.max_tokens, MAX_OUTPUT_TOKENS);
  }
  return { messages, stream: body.stream === true, temperature, maxTokens };
}

function untilReset(resetsAt: string): { seconds: number; text: string } {
  const seconds = Math.max(1, Math.ceil((new Date(resetsAt).getTime() - Date.now()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return { seconds, text: h > 0 ? `${h}h ${m}m` : `${m}m` };
}

/** Pulls token usage and output size out of an SSE stream as it passes through. */
class Sniffer {
  usage?: { prompt_tokens: number; completion_tokens: number };
  outChars = 0;
  private buffer = "";
  private decoder = new TextDecoder();

  push(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        const j = JSON.parse(line.slice(5));
        if (j.usage) this.usage = j.usage;
        this.outChars += j.choices?.[0]?.delta?.content?.length ?? 0;
      } catch { /* partial or non-JSON line */ }
    }
  }
}

export async function handle(req: Request, d: Deps): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/^(\/functions\/v1)?\/sunlight-chat/, "") || "/";

  const token = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) return fail(401, "unauthenticated", "Sign in with `sunlight login`.");
  const user = await d.verifyUser(token);
  if (!user) return fail(401, "unauthenticated", "Your session is not valid. Run `sunlight login`.");

  if (path === "/quota" && req.method === "GET") return json(200, await d.quotaStatus(user.id));
  if (path !== "/chat/completions") return fail(404, "not_found", "Not found.");
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, "too_large", "That request is too large. Start a new conversation with /clear.");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(400, "invalid_request", "Body is not valid JSON.");
  }
  const req_ = validate(parsed);
  if (typeof req_ === "string") return fail(400, "invalid_request", req_);

  // The quota gate. Failed upstream calls are never charged.
  const quota = await d.quotaStatus(user.id);
  if (quota.tokensUsed >= quota.limit) {
    const { seconds, text } = untilReset(quota.resetsAt);
    return fail(429, "quota_exceeded", `You've used your Sunlight tokens for this window. They reset in ${text}.`, {
      "retry-after": String(seconds),
    });
  }

  // Model, key and limits are ours: only whitelisted fields from the client are forwarded.
  const upstreamBody = {
    model: d.upstream.deployment,
    messages: req_.messages,
    stream: req_.stream,
    max_tokens: req_.maxTokens,
    ...(req_.temperature !== undefined && { temperature: req_.temperature }),
  };
  const inChars = req_.messages.reduce((n, m) => n + m.content.length, 0);

  let res: Response;
  try {
    res = await d.fetchUpstream(`${d.upstream.base.replace(/\/+$/, "")}/deployments/${d.upstream.deployment}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.upstream.key}`, "content-type": "application/json" },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    console.error("upstream fetch failed", e);
    return fail(502, "upstream_unavailable", "Sunlight is unavailable right now. Try again in a moment.");
  }

  if (!res.ok) {
    // 401/403/404/409 mean OUR key or deployment is wrong. Users can't act on that, so don't leak it.
    console.error("upstream error", res.status, await res.text().catch(() => ""));
    if (res.status === 429) {
      const wait = res.headers.get("retry-after") ?? "10";
      return fail(429, "rate_limited", `Sunlight is busy. Retrying in ${wait}s.`, { "retry-after": wait });
    }
    if (res.status === 400) return fail(400, "invalid_request", "The model rejected that request.");
    return fail(res.status === 503 ? 503 : 502, "upstream_unavailable", "Sunlight is unavailable right now. Try again in a moment.");
  }

  const record = (usage: { prompt_tokens: number; completion_tokens: number } | undefined, outChars: number) => {
    // If AIHub gives no token counts, estimate high rather than undercount.
    const tokens = usage ? usage.prompt_tokens + usage.completion_tokens : Math.ceil((inChars + outChars) / 3);
    return d.quotaConsume(user.id, tokens).catch((e) => console.error("quota record failed", e));
  };

  const isStream = res.headers.get("content-type")?.includes("text/event-stream") && res.body;
  if (!isStream) {
    const body = await res.json();
    d.defer(record(body.usage, body.choices?.[0]?.message?.content?.length ?? 0));
    return json(200, body);
  }

  const sniffer = new Sniffer();
  const reader = res.body!.getReader();
  let recorded = false;
  const settle = () => {
    if (recorded) return;
    recorded = true;
    d.defer(record(sniffer.usage, sniffer.outChars));
  };
  const out = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          settle();
          return;
        }
        sniffer.push(value);
        controller.enqueue(value);
      } catch (e) {
        settle();
        controller.error(e);
      }
    },
    async cancel(reason) {
      // The CLI aborted (ctrl+c). The model has still produced tokens, so count them.
      await reader.cancel(reason).catch(() => {});
      settle();
    },
  });
  return new Response(out, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}
