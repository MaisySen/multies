/**
 * TD1 AI trust controls: GET /api/ai-trust (everyone in the workspace sees whether AI is on and which provider runs it),
 * PUT /api/ai-trust { enabled } (admins only). 404 while ASK_TD1 is off.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { aiTrustState, setAiTrust } from "../services/ai-trust-td1";
import { flagOnNow } from "../services/console/flag-gate"; // OPS1 feature flags

export function aiTrustRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { if (!flagOnNow(c, "askTd1")) throw new HttpError(404, "not_found", "Page not found."); c.header("Cache-Control", "private, no-store"); await next(); })
    .get("/", async (c) => c.json(await aiTrustState(c.var.deps, c.var.auth.orgId, c.var.auth.role)))
    .put("/", requireAdmin, async (c) => c.json(await setAiTrust(c.var.deps, c.var.auth, (await parseBody(c, z.object({ enabled: z.boolean() }))).enabled)));
}
