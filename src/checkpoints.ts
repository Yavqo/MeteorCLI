import { promises as fs } from "node:fs";
import path from "node:path";

interface Turn {
  /** Original content of every file the AI changed, or null if the file did not exist. */
  files: Map<string, string | null>;
  ranCommands: boolean;
}

/**
 * Remembers what files looked like before the AI changed them, one entry per request,
 * so /undo can put them back. Shell commands can't be rolled back this way; we only note them.
 */
export class Checkpoints {
  private turns: Turn[] = [];

  begin() {
    this.turns.push({ files: new Map(), ranCommands: false });
    if (this.turns.length > 50) this.turns.shift();
  }

  private get current(): Turn {
    if (this.turns.length === 0) this.begin();
    return this.turns[this.turns.length - 1];
  }

  /** Call before writing a file. Only the first snapshot per request counts. */
  async record(abs: string) {
    const turn = this.current;
    if (turn.files.has(abs)) return;
    try {
      turn.files.set(abs, await fs.readFile(abs, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      turn.files.set(abs, null);
    }
  }

  noteCommand() {
    this.current.ranCommands = true;
  }

  /** Files changed during the latest request. */
  changedInLastTurn(): number {
    return this.turns.at(-1)?.files.size ?? 0;
  }

  /** Reverts the most recent request that changed files. */
  async undo(): Promise<{ restored: string[]; deleted: string[]; ranCommands: boolean } | undefined> {
    while (this.turns.length > 0 && this.turns.at(-1)!.files.size === 0) this.turns.pop();
    const turn = this.turns.pop();
    if (!turn) return undefined;
    const restored: string[] = [];
    const deleted: string[] = [];
    for (const [abs, original] of turn.files) {
      if (original === null) {
        await fs.rm(abs, { force: true });
        deleted.push(abs);
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, original);
        restored.push(abs);
      }
    }
    return { restored, deleted, ranCommands: turn.ranCommands };
  }
}
