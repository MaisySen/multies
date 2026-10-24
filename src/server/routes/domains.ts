import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { createDomainSchema } from "@/shared/schemas";
import { audit } from "../services/audit";
import { createDomain, deleteDomain, getDomain, listDomains, presentDomain, setCatchAll, verifyDomain } from "../services/domains";
import { RateLimiter } from "../lib/rate-limit";
import { tooMany } from "../lib/errors";

export function domainRoutes() {
  const verifyLimiter = new RateLimiter(20, 60_000);
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const rows = await listDomains(c.var.deps.db, c.var.auth.orgId);
      return c.json({ domains: rows.map(({ row, counts }) => presentDomain(row, c.var.deps, counts)) });
    })
    .post("/", requireAdmin, async (c) => {
      const { name } = await parseBody(c, createDomainSchema);
      const { auth, deps } = c.var;
      const d = await createDomain(deps, auth.orgId, name);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "domain.added", targetType: "domain", targetId: d.id, metadata: { name }, ip: c.var.ip });
      // First check right away: some people add DNS before they add the domain.
      const { report, status } = await verifyDomain(deps, d);
      return c.json({ domain: presentDomain({ ...d, status, lastCheck: JSON.stringify(report), lastCheckedAt: new Date(report.checkedAt) }, deps) }, 201);
    })
    .get("/:id", async (c) => {
      const d = await getDomain(c.var.deps.db, c.var.auth.orgId, c.req.param("id"));
      return c.json({ domain: presentDomain(d, c.var.deps) });
    })
    .post("/:id/verify", async (c) => {
      const { auth, deps } = c.var;
      if (!verifyLimiter.take(auth.orgId)) throw tooMany("Checking too often. DNS needs a moment. Try again shortly.");
      const d = await getDomain(deps.db, auth.orgId, c.req.param("id"));
      const { report, status, changed } = await verifyDomain(deps, d);
      if (changed) {
        await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: `domain.${status}`, targetType: "domain", targetId: d.id, metadata: { name: d.name }, ip: c.var.ip });
      }
      const fresh = await getDomain(deps.db, auth.orgId, d.id);
      return c.json({ domain: presentDomain(fresh, deps), report });
    })
    .patch("/:id", requireAdmin, async (c) => {
      const { catchAllMailboxId } = await parseBody(c, z.object({ catchAllMailboxId: z.string().nullable() }));
      const { auth, deps } = c.var;
      const d = await setCatchAll(deps.db, auth.orgId, c.req.param("id"), catchAllMailboxId);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "domain.catch_all_changed", targetType: "domain", targetId: d.id, metadata: { catchAllMailboxId }, ip: c.var.ip });
      return c.json({ domain: presentDomain(d, deps) });
    })
    .delete("/:id", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      const d = await deleteDomain(deps.db, auth.orgId, c.req.param("id"), deps);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "domain.removed", targetType: "domain", targetId: d.id, metadata: { name: d.name }, ip: c.var.ip });
      return c.json({ ok: true });
    });
}
