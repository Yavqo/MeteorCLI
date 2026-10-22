import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { displayPath, resolvePath } from "./paths.js";

export type Risk = "read" | "write" | "exec" | "network";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Called with the absolute path before a file is written, so /undo can restore it. */
  beforeWrite?(abs: string): Promise<void>;
  /** Called before a shell command runs (its effects can't be undone). */
  beforeCommand?(): void;
}

export interface Tool {
  name: string;
  risk: Risk;
  doc: string;
  /** One line for the terminal and the permission prompt, e.g. "edit src/a.ts". */
  describe(args: Args, cwd: string): string;
  /** Absolute paths the call touches, checked against the workspace folders. */
  paths?(args: Args, cwd: string): string[];
  /** Optional preview shown under the prompt before the user decides. */
  preview?(args: Args, cwd: string): Promise<string | undefined>;
  run(args: Args, ctx: ToolContext): Promise<string>;
}

type Args = Record<string, unknown>;

const MAX_OUTPUT = 20_000;
const MAX_TREE_LINES = 400;
const IGNORED = new Set(["node_modules", ".git", "dist", ".next", "build", "__pycache__", ".venv", ".DS_Store", ".Trash"]);

function str(args: Args, key: string, required = true): string {
  const v = args[key];
  if (typeof v === "string") return v;
  if (required) throw new Error(`"${key}" is required and must be a string`);
  return "";
}

function num(args: Args, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" ? v : undefined;
}

