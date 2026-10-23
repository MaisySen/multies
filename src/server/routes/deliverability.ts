import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { emailSchema } from "@/shared/schemas";
import { audit } from "../services/audit";
import { fromB64 } from "../lib/crypto";
import { HttpError, badRequest } from "../lib/errors";
import { dmarcSummary, parseDmarcReport, storeDmarcReport } from "../services/deliverability/dmarc";
import { workspaceHealth } from "../services/deliverability/health";
import { handleResendEvent, verifyResendWebhook } from "../services/deliverability/resend-events";
import { listSuppressions, suppress, unsuppress } from "../services/deliverability/suppressions";

export function deliverabilityRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/health", async (c) => c.json({ domains: await workspaceHealth(c.var.deps, c.var.auth.orgId) }))
    .get("/suppressions", async (c) => c.json({ suppressions: await listSuppressions(c.var.deps.db, c.var.auth.orgId) }))
    .post("/suppressions", requireAdmin, async (c) => {
      const { address, note } = await parseBody(c, z.object({ address: emailSchema, note: z.string().trim().max(200).optional() }));
      const { auth, deps } = c.var;
      const id = await suppress(deps.db, auth.orgId, address, "manual", note);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "suppression.added", targetType: "suppression", targetId: id, metadata: { address }, ip: c.var.ip });
      return c.json({ id }, 201);
    })
    .delete("/suppressions/:id", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      const row = await unsuppress(deps.db, auth.orgId, c.req.param("id"));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "suppression.removed", targetType: "suppression", targetId: row.id, metadata: { address: row.address, reason: row.reason }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .get("/dmarc", async (c) => c.json(await dmarcSummary(c.var.deps, c.var.auth.orgId)))
    .post("/dmarc/reports", requireAdmin, async (c) => {
      const { contentB64 } = await parseBody(c, z.object({ filename: z.string().max(255).optional(), contentB64: z.string().min(1).max(14_000_000) }));
      let bytes: Uint8Array;
      try { bytes = fromB64(contentB64); } catch { throw badRequest("The file could not be read."); }
      const report = parseDmarcReport(bytes);
      const out = await storeDmarcReport(c.var.deps, c.var.auth.orgId, report);
      return c.json({ ...out, domain: report.domain, reporter: report.reporter, messages: report.rows.reduce((n, r) => n + r.count, 0) }, out.duplicate ? 200 : 201);
    });
}

/** Delivery events from the outbound provider. Signed; no cookie auth. */
export function resendWebhookRoutes() {
  return new Hono<AppEnv>().post("/", async (c) => {
    const secret = c.var.deps.config.outbound.resendWebhookSecret;
    if (!secret) throw new HttpError(404, "not_found", "No such endpoint.");
    const body = await c.req.text();
    const event = verifyResendWebhook(secret, body, c.req.raw.headers);
    const result = await handleResendEvent(c.var.deps, event);
    return c.json({ ok: true, ...result });
  });
}
