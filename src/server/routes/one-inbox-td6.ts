/**
 * TD6 One inbox (flag INBOX_TD6): /api/one-inbox. Signed in workspace members by session only (API keys answer 404);
 * flag off or the vv8k workspace answer 404. Every item is checked in the service (owner, workspace, mailbox scope).
 * Never cached; writes rate limited per person; nothing about an item is logged.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { act, assertInboxOpen, deleteRule, inboxCount, listInbox, listRules, moveItem } from "../services/inbox-td6";

const body = async (c: Context<AppEnv>) => {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return (b && typeof b === "object" && !Array.isArray(b) ? b : {}) as Record<string, unknown>;
};

export function oneInboxRoutes() {
  const writes = new RateLimiter(300, 15 * 60_000);
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => {
      if (c.var.apiKeyOrg) throw new HttpError(404, "not_found", "Page not found.");
      await assertInboxOpen(c.var.deps, c.var.auth);
      if (c.req.method !== "GET" && !writes.take(`${c.var.auth.orgId}:${c.var.auth.userId}`)) throw new HttpError(429, "rate_limited", "Too many changes. Wait a few minutes and try again.");
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .get("/", async (c) => c.json(await listInbox(c.var.deps, c.var.auth, { lane: c.req.query("lane"), view: c.req.query("view"), source: c.req.query("source") })))
    .get("/count", async (c) => c.json(await inboxCount(c.var.deps, c.var.auth)))
    .post("/act", async (c) => c.json(await act(c.var.deps, c.var.auth, await body(c))))
    .post("/move", async (c) => c.json(await moveItem(c.var.deps, c.var.auth, await body(c))))
    .get("/rules", async (c) => c.json({ rules: await listRules(c.var.deps, c.var.auth) }))
    .delete("/rules", async (c) => c.json(await deleteRule(c.var.deps, c.var.auth, (await body(c)).key)));
}
