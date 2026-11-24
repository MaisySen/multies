import { Hono } from "hono";
import type { AppEnv, Deps } from "../context";
import { requireAdmin, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import { parseMime, untrustedAuthResults } from "../services/mail/mime";
import { deliverInbound } from "../services/mail/delivery";
import { sha256Hex } from "../lib/crypto";
import { firstReceipt, releaseReceipt } from "../lib/webhook-receipts";
import { createInboundKey, deleteInboundKey, isPlatformInboundKey, listInboundKeys, verifyInboundSignature } from "../services/mail/inbound-keys";

/**
 * POST /api/inbound/cloudflare is called by the Cloudflare Email Worker in
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
    // Round 2: a signed delivery replayed inside its 5 minute window is answered as delivered and stored once. The
    // Email Worker signs each attempt afresh, so the id is the key, timestamp and signature. A failure that asks for a
    // retry forgets it.
    const receipt = await sha256Hex(`${verified.keyId}\n${c.req.header("x-mymail-timestamp")}\n${(c.req.header("x-mymail-signature") ?? "").toLowerCase()}`);
    if (!(await firstReceipt(deps.db, "cloudflare_inbound", receipt, deps.now()))) return c.json({ action: "accept", code: 250, reason: "Already delivered." }, 200);
    try {
      const out = await deliverSigned(deps, body, from, to, verified.orgId);
      if (out.body.action === "retry") await releaseReceipt(deps.db, "cloudflare_inbound", receipt);
      return c.json(out.body, out.status);
    } catch (err) {
      await releaseReceipt(deps.db, "cloudflare_inbound", receipt);
      throw err;
    }
  });
}

/** A verified delivery from the Email Worker: parse, authenticate and deliver. The answer tells the worker what to do. */
async function deliverSigned(deps: Deps, body: Uint8Array<ArrayBuffer>, from: string, to: string, orgId: string): Promise<{ body: { action: "accept" | "retry" | "reject"; code: number; reason?: string }; status: 200 | 422 | 503 }> {
  let email;
  try {
    email = await parseMime(body);
  } catch {
    return { body: { action: "reject", code: 550, reason: "Unparseable message." }, status: 422 };
  }
  // PRIV1b (P38): a workspace's key can sign any bytes, so its Authentication-Results headers prove nothing. Only
  // the platform's own worker (mail from Cloudflare) or our own authenticator can say pass.
  if (!isPlatformInboundKey(deps, orgId)) email.authResults = untrustedAuthResults(email.authResults);
  if (deps.authenticate) {
    try {
      const verdict = await deps.authenticate(body, { sender: from });
      // Keep the MTA's SPF verdict: only it saw the connecting IP.
      email.authResults = { ...email.authResults, ...verdict.results, spf: verdict.results.spf ?? email.authResults.spf };
    } catch (err) {
      deps.reportError?.(err, { where: "inbound.authenticate" });
    }
  }
  const result = await deliverInbound(deps, { envelopeFrom: from, rcptTo: to, email, sizeBytes: body.byteLength, via: "cloudflare", requireOrgId: orgId, raw: body });
  const action = result.accepted ? "accept" : result.code === 450 ? "retry" : "reject";
  return { body: { action, code: result.code, reason: result.reason }, status: result.accepted ? 200 : result.code === 450 ? 503 : 200 };
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
