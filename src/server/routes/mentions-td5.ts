/**
 * TD5 mentions (flag MENTIONS_TD5): /api/mentions. Signed in workspace members only (sessions; project guests, portal
 * users, keys and agents get 404); vv8k and MENTIONS_EXCLUDE answer 404. Reads only, rate limited per person, never
 * cached. Every answer is resolved for the caller: a record they cannot open comes back as "restricted" with no title.
 */
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { assertMentionsOpen, listReferences, resolveRefs, searchMentions } from "../services/mentions-td5";
import { isRefType, parseRefKey, RESOLVE_MAX, type RecordRef } from "../../shared/mentions-td5";

export function mentionsRoutes() {
  const reads = new RateLimiter(600, 5 * 60_000); // per person: a busy typist stays far below; a scraper does not
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => {
      if (c.var.apiKeyOrg) throw new HttpError(404, "not_found", "Page not found.");
      await assertMentionsOpen(c.var.deps, c.var.auth);
      if (!reads.take(`${c.var.auth.orgId}:${c.var.auth.userId}`)) throw new HttpError(429, "rate_limited", "Too many requests. Wait a minute and try again.");
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .get("/search", async (c) => c.json(await searchMentions(c.var.deps, c.var.auth, c.req.query("q") ?? "", Number(c.req.query("limit") ?? 12))))
    .post("/resolve", async (c) => {
      const b = (await c.req.json().catch(() => null)) as { refs?: unknown } | null;
      const raw = Array.isArray(b?.refs) ? b!.refs : null;
      if (!raw) throw new HttpError(422, "invalid", "Send refs as a list.");
      if (raw.length > RESOLVE_MAX) throw new HttpError(422, "too_many", `At most ${RESOLVE_MAX} at a time.`);
      const refs = raw.map(parseRefKey).filter((r): r is RecordRef => !!r);
      const map = await resolveRefs(c.var.deps, c.var.auth, refs);
      return c.json({ items: Object.fromEntries(map) });
    })
    .get("/refs/:type/:id", async (c) => {
      const type = c.req.param("type");
      const ref = isRefType(type) && type !== "thread" ? parseRefKey(`${type}:${c.req.param("id")}`) : null;
      if (!ref) throw new HttpError(404, "not_found", "Page not found.");
      const dir = c.req.query("dir") === "out" ? "out" : "in";
      return c.json(await listReferences(c.var.deps, c.var.auth, ref, dir, c.req.query("cursor") ?? undefined));
    });
}