export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - max} characters omitted] …\n${text.slice(-half)}`;
}

const target = (a: Args, cwd: string, key = "path", fallback?: string) => resolvePath(cwd, str(a, key, fallback === undefined) || fallback!);
const shown = (a: Args, cwd: string, key = "path", fallback?: string) => displayPath(target(a, cwd, key, fallback), cwd);

export async function listTree(dir: string, depth: number, prefix = "", budget = { left: MAX_TREE_LINES }): Promise<string[]> {
  const entries = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => !IGNORED.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const [i, e] of entries.entries()) {
    if (budget.left <= 0) {
      lines.push(`${prefix}… ${entries.length - i} more`);
      break;
    }
    budget.left--;
    lines.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
    if (e.isDirectory() && depth > 1) {
      lines.push(...(await listTree(path.join(dir, e.name), depth - 1, prefix + "  ", budget).catch(() => [])));
    }
  }
  return lines;
}

/** Turns a glob like "*.ts", "src/**\/test*" or a plain word into a case-insensitive matcher. */
function globMatcher(pattern: string): (relPath: string) => boolean {
  if (!/[*?]/.test(pattern)) {
    const needle = pattern.toLowerCase();
    return (rel) => rel.toLowerCase().includes(needle);
  }
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*(\/?)/g, (_, slash) => (slash ? "\u0000" : "\u0001"))
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  const re = new RegExp(`^${source}$`, "i");
  return pattern.includes("/") ? (rel) => re.test(rel) : (rel) => re.test(path.basename(rel));
}

function exec(cmd: string, args: string[], opts: { cwd: string; signal?: AbortSignal; timeoutMs: number; shell?: boolean }) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, shell: opts.shell, signal: opts.signal, env: process.env });
    let out = "";
    const timer = setTimeout(() => {
      out += `\n[timed out after ${opts.timeoutMs / 1000}s]`;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const take = (d: Buffer) => {
      if (out.length < MAX_OUTPUT * 4) out += d.toString();
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out: out + `\n${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

export const tools: Tool[] = [
  {
    name: "read_file",
    risk: "read",
    doc: `read_file {"path": string, "offset"?: number, "limit"?: number}
  Read a text file. Lines are numbered. offset is the first line (1-based), limit the line count (default 2000).`,
    describe: (a, cwd) => `read ${shown(a, cwd)}`,
    paths: (a, cwd) => [target(a, cwd)],
    async run(a, { cwd }) {
      const lines = (await fs.readFile(target(a, cwd), "utf8")).split("\n");
      const start = Math.max(1, num(a, "offset") ?? 1);
      const limit = num(a, "limit") ?? 2000;
      const slice = lines.slice(start - 1, start - 1 + limit);
      const body = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
      const more = start - 1 + limit < lines.length ? `\n… ${lines.length - (start - 1 + limit)} more lines` : "";
      return truncate(body + more);
    },
  },
  {
    name: "list_files",
    risk: "read",
    doc: `list_files {"path"?: string, "depth"?: number}
  List a directory as a tree (default ".", depth 2). Skips node_modules, .git and build output.`,
    describe: (a, cwd) => `list ${shown(a, cwd, "path", ".")}`,
    paths: (a, cwd) => [target(a, cwd, "path", ".")],
    async run(a, { cwd }) {
      return (await listTree(target(a, cwd, "path", "."), Math.min(num(a, "depth") ?? 2, 5))).join("\n") || "(empty)";
    },
  },
  {
    name: "find_files",
    risk: "read",
    doc: `find_files {"pattern": string, "path"?: string}
  Find files by name. pattern is a glob ("*.test.ts", "src/**/index.*") or part of a name ("readme"). Returns paths.`,
    describe: (a, cwd) => `find ${JSON.stringify(str(a, "pattern"))} in ${shown(a, cwd, "path", ".")}`,
    paths: (a, cwd) => [target(a, cwd, "path", ".")],
    async run(a, { cwd, signal }) {
      const root = target(a, cwd, "path", ".");
      const match = globMatcher(str(a, "pattern"));
      const found: string[] = [];
      const queue = [""];
      let visited = 0;
      while (queue.length > 0 && found.length < 200 && visited < 50_000) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const relDir = queue.shift()!;
        const entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (IGNORED.has(e.name)) continue;
          visited++;
          const rel = relDir ? `${relDir}/${e.name}` : e.name;
          if (e.isDirectory()) queue.push(rel);
          else if (match(rel)) found.push(rel);
        }
      }
      if (found.length === 0) return "No files found.";
      return found.sort().join("\n") + (found.length >= 200 ? "\n… more results; narrow the pattern" : "");
    },
  },
  {
    name: "search",
    risk: "read",
    doc: `search {"pattern": string, "path"?: string}
  Search file contents with a regular expression. Returns file:line:match.`,
    describe: (a, cwd) => `search for ${JSON.stringify(str(a, "pattern"))} in ${shown(a, cwd, "path", ".")}`,
    paths: (a, cwd) => [target(a, cwd, "path", ".")],
    async run(a, { cwd, signal }) {
      const excludes = [...IGNORED].flatMap((d) => ["--exclude-dir", d]);
      const r = await exec("grep", ["-rnIE", ...excludes, "-e", str(a, "pattern"), target(a, cwd, "path", ".")], { cwd, signal, timeoutMs: 30_000 });
      if (r.code === 1 && !r.out.trim()) return "No matches.";
      return truncate(r.out.trim().split("\n").slice(0, 200).join("\n"));
    },
  },
  {
    name: "write_file",
    risk: "write",
    doc: `write_file {"path": string, "content": string}
  Create a file or overwrite it completely. Creates parent folders.`,
    describe: (a, cwd) => `write ${shown(a, cwd)}`,
    paths: (a, cwd) => [target(a, cwd)],
    async preview(a, cwd) {
      const content = str(a, "content");
      let existed = true;
      await fs.access(target(a, cwd)).catch(() => (existed = false));
      return `${existed ? "overwrites" : "creates"} file, ${content.split("\n").length} lines`;
    },
    async run(a, { cwd, beforeWrite }) {
      const file = target(a, cwd);
      const content = str(a, "content");
      await beforeWrite?.(file);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
      return `Wrote ${content.split("\n").length} lines to ${displayPath(file, cwd)}`;
    },
  },
  {
    name: "edit_file",
    risk: "write",
    doc: `edit_file {"path": string, "old_string": string, "new_string": string, "replace_all"?: boolean}
  Replace exact text in a file. old_string must match exactly once (include surrounding lines to make it unique), unless replace_all is true.`,
    describe: (a, cwd) => `edit ${shown(a, cwd)}`,
    paths: (a, cwd) => [target(a, cwd)],
    async preview(a) {
      const minus = str(a, "old_string").split("\n").map((l) => `- ${l}`);
      const plus = str(a, "new_string").split("\n").map((l) => `+ ${l}`);
      return [...minus.slice(0, 12), ...plus.slice(0, 12)].join("\n");
    },
    async run(a, { cwd, beforeWrite }) {
      const file = target(a, cwd);
      const oldS = str(a, "old_string");
      const newS = str(a, "new_string");
      if (!oldS) throw new Error("old_string must not be empty");
      const text = await fs.readFile(file, "utf8");
      const count = text.split(oldS).length - 1;
      if (count === 0) throw new Error("old_string was not found. Read the file again and copy the text exactly.");
      if (count > 1 && a.replace_all !== true) {
        throw new Error(`old_string matches ${count} places. Add more surrounding lines, or set replace_all.`);
      }
      await beforeWrite?.(file);
      await fs.writeFile(file, a.replace_all === true ? text.split(oldS).join(newS) : text.replace(oldS, () => newS));
      const n = a.replace_all === true ? count : 1;
      return `Edited ${displayPath(file, cwd)} (${n} replacement${n > 1 ? "s" : ""})`;
    },
  },
  {
    name: "run_command",
    risk: "exec",
    doc: `run_command {"command": string, "cwd"?: string, "timeout_ms"?: number}
  Run a shell command and return its output and exit code. cwd defaults to the working directory; set it to run inside another workspace folder. Default timeout 120000.`,
    describe: (a, cwd) => {
      const dir = str(a, "cwd", false);
      return `run  ${str(a, "command")}${dir ? `  (in ${shown(a, cwd, "cwd")})` : ""}`;
    },
    paths: (a, cwd) => [target(a, cwd, "cwd", ".")],
    async run(a, { cwd, signal, beforeCommand }) {
      const timeoutMs = Math.min(num(a, "timeout_ms") ?? 120_000, 600_000);
      beforeCommand?.();
      const r = await exec(str(a, "command"), [], { cwd: target(a, cwd, "cwd", "."), signal, timeoutMs, shell: true });
      return truncate(`${r.out.trim() || "(no output)"}\n[exit code ${r.code}]`);
    },
  },
  {
    name: "fetch_url",
    risk: "network",
    doc: `fetch_url {"url": string}
  Fetch a web page or JSON endpoint and return its text (HTML is stripped to text).`,
    describe: (a) => `fetch ${str(a, "url")}`,
    async run(a, { signal }) {
      const url = str(a, "url");
      if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
      const res = await fetch(url, { signal, headers: { "User-Agent": "sunlight-cli" } });
      const type = res.headers.get("content-type") ?? "";
      let text = await res.text();
      if (type.includes("html")) {
        text = text
          .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/[ \t]+/g, " ")
          .replace(/\n\s*\n+/g, "\n\n");
      }
      return truncate(`[${res.status}]\n${text.trim()}`);
    },
  },
];

export const toolDocs = tools.map((t) => t.doc).join("\n\n");
export const toolNames = tools.map((t) => t.name).join(", ");
export const findTool = (name: string) => tools.find((t) => t.name === name);
