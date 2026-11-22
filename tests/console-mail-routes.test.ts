/**
 * OPS1: /api/console/mail routes. Lists answer { items, nextCursor } and page through every row; unknown sorts and
 * filters are 400s; changes need a reason, the right role, and write a platform audit row with the workspace on it.
 * Nothing returns a subject, a body, an address of a delivery, or a credential.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { auditLogs, deliveries, domains, importJobs, mailboxes, mailConnections, mailSchedules, organizations, platformAuditLogs, suppressions } from "@/server/db/schema";
import { newId } from "@/server/lib/crypto";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SUBJECT = "PLANTED-ROUTE-SUBJECT-q8Wn3Zt5Lp1";
const TO_ADDR = "planted-route-recipient-v4Kc9@outside.example";
const CONN_SECRET = "PLANTED-ROUTE-CONN-SECRET-m7Hx2Rb6";
const IMPORT_SECRET = "PLANTED-ROUTE-IMPORT-SECRET-c3Ty8Nf4";
const HELD_BODY = "PLANTED-ROUTE-HELD-BODY-j5Qs1Vd7";

let ctx: Ctx;
let owner: Client;
let support: Client;
let billing: Client;
let readonly: Client;
let customer: Client;
let orgA: string;
let orgB: string;
let domainA: string;
let mailboxA: string;
let mailboxB: string;

async function customerWorkspace(email: string, name: string, domain: string) {
  const { c } = await signUpAs(ctx, email, null, name);
  const orgId = (await c.get("/api/account/me")).body.organization.id as string;
  const r = await c.post("/api/domains", { name: domain });
  expect(r.status).toBe(201);
  const domainId = r.body.domain.id as string;
  const mailboxId = newId("mbx");
  await ctx.db.insert(mailboxes).values({ id: mailboxId, orgId, domainId, localPart: "hello", address: `hello@${domain}`, displayName: "Hello", quotaMb: 100 });
  return { c, orgId, domainId, mailboxId };
}

async function addDelivery(orgId: string, status: (typeof deliveries.$inferSelect)["status"], at: Date, direction: "inbound" | "outbound" = "outbound") {
  const id = newId("dlv");
  await ctx.db.insert(deliveries).values({ id, orgId, direction, fromAddress: "hello@alpha.test", toAddress: TO_ADDR, subject: SUBJECT, status, provider: "log", detail: "550 mailbox unavailable", createdAt: at });
  return id;
}

/** Every id across all pages, following nextCursor. */
async function walk(c: Client, path: string, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await c.get(`${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.length).toBeLessThanOrEqual(limit);
    ids.push(...r.body.items.map((x: { id: string }) => x.id));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return ids;
}

async function lastAudit(action: string) {
  const rows = await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, action)).orderBy(platformAuditLogs.createdAt).all();
  return rows[rows.length - 1];
}

beforeAll(async () => {
  ctx = await makeTestApp();
  owner = (await signUpAs(ctx, "owner@ops.test", "admin")).c;
  support = (await signUpAs(ctx, "support@ops.test", "ops_support")).c;
  billing = (await signUpAs(ctx, "billing@ops.test", "ops_billing")).c;
  readonly = (await signUpAs(ctx, "readonly@ops.test", "ops_readonly")).c;
  const a = await customerWorkspace("a@alpha.test", "Alpha Co", "alpha.test");
  const b = await customerWorkspace("b@beta.test", "Beta Co", "beta.test");
  customer = a.c;
  ({ orgId: orgA, domainId: domainA, mailboxId: mailboxA } = a);
  ({ orgId: orgB, mailboxId: mailboxB } = b);
}, 120_000);

describe("who can read", () => {
  it("anonymous callers get 401, customers 403, every operator tier can read", async () => {
    expect((await new Client(ctx.app).get("/api/console/mail/deliveries")).status).toBe(401);
    expect((await customer.get("/api/console/mail/deliveries")).status).toBe(403);
    for (const c of [owner, support, billing, readonly]) expect((await c.get("/api/console/mail/domains")).status).toBe(200);
  }, 60_000);
});

describe("deliveries and failure rates", () => {
  it("default to failures in the last 7 days, page by nextCursor, filter, refuse bad input, and never show subject or addresses", async () => {
    const now = Date.now();
    const f1 = await addDelivery(orgA, "bounced", new Date(now - HOUR));
    const f2 = await addDelivery(orgA, "failed", new Date(now - 2 * HOUR));
    const f3 = await addDelivery(orgB, "complained", new Date(now - 3 * HOUR));
    const inbound = await addDelivery(orgB, "rejected", new Date(now - 4 * HOUR), "inbound");
    await addDelivery(orgA, "delivered", new Date(now - HOUR));
    const old = await addDelivery(orgA, "bounced", new Date(now - 10 * DAY));

    const first = await readonly.get("/api/console/mail/deliveries");
    expect(first.status).toBe(200);
    expect(first.body.items.map((d: { id: string }) => d.id)).toEqual([f1, f2, f3, inbound]);
    expect(first.body.nextCursor).toBeNull();
    expect(first.body.items[0]).toMatchObject({ orgId: orgA, orgName: "Alpha Co", status: "bounced", direction: "outbound", detail: "550 mailbox unavailable" });
    const raw = JSON.stringify(first.body);
    for (const s of [SUBJECT, TO_ADDR, "hello@alpha.test"]) expect(raw).not.toContain(s);
    expect(Object.keys(first.body.items[0])).not.toContain("toAddress");

    expect(await walk(readonly, "/api/console/mail/deliveries", 1)).toEqual([f1, f2, f3, inbound]);
    expect(await walk(readonly, "/api/console/mail/deliveries?sort=createdAt:asc", 3)).toEqual([inbound, f3, f2, f1]);
    expect((await readonly.get(`/api/console/mail/deliveries?orgId=${orgB}`)).body.items.map((d: { id: string }) => d.id)).toEqual([f3, inbound]);
    expect((await readonly.get("/api/console/mail/deliveries?direction=inbound")).body.items.map((d: { id: string }) => d.id)).toEqual([inbound]);
    expect((await readonly.get("/api/console/mail/deliveries?status=bounced,complained")).body.items.map((d: { id: string }) => d.id)).toEqual([f1, f3]);
    expect((await readonly.get("/api/console/mail/deliveries?window=30&status=bounced")).body.items.map((d: { id: string }) => d.id)).toEqual([f1, old]);

    expect((await readonly.get("/api/console/mail/deliveries?sort=subject:desc")).status).toBe(400);
    expect((await readonly.get("/api/console/mail/deliveries?sort=createdAt:sideways")).status).toBe(400);
    expect((await readonly.get("/api/console/mail/deliveries?status=lost")).status).toBe(400);
    expect((await readonly.get("/api/console/mail/deliveries?direction=up")).status).toBe(400);
    expect((await readonly.get("/api/console/mail/deliveries?window=365")).status).toBe(400);
    expect((await readonly.get("/api/console/mail/deliveries?cursor=not-a-cursor")).status).toBe(400);
  }, 120_000);

  it("name each workspace's owner, and say when a list looked at recent rows only", async () => {
    const now = Date.now();
    await addDelivery(orgA, "bounced", new Date(now - HOUR));
    await addDelivery(orgA, "delivered", new Date(now - HOUR));
    const failures = await readonly.get("/api/console/mail/deliveries");
    expect(failures.body.items[0]).toMatchObject({ orgId: orgA, ownerEmail: "a@alpha.test" });
    // Failures read an index: the whole window, no note.
    expect(failures.body.recentOnly).toBeUndefined();
    // Other statuses across every workspace look at the newest rows only, and say so.
    const delivered = await readonly.get("/api/console/mail/deliveries?status=delivered");
    expect(delivered.status).toBe(200);
    expect(delivered.body.recentOnly).toBe(true);
    // One workspace reads its own index: everything in the window.
    expect((await readonly.get(`/api/console/mail/deliveries?status=delivered&orgId=${orgA}`)).body.recentOnly).toBeUndefined();
    const domainsList = await readonly.get("/api/console/mail/domains?status=pending,verified,failed");
    expect(domainsList.body.items.find((d: { orgId: string }) => d.orgId === orgB)).toMatchObject({ ownerEmail: "b@beta.test" });
  }, 60_000);

  it("ranks workspaces by outbound failure rate", async () => {
    for (let i = 0; i < 9; i++) await addDelivery(orgB, "delivered", new Date(Date.now() - (i + 5) * HOUR));
    const r = await readonly.get("/api/console/mail/failure-rates?window=7");
    expect(r.status).toBe(200);
    const b = r.body.items.find((x: { orgId: string }) => x.orgId === orgB);
    expect(b).toMatchObject({ orgName: "Beta Co", failed: 1, complained: 1 });
    expect(b.total).toBeGreaterThanOrEqual(10);
    expect((await readonly.get("/api/console/mail/failure-rates?window=0")).status).toBe(400);
  }, 60_000);
});

describe("domains", () => {
  it("lists with state and search filters and pages", async () => {
    const r = await readonly.get("/api/console/mail/domains?status=pending,failed");
    expect(r.status).toBe(200);
    expect(r.body.items.map((d: { name: string }) => d.name).sort()).toEqual(["alpha.test", "beta.test"]);
    expect(JSON.stringify(r.body)).not.toMatch(/dkim(Private|Public)?Key|verificationToken/i);
    expect((await readonly.get("/api/console/mail/domains?q=ALPHA")).body.items.map((d: { id: string }) => d.id)).toEqual([domainA]);
    expect((await walk(readonly, "/api/console/mail/domains?sort=name:asc", 1)).length).toBe(2);
    expect((await readonly.get("/api/console/mail/domains?status=broken")).status).toBe(400);
    expect((await readonly.get("/api/console/mail/domains?sort=dkimPrivateKeyEnc:asc")).status).toBe(400);
  }, 60_000);

  it("re-check needs a reason and mail.manage, then audits with the workspace", async () => {
    const path = `/api/console/mail/domains/${domainA}/recheck`;
    expect((await support.post(path, {})).status).toBe(422);
    expect((await support.post(path, { reason: "x" })).status).toBe(422);
    expect((await readonly.post(path, { reason: "Customer says DNS is set" })).status).toBe(403);
    expect((await billing.post(path, { reason: "Customer says DNS is set" })).status).toBe(403);
    expect((await customer.post(path, { reason: "Customer says DNS is set" })).status).toBe(403);
    const r = await support.post(path, { reason: "Customer says DNS is set" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: domainA, status: "pending", verified: false });
    const row = await lastAudit("mail.domain_rechecked");
    expect(row).toMatchObject({ actorEmail: "support@ops.test", targetType: "domain", targetId: domainA, orgId: orgA, reason: "Customer says DNS is set" });
    expect(JSON.parse(row!.before!)).toMatchObject({ name: "alpha.test", status: "pending" });
    expect((await ctx.db.select().from(domains).where(eq(domains.id, domainA)).get())!.lastCheckedAt).not.toBeNull();
    expect((await support.post("/api/console/mail/domains/dom_missing/recheck", { reason: "Customer says DNS is set" })).status).toBe(404);
  }, 60_000);
});

describe("suppressions", () => {
  it("lists, searches, pages and removes one with a reason and an audit row", async () => {
    const ids: string[] = [];
    for (const [orgId, address, reason] of [[orgA, "bounce-route@x.test", "hard_bounce"], [orgA, "angry-route@x.test", "complaint"], [orgB, "hand-route@y.test", "manual"]] as const) {
      const id = newId("sup");
      await ctx.db.insert(suppressions).values({ id, orgId, address, reason });
      ids.push(id);
    }
    const list = await readonly.get("/api/console/mail/suppressions");
    expect(list.status).toBe(200);
    expect(new Set(list.body.items.map((s: { id: string }) => s.id))).toEqual(new Set(ids));
    expect((await readonly.get("/api/console/mail/suppressions?q=angry")).body.items.map((s: { id: string }) => s.id)).toEqual([ids[1]]);
    expect((await readonly.get("/api/console/mail/suppressions?reason=manual")).body.items.map((s: { id: string }) => s.id)).toEqual([ids[2]]);
    expect(await walk(readonly, "/api/console/mail/suppressions?sort=address:asc", 1)).toEqual([ids[1], ids[0], ids[2]]);
    expect((await readonly.get("/api/console/mail/suppressions?reason=spam")).status).toBe(400);
    expect((await readonly.get("/api/console/mail/suppressions?sort=reason:asc")).status).toBe(400);

    const path = `/api/console/mail/suppressions/${ids[0]}`;
    expect((await support.call("DELETE", path, {})).status).toBe(422);
    expect((await readonly.call("DELETE", path, { reason: "Address fixed by recipient" })).status).toBe(403);
    expect((await billing.call("DELETE", path, { reason: "Address fixed by recipient" })).status).toBe(403);
    const r = await support.call("DELETE", path, { reason: "Address fixed by recipient" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await ctx.db.select().from(suppressions).where(eq(suppressions.id, ids[0]!)).get()).toBeUndefined();
    const row = await lastAudit("mail.suppression_removed");
    expect(row).toMatchObject({ targetType: "suppression", targetId: ids[0], orgId: orgA, reason: "Address fixed by recipient", actorRole: "ops_support" });
    expect(JSON.parse(row!.before!)).toEqual({ address: "bounce-route@x.test", reason: "hard_bounce" });
    // The workspace's own Activity shows the operator change too.
    const ws = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgA), eq(auditLogs.action, "mail.suppression_removed"))).get();
    expect(ws).toBeTruthy();
    expect((await support.call("DELETE", path, { reason: "Address fixed by recipient" })).status).toBe(404);
  }, 60_000);
});

describe("held sends", () => {
  it("lists held sends without content and forces one with a reason and an audit row", async () => {
    const add = async (orgId: string, mailboxId: string, dueAt: Date, status: "pending" | "returned" = "pending") => {
      const id = newId("sch");
      const payload = { via: "person", held: "Outside sending is at its limit for today", input: { mailboxId, to: [TO_ADDR], subject: SUBJECT, text: HELD_BODY } };
      await ctx.db.insert(mailSchedules).values({ id, orgId, mailboxId, kind: "send", status, dueAt, payload: JSON.stringify(payload) });
      return id;
    };
    const soon = Date.now() + 6 * HOUR;
    const hA = await add(orgA, mailboxA, new Date(soon));
    const hB = await add(orgB, mailboxB, new Date(soon + 1000));
    const sent = await add(orgB, mailboxB, new Date(soon + 2000), "returned");

    const list = await readonly.get("/api/console/mail/queued-sends");
    expect(list.status).toBe(200);
    expect(list.body.items.map((q: { id: string }) => q.id)).toEqual([hA, hB]);
    expect(list.body.items[0]).toMatchObject({ orgName: "Alpha Co", recipients: 1, forced: false, reason: "Outside sending is at its limit for today" });
    for (const s of [SUBJECT, TO_ADDR, HELD_BODY]) expect(JSON.stringify(list.body)).not.toContain(s);
    expect(await walk(readonly, "/api/console/mail/queued-sends", 1)).toEqual([hA, hB]);
    expect((await readonly.get("/api/console/mail/queued-sends?sort=subject:asc")).status).toBe(400);

    const path = `/api/console/mail/queued-sends/${hA}/send`;
    expect((await support.post(path, {})).status).toBe(422);
    expect((await readonly.post(path, { reason: "Customer is waiting on this" })).status).toBe(403);
    expect((await billing.post(path, { reason: "Customer is waiting on this" })).status).toBe(403);
    const r = await owner.post(path, { reason: "Customer is waiting on this" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.parse((await ctx.db.select().from(mailSchedules).where(eq(mailSchedules.id, hA)).get())!.payload!).force).toBe(true);
    const row = await lastAudit("mail.queued_send_forced");
    expect(row).toMatchObject({ targetType: "schedule", targetId: hA, orgId: orgA, reason: "Customer is waiting on this", actorEmail: "owner@ops.test" });
    expect(row!.after).not.toContain(HELD_BODY);

    expect((await owner.post(`/api/console/mail/queued-sends/${sent}/send`, { reason: "Customer is waiting on this" })).status).toBe(409);
    expect((await owner.post("/api/console/mail/queued-sends/sch_missing/send", { reason: "Customer is waiting on this" })).status).toBe(404);
  }, 60_000);
});

describe("workspace sending switch", () => {
  it("turns sending off and on with a reason, by support and owners only, audited on the workspace", async () => {
    const path = `/api/console/mail/workspaces/${orgB}/sending`;
    expect((await support.put(path, { enabled: false })).status).toBe(422);
    expect((await support.put(path, { reason: "Phishing reports" })).status).toBe(422);
    expect((await readonly.put(path, { enabled: false, reason: "Phishing reports" })).status).toBe(403);
    expect((await billing.put(path, { enabled: false, reason: "Phishing reports" })).status).toBe(403);
    const off = await support.put(path, { enabled: false, reason: "Phishing reports" });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ ok: true, sending: false, sendCapDaily: 0 });
    expect((await ctx.db.select().from(organizations).where(eq(organizations.id, orgB)).get())!.sendCapDaily).toBe(0);
    const row = await lastAudit("workspace.sending_off");
    expect(row).toMatchObject({ targetType: "workspace", targetId: orgB, orgId: orgB, reason: "Phishing reports" });
    expect(JSON.parse(row!.after!)).toEqual({ cap: 0 });
    expect(await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgB), eq(auditLogs.action, "workspace.sending_off"))).get()).toBeTruthy();

    const on = await owner.put(path, { enabled: true, reason: "Cleared after review" });
    expect(on.body).toMatchObject({ sending: true, sendCapDaily: null });
    expect((await lastAudit("workspace.sending_on"))).toMatchObject({ orgId: orgB, reason: "Cleared after review" });
    expect((await owner.put("/api/console/mail/workspaces/org_missing/sending", { enabled: true, reason: "Cleared after review" })).status).toBe(404);
  }, 60_000);
});

describe("connections and imports", () => {
  it("list with state filters, page, and never return credentials", async () => {
    const conns: string[] = [];
    for (const [orgId, mailboxId, email, status] of [[orgA, mailboxA, "a-route@gmail.test", "auth_failed"], [orgB, mailboxB, "b-route@gmail.test", "active"]] as const) {
      const id = newId("mcn");
      await ctx.db.insert(mailConnections).values({ id, orgId, mailboxId, provider: "gmail", email, username: email, imapHost: "imap.example", imapPort: 993, imapSecurity: "tls", smtpHost: "smtp.example", smtpPort: 465, smtpSecurity: "tls", secretEnc: CONN_SECRET, status, lastError: status === "auth_failed" ? "Invalid credentials" : null });
      conns.push(id);
    }
    const bad = await readonly.get("/api/console/mail/connections?status=auth_failed,error");
    expect(bad.status).toBe(200);
    expect(bad.body.items.map((x: { id: string }) => x.id)).toEqual([conns[0]]);
    expect(bad.body.items[0]).toMatchObject({ status: "auth_failed", lastError: "Invalid credentials", orgName: "Alpha Co" });
    expect(await walk(readonly, "/api/console/mail/connections", 1)).toHaveLength(2);
    expect(JSON.stringify((await readonly.get("/api/console/mail/connections")).body)).not.toContain(CONN_SECRET);
    expect((await readonly.get("/api/console/mail/connections?status=asleep")).status).toBe(400);

    const jobs: string[] = [];
    for (const status of ["failed", "done", "running"] as const) {
      const id = newId("imp");
      await ctx.db.insert(importJobs).values({ id, orgId: orgA, mailboxId: mailboxA, provider: "imap", sourceHost: "imap.old.test", sourceUser: "me@old.test", secretEnc: IMPORT_SECRET, status, error: status === "failed" ? "Login failed" : null });
      jobs.push(id);
    }
    const failed = await readonly.get("/api/console/mail/imports?status=failed");
    expect(failed.body.items.map((x: { id: string }) => x.id)).toEqual([jobs[0]]);
    expect(failed.body.items[0]).toMatchObject({ error: "Login failed", sourceHost: "imap.old.test" });
    expect((await walk(readonly, "/api/console/mail/imports", 2)).sort()).toEqual([...jobs].sort());
    expect(JSON.stringify((await readonly.get("/api/console/mail/imports")).body)).not.toContain(IMPORT_SECRET);
    expect((await readonly.get("/api/console/mail/imports?status=lost")).status).toBe(400);
    expect((await readonly.get("/api/console/mail/imports?sort=status:asc")).status).toBe(400);
  }, 60_000);
});
