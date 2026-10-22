import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const expandHome = (p: string) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

export const resolvePath = (cwd: string, p: string) => path.resolve(cwd, expandHome(p));

/** ~/… under the home folder, absolute otherwise. */
export function homePath(abs: string): string {
  const home = os.homedir();
  return abs === home ? "~" : abs.startsWith(home + path.sep) ? `~/${abs.slice(home.length + 1)}` : abs;
}

/** Short form for the terminal: relative inside cwd, ~/… under home, absolute otherwise. */
export function displayPath(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs);
  if (!rel) return ".";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  return homePath(abs);
}

/**
 * Real path of the nearest existing ancestor, plus the part that doesn't exist yet.
 * Following symlinks here stops "workspace/link-to-etc/passwd" from counting as inside.
 */
export async function realish(abs: string): Promise<string> {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

export function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
