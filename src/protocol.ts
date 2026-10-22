/**
 * AIHub's chat API takes plain messages, with no native tool-calling field.
 * So tools travel as text: the model writes <tool_call>{json}</tool_call>,
 * we run it, and reply with <tool_result> in the next user turn.
 */

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParsedReply {
  /** Prose the model wrote before its first tool call. */
  text: string;
  calls: ToolCall[];
  /** Problems the model should hear about, e.g. malformed JSON. */
  errors: string[];
  /** The reply up to the end of the last call: what we keep in history. */
  kept: string;
}

export const OPEN = "<tool_call>";
export const CLOSE = "</tool_call>";

/**
 * Takes the first batch of consecutive tool calls and drops anything after it.
 * Models like to imagine the tool's output and keep writing; that text is discarded.
 */
export function parseReply(raw: string): ParsedReply {
  const calls: ToolCall[] = [];
  const errors: string[] = [];
  const first = raw.indexOf(OPEN);
  if (first < 0) return { text: raw, calls, errors, kept: raw };

  const text = raw.slice(0, first).trimEnd();
  let pos = first;
  let keptEnd = raw.length;
  while (raw.startsWith(OPEN, pos)) {
    const end = raw.indexOf(CLOSE, pos);
    if (end < 0) {
      errors.push("A <tool_call> was never closed (the reply was cut off). Send it again, shorter.");
      break;
    }
    const body = raw.slice(pos + OPEN.length, end).trim();
    try {
      const json = JSON.parse(body);
      if (typeof json?.name !== "string") throw new Error('missing "name"');
      calls.push({ name: json.name, arguments: json.arguments ?? {} });
    } catch (e) {
      errors.push(`Invalid tool call JSON (${(e as Error).message}). Use {"name": "...", "arguments": {...}}.`);
    }
    pos = end + CLOSE.length;
    keptEnd = pos;
    const rest = raw.slice(pos);
    pos += rest.length - rest.trimStart().length;
  }
  return { text, calls, errors, kept: raw.slice(0, keptEnd) };
}

export function formatResult(name: string, ok: boolean, output: string): string {
  return `<tool_result name="${name}" status="${ok ? "ok" : "error"}">\n${output}\n</tool_result>`;
}

/**
 * Hides tool-call markup from the terminal while a reply streams.
 * Holds back a tail that could still turn into "<tool_call>".
 */
export class StreamFilter {
  private pending = "";
  private hidden = false;

  push(chunk: string): string {
    if (this.hidden) return "";
    this.pending += chunk;
    const i = this.pending.indexOf(OPEN);
    if (i >= 0) {
      const out = this.pending.slice(0, i);
      this.pending = "";
      this.hidden = true;
      return out.replace(/\s+$/, "");
    }
    // Keep the longest tail that is a prefix of OPEN.
    let keep = 0;
    for (let n = Math.min(OPEN.length - 1, this.pending.length); n > 0; n--) {
      if (OPEN.startsWith(this.pending.slice(-n))) {
        keep = n;
        break;
      }
    }
    const out = this.pending.slice(0, this.pending.length - keep);
    this.pending = this.pending.slice(this.pending.length - keep);
    return out;
  }

  flush(): string {
    const out = this.hidden ? "" : this.pending;
    this.pending = "";
    return out;
  }
}

export function systemPrompt(opts: { cwd: string; folders: string[]; platform: string; date: string; instructions?: string; toolDocs: string }): string {
  const extra = opts.folders.filter((f) => f !== opts.cwd);
  return `You are Sunlight, an AI coding agent running in the user's terminal. You help with software engineering tasks: reading code, finding bugs, writing features, running commands.

Working directory: ${opts.cwd}${
    extra.length ? `\nOther workspace folders the user added (use absolute paths for these):\n${extra.map((f) => `- ${f}`).join("\n")}` : ""
  }
Platform: ${opts.platform}
Date: ${opts.date}

# Using tools
You can act on the user's machine with tools. To call a tool, write exactly this and nothing else after it:

<tool_call>{"name": "read_file", "arguments": {"path": "src/index.ts"}}</tool_call>

Rules:
- The arguments must be valid JSON. Escape newlines in strings as \\n and quotes as \\".
- After a tool call, STOP. Do not guess the result and do not keep writing. The result arrives in the next message as <tool_result>.
- You may write several <tool_call> blocks in a row when they are independent. Put no text between them.
- Read a file before you edit it. Prefer edit_file over write_file for existing files.
- Relative paths are resolved against the working directory. Work inside the workspace folders; anything outside them needs the user's approval.
- The user can attach folders and files by writing @path. They arrive in an <attached> block at the end of their message.
- If a tool fails, read the error and try a different approach.
- When the task is done, answer in plain text with no tool call.

# Tools
${opts.toolDocs}

# Style
Be brief and direct. Say what you did and what you found. No hype words, no emoji. Use markdown code fences for code.${
    opts.instructions ? `\n\n# Project instructions (SUNLIGHT.md)\n${opts.instructions.trim()}` : ""
  }`;
}
