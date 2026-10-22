import { promises as fs } from "node:fs";
import { AUTH_FILE, CONFIG_DIR, SUPABASE_PUBLISHABLE_KEY, authUrl } from "./config.js";

export interface Session {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. */
  expires_at: number;
  email: string;
  user_id: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const SIGNED_OUT = "You're signed out. Run `sunlight login`.";

async function authFetch(pathAndQuery: string, body?: unknown, bearer?: string): Promise<Response> {
  return fetch(`${authUrl()}/auth/v1${pathAndQuery}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      "content-type": "application/json",
      ...(bearer && { authorization: `Bearer ${bearer}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function toSession(json: any): Session {
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: json.expires_at ?? Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600),
    email: json.user?.email ?? "",
    user_id: json.user?.id ?? "",
  };
}

export async function loadSession(): Promise<Session | undefined> {
  try {
    const s = JSON.parse(await fs.readFile(AUTH_FILE, "utf8")) as Session;
    return s.access_token && s.refresh_token ? s : undefined;
  } catch {
    return undefined;
  }
}

export async function saveSession(s: Session): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Holds a refresh token, so keep it private to the user.
  await fs.writeFile(AUTH_FILE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(AUTH_FILE, 0o600);
}

export const clearSession = () => fs.rm(AUTH_FILE, { force: true });

/** Signs in with a Yavqo account (email and password). The password is sent once and never stored. */
export async function signIn(email: string, password: string): Promise<Session> {
  let res: Response;
  try {
    res = await authFetch("/token?grant_type=password", { email, password });
  } catch {
    throw new AuthError("Could not reach Yavqo. Check your connection and try again.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error_code?: string; msg?: string };
    if (res.status === 429) throw new AuthError("Too many sign-in attempts. Wait a minute and try again.");
    if (res.status === 400 || res.status === 401) {
      if (body.error_code === "email_not_confirmed") throw new AuthError("Confirm your email first, then sign in again.");
      throw new AuthError("Wrong email or password.");
    }
    throw new AuthError(body.msg ?? `Sign-in failed (status ${res.status}).`);
  }
  const session = toSession(await res.json());
  await saveSession(session);
  return session;
}

async function refresh(s: Session): Promise<Session> {
  let res: Response;
  try {
    res = await authFetch("/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
  } catch {
    throw new AuthError("Could not reach Yavqo to renew your session. Check your connection.");
  }
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) {
      await clearSession(); // the refresh token is dead; keeping it would only repeat this error
      throw new AuthError("Your session has expired. Run `sunlight login`.");
    }
    throw new AuthError("Yavqo is unavailable right now. Try again in a moment.");
  }
  const next = toSession(await res.json());
  next.email ||= s.email;
  next.user_id ||= s.user_id;
  await saveSession(next);
  return next;
}

/** A valid access token, renewed when it is within a minute of expiring (or when forced). */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const session = await loadSession();
  if (!session) throw new AuthError(SIGNED_OUT);
  if (!forceRefresh && session.expires_at - Date.now() / 1000 > 60) return session.access_token;
  return (await refresh(session)).access_token;
}

export async function signOut(): Promise<boolean> {
  const session = await loadSession();
  if (!session) return false;
  // Best effort: revoke the session on the server, then always delete the local copy.
  await authFetch("/logout?scope=local", undefined, session.access_token).catch(() => {});
  await clearSession();
  return true;
}
