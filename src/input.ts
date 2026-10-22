import type readline from "node:readline";

/**
 * Turns readline's line events into whole messages.
 *
 * A paste arrives as many lines within a few milliseconds; without this each line would be
 * sent as its own message. Lines that arrive together are joined into one message. A line
 * ending in "\" continues onto the next line, like in a shell.
 */
export class Inbox implements AsyncIterable<string> {
  private lines: string[] = [];
  private queue: string[] = [];
  private timer?: NodeJS.Timeout;
  private waiting?: (r: IteratorResult<string>) => void;
  private closed = false;

  constructor(
    rl: readline.Interface,
    private opts: { pasteMs?: number; onContinue?: () => void } = {},
  ) {
    rl.on("line", (line) => {
      this.lines.push(line);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), this.opts.pasteMs ?? 30);
    });
    rl.on("close", () => {
      this.closed = true;
      this.flush();
      this.waiting?.({ value: undefined, done: true });
    });
  }

  private flush() {
    clearTimeout(this.timer);
    if (this.lines.length === 0) return;
    const last = this.lines[this.lines.length - 1];
    if (last.endsWith("\\") && !this.closed) {
      this.lines[this.lines.length - 1] = last.slice(0, -1);
      this.opts.onContinue?.();
      return;
    }
    const message = this.lines.join("\n");
    this.lines = [];
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: message, done: false });
    } else this.queue.push(message);
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}
