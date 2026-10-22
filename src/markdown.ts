/**
 * Streaming markdown for the terminal. Text is styled as it arrives, token by token;
 * only a few characters are ever held back (a lone "*" that may become "**", the start
 * of a line that may become "```", "# " or "- "). Fenced code is shown with a gutter
 * and is never restyled.
 */

export interface Styles {
  bold(s: string): string;
  code(s: string): string;
  dim(s: string): string;
}

export const plainStyles: Styles = { bold: (s) => s, code: (s) => s, dim: (s) => s };

export class MarkdownStream {
  private pending = "";
  private lineStart = true;
  private inFence = false;
  private fenceLine = false;
  private heading = false;
  private bold = false;
  private code = false;

  constructor(private s: Styles) {}

  push(text: string): string {
    this.pending += text;
    return this.drain(false);
  }

  flush(): string {
    const out = this.drain(true);
    this.pending = "";
    return out;
  }

  private style(run: string): string {
    if (!run) return "";
    if (this.fenceLine) return run;
    if (this.code) return this.s.code(run);
    if (this.bold || this.heading) return this.s.bold(run);
    return run;
  }

  private drain(final: boolean): string {
    let out = "";
    while (this.pending) {
      if (this.lineStart) {
        const decided = this.lineOpening(final);
        if (decided === undefined) break; // need more text to decide
        out += decided;
        continue;
      }

      const ch = this.pending[0];
      if (ch === "\n") {
        out += "\n";
        this.pending = this.pending.slice(1);
        this.lineStart = true;
        this.fenceLine = this.heading = this.code = false;
        continue;
      }
      if (!this.fenceLine && ch === "`") {
        this.code = !this.code;
        this.pending = this.pending.slice(1);
        continue;
      }
      if (!this.fenceLine && !this.code && ch === "*") {
        if (this.pending.length < 2 && !final) break;
        if (this.pending[1] === "*") {
          this.bold = !this.bold;
          this.pending = this.pending.slice(2);
          continue;
        }
      }
      // Emit a run of ordinary characters in one styled chunk.
      const stop = this.fenceLine ? /\n/ : /[\n`*]/;
      const m = stop.exec(this.pending.slice(1));
      const end = m ? m.index + 1 : this.pending.length;
      out += this.style(this.pending.slice(0, end));
      this.pending = this.pending.slice(end);
    }
    return out;
  }

  /** Handles what a line starts with. Returns rendered text, or undefined to wait for more input. */
  private lineOpening(final: boolean): string | undefined {
    const p = this.pending;
    const nl = p.indexOf("\n");
    const line = nl >= 0 ? p.slice(0, nl) : p;

    const maybe = (prefix: string) => !final && nl < 0 && prefix.startsWith(line.trimStart());
    if (line.trimStart().startsWith("```")) {
      if (nl < 0 && !final) return undefined; // wait for the whole fence line
      this.inFence = !this.inFence;
      this.pending = nl >= 0 ? p.slice(nl + 1) : "";
      this.lineStart = true;
      return this.s.dim(line) + (nl >= 0 ? "\n" : "");
    }
    if (maybe("```")) return undefined;

    if (this.inFence) {
      this.lineStart = false;
      this.fenceLine = true;
      return this.s.dim("│ ");
    }

    const heading = /^#{1,6} /.exec(p);
    if (heading) {
      this.pending = p.slice(heading[0].length);
      this.lineStart = false;
      this.heading = true;
      return "";
    }
    if (/^#{1,6}$/.test(line) && !final && nl < 0) return undefined;

    const bullet = /^(\s*)[-*] /.exec(p);
    if (bullet) {
      this.pending = p.slice(bullet[0].length);
      this.lineStart = false;
      return `${bullet[1]}• `;
    }
    if (!final && nl < 0 && /^\s*[-*]?$/.test(line)) return undefined;

    this.lineStart = false;
    return "";
  }
}
