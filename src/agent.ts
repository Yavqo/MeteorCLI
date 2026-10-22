import { Checkpoints } from "./checkpoints.js";
import { streamChat, type Message, type Usage } from "./client.js";
import type { Config } from "./config.js";
import { trimHistory } from "./history.js";
import { isInside, realish } from "./paths.js";
import { formatResult, parseReply, StreamFilter, systemPrompt } from "./protocol.js";
import { findTool, toolDocs, toolNames, truncate } from "./tools.js";
import { c, type Terminal } from "./ui.js";

const MAX_STEPS = 25;

export class Agent {
  messages: Message[];
  usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
  readonly checkpoints = new Checkpoints();
  /** Folders the AI may work in without extra approval. The first is the working directory. */
  readonly folders: string[];
  /** Tool names the user approved with "always" (only ever applies inside the workspace). */
  private allowed = new Set<string>();
  private realFolders: Promise<string[]>;
  /** Told to the model with the next message, e.g. that the user undid its changes. */
  private note?: string;
  private trimNotified = false;

  constructor(
    public cfg: Config,
    private term: Terminal,
    private cwd: string,
    private instructions?: string,
  ) {
    this.folders = [cwd];
    this.realFolders = Promise.all(this.folders.map(realish));
    this.messages = [this.system()];
  }

  private system(): Message {
    return {
      role: "system",
      content: systemPrompt({
        cwd: this.cwd,
        folders: this.folders,
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
        instructions: this.instructions,
        toolDocs,
      }),
    };
  }

  /** Adds a folder to the workspace. Returns false if it was already covered. */
  async addFolder(abs: string): Promise<boolean> {
    const real = await realish(abs);
    if ((await this.realFolders).some((f) => isInside(real, f))) return false;
    this.folders.push(abs);
    this.realFolders = Promise.all(this.folders.map(realish));
    this.messages[0] = this.system();
    return true;
  }

  async inWorkspace(abs: string): Promise<boolean> {
    const real = await realish(abs);
    return (await this.realFolders).some((f) => isInside(real, f));
  }

  reset() {
    this.messages = [this.system()];
    this.note = undefined;
  }

  async undo() {
    const result = await this.checkpoints.undo();
    if (result) {
      const files = [...result.restored, ...result.deleted];
      this.note = `[The user undid your file changes from an earlier request. These files are back to how they were before it: ${files.join(", ")}. Read them again before editing.]`;
    }
    return result;
  }

  /** Runs one user request to completion, looping through tool calls. */
  async run(input: string, signal: AbortSignal): Promise<void> {
    this.checkpoints.begin();
    this.messages.push({ role: "user", content: this.note ? `${this.note}\n\n${input}` : input });
    this.note = undefined;

    for (let step = 0; step < MAX_STEPS; step++) {
      this.fit();
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

  /** Keeps long sessions under the request size limit. */
  private fit() {
    const { messages, trimmed } = trimHistory(this.messages);
    if (!trimmed) return;
    this.messages = messages;
    if (!this.trimNotified) {
      this.trimNotified = true;
      this.term.info(c.dim("This conversation is long, so older tool output was dropped. /clear starts fresh."));
    }
  }

  private async stream(signal: AbortSignal): Promise<string> {
    const filter = new StreamFilter();
    const render = this.term.renderer();
    let raw = "";
    let started = false;
    const show = (text: string) => {
      if (!text) return;
      if (!started) {
        this.term.stopSpinner();
        started = true;
      }
      this.term.write(text);
    };
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
        show(render.push(filter.push(ev.delta)));
      }
    } finally {
      this.term.stopSpinner();
    }
    show(render.push(filter.flush()) + render.flush());
    this.term.ensureNewline();
    return raw;
  }

  private async execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const tool = findTool(name);
    if (!tool) return formatResult(name, false, `Unknown tool "${name}". Available tools: ${toolNames}.`);

    let description: string;
    let paths: string[];
    try {
      description = tool.describe(args, this.cwd);
      paths = tool.paths?.(args, this.cwd) ?? [];
    } catch (e) {
      return formatResult(name, false, (e as Error).message);
    }
    const outside = [];
    for (const p of paths) if (!(await this.inWorkspace(p))) outside.push(p);
    this.term.toolLine(description, outside.length > 0);

    // Inside the workspace, reads just run and "always" sticks. Outside it, everything asks, every time.
    if (outside.length > 0 || (tool.risk !== "read" && !this.allowed.has(name))) {
      const preview = await tool.preview?.(args, this.cwd).catch(() => undefined);
      const decision = await this.term.confirm(description, preview, outside.length > 0);
      if (decision === "no") {
        this.term.toolResult(false, "denied");
        const why = outside.length > 0 ? " It is outside the workspace folders; the user can add a folder with @path." : "";
        return formatResult(name, false, `The user denied this action.${why} Do not retry it; ask what they want instead.`);
      }
      if (decision === "always" && outside.length === 0) this.allowed.add(name);
    }

    try {
      const output = await tool.run(args, {
        cwd: this.cwd,
        signal,
        beforeWrite: (abs) => this.checkpoints.record(abs),
        beforeCommand: () => this.checkpoints.noteCommand(),
      });
      this.term.toolResult(true, output);
      return formatResult(name, true, truncate(output));
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      const err = e as NodeJS.ErrnoException;
      const message = err.code === "ENOENT" ? `No such file or directory: ${err.path ?? ""}` : err.message;
      this.term.toolResult(false, message);
      return formatResult(name, false, message);
    }
  }
}
