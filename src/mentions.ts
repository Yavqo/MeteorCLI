import { promises as fs, readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { expandHome } from "./paths.js";
import { listTree, truncate } from "./tools.js";

/**
 * @-mentions: "fix the build in @~/Projects/site" adds that folder to the workspace and shows
 * the model its layout; "@src/app.ts" attaches the file. Spaces are written as "\ " (Tab
 * completion inserts them) or the whole path is quoted: @"~/My Folder".
 */

export interface Mention {
  raw: string;
  abs: string;
  kind: "folder" | "file";
}

const MENTION = /(^|\s)@("([^"]+)"|((?:\\ |[^\s])+))/g;
const TRAILING = /[,.;:!?)\]]+$/;
const MAX_FILE_BYTES = 200_000;

const unescape = (p: string) => p.replace(/\\ /g, " ");
const escape = (p: string) => p.replace(/ /g, "\\ ");

async function kindOf(abs: string): Promise<"folder" | "file" | undefined> {
  try {
    return (await fs.stat(abs)).isDirectory() ? "folder" : "file";
  } catch {
    return undefined;
  }
}

/** Finds @-mentions that point at real files or folders. */
export async function findMentions(input: string, cwd: string): Promise<{ mentions: Mention[]; missing: string[] }> {
  const mentions: Mention[] = [];
  const missing: string[] = [];
  for (const m of input.matchAll(MENTION)) {
    const token = m[3] ?? unescape(m[4]);
    const candidates = [token, token.replace(TRAILING, "")].filter((t, i, a) => t && a.indexOf(t) === i);
    let found: Mention | undefined;
    for (const t of candidates) {
      const abs = path.resolve(cwd, expandHome(t));
      const kind = await kindOf(abs);
      if (kind) {
        found = { raw: `@${m[2]}`, abs, kind };
        break;
      }
    }
    if (found) {
      if (!mentions.some((x) => x.abs === found!.abs)) mentions.push(found);
    } else if (/[/.~]/.test(token)) {
      missing.push(`@${m[2]}`); // looks like a path; "@john" is probably just text
    }
  }
  return { mentions, missing };
}

async function describeFile(abs: string): Promise<string> {
  const stat = await fs.stat(abs);
  const handle = await fs.open(abs, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES)), 0, Math.min(stat.size, MAX_FILE_BYTES), 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return `(binary file, ${stat.size.toLocaleString()} bytes)`;
    const lines = bytes.toString("utf8").split("\n");
    const body = lines.map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n");
    return truncate(stat.size > MAX_FILE_BYTES ? `${body}\n… file continues (${stat.size.toLocaleString()} bytes in total). Use read_file with offset for the rest.` : body);
  } finally {
    await handle.close();
  }
}

/** The context block appended to the user's message for each mention. */
export async function attachmentBlock(mentions: Mention[]): Promise<string> {
  if (mentions.length === 0) return "";
  const parts: string[] = [];
  for (const m of mentions) {
    if (m.kind === "folder") {
      const tree = (await listTree(m.abs, 2).catch(() => [])).join("\n") || "(empty)";
      parts.push(`<folder path="${m.abs}">\nThe user added this folder to your workspace. You can read and change files in it with absolute paths.\n${tree}\n</folder>`);
    } else {
      parts.push(`<file path="${m.abs}">\n${await describeFile(m.abs).catch((e) => `(could not read: ${(e as Error).message})`)}\n</file>`);
    }
  }
  return `\n\n<attached>\n${parts.join("\n")}\n</attached>`;
}

const COMMANDS = ["/help", "/add ", "/folders", "/undo", "/clear", "/usage", "/yes", "/exit"];

function completePath(partial: string, cwd: string): string[] {
  const unescaped = unescape(partial);
  const slash = unescaped.lastIndexOf("/");
  const dirPart = slash >= 0 ? unescaped.slice(0, slash + 1) : "";
  const base = unescaped.slice(slash + 1);
  const dirAbs = path.resolve(cwd, expandHome(dirPart || "."));
  let entries: Dirent[];
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const lower = base.toLowerCase();
  const isDir = (e: Dirent) => {
    if (e.isDirectory()) return true;
    if (!e.isSymbolicLink()) return false;
    try {
      return statSync(path.join(dirAbs, e.name)).isDirectory();
    } catch {
      return false;
    }
  };
  return entries
    .filter((e) => e.name.toLowerCase().startsWith(lower) && (base.startsWith(".") || !e.name.startsWith(".")))
    .map((e) => ({ name: e.name, dir: isDir(e) }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    .slice(0, 200)
    .map((e) => escape(dirPart + e.name + (e.dir ? "/" : "")));
}

/** readline completer: @paths anywhere in the line, paths after /add, and slash commands. */
export function complete(line: string, cwd: string): [string[], string] {
  const at = /(?:^|\s)(@(?:\\ |[^\s])*)$/.exec(line);
  if (at) {
    const token = at[1];
    return [completePath(token.slice(1), cwd).map((p) => `@${p}`), token];
  }
  const add = /^\/add\s+((?:\\ |[^\s])*)$/.exec(line);
  if (add) return [completePath(add[1], cwd), add[1]];
  if (/^\/\w*$/.test(line)) return [COMMANDS.filter((c) => c.startsWith(line)), line];
  return [[], line];
}
