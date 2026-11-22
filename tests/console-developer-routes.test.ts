/**
 * OPS1: /api/console/developer. Lists page with nextCursor, filter and refuse a bad sort; every change needs a reason
 * and developer.manage (ops_admin and owners), and writes a platform audit row and the workspace's own row. Nothing
 * secret leaves: no API key, hash, signing secret, webhook URL path, payload value or OAuth code.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { apiKeys, auditLogs, oauthClients, oauthGrants, platformAuditLogs, webhookDeliveries, webhookEndpoints } from "@/server/db/schema";
import { newId } from "@/server/lib/crypto";
import { createApiKey } from "@/server/services/developer/api-keys";
import { createEndpoint } from "@/server/services/developer/webhooks";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Planted values: long markers nothing else can contain by chance. */
const PLANTED_PAYLOAD = "PLANTED-DEV-ROUTE-PAYLOAD-VALUE-k3Rf9Tq2Zx7Lm";
const PLANTED_PATH_TOKEN = "PLANTED-DEV-ROUTE-URL-TOKEN-w8Jd4Np6Vy1Hs";
const PLANTED_CODE_HASH = "PLANTED-DEV-ROUTE-CODE-HASH-b5Gt7Ke3Qu9Wa";
const PLANTED_REFRESH = "PLANTED-DEV-ROUTE-REFRESH-HASH-c2Xn8Mp4Rz6Yd";

let ctx: Ctx;
let owner: Client;
let opsAdmin: Client;
let support: Client;
let readonly: Client;
let customer: Client;
let customerId: string;
let orgA: string;
const posted: string[] = [];
const secrets: string[] = [];
const keyIds: string[] = [];
let endpointA: string;
let endpointB: string;
const failedIds: string[] = [];
let deliveredId: string;
let clientId: string;
const grantIds: string[] = [];

async function addDelivery(orgId: string, endpointId: string, status: "pending" | "delivered" | "failed", at: Date, eventType = "message.bounced") {
  const id = newId("msg");
  const payload = JSON.stringify({ type: eventType, data: { id: PLANTED_PAYLOAD, subject: PLANTED_PAYLOAD } });
  await ctx.db.insert(webhookDeliveries).values({ id, orgId, endpointId, eventType, payload, status, attempts: status === "failed" ? 6 : 1, lastError: status === "failed" ? "Receiver answered 500" : null, createdAt: at });
  return id;
}

beforeAll(async () => {
  ctx = await makeTestApp({}, { fetch: (async (url: string) => { posted.push(String(url)); return new Response("ok", { status: 200 }); }) as unknown as typeof fetch });
  owner = (await signUpAs(ctx, "owner@ops.test", "admin")).c;
  opsAdmin = (await signUpAs(ctx, "opsadmin@ops.test", "ops_admin")).c;
  support = (await signUpAs(ctx, "support@ops.test", "ops_support")).c;
  readonly = (await signUpAs(ctx, "readonly@ops.test", "ops_readonly")).c;
  const cust = await signUpAs(ctx, "dev@alpha.test", null, "Alpha Co");
  customer = cust.c;
  customerId = cust.id;
  orgA = (await customer.get("/api/account/me")).body.organization.id as string;

  for (const name of ["Zapier", "Backup script", "CI deploy"]) {
    const out = await createApiKey(ctx.deps, { orgId: orgA, userId: customerId }, { name, scope: "full" });
    secrets.push(out.secret);
    keyIds.push(out.apiKey.id);
  }
  const a = await createEndpoint(ctx.deps, orgA, { url: `https://hooks.alpha.example/in/${PLANTED_PATH_TOKEN}`, events: ["*"], description: "Alpha CRM" });
  const b = await createEndpoint(ctx.deps, orgA, { url: "https://hooks2.alpha.example/in", events: ["task.created"] });
  endpointA = a.endpoint.id;
  endpointB = b.endpoint.id;
  secrets.push(a.secret, b.secret);
  const now = Date.now();
  for (let i = 1; i <= 3; i++) failedIds.push(await addDelivery(orgA, endpointA, "failed", new Date(now - i * HOUR)));
  deliveredId = await addDelivery(orgA, endpointB, "delivered", new Date(now - HOUR), "task.created");
  await addDelivery(orgA, endpointA, "failed", new Date(now - 10 * DAY)); // outside the default 7 day window

  clientId = newId("oac");
  await ctx.db.insert(oauthClients).values({ id: clientId, name: "Claude", redirectUris: JSON.stringify(["https://claude.example/callback"]), createdAt: new Date(now - HOUR) });
  await ctx.db.insert(oauthClients).values({ id: newId("oac"), name: "Cursor", redirectUris: JSON.stringify(["https://cursor.example/callback"]), createdAt: new Date(now - 2 * HOUR) });
  for (let i = 0; i < 3; i++) {
    const id = newId("oag");
    const at = new Date(now - (i + 1) * HOUR);
    await ctx.db.insert(oauthGrants).values({
      id, clientId, orgId: orgA, userId: customerId, scope: "full", redirectUri: "https://claude.example/callback",
      codeHash: PLANTED_CODE_HASH, codeUsedAt: at, refreshHash: PLANTED_REFRESH, revokedAt: i === 2 ? at : null, createdAt: at,
    });
    grantIds.push(id);
  }
}, 120_000);

