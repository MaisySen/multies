import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { parseMime } from "@/server/services/mail/mime";
import { DISABLE_AFTER_DEAD, emitEvent, retryDueDeliveries } from "@/server/services/developer/webhooks";
import { organizations, webhookEndpoints } from "@/server/db/schema";

type Captured = { url: string; headers: Record<string, string>; body: string };

function receiver(statuses: number[] = []) {
  const seen: Captured[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, headers: Object.fromEntries(req.headers), body: await req.text() });
    return new Response("ok", { status: statuses.shift() ?? 200 });
  };
  return { seen, fetch: fetchImpl as typeof fetch };
}

async function bearer(ctx: Awaited<ReturnType<typeof makeTestApp>>, key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(path, {
    method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("API keys and the v1 REST API", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let c: Client;
  beforeEach(async () => {
    ctx = await makeTestApp();
    c = new Client(ctx.app);
    await c.signup();
  });

  it("refuses keys of a suspended workspace, and checks the key once per request", async () => {
    const made = await c.post("/api/developer/keys", { name: "CI" });
    const orgId = (await c.get("/api/account/me")).body.organization.id;
    const select = ctx.deps.db.select.bind(ctx.deps.db);
    const callers: string[] = [];
    const spy = vi.spyOn(ctx.deps.db, "select").mockImplementation(((...a: Parameters<typeof select>) => {
      callers.push(new Error().stack ?? "");
      return select(...a);
    }) as typeof select);
    expect((await bearer(ctx, made.body.secret, "GET", "/api/v1/domains")).status).toBe(200);
    spy.mockRestore();
    // Authentication is one query: the key, its creator's membership and the workspace together.
    expect(callers.filter((s) => !s.includes("listDomains"))).toHaveLength(1);
    await ctx.db.update(organizations).set({ suspendedAt: new Date(), suspendedReason: "test" }).where(eq(organizations.id, orgId));
    const res = await bearer(ctx, made.body.secret, "GET", "/api/v1/domains");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("workspace_suspended");
  });

  it("creates a key shown once, and the key works on /api/v1", async () => {
    const made = await c.post("/api/developer/keys", { name: "CI" });
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^mm_live_/);
    const list = await c.get("/api/developer/keys");
    expect(JSON.stringify(list.body)).not.toContain(made.body.secret);
    expect(list.body.apiKeys[0]).toMatchObject({ name: "CI", scope: "full", prefix: made.body.secret.slice(0, 12) });

    const created = await bearer(ctx, made.body.secret, "POST", "/api/v1/domains", { name: "acme.io" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "acme.io", status: "pending" });
    expect(created.body.records.length).toBeGreaterThan(2);
    const mb = await bearer(ctx, made.body.secret, "POST", "/api/v1/mailboxes", { domainId: created.body.id, localPart: "hello", displayName: "Hello" });
    expect(mb.status).toBe(201);
    expect((await bearer(ctx, made.body.secret, "GET", "/api/v1/mailboxes")).body.data[0].address).toBe("hello@acme.io");
    // The audit log names the key.
    const activity = await c.get("/api/org/audit");
    expect(JSON.stringify(activity.body)).toContain("api-key:");
  });

  it("refuses missing, wrong, read-only and deleted keys appropriately", async () => {
    expect((await ctx.app.request("/api/v1/domains")).status).toBe(401);
    expect((await bearer(ctx, "mm_live_nopenopenopenopenopenope", "GET", "/api/v1/domains")).status).toBe(401);
    const ro = await c.post("/api/developer/keys", { name: "Reporting", scope: "read" });
    expect((await bearer(ctx, ro.body.secret, "GET", "/api/v1/domains")).status).toBe(200);
    const write = await bearer(ctx, ro.body.secret, "POST", "/api/v1/domains", { name: "acme.io" });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("read_only_key");
    await c.del(`/api/developer/keys/${ro.body.apiKey.id}`);
    expect((await bearer(ctx, ro.body.secret, "GET", "/api/v1/domains")).status).toBe(401);
  });

  it("validates bodies with the same schemas the docs describe", async () => {
    const k = (await c.post("/api/developer/keys", { name: "x" })).body.secret;
    const bad = await bearer(ctx, k, "POST", "/api/v1/messages", { mailboxId: "mbx_1", to: [] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("validation_failed");
  });

  it("keeps another workspace's data out of reach", async () => {
    const k = (await c.post("/api/developer/keys", { name: "x" })).body.secret;
    const other = new Client(ctx.app);
    await other.signup();
    const theirs = (await other.post("/api/domains", { name: "theirs.io" })).body.domain.id;
    expect((await bearer(ctx, k, "GET", `/api/v1/domains/${theirs}`)).status).toBe(404);
  });

  it("publishes an OpenAPI 3.1 document and a docs page", async () => {
    const doc = await (await ctx.app.request("/api/v1/openapi.json")).json();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/domains", "/domains/{id}", "/mailboxes", "/aliases", "/messages", "/messages/{id}", "/webhooks"]));
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(doc.components.schemas.SendRequest).toBeTruthy();
    const page = await ctx.app.request("/api/v1/reference");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/api/v1/openapi.json");
    // The old address sends a browser to the reference; a key gets the docs list (dogfood finding F1).
    const old = await ctx.app.request("/api/v1/docs", { headers: { accept: "text/html" } });
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("/api/v1/reference");
  });

  it("only admins manage keys", async () => {
    const invite = await c.post("/api/team/invites", { email: "mem@example.com", role: "member" });
    expect(invite.status).toBe(201);
    const m = new Client(ctx.app);
    await m.signup("mem@example.com", "Member", "");
    expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    expect((await m.get("/api/developer/keys")).status).toBe(403);
  });
});

describe("outbound webhooks (Standard Webhooks)", () => {
  it("signs message.received so a Standard Webhooks library verifies it", async () => {
    const rx = receiver();
    const ctx = await makeTestApp({}, { fetch: rx.fetch });
    const c = new Client(ctx.app);
    await c.signup();
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    await c.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" });
    const ep = await c.post("/api/developer/webhooks", { url: "https://hooks.example.com/mymail", events: ["message.received"] });
    expect(ep.status).toBe(201);
    expect(ep.body.secret).toMatch(/^whsec_/);

    const raw = new TextEncoder().encode("From: bob@example.com\r\nTo: ada@acme.io\r\nSubject: Hello\r\n\r\nHi\r\n");
    await deliverInbound(ctx.deps, { envelopeFrom: "bob@example.com", rcptTo: "ada@acme.io", email: await parseMime(raw), sizeBytes: raw.length, via: "test", raw });

    const hit = rx.seen.find((s) => s.url === "https://hooks.example.com/mymail");
    expect(hit).toBeTruthy();
    const event = new Webhook(ep.body.secret).verify(hit!.body, hit!.headers) as { type: string; data: { to: string; subject: string } };
    expect(event).toMatchObject({ type: "message.received", data: { to: "ada@acme.io", subject: "Hello" } });
    // A tampered body fails verification.
    expect(() => new Webhook(ep.body.secret).verify(hit!.body.replace("Hello", "Hacked"), hit!.headers)).toThrow();

    const deliveries = await c.get(`/api/developer/webhooks/${ep.body.endpoint.id}/deliveries`);
    expect(deliveries.body.deliveries[0]).toMatchObject({ eventType: "message.received", status: "delivered", attempts: 1, responseStatus: 200 });
  });

  it("retries failed deliveries with backoff, then gives up", async () => {
    const rx = receiver([500, 503]);
    const ctx = await makeTestApp({}, { fetch: rx.fetch });
    let now = Date.now();
    ctx.deps.now = () => new Date(now);
    const c = new Client(ctx.app);
    await c.signup();
    const ep = await c.post("/api/developer/webhooks", { url: "https://hooks.example.com/x", events: ["*"] });
    const first = await c.post(`/api/developer/webhooks/${ep.body.endpoint.id}/test`, {});
    expect(first.body.delivery).toMatchObject({ status: "pending", attempts: 1, responseStatus: 500 });
    expect(await retryDueDeliveries(ctx.deps)).toBe(0); // not due yet
    now += 61_000;
    expect(await retryDueDeliveries(ctx.deps)).toBe(1); // 503, still pending
    now += 5 * 60_000 + 1000;
    await retryDueDeliveries(ctx.deps); // 200
    const list = await c.get(`/api/developer/webhooks/${ep.body.endpoint.id}/deliveries`);
    expect(list.body.deliveries[0]).toMatchObject({ status: "delivered", attempts: 3 });
  });

  it("keeps dead letters for replay and disables an endpoint that keeps failing", async () => {
    let up = false;
    const fetchImpl = (async () => new Response("no", { status: up ? 200 : 500 })) as typeof fetch;
    const ctx = await makeTestApp({}, { fetch: fetchImpl });
    let now = Date.now();
    ctx.deps.now = () => new Date(now);
    const c = new Client(ctx.app);
    await c.signup();
    const ep = await c.post("/api/developer/webhooks", { url: "https://hooks.example.com/dead", events: ["*"] });
    const id = ep.body.endpoint.id as string;
    const orgId = (await ctx.deps.db.select().from(webhookEndpoints).get())!.orgId;
    for (let i = 0; i < DISABLE_AFTER_DEAD; i++) await emitEvent(ctx.deps, orgId, "message.sent", { n: i });
    for (let i = 0; i < 6; i++) { now += 7 * 3600_000; await retryDueDeliveries(ctx.deps); }

    const list = await c.get("/api/developer/webhooks");
    const endpoint = list.body.endpoints.find((e: { id: string }) => e.id === id);
    expect(endpoint.enabled).toBe(false);
    expect(endpoint.disabledReason).toMatch(/Disabled after 5 deliveries in a row failed/);
    const dead = (await c.get(`/api/developer/webhooks/${id}/deliveries`)).body.deliveries;
    expect(dead.filter((d: { status: string }) => d.status === "failed")).toHaveLength(DISABLE_AFTER_DEAD);
    // New events skip a disabled endpoint.
    expect(await emitEvent(ctx.deps, orgId, "message.sent", { n: 99 })).toEqual([]);

    // The receiver is fixed: replay sends every dead letter again and switches the endpoint back on.
    up = true;
    const replay = await c.post(`/api/developer/webhooks/${id}/replay`, {});
    expect(replay.body.replayed).toBe(DISABLE_AFTER_DEAD);
    const after = (await c.get(`/api/developer/webhooks/${id}/deliveries`)).body.deliveries;
    expect(after.every((d: { status: string }) => d.status === "delivered")).toBe(true);
    const again = (await c.get("/api/developer/webhooks")).body.endpoints.find((e: { id: string }) => e.id === id);
    expect(again).toMatchObject({ enabled: true, disabledReason: null });
  });

  it("refuses private and non-https URLs in production", async () => {
    const ctx = await makeTestApp({ APP_MODE: "production" });
    const c = new Client(ctx.app);
    await c.signup();
    for (const url of ["http://example.com/x", "https://localhost/x", "https://10.0.0.5/x", "https://169.254.169.254/latest"]) {
      expect((await c.post("/api/developer/webhooks", { url, events: ["*"] })).status).toBe(400);
    }
  });
});
