import { AuthError } from "./auth.js";
import type { Config } from "./config.js";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export type StreamEvent = { delta: string } | { usage: Usage };

export interface Quota {
  tokensUsed: number;
  limit: number;
  resetsAt: string;
}

export class SunlightError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "SunlightError";
  }
}

/** The server writes user-facing messages already; these cover gaps and odd statuses. */
function explain(status: number, apiMessage: string): string {
  if (apiMessage) return apiMessage;
  switch (status) {
    case 401:
      return "You're signed out or your session expired. Run `sunlight login`.";
    case 429:
      return "Sunlight is busy right now.";
    case 502:
    case 503:
      return "Sunlight is unavailable right now.";
    default:
      return `Request failed with status ${status}.`;
  }
}

const RETRYABLE = new Set([429, 502, 503]);
const MAX_ATTEMPTS = 4;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

async function toError(res: Response): Promise<SunlightError> {
  let apiMessage = "";
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } };
    apiMessage = body.error?.message ?? "";
    code = body.error?.code;
  } catch {
    /* body was not JSON */
  }
  const retryAfter = Number(res.headers.get("retry-after")) || undefined;
  return new SunlightError(explain(res.status, apiMessage), res.status, code, retryAfter);
}

export const endpoint = (cfg: Config) => `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;

/**
 * Streams a chat completion through the Sunlight API (OpenAI-compatible SSE).
 * Renews an expired session once, and retries 429/502/503 before the stream starts,
 * except a spent quota, which will not clear by waiting a few seconds.
 */
export async function* streamChat(
  cfg: Config,
  messages: Message[],
  signal?: AbortSignal,
  onRetry?: (waitSeconds: number, error: SunlightError) => void,
): AsyncGenerator<StreamEvent> {
  const body = JSON.stringify({ model: cfg.model, messages, stream: true });

  let token = await cfg.getToken();
  let renewed = false;
  let res: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(endpoint(cfg), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent": "sunlight-cli",
      },
      body,
      signal,
    });
    if (res.ok) break;
    if (res.status === 401 && !renewed) {
      renewed = true;
      token = await cfg.getToken(true);
      attempt--; // renewing the session is not a failed attempt
      continue;
    }
    const err = await toError(res);
    const retry = RETRYABLE.has(res.status) && err.code !== "quota_exceeded";
    if (!retry || attempt === MAX_ATTEMPTS) throw err;
    const wait = err.retryAfter ?? Math.min(2 ** attempt, 20);
    onRetry?.(wait, err);
    await sleep(wait * 1000, signal);
  }
  if (!res?.ok || !res.body) throw new SunlightError("Empty response from Sunlight.", 502);

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new SunlightError(json.error.message ?? "Stream error.", 502, json.error.code);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) yield { delta };
      if (json.usage) yield { usage: json.usage };
    }
  }
}

export async function getQuota(cfg: Config): Promise<Quota> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/quota`, {
    headers: { Authorization: `Bearer ${await cfg.getToken()}`, "User-Agent": "sunlight-cli" },
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as Quota;
}

export function formatQuota(q: Quota, now = Date.now()): string {
  const secs = Math.max(0, Math.round((new Date(q.resetsAt).getTime() - now) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.ceil((secs % 3600) / 60);
  const pct = q.limit > 0 ? Math.min(100, Math.round((q.tokensUsed / q.limit) * 100)) : 0;
  return `${q.tokensUsed.toLocaleString()} of ${q.limit.toLocaleString()} tokens used (${pct}%) · resets in ${h > 0 ? `${h}h ${m}m` : `${m}m`}`;
}

export { AuthError };
