/**
 * QUAL1 (audit rows 36 and 69): GET /api/health was public and showed the release, the account's D1 reads and
 * writes, budgets, shed levels, the largest workspace and the production and staging split; the public status page
 * showed the platform's mail volume ("1 messages"). Now the public answers carry only what uptime checks, the deploy
 * smoke test and the status page need, and the detail is for platform operators on /api/admin/health and
 * /api/admin/status.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { verifiedDomain } from "./priv1a-world";
import { messagesLine, resetStatusCache } from "@/server/services/status";
import { resetWriteBudgetCache } from "@/server/services/write-budget";

/** Cloudflare analytics answering `rows` written today (the write budget guard on). */
const analytics = (rows: number) => (async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [
  { sum: { rowsWritten: rows, rowsRead: 1_000 }, dimensions: { databaseId: "db1", date: "2026-11-11" } },
] }] } }, errors: null }))) as unknown as typeof fetch;

async function operator(ctx: Awaited<ReturnType<typeof makeTestApp>>, email = "ops@multies.si") {
  const op = new Client(ctx.app);
  await op.signup(email);
  await ctx.db.run(sql`update users set role = 'admin' where email = ${email}`);
  return op;
}

beforeEach(() => { resetWriteBudgetCache(); resetStatusCache(); });

describe("public health is the minimum (QUAL1, row 36)", () => {
  it("/api/health, /health and /healthz answer only { ok, db }, with the write guard on", async () => {
    const ctx = await makeTestApp({ CF_ANALYTICS_TOKEN: "cf_test", CF_ACCOUNT_ID: "acct", RELEASE: "abcdef123456" }, { fetch: analytics(62_000) });
    for (const path of ["/api/health", "/health", "/healthz"]) {
      const res = await ctx.app.request(path, { headers: { host: "localhost" } });
      expect(res.status, path).toBe(200);
      expect(await res.json(), path).toEqual({ ok: true, db: "ok" });
    }
    // The deploy is still confirmed through the release on /api/config (scripts/smoke.sh, docs/runbooks/deploy.md).
    const config = await ctx.app.request("/api/config", { headers: { host: "localhost" } });
    expect(await config.text()).toContain('"release":"abcdef123456"');
  });

  it("the deploy smoke test waits for the release on /api/config, and reads only ok and db from /api/health", () => {
    const smoke = readFileSync("scripts/smoke.sh", "utf8");
    expect(smoke).toContain('CONFIG=$(curl -fsS "$BASE/api/config")');
    expect(smoke).not.toMatch(/HEALTH"? \| grep -q "\\"release/);
    expect(smoke).toContain(`grep -q '"db":"ok"'`);
  });

  it("a database that does not answer is a 503 with no detail", async () => {
    const ctx = await makeTestApp();
    await new Client(ctx.app).get("/api/health"); // the schema is known to be current from here on
    (ctx.db as unknown as { run: () => Promise<never> }).run = async () => { throw new Error("D1_ERROR: database unavailable"); };
    const res = await ctx.app.request("/api/health", { headers: { host: "localhost" } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "unreachable" });
  });

  it("the detail is on /api/admin/health for platform operators only", async () => {
    const ctx = await makeTestApp({ CF_ANALYTICS_TOKEN: "cf_test", CF_ACCOUNT_ID: "acct", RELEASE: "abcdef123456" }, { fetch: analytics(62_000) });
    expect((await new Client(ctx.app).get("/api/admin/health")).status).toBe(401);
    const member = new Client(ctx.app);
    await member.signup("someone@acme.io");
    expect((await member.get("/api/admin/health")).status).toBe(403);
    const op = await operator(ctx);
    const r = await op.get("/api/admin/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, db: "ok", release: "abcdef123456", writes: { today: 62_000, level: "warn" } });
    expect(r.body).toHaveProperty("reads");
    expect(r.body).toHaveProperty("workspaces");
  });
});

describe("the public status page shows no mail volume (QUAL1, row 69)", () => {
  it("states and plain words only; operators see the volume with the right plural", async () => {
    const ctx = await makeTestApp();
    const owner = new Client(ctx.app);
    await owner.signup("owner@acme.io");
    const domainId = await verifiedDomain(ctx, owner, "acme.io");
    await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" });
    await deliverInbound(ctx.deps, {
      envelopeFrom: "a@example.net", rcptTo: "hello@acme.io", sizeBytes: 300, via: "test",
      email: { messageId: "<v1@example.net>", from: { address: "a@example.net" }, to: [{ address: "hello@acme.io" }], cc: [], subject: "One", text: "Hi", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const pub = await new Client(ctx.app).get("/api/status");
    expect(pub.status).toBe(200);
    expect(pub.body).not.toHaveProperty("volume");
    const inbound = pub.body.components.find((c: { id: string }) => c.id === "inbound");
    expect(inbound).toMatchObject({ state: "operational", detail: "Receiving normally." });
    expect(JSON.stringify(pub.body.components)).not.toMatch(/\d+ messages?\b|last 24 hours/);
    const op = await operator(ctx);
    const full = await op.get("/api/admin/status");
    expect(full.status).toBe(200);
    expect(full.body.volume).toMatchObject({ received: 1, receivedLine: "1 message received in the last 24 hours." });
    expect((await owner.get("/api/admin/status")).status).toBe(403);
  });

  it("QUAL1 review: the public queue line has no count either; operators see it", async () => {
    const ctx = await makeTestApp();
    const { enqueue } = await import("@/server/services/jobs");
    for (const n of [1, 2, 3]) await enqueue(ctx.deps, "test.status_queue", { n });
    const queue = (await new Client(ctx.app).get("/api/status")).body.components.find((c: { id: string }) => c.id === "queue");
    expect(queue).toMatchObject({ state: "operational", detail: "Work is queued and running normally." });
    expect(queue.detail).not.toMatch(/\d/);
    resetStatusCache();
    const full = await (await operator(ctx)).get("/api/admin/status");
    expect(full.body.volume).toMatchObject({ queued: 3 });
  });

  it("one plural rule: 1 message, 2 messages", () => {
    expect(messagesLine(1)).toBe("1 message");
    expect(messagesLine(2)).toBe("2 messages");
    expect(messagesLine(0)).toBe("0 messages");
    expect(messagesLine(12_400)).toBe("12,400 messages");
  });
});
