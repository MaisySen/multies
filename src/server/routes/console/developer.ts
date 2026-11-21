/**
 * OPS1: /api/console/developer, Developer platform. Mounted by routes/console/index.ts.
 *
 * Reads (developer.read), each { items, nextCursor } with ?limit=&cursor=&sort=field:dir:
 *   GET /api-keys              ?q (name or prefix) &orgId &agentId                 sort createdAt|lastUsedAt|name
 *   GET /webhooks              ?q (URL or description) &orgId &enabled=true|false   sort createdAt|url
 *   GET /webhook-deliveries    ?status=failed (comma list; default failed) &orgId &endpointId &eventType
 *                              &days=1..90 (default 7) or &from &to                 sort createdAt
 *   GET /oauth-clients         ?q (name or site)                                    sort createdAt|name
 *   GET /oauth-grants          ?state=active|revoked|all (default active) &orgId &userId &clientId
 *                                                                                  sort createdAt|lastUsedAt
 * Changes (developer.manage, no step up), each { reason } and audited on the platform and in the workspace:
 *   POST /api-keys/:id/revoke                  developer.api_key_revoked     (deletes the key; permanent)
 *   POST /webhooks/:id/disable                 developer.webhook_disabled
 *   POST /webhooks/:id/enable                  developer.webhook_enabled
 *   POST /webhook-deliveries/:id/redeliver     developer.webhook_redelivered (also switches a disabled endpoint back on)
 *   POST /oauth-grants/:id/revoke              developer.oauth_grant_revoked (the app's tokens stop working)
 *
 * Never returned: API keys or their hashes, webhook signing secrets, payload values, OAuth codes, tokens or hashes.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context";
import { parseBody, parseQuery } from "../../middleware";
import { notFound } from "../../lib/errors";
import { operatorSession, requireOperator } from "../../auth/operator";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import { decodeCursor, encodeCursor } from "../../services/console/listing";
import type { Page, PageRequest } from "../../services/console/mail";
import {
  developerTargetOrg, listApiKeys, listOAuthClients, listOAuthGrants, listWebhookDeliveries, listWebhookEndpoints,
  redeliverWebhook, revokeApiKey, revokeOAuthGrant, setWebhookEndpointEnabled, type WebhookDeliveryStatus,
} from "../../services/console/developer";

const DAY = 86_400_000;
/** An optional id or text filter; empty means unset. */
const optText = z.string().trim().max(100).optional().transform((v) => v || undefined);
const optId = optText;
const date = z.string().max(40).optional().transform((v, ctx) => {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) { ctx.addIssue({ code: "custom", message: "Use a date like 2026-11-21." }); return z.NEVER; }
  return d;
});
const ReasonBody = z.object({ reason: reasonSchema });

/** ?limit, ?cursor and ?sort as the data layer's page request. A bad cursor is a 400; a bad sort field, the service's 400. */
function pageRequest(c: Context<AppEnv>, defaultSort: string): PageRequest {
  const q = c.req.query();
  const raw = Number.parseInt(q.limit ?? "", 10);
  const [field, dir] = (q.sort || defaultSort).split(":");
  const [defField, defDir] = defaultSort.split(":");
  const cur = q.cursor ? decodeCursor(q.cursor) : null;
  return {
    limit: Number.isFinite(raw) && raw > 0 ? raw : 50,
    cursor: cur ? { v: cur.sort instanceof Date ? cur.sort.getTime() : cur.sort, id: cur.id } : null,
    sort: { field: field || defField!, dir: dir === "asc" || dir === "desc" ? dir : (defDir as "asc" | "desc") },
  };
}

/** The :id in the path. Ids are short; anything else can't name a row (404). */
function targetParam(c: Context<AppEnv>): string {
  const v = (c.req.param("id") ?? "").trim();
  if (!v || v.length > 100) throw notFound("Item");
  return v;
}

