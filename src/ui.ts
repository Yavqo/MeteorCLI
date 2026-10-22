import type readline from "node:readline";

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");

const rgb = (r: number, g: number, b: number, basic: number) => (s: string) =>
  useColor ? `\x1b[${truecolor ? `38;2;${r};${g};${b}` : basic}m${s}\x1b[39m` : s;
const style = (open: number, close: number) => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  blue: rgb(0, 100, 224, 34), // Yavqo Blue
  sun: rgb(247, 185, 40, 33), // warning yellow, used as the sunlight accent
  green: rgb(49, 162, 76, 32),
  red: rgb(228, 30, 63, 31),
  dim: style(2, 22),
  bold: style(1, 22),
};

export type Decision = "yes" | "no" | "always";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Terminal {
  private timer?: NodeJS.Timeout;
  private spinning = false;
  private col = 0;

  constructor(
    private rl?: readline.Interface,
    private opts: { autoApprove?: boolean; interactive?: boolean } = {},
  ) {}

  toggleAutoApprove(): boolean {
    this.opts.autoApprove = !this.opts.autoApprove;
    return Boolean(this.opts.autoApprove);
  }

  write(s: string) {
    if (!s) return;
    process.stdout.write(s);
    const nl = s.lastIndexOf("\n");
    this.col = nl < 0 ? this.col + s.length : s.length - nl - 1;
  }

  /** Starts a new line only if the cursor is not already at the start of one. */
  ensureNewline() {
    if (this.col > 0) this.write("\n");
  }

  info(s: string) {
    this.stopSpinner();
    this.ensureNewline();
    this.write(`${s}\n`);
  }

  error(s: string) {
    this.stopSpinner();
    this.ensureNewline();
    process.stderr.write(`${c.red("✕")} ${s}\n`);
  }

  startSpinner(label = "Thinking") {
    if (!process.stdout.isTTY || this.spinning) return;
    this.spinning = true;
    let i = 0;
    const draw = () => process.stdout.write(`\r${c.sun(FRAMES[i++ % FRAMES.length])} ${c.dim(label)}\x1b[K`);
    draw();
    this.timer = setInterval(draw, 80);
  }

  stopSpinner() {
    if (!this.spinning) return;
    clearInterval(this.timer);
    this.spinning = false;
    process.stdout.write("\r\x1b[K");
  }

  banner(version: string, email: string | undefined, cwd: string) {
    const home = process.env.HOME;
    const shown = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
    this.write(`\n${c.sun("☀")} ${c.bold("Sunlight CLI")} ${c.dim(`v${version}`)}\n`);
    this.write(`  ${c.dim(`${email ?? "not signed in"} · ${shown}`)}\n`);
    this.write(`  ${c.dim("/help for commands · ctrl+c to stop a reply")}\n`);
    if (!email) this.write(`\n  ${c.sun("Sign in with your Yavqo account:")} ${c.bold("sunlight login")}\n`);
    this.write("\n");
  }

  toolLine(description: string) {
    this.stopSpinner();
    this.ensureNewline();
    this.write(`${c.blue("●")} ${description}\n`);
  }

  toolResult(ok: boolean, summary: string) {
    const first = summary.split("\n")[0].slice(0, 100);
    this.write(`  ${ok ? c.green("✓") : c.red("✕")} ${c.dim(first)}\n`);
  }

  async confirm(description: string, preview?: string): Promise<Decision> {
    this.stopSpinner();
    if (this.opts.autoApprove) return "yes";
    if (!this.opts.interactive || !this.rl) return "no";
    this.ensureNewline();
    this.write(`${c.sun("?")} Allow: ${c.bold(description)}\n`);
    if (preview) {
      for (const line of preview.split("\n").slice(0, 24)) {
        const colored = line.startsWith("+ ") ? c.green(line) : line.startsWith("- ") ? c.red(line) : c.dim(line);
        this.write(`    ${colored}\n`);
      }
    }
    const answer = await new Promise<string>((resolve) =>
      this.rl!.question(`  ${c.dim("[y]es  [n]o  [a]lways this session")} › `, resolve),
    );
    const a = answer.trim().toLowerCase();
    return a === "a" || a === "always" ? "always" : a === "y" || a === "yes" || a === "" ? "yes" : "no";
  }
}
