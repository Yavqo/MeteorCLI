import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Public by design. The publishable key only tells Supabase Auth which project to talk to;
// it grants no data access on its own. Sunlight's AIHub key never appears in this package:
// it lives as a secret on the sunlight-chat Edge Function.
export const SUPABASE_URL = "https://ikjugnimawkoatkbvpgk.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_X4TxQSmN52bx_1bf6jIMPQ_8c2k81CM";

export const CONFIG_DIR = path.join(os.homedir(), ".sunlight");
export const AUTH_FILE = path.join(CONFIG_DIR, "auth.json");
export const HISTORY_FILE = path.join(CONFIG_DIR, "history");

/** Overridable so tests and local development can point at a stand-in server. */
export const authUrl = () => (process.env.SUNLIGHT_AUTH_URL ?? SUPABASE_URL).replace(/\/+$/, "");
export const apiUrl = () => (process.env.SUNLIGHT_API_URL ?? `${SUPABASE_URL}/functions/v1/sunlight-chat`).replace(/\/+$/, "");

export interface Config {
  /** Sunlight API root; requests go to <baseUrl>/chat/completions. */
  baseUrl: string;
  /** Label only. The server decides which model answers. */
  model: string;
  /** Returns a valid access token, refreshing it when needed. */
  getToken(forceRefresh?: boolean): Promise<string>;
}

/** Project instructions, like CLAUDE.md: SUNLIGHT.md in the working directory. */
export async function loadProjectInstructions(cwd: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(cwd, "SUNLIGHT.md"), "utf8");
  } catch {
    return undefined;
  }
}
