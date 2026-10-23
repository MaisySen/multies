import { Hono } from "hono";
import type { AppEnv } from "../context";
import { requireAdmin, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import { parseMime } from "../services/mail/mime";
import { deliverInbound } from "../services/mail/delivery";
import { createInboundKey, deleteInboundKey, listInboundKeys, verifyInboundSignature } from "../services/mail/inbound-keys";

/**
 * POST /api/inbound/cloudflare — called by the Cloudflare Email Worker in
 * email-worker/ for every message Email Routing hands it. The raw RFC 5322 message
 * is the body; envelope and HMAC signature travel in headers. The response's
 * `action` tells the worker whether to accept or reject (bounce) the message.
 */
export function inboundWebhookRoutes() {
  return new Hono<AppEnv>().post("/cloudflare", async (c) => {
    const { deps } = c.var;
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > deps.config.maxMessageBytes) {
      return c.json({ action: "reject", code: 552, reason: "Message too large." }, 413);
    }
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > deps.config.maxMessageBytes) {
      return c.json({ action: "reject", code: 552, reason: "Message too large." }, 413);
    }
    const from = c.req.header("x-mymail-envelope-from") ?? "";
    const to = c.req.header("x-mymail-envelope-to") ?? "";
    const verified = await verifyInboundSignature(deps, {
      keyId: c.req.header("x-mymail-key"),
      ts: c.req.header("x-mymail-timestamp"),
      signature: c.req.header("x-mymail-signature"),
      from,
      to,
    }, body);
    if (!verified.ok) return c.json({ action: "retry", code: 401, reason: verified.reason }, 401);

    let email;
    try {
      email = await parseMime(body);
    } catch {
      return c.json({ action: "reject", code: 550, reason: "Unparseable message." }, 422);
    }
    const result = await deliverInbound(deps, { envelopeFrom: from, rcptTo: to, email, sizeBytes: body.byteLength, via: "cloudflare", requireOrgId: verified.orgId });
    const action = result.accepted ? "accept" : result.code === 450 ? "retry" : "reject";
    return c.json({ action, code: result.code, reason: result.reason }, result.accepted ? 200 : result.code === 450 ? 503 : 200);
  });
}

export function inboundKeyRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ keys: await listInboundKeys(c.var.deps, c.var.auth.orgId) }))
    .post("/", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      const key = await createInboundKey(deps, auth.orgId);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "inbound_key.created", targetType: "inbound_key", targetId: key.id, ip: c.var.ip });
      return c.json({ key, webhookUrl: `${deps.config.appUrl}/api/inbound/cloudflare` }, 201);
    })
    .delete("/:id", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      await deleteInboundKey(deps, auth.orgId, c.req.param("id"));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "inbound_key.revoked", targetType: "inbound_key", targetId: c.req.param("id"), ip: c.var.ip });
      return c.json({ ok: true });
    });
}
