import { createClient } from "jsr:@supabase/supabase-js@2";
import { handle, type Quota } from "./core.ts";

declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void } | undefined;

// Secrets (set with `supabase secrets set`, never committed):
//   AIHUB_API_KEY      Yavqo's AIHub key. Shared by every Sunlight user and never leaves the server.
//   AIHUB_DEPLOYMENT   Optional. Defaults to the Sunlight deployment below.
//   AIHUB_BASE_URL     Optional. Defaults to the production API.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase itself.
const upstreamKey = Deno.env.get("AIHUB_API_KEY");
const upstream = {
  base: Deno.env.get("AIHUB_BASE_URL") ?? "https://aihub.yavqo.com/api/v1",
  deployment: Deno.env.get("AIHUB_DEPLOYMENT") ?? "sunlighty-5cd7e4",
  key: upstreamKey ?? "",
};

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (!upstreamKey) {
    console.error("AIHUB_API_KEY is not set");
    return new Response(JSON.stringify({ error: { message: "Sunlight is not configured yet.", type: "unavailable", code: "unavailable" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  try {
    return await handle(req, {
      upstream,
      fetchUpstream: fetch,
      defer: (work) => (typeof EdgeRuntime !== "undefined" ? EdgeRuntime.waitUntil(work) : void work),
      async verifyUser(token) {
        const { data, error } = await admin.auth.getUser(token);
        if (error || !data.user) return null;
        const bannedUntil = (data.user as { banned_until?: string }).banned_until;
        if (bannedUntil && new Date(bannedUntil) > new Date()) return null;
        return { id: data.user.id };
      },
      async quotaStatus(userId) {
        const { data, error } = await admin.rpc("sunlight_quota_status", { p_user: userId });
        if (error) throw error;
        return data as Quota;
      },
      async quotaConsume(userId, tokens) {
        const { error } = await admin.rpc("sunlight_quota_consume", { p_user: userId, p_tokens: tokens });
        if (error) throw error;
      },
    });
  } catch (e) {
    console.error("unhandled", e);
    return new Response(JSON.stringify({ error: { message: "Something went wrong. Try again.", type: "server_error", code: "server_error" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
