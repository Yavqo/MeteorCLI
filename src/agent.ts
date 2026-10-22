import { streamChat, type Message, type Usage } from "./client.js";
import type { Config } from "./config.js";
import { formatResult, parseReply, StreamFilter, systemPrompt } from "./protocol.js";
import { findTool, toolDocs, truncate } from "./tools.js";
import { c, type Terminal } from "./ui.js";

const MAX_STEPS = 25;

export class Agent {
  messages: Message[];
  usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
  /** Tool names the user approved with "always" for this session. */
  private allowed = new Set<string>();

  constructor(
    public cfg: Config,
    private term: Terminal,
    private cwd: string,
    private instructions?: string,
  ) {
    this.messages = [this.system()];
  }

  private system(): Message {
    return {
      role: "system",
      content: systemPrompt({
        cwd: this.cwd,
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
        instructions: this.instructions,
        toolDocs,
      }),
    };
  }

  reset() {
    this.messages = [this.system()];
  }

  /** Runs one user request to completion, looping through tool calls. */
  async run(input: string, signal: AbortSignal): Promise<void> {
    this.messages.push({ role: "user", content: input });

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await this.stream(signal);
      const parsed = parseReply(reply);
      // Keep only what the model legitimately said: prose plus its calls, not imagined results.
      this.messages.push({ role: "assistant", content: parsed.kept });

      if (parsed.calls.length === 0 && parsed.errors.length === 0) return;

      const results: string[] = [];
      for (const call of parsed.calls) results.push(await this.execute(call.name, call.arguments, signal));
      for (const e of parsed.errors) results.push(formatResult("tool_call", false, e));
      this.messages.push({ role: "user", content: results.join("\n\n") });
    }
    this.term.info(c.dim(`Stopped after ${MAX_STEPS} steps. Say "continue" to go on.`));
  }

  private async stream(signal: AbortSignal): Promise<string> {
    const filter = new StreamFilter();
    let raw = "";
    let started = false;
    this.term.startSpinner();
    try {
      for await (const ev of streamChat(this.cfg, this.messages, signal, (wait, err) => {
        this.term.stopSpinner();
        this.term.info(c.dim(`${err.message} Retrying in ${wait}s…`));
        this.term.startSpinner("Waiting");
      })) {
        if ("usage" in ev) {
          this.usage.prompt_tokens += ev.usage.prompt_tokens ?? 0;
          this.usage.completion_tokens += ev.usage.completion_tokens ?? 0;
          continue;
        }
        raw += ev.delta;
        const visible = filter.push(ev.delta);
        if (visible) {
          if (!started) {
            this.term.stopSpinner();
            started = true;
          }
          this.term.write(visible);
        }
      }
    } finally {
      this.term.stopSpinner();
    }
    const tail = filter.flush();
    if (tail) this.term.write(tail);
    this.term.ensureNewline();
    return raw;
  }

  private async execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const tool = findTool(name);
    if (!tool) {
      const known = "read_file, list_files, search, write_file, edit_file, run_command, fetch_url";
      return formatResult(name, false, `Unknown tool "${name}". Available tools: ${known}.`);
    }

    let description = name;
    try {
      description = tool.describe(args, this.cwd);
    } catch (e) {
      return formatResult(name, false, (e as Error).message);
    }
    this.term.toolLine(description);

    if (tool.risk !== "read" && !this.allowed.has(name)) {
      const preview = await tool.preview?.(args, this.cwd).catch(() => undefined);
      const decision = await this.term.confirm(description, preview);
      if (decision === "no") {
        this.term.toolResult(false, "denied");
        return formatResult(name, false, "The user denied this action. Do not retry it; ask what they want instead.");
      }
      if (decision === "always") this.allowed.add(name);
    }

    try {
      const output = await tool.run(args, { cwd: this.cwd, signal });
      this.term.toolResult(true, output);
      return formatResult(name, true, truncate(output));
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      const message = (e as NodeJS.ErrnoException).code === "ENOENT" ? `No such file or directory: ${(e as any).path ?? ""}` : (e as Error).message;
      this.term.toolResult(false, message);
      return formatResult(name, false, message);
    }
  }
}