const noSecrets = (body: unknown) => {
  const json = JSON.stringify(body);
  for (const s of [...secrets, PLANTED_PAYLOAD, PLANTED_PATH_TOKEN, PLANTED_CODE_HASH, PLANTED_REFRESH, "keyHash", "secretEnc", "codeHash", "refreshHash"]) expect(json).not.toContain(s);
};

async function walk(c: Client, path: string) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await c.get(`${path}${sep}limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.length).toBeLessThanOrEqual(1);
    ids.push(...r.body.items.map((x: { id: string }) => x.id));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return ids;
}

describe("lists", () => {
  it("API keys: page by nextCursor, search, bad sort is 400, never the key", async () => {
    const r = await readonly.get("/api/console/developer/api-keys?sort=name:asc");
    expect(r.status).toBe(200);
    expect(r.body.items.map((k: { name: string }) => k.name)).toEqual(["Backup script", "CI deploy", "Zapier"]);
    expect(r.body.items[0]).toMatchObject({ orgId: orgA, orgName: "Alpha Co", createdByEmail: "dev@alpha.test", scope: "full" });
    expect(r.body.nextCursor).toBeNull();
    noSecrets(r.body);
    expect(new Set(await walk(readonly, "/api/console/developer/api-keys"))).toEqual(new Set(keyIds));
    expect((await readonly.get("/api/console/developer/api-keys?q=zap")).body.items.map((k: { id: string }) => k.id)).toEqual([keyIds[0]]);
    expect((await readonly.get(`/api/console/developer/api-keys?orgId=org_nobody`)).body.items).toEqual([]);
    expect((await readonly.get("/api/console/developer/api-keys?sort=keyHash:asc")).status).toBe(400);
    expect((await readonly.get("/api/console/developer/api-keys?cursor=not-a-cursor")).status).toBe(400);
  }, 60_000);

  it("webhook endpoints: only the address's origin, failure counts, enabled filter, paging, bad sort", async () => {
    const r = await readonly.get("/api/console/developer/webhooks?sort=createdAt:asc");
    expect(r.status).toBe(200);
    expect(new Set(r.body.items.map((e: { id: string }) => e.id))).toEqual(new Set([endpointA, endpointB]));
    expect(r.body.items.find((e: { id: string }) => e.id === endpointA)).toMatchObject({ url: "https://hooks.alpha.example", description: "Alpha CRM", enabled: true, recentFailures: 3, orgName: "Alpha Co" });
    noSecrets(r.body);
    expect(new Set(await walk(readonly, "/api/console/developer/webhooks?sort=createdAt:desc"))).toEqual(new Set([endpointB, endpointA]));
    expect((await readonly.get("/api/console/developer/webhooks?sort=url:asc")).status).toBe(400); // OPS1 security (M1)
    expect((await readonly.get("/api/console/developer/webhooks?enabled=false")).body.items).toEqual([]);
    expect((await readonly.get("/api/console/developer/webhooks?q=CRM")).body.items.map((e: { id: string }) => e.id)).toEqual([endpointA]);
    expect((await readonly.get("/api/console/developer/webhooks?sort=secretEnc:asc")).status).toBe(400);
    expect((await readonly.get("/api/console/developer/webhooks?enabled=maybe")).status).toBe(422);
  }, 60_000);

  it("webhook deliveries: failed in the last 7 days by default, field names only, status and window filters, paging", async () => {
    const r = await readonly.get("/api/console/developer/webhook-deliveries");
    expect(r.status).toBe(200);
    expect(r.body.items.map((d: { id: string }) => d.id)).toEqual(failedIds);
    expect(r.body.items[0]).toMatchObject({ status: "failed", attempts: 6, eventType: "message.bounced", endpointUrl: "https://hooks.alpha.example", payloadPreview: "message.bounced: id, subject", orgName: "Alpha Co" });
    noSecrets(r.body);
    expect(await walk(readonly, "/api/console/developer/webhook-deliveries")).toEqual(failedIds);
    expect((await readonly.get("/api/console/developer/webhook-deliveries?status=delivered")).body.items.map((d: { id: string }) => d.id)).toEqual([deliveredId]);
    expect((await readonly.get("/api/console/developer/webhook-deliveries?days=30")).body.items).toHaveLength(4);
    expect((await readonly.get(`/api/console/developer/webhook-deliveries?endpointId=${endpointB}&status=pending,delivered,failed`)).body.items).toHaveLength(1);
    expect((await readonly.get("/api/console/developer/webhook-deliveries?status=dead")).status).toBe(400);
    expect((await readonly.get("/api/console/developer/webhook-deliveries?days=365")).status).toBe(422);
    expect((await readonly.get("/api/console/developer/webhook-deliveries?sort=payload:desc")).status).toBe(400);
  }, 60_000);

  it("OAuth clients and grants: search, state filter, paging, bad sort, no codes or tokens", async () => {
    const cl = await readonly.get("/api/console/developer/oauth-clients?sort=name:asc");
    expect(cl.status).toBe(200);
    expect(cl.body.items.map((x: { name: string }) => x.name)).toEqual(["Claude", "Cursor"]);
    expect((await readonly.get("/api/console/developer/oauth-clients?q=curs")).body.items.map((x: { name: string }) => x.name)).toEqual(["Cursor"]);
    expect(await walk(readonly, "/api/console/developer/oauth-clients?sort=name:desc")).toHaveLength(2);
    expect((await readonly.get("/api/console/developer/oauth-clients?sort=redirectUris:asc")).status).toBe(400);

    const g = await readonly.get("/api/console/developer/oauth-grants");
    expect(g.status).toBe(200);
    expect(g.body.items.map((x: { id: string }) => x.id)).toEqual(grantIds.slice(0, 2));
    expect(g.body.items[0]).toMatchObject({ clientName: "Claude", userEmail: "dev@alpha.test", orgName: "Alpha Co", revokedAt: null });
    noSecrets((await readonly.get("/api/console/developer/oauth-grants?state=all")).body);
    expect((await readonly.get("/api/console/developer/oauth-grants?state=revoked")).body.items.map((x: { id: string }) => x.id)).toEqual([grantIds[2]]);
    expect(await walk(readonly, "/api/console/developer/oauth-grants?state=all")).toEqual(grantIds);
    expect((await readonly.get("/api/console/developer/oauth-grants?state=gone")).status).toBe(422);
    expect((await readonly.get("/api/console/developer/oauth-grants?sort=refreshHash:asc")).status).toBe(400);
  }, 60_000);

  it("name each workspace's owner, and say when a list looked at recent rows only", async () => {
    const keys = await readonly.get("/api/console/developer/api-keys");
    expect(keys.body.items[0]).toMatchObject({ orgId: orgA, ownerEmail: "dev@alpha.test" });
    expect((await readonly.get("/api/console/developer/webhooks")).body.items.find((e: { orgId: string }) => e.orgId === orgA)).toMatchObject({ ownerEmail: "dev@alpha.test" });
    const failed = await readonly.get("/api/console/developer/webhook-deliveries");
    expect(failed.body.items[0]).toMatchObject({ ownerEmail: "dev@alpha.test" });
    expect(failed.body.recentOnly).toBeUndefined();
    expect((await readonly.get("/api/console/developer/webhook-deliveries?status=delivered")).body.recentOnly).toBe(true);
    expect((await readonly.get(`/api/console/developer/webhook-deliveries?status=delivered&orgId=${orgA}`)).body.recentOnly).toBeUndefined();
    const grants = await readonly.get("/api/console/developer/oauth-grants");
    expect(grants.body.items[0]).toMatchObject({ ownerEmail: "dev@alpha.test" });
    expect(grants.body.recentOnly).toBe(true);
    expect((await readonly.get(`/api/console/developer/oauth-grants?orgId=${orgA}`)).body.recentOnly).toBeUndefined();
    expect((await readonly.get("/api/console/developer/oauth-clients")).body.recentOnly).toBe(true);
  }, 60_000);

  it("non operators get 401 or 403", async () => {
    for (const p of ["api-keys", "webhooks", "webhook-deliveries", "oauth-clients", "oauth-grants"]) {
      expect((await new Client(ctx.app).get(`/api/console/developer/${p}`)).status).toBe(401);
      expect((await customer.get(`/api/console/developer/${p}`)).status).toBe(403);
    }
  }, 60_000);
});

async function auditRow(action: string, targetId: string) {
  return ctx.db.select().from(platformAuditLogs).where(and(eq(platformAuditLogs.action, action), eq(platformAuditLogs.targetId, targetId))).get();
}
async function workspaceRow(action: string, targetId: string) {
  return ctx.db.select().from(auditLogs).where(and(eq(auditLogs.action, action), eq(auditLogs.targetId, targetId), eq(auditLogs.orgId, orgA))).get();
}

describe("changes", () => {
  it("revoke an API key: reason required, support and read only refused, audited, the key stops working", async () => {
    const id = keyIds[2]!;
    const path = `/api/console/developer/api-keys/${id}/revoke`;
    expect((await owner.post(path, {})).status).toBe(422);
    expect((await owner.post(path, { reason: "x" })).status).toBe(422);
    for (const c of [support, readonly, customer]) expect((await c.post(path, { reason: "Leaked in a public repo" })).status).toBe(403);
    expect((await new Client(ctx.app).post(path, { reason: "Leaked in a public repo" })).status).toBe(401);
    const ok = await new Client(ctx.app).call("GET", "/api/v1/mailboxes", undefined, { authorization: `Bearer ${secrets[2]}` });
    expect(ok.status).toBe(200);

    const r = await opsAdmin.post(path, { reason: "Leaked in a public repo" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await ctx.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()).toBeUndefined();
    const refused = await new Client(ctx.app).call("GET", "/api/v1/mailboxes", undefined, { authorization: `Bearer ${secrets[2]}` });
    expect(refused.status).toBe(401);
    const row = await auditRow("developer.api_key_revoked", id);
    expect(row).toMatchObject({ actorEmail: "opsadmin@ops.test", actorRole: "ops_admin", targetType: "api_key", orgId: orgA, reason: "Leaked in a public repo" });
    expect(JSON.parse(row!.before!)).toMatchObject({ name: "CI deploy" });
    noSecrets(row);
    expect(await workspaceRow("developer.api_key_revoked", id)).toBeTruthy();
    expect((await owner.post(path, { reason: "Again" })).status).toBe(404);
  }, 60_000);

  it("disable and enable a webhook endpoint", async () => {
    const off = `/api/console/developer/webhooks/${endpointB}/disable`;
    const on = `/api/console/developer/webhooks/${endpointB}/enable`;
    expect((await owner.post(off, {})).status).toBe(422);
    expect((await support.post(off, { reason: "Receiver is down" })).status).toBe(403);
    const r = await owner.post(off, { reason: "Receiver is down" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, enabled: false });
    expect((await ctx.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointB)).get())!.enabled).toBe(false);
    const row = await auditRow("developer.webhook_disabled", endpointB);
    expect(row).toMatchObject({ actorRole: "admin", targetType: "webhook_endpoint", orgId: orgA, reason: "Receiver is down" });
    expect(JSON.parse(row!.before!)).toEqual({ enabled: true });
    expect(JSON.parse(row!.after!)).toEqual({ enabled: false, endpoint: "https://hooks2.alpha.example" });
    expect(await workspaceRow("developer.webhook_disabled", endpointB)).toBeTruthy();

    expect((await readonly.post(on, { reason: "Receiver is back" })).status).toBe(403);
    expect((await owner.post(on, { reason: "Receiver is back" })).body).toMatchObject({ ok: true, enabled: true });
    expect(await auditRow("developer.webhook_enabled", endpointB)).toMatchObject({ reason: "Receiver is back" });
    expect((await owner.post("/api/console/developer/webhooks/whe_missing/enable", { reason: "Receiver is back" })).status).toBe(404);
  }, 60_000);

  it("redeliver a failed delivery (and it switches a disabled endpoint back on)", async () => {
    await ctx.db.update(webhookEndpoints).set({ enabled: false, disabledReason: "Disabled after 5 failures" }).where(eq(webhookEndpoints.id, endpointA));
    const id = failedIds[0]!;
    const path = `/api/console/developer/webhook-deliveries/${id}/redeliver`;
    expect((await opsAdmin.post(path, {})).status).toBe(422);
    expect((await support.post(path, { reason: "Customer fixed their server" })).status).toBe(403);
    const r = await opsAdmin.post(path, { reason: "Customer fixed their server" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, replayed: 1 });
    expect(posted).toContain(`https://hooks.alpha.example/in/${PLANTED_PATH_TOKEN}`);
    expect((await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).get())!.status).toBe("delivered");
    expect((await ctx.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointA)).get())!.enabled).toBe(true);
    const row = await auditRow("developer.webhook_redelivered", id);
    expect(row).toMatchObject({ targetType: "webhook_delivery", orgId: orgA, reason: "Customer fixed their server" });
    noSecrets(row);
    expect(await workspaceRow("developer.webhook_redelivered", id)).toBeTruthy();
    // Only a failed delivery can be sent again; unknown ids are 404.
    expect((await opsAdmin.post(`/api/console/developer/webhook-deliveries/${deliveredId}/redeliver`, { reason: "Try it" })).status).toBe(400);
    expect((await opsAdmin.post("/api/console/developer/webhook-deliveries/msg_missing/redeliver", { reason: "Try it" })).status).toBe(404);
  }, 60_000);

  it("revoke an OAuth grant", async () => {
    const id = grantIds[0]!;
    const path = `/api/console/developer/oauth-grants/${id}/revoke`;
    expect((await owner.post(path, { reason: "  " })).status).toBe(422);
    expect((await support.post(path, { reason: "Account taken over" })).status).toBe(403);
    expect((await customer.post(path, { reason: "Account taken over" })).status).toBe(403);
    const r = await owner.post(path, { reason: "Account taken over" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const g = await ctx.db.select().from(oauthGrants).where(eq(oauthGrants.id, id)).get();
    expect(g!.revokedAt).not.toBeNull();
    expect(g!.refreshHash).toBeNull();
    const row = await auditRow("developer.oauth_grant_revoked", id);
    expect(row).toMatchObject({ targetType: "oauth_grant", orgId: orgA, reason: "Account taken over", actorEmail: "owner@ops.test" });
    noSecrets(row);
    expect(await workspaceRow("developer.oauth_grant_revoked", id)).toBeTruthy();
    expect((await owner.post("/api/console/developer/oauth-grants/oag_missing/revoke", { reason: "Account taken over" })).status).toBe(404);
  }, 60_000);
});
