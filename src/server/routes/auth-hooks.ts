import { Hono } from "hono";
import type { AppEnv } from "../context";
import { handleSupabaseHook } from "../services/mail/auth-email-hooks";

/** POST /api/auth-hooks/supabase/:id, called by Supabase Auth. Signed with the hook secret; no session or key. */
export function authHookWebhookRoutes() {
  return new Hono<AppEnv>().post("/supabase/:id", async (c) => {
    const body = await c.req.text();
    if (body.length > 64_000) return c.json({ error: { http_code: 413, message: "Too large." } }, 413);
    const r = await handleSupabaseHook(c.var.deps, c.req.param("id"), body, c.req.raw.headers);
    return c.json(r.body as Record<string, unknown>, r.status);
  });
}
