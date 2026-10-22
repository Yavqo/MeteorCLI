import type { Message } from "./client.js";

/** Stays well under the server's 1 MB request limit and the model's context window. */
export const MAX_CHARS = 400_000;
export const MAX_MESSAGES = 380;
const KEEP_RECENT = 6;
const BULKY = /(<(tool_result|file|folder)\b[^>]*>)\n[\s\S]*?\n(<\/\2>)/g;
const PLACEHOLDER = "[removed to save space; read it again if you need it]";

const size = (messages: Message[]) => messages.reduce((n, m) => n + m.content.length, 0);

/**
 * Keeps a long session sendable. First empties old tool output and attachments (the model can
 * re-read files), then drops the oldest exchanges. The system prompt and recent turns stay intact.
 */
export function trimHistory(messages: Message[], maxChars = MAX_CHARS, maxMessages = MAX_MESSAGES): { messages: Message[]; trimmed: boolean } {
  if (size(messages) <= maxChars && messages.length <= maxMessages) return { messages, trimmed: false };
  const out = messages.map((m) => ({ ...m }));
  let trimmed = false;

  for (let i = 1; i < out.length - KEEP_RECENT && size(out) > maxChars; i++) {
    if (out[i].role !== "user") continue;
    const slim = out[i].content.replace(BULKY, (_, open, _tag, close) => `${open}\n${PLACEHOLDER}\n${close}`);
    if (slim !== out[i].content) {
      out[i].content = slim;
      trimmed = true;
    }
  }

  while ((size(out) > maxChars || out.length > maxMessages) && out.length > KEEP_RECENT + 1) {
    out.splice(1, 1);
    // A conversation must not open with the assistant replying to nothing.
    while (out.length > KEEP_RECENT + 1 && out[1].role === "assistant") out.splice(1, 1);
    trimmed = true;
  }
  return { messages: out, trimmed };
}