/** A webhook URL's path can hold a token (Slack, Discord and Teams URLs are secrets), so only its origin leaves. */
export function urlOrigin(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

/** The data layer's { items, next } as the console's { items, nextCursor }. */
const listOut = <T,>(p: Page<T>) => ({ items: p.items, nextCursor: p.next ? encodeCursor(p.next.v, p.next.id) : null });

export function developerRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)

    // ------------------------------------------------------------ reads
    .get("/api-keys", requireOperator("developer.read"), async (c) => {
      const f = parseQuery(c, z.object({ q: optText, orgId: optId, agentId: optId }).passthrough());
      c.header("cache-control", "no-store");
      return c.json(listOut(await listApiKeys(c.var.deps, { q: f.q, orgId: f.orgId, agentId: f.agentId }, pageRequest(c, "createdAt:desc"))));
    })
    .get("/webhooks", requireOperator("developer.read"), async (c) => {
      const f = parseQuery(c, z.object({ q: optText, orgId: optId, enabled: z.enum(["true", "false", ""]).optional() }).passthrough());
      const enabled = f.enabled === "true" ? true : f.enabled === "false" ? false : undefined;
      c.header("cache-control", "no-store");
      const page = await listWebhookEndpoints(c.var.deps, { q: f.q, orgId: f.orgId, enabled }, pageRequest(c, "createdAt:desc"));
      return c.json(listOut({ ...page, items: page.items.map((e) => ({ ...e, url: urlOrigin(e.url) ?? "" })) }));
    })
    .get("/webhook-deliveries", requireOperator("developer.read"), async (c) => {
      const f = parseQuery(c, z.object({
        status: z.string().trim().max(60).optional(),
        orgId: optId, endpointId: optId, eventType: optText,
        days: z.coerce.number().int().min(1, "Pick 1 to 90 days.").max(90, "Pick 1 to 90 days.").optional(),
        from: date, to: date,
      }).passthrough());
      const status = f.status ? f.status.split(",").map((s) => s.trim()).filter(Boolean) as WebhookDeliveryStatus[] : undefined;
      const window = f.from || f.to ? { from: f.from, to: f.to }
        : f.days ? { from: new Date(c.var.deps.now().getTime() - f.days * DAY) } : undefined;
      c.header("cache-control", "no-store");
      const page = await listWebhookDeliveries(c.var.deps, {
        status, orgId: f.orgId, endpointId: f.endpointId, eventType: f.eventType, window,
      }, pageRequest(c, "createdAt:desc"));
      return c.json(listOut({ ...page, items: page.items.map((d) => ({ ...d, endpointUrl: urlOrigin(d.endpointUrl) })) }));
    })
    .get("/oauth-clients", requireOperator("developer.read"), async (c) => {
      const f = parseQuery(c, z.object({ q: optText }).passthrough());
      c.header("cache-control", "no-store");
      return c.json(listOut(await listOAuthClients(c.var.deps, { q: f.q }, pageRequest(c, "createdAt:desc"))));
    })
    .get("/oauth-grants", requireOperator("developer.read"), async (c) => {
      const f = parseQuery(c, z.object({ state: z.enum(["active", "revoked", "all", ""]).optional(), orgId: optId, userId: optId, clientId: optId }).passthrough());
      c.header("cache-control", "no-store");
      return c.json(listOut(await listOAuthGrants(c.var.deps, {
        state: f.state || undefined, orgId: f.orgId, userId: f.userId, clientId: f.clientId,
      }, pageRequest(c, "createdAt:desc"))));
    })

    // ------------------------------------------------------------ changes
    .post("/api-keys/:id/revoke", requireOperator("developer.manage"), async (c) => {
      const { reason } = await parseBody(c, ReasonBody);
      const keyId = targetParam(c);
      const orgId = await developerTargetOrg(c.var.deps, "apiKey", keyId);
      type R = Awaited<ReturnType<typeof revokeApiKey>>;
      await operatorAction(c, {
        action: "developer.api_key_revoked", targetType: "api_key", targetId: keyId, orgId, reason,
        before: (r: R) => ({ name: r.name, prefix: r.prefix }), after: { deleted: true }, workspaceAudit: true,
      }, () => revokeApiKey(c.var.deps, keyId));
      return c.json({ ok: true });
    })
    .post("/webhooks/:id/disable", requireOperator("developer.manage"), (c) => setEnabled(c, false))
    .post("/webhooks/:id/enable", requireOperator("developer.manage"), (c) => setEnabled(c, true))
    .post("/webhook-deliveries/:id/redeliver", requireOperator("developer.manage"), async (c) => {
      const { reason } = await parseBody(c, ReasonBody);
      const deliveryId = targetParam(c);
      const orgId = await developerTargetOrg(c.var.deps, "webhookDelivery", deliveryId);
      type R = Awaited<ReturnType<typeof redeliverWebhook>>;
      const out = await operatorAction(c, {
        action: "developer.webhook_redelivered", targetType: "webhook_delivery", targetId: deliveryId, orgId, reason,
        before: { status: "failed" }, after: (r: R) => ({ replayed: r.replayed, endpointId: r.endpointId, endpointEnabled: true }),
        metadata: { note: "Redelivery switches the endpoint back on if it was off." }, workspaceAudit: true,
      }, () => redeliverWebhook(c.var.deps, deliveryId));
      return c.json({ ok: true, replayed: out.replayed });
    })
    .post("/oauth-grants/:id/revoke", requireOperator("developer.manage"), async (c) => {
      const { reason } = await parseBody(c, ReasonBody);
      const grantId = targetParam(c);
      const orgId = await developerTargetOrg(c.var.deps, "oauthGrant", grantId);
      type R = Awaited<ReturnType<typeof revokeOAuthGrant>>;
      await operatorAction(c, {
        action: "developer.oauth_grant_revoked", targetType: "oauth_grant", targetId: grantId, orgId, reason,
        before: { revoked: false }, after: (r: R) => ({ revoked: true, clientId: r.clientId, userId: r.userId }), workspaceAudit: true,
      }, () => revokeOAuthGrant(c.var.deps, grantId));
      return c.json({ ok: true });
    });
}

async function setEnabled(c: Context<AppEnv>, enabled: boolean) {
  const { reason } = await parseBody(c, ReasonBody);
  const endpointId = targetParam(c);
  const orgId = await developerTargetOrg(c.var.deps, "webhookEndpoint", endpointId);
  type R = Awaited<ReturnType<typeof setWebhookEndpointEnabled>>;
  const out = await operatorAction(c, {
    action: enabled ? "developer.webhook_enabled" : "developer.webhook_disabled", targetType: "webhook_endpoint", targetId: endpointId, orgId, reason,
    before: (r: R) => r.before, after: (r: R) => ({ enabled: r.enabled, endpoint: urlOrigin(r.url) }), workspaceAudit: true,
  }, () => setWebhookEndpointEnabled(c.var.deps, endpointId, enabled));
  return c.json({ ok: true, enabled: out.enabled });
}
