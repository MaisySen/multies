import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { apiKeys, oauthClients, oauthGrants, users, webhookDeliveries, webhookEndpoints } from "@/server/db/schema";
import { newId } from "@/server/lib/crypto";
import { createApiKey } from "@/server/services/developer/api-keys";
import { createEndpoint } from "@/server/services/developer/webhooks";
import type { Page, PageCursor, PageRequest } from "@/server/services/console/mail";
import {
  API_KEY_SORT_FIELDS, OAUTH_CLIENT_SORT_FIELDS, OAUTH_GRANT_SORT_FIELDS, WEBHOOK_DELIVERY_SORT_FIELDS, WEBHOOK_ENDPOINT_SORT_FIELDS,
  listApiKeys, listOAuthClients, listOAuthGrants, listWebhookDeliveries, listWebhookEndpoints,
  redeliverWebhook, revokeApiKey, revokeOAuthGrant, setWebhookEndpointEnabled,
} from "@/server/services/console/developer";

/** OPS1: the console's Developer platform data layer, called directly over real data in two workspaces. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let orgA: string;
let orgB: string;
let userA: string;
let userB: string;
const posted: string[] = [];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function workspace(email: string, name: string) {
  const c = new Client(ctx.app);
  await c.signup(email, "Someone", name);
  const orgId = (await c.get("/api/account/me")).body.organization.id as string;
  const userId = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!.id;
  return { orgId, userId };
}

beforeEach(async () => {
  posted.length = 0;
  // Webhook receivers answer 200, so a redelivery can succeed.
  ctx = await makeTestApp({}, { fetch: (async (url: string) => { posted.push(String(url)); return new Response("ok", { status: 200 }); }) as unknown as typeof fetch });
  ({ orgId: orgA, userId: userA } = await workspace("a@alpha.io", "Alpha Co"));
  ({ orgId: orgB, userId: userB } = await workspace("b@beta.io", "Beta Co"));
});

const page = (field: string, dir: "asc" | "desc" = "desc", limit = 50, cursor: PageCursor | null = null): PageRequest => ({ limit, cursor, sort: { field, dir } });

async function walk<T extends { id: string }>(fn: (p: PageRequest) => Promise<Page<T>>, field: string, dir: "asc" | "desc", limit: number) {
  const ids: string[] = [];
  let cursor: PageCursor | null = null;
  for (let i = 0; i < 50; i++) {
    const p: Page<T> = await fn(page(field, dir, limit, cursor));
    expect(p.items.length).toBeLessThanOrEqual(limit);
    ids.push(...p.items.map((x) => x.id));
    if (!p.next) break;
    cursor = p.next;
  }
  return ids;
}

describe("API keys", () => {
  it("lists keys across workspaces without the key or its hash, filters, pages, and revokes one", async () => {
    const made: { id: string; secret: string }[] = [];
    for (const [orgId, userId, name] of [[orgA, userA, "Zapier"], [orgA, userA, "Backup script"], [orgB, userB, "CI deploy"]] as const) {
      const out = await createApiKey(ctx.deps, { orgId, userId }, { name, scope: "full" });
      made.push({ id: out.apiKey.id, secret: out.secret });
    }
    const all = await listApiKeys(ctx.deps, {}, page("name", "asc"));
    expect(all.items.map((k) => k.name)).toEqual(["Backup script", "CI deploy", "Zapier"]);
    expect(all.items[1]).toMatchObject({ orgId: orgB, orgName: "Beta Co", createdByEmail: "b@beta.io", scope: "full", lastUsedAt: null });
    const json = JSON.stringify(all);
    const hashes = (await ctx.db.select().from(apiKeys)).map((k) => k.keyHash);
    for (const s of [...made.map((m) => m.secret), ...hashes, "keyHash"]) expect(json).not.toContain(s);
    expect(all.items[0]!.prefix).toBe(made[1]!.secret.slice(0, 12));

    expect((await listApiKeys(ctx.deps, { orgId: orgA }, page("createdAt"))).items).toHaveLength(2);
    expect((await listApiKeys(ctx.deps, { q: "zap" }, page("createdAt"))).items.map((k) => k.id)).toEqual([made[0]!.id]);
    expect((await listApiKeys(ctx.deps, { q: made[2]!.secret.slice(0, 12) }, page("createdAt"))).items.map((k) => k.id)).toEqual([made[2]!.id]);
    const walked = await walk((p) => listApiKeys(ctx.deps, {}, p), "lastUsedAt", "desc", 2);
    expect(new Set(walked)).toEqual(new Set(made.map((m) => m.id)));
    expect(walked).toHaveLength(3);
    expect(API_KEY_SORT_FIELDS).toEqual(["createdAt", "lastUsedAt", "name"]);
    await expect(listApiKeys(ctx.deps, {}, page("keyHash"))).rejects.toMatchObject({ status: 400 });
    await expect(listApiKeys(ctx.deps, {}, page("name", "asc", 10, { v: 5, id: "x" }))).rejects.toMatchObject({ status: 400 });

    // The revoked key stops working at once.
    const ok = await new Client(ctx.app).call("GET", "/api/v1/mailboxes", undefined, { authorization: `Bearer ${made[2]!.secret}` });
    expect(ok.status).toBe(200);
    expect(await revokeApiKey(ctx.deps, made[2]!.id)).toMatchObject({ id: made[2]!.id, orgId: orgB, name: "CI deploy" });
    expect(await ctx.db.select().from(apiKeys).where(eq(apiKeys.id, made[2]!.id)).get()).toBeUndefined();
    const refused = await new Client(ctx.app).call("GET", "/api/v1/mailboxes", undefined, { authorization: `Bearer ${made[2]!.secret}` });
    expect(refused.status).toBe(401);
    await expect(revokeApiKey(ctx.deps, made[2]!.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("webhooks", () => {
  async function addDelivery(orgId: string, endpointId: string, status: "pending" | "delivered" | "failed", at: Date, eventType = "message.bounced") {
    const id = newId("msg");
    const payload = JSON.stringify({ type: eventType, timestamp: at.toISOString(), data: { id: "msg_1", to: "private@customer.example", subject: "Very private subject" } });
    await ctx.db.insert(webhookDeliveries).values({ id, orgId, endpointId, eventType, payload, status, attempts: status === "failed" ? 6 : 1, lastError: status === "failed" ? "Receiver answered 500" : null, createdAt: at });
    return id;
  }

  it("lists endpoints with recent failure counts and no signing secret, filters, pages, and switches one off and on", async () => {
    const a = await createEndpoint(ctx.deps, orgA, { url: "https://hooks.alpha.example/in", events: ["*"], description: "Alpha CRM" });
    const b = await createEndpoint(ctx.deps, orgB, { url: "https://hooks.beta.example/in", events: ["message.received", "task.created"] });
    const now = Date.now();
    await addDelivery(orgA, a.endpoint.id, "failed", new Date(now - HOUR));
    await addDelivery(orgA, a.endpoint.id, "failed", new Date(now - 2 * HOUR));
    await addDelivery(orgA, a.endpoint.id, "failed", new Date(now - 10 * DAY)); // outside the window
    await addDelivery(orgA, a.endpoint.id, "delivered", new Date(now - HOUR));
    await addDelivery(orgB, b.endpoint.id, "pending", new Date(now - HOUR));

    const all = await listWebhookEndpoints(ctx.deps, {}, page("url", "asc"));
    expect(all.items.map((e) => e.id)).toEqual([a.endpoint.id, b.endpoint.id]);
    expect(all.items[0]).toMatchObject({ orgId: orgA, orgName: "Alpha Co", events: ["*"], enabled: true, recentFailures: 2, consecutiveDead: 0, format: "json", description: "Alpha CRM" });
    expect(all.items[1]).toMatchObject({ orgName: "Beta Co", events: ["message.received", "task.created"], recentFailures: 0 });
    const json = JSON.stringify(all);
    const encs = (await ctx.db.select().from(webhookEndpoints)).map((e) => e.secretEnc);
    for (const s of [a.secret, b.secret, ...encs, "secretEnc", "whsec_"]) expect(json).not.toContain(s);
    const wide = await listWebhookEndpoints(ctx.deps, { orgId: orgA, failuresWindow: { from: new Date(now - 11 * DAY) } }, page("createdAt"));
    expect(wide.items[0]!.recentFailures).toBe(3);
    expect((await listWebhookEndpoints(ctx.deps, { q: "CRM" }, page("createdAt"))).items.map((e) => e.id)).toEqual([a.endpoint.id]);
    expect(await walk((p) => listWebhookEndpoints(ctx.deps, {}, p), "url", "desc", 1)).toEqual([b.endpoint.id, a.endpoint.id]);
    expect(WEBHOOK_ENDPOINT_SORT_FIELDS).toEqual(["createdAt", "url"]);
    await expect(listWebhookEndpoints(ctx.deps, {}, page("secretEnc"))).rejects.toMatchObject({ status: 400 });

    expect(await setWebhookEndpointEnabled(ctx.deps, a.endpoint.id, false)).toMatchObject({ id: a.endpoint.id, orgId: orgA, before: { enabled: true }, enabled: false });
    expect((await listWebhookEndpoints(ctx.deps, { enabled: false }, page("createdAt"))).items.map((e) => e.id)).toEqual([a.endpoint.id]);
    expect((await listWebhookEndpoints(ctx.deps, { enabled: true }, page("createdAt"))).items.map((e) => e.id)).toEqual([b.endpoint.id]);
    expect(await setWebhookEndpointEnabled(ctx.deps, a.endpoint.id, true)).toMatchObject({ before: { enabled: false }, enabled: true });
    await expect(setWebhookEndpointEnabled(ctx.deps, "whe_missing", true)).rejects.toMatchObject({ status: 404 });
  });

  it("lists deliveries (failures by default) in a window with a field-name preview only, pages, and redelivers one", async () => {
    const a = await createEndpoint(ctx.deps, orgA, { url: "https://hooks.alpha.example/in", events: ["*"] });
    const a2 = await createEndpoint(ctx.deps, orgA, { url: "https://hooks2.alpha.example/in", events: ["*"] });
    const b = await createEndpoint(ctx.deps, orgB, { url: "https://hooks.beta.example/in", events: ["*"] });
    const now = Date.now();
    const fA = await addDelivery(orgA, a.endpoint.id, "failed", new Date(now - HOUR));
    const fA2 = await addDelivery(orgA, a2.endpoint.id, "failed", new Date(now - 2 * HOUR), "task.created");
    const fB = await addDelivery(orgB, b.endpoint.id, "failed", new Date(now - 3 * HOUR));
    const okB = await addDelivery(orgB, b.endpoint.id, "delivered", new Date(now - HOUR));
    const oldA = await addDelivery(orgA, a.endpoint.id, "failed", new Date(now - 8 * DAY));

    const all = await listWebhookDeliveries(ctx.deps, {}, page("createdAt"));
    expect(all.items.map((d) => d.id)).toEqual([fA, fA2, fB]);
    expect(all.items[0]).toMatchObject({ orgId: orgA, orgName: "Alpha Co", endpointUrl: "https://hooks.alpha.example/in", eventType: "message.bounced", status: "failed", attempts: 6, lastError: "Receiver answered 500" });
    expect(all.items[0]!.payloadPreview).toBe("message.bounced: id, to, subject");
    const json = JSON.stringify(all);
    for (const s of ["private@customer.example", "Very private subject", "msg_1", "\"payload\""]) expect(json).not.toContain(s);

    expect((await listWebhookDeliveries(ctx.deps, { orgId: orgA }, page("createdAt"))).items.map((d) => d.id)).toEqual([fA, fA2]);
    expect((await listWebhookDeliveries(ctx.deps, { endpointId: b.endpoint.id, status: ["delivered", "failed"] }, page("createdAt"))).items.map((d) => d.id)).toEqual([okB, fB]);
    expect((await listWebhookDeliveries(ctx.deps, { eventType: "task.created" }, page("createdAt"))).items.map((d) => d.id)).toEqual([fA2]);
    expect((await listWebhookDeliveries(ctx.deps, { window: { from: new Date(now - 9 * DAY), to: new Date(now - 7 * DAY) } }, page("createdAt"))).items.map((d) => d.id)).toEqual([oldA]);
    expect((await listWebhookDeliveries(ctx.deps, { orgId: "org_without_endpoints" }, page("createdAt")))).toEqual({ items: [], next: null });
    expect(await walk((p) => listWebhookDeliveries(ctx.deps, {}, p), "createdAt", "asc", 2)).toEqual([fB, fA2, fA]);
    expect(WEBHOOK_DELIVERY_SORT_FIELDS).toEqual(["createdAt"]);
    await expect(listWebhookDeliveries(ctx.deps, {}, page("payload"))).rejects.toMatchObject({ status: 400 });
    await expect(listWebhookDeliveries(ctx.deps, { status: ["dead" as never] }, page("createdAt"))).rejects.toMatchObject({ status: 400 });

    // Redeliver: only failed ones, sent again now to the endpoint's URL.
    await expect(redeliverWebhook(ctx.deps, okB)).rejects.toMatchObject({ status: 400 });
    expect(await redeliverWebhook(ctx.deps, fB)).toEqual({ id: fB, orgId: orgB, endpointId: b.endpoint.id, replayed: 1 });
    expect(posted).toEqual(["https://hooks.beta.example/in"]);
    expect((await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, fB)).get())!.status).toBe("delivered");
    expect((await listWebhookDeliveries(ctx.deps, { orgId: orgB }, page("createdAt"))).items).toEqual([]);
    await expect(redeliverWebhook(ctx.deps, "msg_missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("OAuth", () => {
  async function client(name: string, at = new Date()) {
    const id = newId("oac");
    await ctx.db.insert(oauthClients).values({ id, name, redirectUris: JSON.stringify([`https://${name.toLowerCase()}.example/callback`]), createdAt: at });
    return id;
  }
  async function grant(clientId: string, orgId: string, userId: string, opts: { used?: boolean; revoked?: boolean; at?: Date } = {}) {
    const id = newId("oag");
    const at = opts.at ?? new Date();
    await ctx.db.insert(oauthGrants).values({
      id, clientId, orgId, userId, scope: "full", redirectUri: "https://claude.example/callback", codeHash: "CODE-HASH-SECRET", codeChallenge: "PKCE-CHALLENGE",
      codeUsedAt: opts.used === false ? null : at, refreshHash: opts.revoked ? null : "REFRESH-HASH-SECRET", revokedAt: opts.revoked ? at : null, createdAt: at,
    });
    return id;
  }

  it("lists clients with a window and name search", async () => {
    const claude = await client("Claude");
    const cursor = await client("Cursor");
    const old = await client("Ancient", new Date(Date.now() - 200 * DAY));
    const all = await listOAuthClients(ctx.deps, {}, page("name", "asc"));
    expect(all.items.map((c) => c.id)).toEqual([claude, cursor]);
    expect(all.items[0]).toMatchObject({ name: "Claude", redirectUris: ["https://claude.example/callback"], clientUri: null });
    expect((await listOAuthClients(ctx.deps, { q: "ancient" }, page("createdAt"))).items.map((c) => c.id)).toEqual([old]);
    expect(await walk((p) => listOAuthClients(ctx.deps, {}, p), "name", "desc", 1)).toEqual([cursor, claude]);
    expect(OAUTH_CLIENT_SORT_FIELDS).toEqual(["createdAt", "name"]);
    await expect(listOAuthClients(ctx.deps, {}, page("redirectUris"))).rejects.toMatchObject({ status: 400 });
  });

  it("lists grants without codes, hashes or challenges, filters by state, workspace and client, pages, and revokes one", async () => {
    const claude = await client("Claude");
    const chatgpt = await client("ChatGPT");
    const t = Date.now() - HOUR;
    const gA = await grant(claude, orgA, userA, { at: new Date(t) });
    const gA2 = await grant(chatgpt, orgA, userA, { at: new Date(t - 1000) });
    const gB = await grant(claude, orgB, userB, { at: new Date(t - 2000) });
    const unused = await grant(claude, orgB, userB, { used: false, at: new Date(t - 3000) });
    const revoked = await grant(chatgpt, orgB, userB, { revoked: true, at: new Date(t - 4000) });

    const active = await listOAuthGrants(ctx.deps, {}, page("createdAt"));
    expect(active.items.map((g) => g.id)).toEqual([gA, gA2, gB]);
    expect(active.items[2]).toMatchObject({ orgId: orgB, orgName: "Beta Co", clientId: claude, clientName: "Claude", userId: userB, userEmail: "b@beta.io", scope: "full", revokedAt: null });
    const json = JSON.stringify(await listOAuthGrants(ctx.deps, { state: "all" }, page("createdAt")));
    for (const s of ["CODE-HASH-SECRET", "REFRESH-HASH-SECRET", "PKCE-CHALLENGE", "codeHash", "refreshHash", "codeChallenge"]) expect(json).not.toContain(s);
    expect((await listOAuthGrants(ctx.deps, { state: "all", orgId: orgB }, page("createdAt"))).items.map((g) => g.id)).toEqual([gB, unused, revoked]);
    expect((await listOAuthGrants(ctx.deps, { state: "revoked" }, page("createdAt"))).items.map((g) => g.id)).toEqual([revoked]);
    expect((await listOAuthGrants(ctx.deps, { clientId: chatgpt }, page("createdAt"))).items.map((g) => g.id)).toEqual([gA2]);
    expect((await listOAuthGrants(ctx.deps, { orgId: orgA, userId: userA }, page("createdAt"))).items).toHaveLength(2);
    expect(await walk((p) => listOAuthGrants(ctx.deps, { state: "all" }, p), "createdAt", "asc", 2)).toEqual([revoked, unused, gB, gA2, gA]);
    expect(OAUTH_GRANT_SORT_FIELDS).toEqual(["createdAt", "lastUsedAt"]);
    await expect(listOAuthGrants(ctx.deps, {}, page("refreshHash"))).rejects.toMatchObject({ status: 400 });

    expect(await revokeOAuthGrant(ctx.deps, gB)).toEqual({ id: gB, orgId: orgB, clientId: claude, userId: userB });
    const row = await ctx.db.select().from(oauthGrants).where(eq(oauthGrants.id, gB)).get();
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.refreshHash).toBeNull();
    expect((await listOAuthGrants(ctx.deps, {}, page("createdAt"))).items.map((g) => g.id)).toEqual([gA, gA2]);
    await expect(revokeOAuthGrant(ctx.deps, gB)).rejects.toMatchObject({ status: 404 });
  });
});
