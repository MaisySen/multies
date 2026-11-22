import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliveries, domains, importJobs, mailboxes, mailConnections, mailSchedules, organizations, suppressions } from "@/server/db/schema";
import { newId } from "@/server/lib/crypto";
import {
  DELIVERY_SORT_FIELDS, DOMAIN_SORT_FIELDS, IMPORT_JOB_SORT_FIELDS, MAIL_CONNECTION_SORT_FIELDS, QUEUED_SEND_SORT_FIELDS, SUPPRESSION_SORT_FIELDS,
  deliveryFailureRateByWorkspace, forceQueuedSend, listDeliveries, listDomains, listImportJobs, listMailConnections, listQueuedSendsAll, listSuppressions,
  recheckDomain, removeSuppression, setWorkspaceSending, type Page, type PageCursor, type PageRequest,
} from "@/server/services/console/mail";

/** OPS1: the console's Mail and deliverability data layer, called directly over real data in two workspaces. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let orgA: string;
let orgB: string;
let domainA: string;
let domainB: string;
let mailboxA: string;
let mailboxB: string;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function workspace(email: string, name: string, domain: string) {
  const c = new Client(ctx.app);
  await c.signup(email, "Someone", name);
  const orgId = (await c.get("/api/account/me")).body.organization.id as string;
  const r = await c.post("/api/domains", { name: domain });
  expect(r.status).toBe(201);
  const domainId = r.body.domain.id as string;
  const mailboxId = newId("mbx");
  await ctx.db.insert(mailboxes).values({ id: mailboxId, orgId, domainId, localPart: "hello", address: `hello@${domain}`, displayName: "Hello", quotaMb: 100 });
  return { c, orgId, domainId, mailboxId };
}

beforeEach(async () => {
  ctx = await makeTestApp();
  ({ orgId: orgA, domainId: domainA, mailboxId: mailboxA } = await workspace("a@alpha.io", "Alpha Co", "alpha.io"));
  ({ orgId: orgB, domainId: domainB, mailboxId: mailboxB } = await workspace("b@beta.io", "Beta Co", "beta.io"));
}, 120_000);

const page = (field: string, dir: "asc" | "desc" = "desc", limit = 50, cursor: PageCursor | null = null): PageRequest => ({ limit, cursor, sort: { field, dir } });

/** Walks every page and returns the ids in order. */
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

async function addDelivery(orgId: string, status: (typeof deliveries.$inferSelect)["status"], at: Date, extra: Partial<typeof deliveries.$inferInsert> = {}) {
  const id = newId("dlv");
  await ctx.db.insert(deliveries).values({ id, orgId, direction: "outbound", fromAddress: "hello@alpha.io", toAddress: `to-${id}@outside.example`, subject: "PLANTED-DELIVERY-SUBJECT-h2Vx7", status, provider: "log", detail: "550 mailbox unavailable", createdAt: at, ...extra });
  return id;
}

describe("deliveries", () => {
  it("default to failures in the last 7 days, filter by workspace, status, direction and address, and never return the subject", async () => {
    const now = Date.now();
    const fA = await addDelivery(orgA, "bounced", new Date(now - HOUR));
    const fB = await addDelivery(orgB, "failed", new Date(now - 2 * HOUR));
    await addDelivery(orgA, "delivered", new Date(now - HOUR));
    const old = await addDelivery(orgA, "bounced", new Date(now - 8 * DAY));
    const inbound = await addDelivery(orgB, "rejected", new Date(now - 3 * HOUR), { direction: "inbound", toAddress: "hello@beta.io", fromAddress: "spam@bad.example" });

    const all = await listDeliveries(ctx.deps, {}, page("createdAt"));
    expect(all.items.map((d) => d.id)).toEqual([fA, fB, inbound]);
    expect(all.next).toBeNull();
    expect(all.items[0]).toMatchObject({ orgId: orgA, orgName: "Alpha Co", status: "bounced", detail: "550 mailbox unavailable" });
    expect(JSON.stringify(all)).not.toContain("PLANTED-DELIVERY-SUBJECT-h2Vx7");
    expect(Object.keys(all.items[0]!)).not.toContain("subject");

    expect((await listDeliveries(ctx.deps, { orgId: orgB }, page("createdAt"))).items.map((d) => d.id)).toEqual([fB, inbound]);
    const delivered = await listDeliveries(ctx.deps, { status: ["delivered"] }, page("createdAt"));
    expect(delivered.items).toHaveLength(1);
    // Unscoped and not failures: only the newest rows were read, and the page says so.
    expect(delivered.recentOnly).toBe(true);
    expect(delivered.items[0]).toHaveProperty("ownerEmail");
    expect(all.recentOnly).toBeUndefined();
    expect((await listDeliveries(ctx.deps, { status: ["delivered"], orgId: orgB }, page("createdAt"))).recentOnly).toBeUndefined();
    expect((await listDeliveries(ctx.deps, { direction: "inbound" }, page("createdAt"))).items.map((d) => d.id)).toEqual([inbound]);
    expect((await listDeliveries(ctx.deps, { q: "SPAM@bad" }, page("createdAt"))).items.map((d) => d.id)).toEqual([inbound]);
    // The window bounds both ends: the 8 day old bounce only shows in a window that reaches it.
    const wide = await listDeliveries(ctx.deps, { window: { from: new Date(now - 9 * DAY), to: new Date(now - 7 * DAY) } }, page("createdAt"));
    expect(wide.items.map((d) => d.id)).toEqual([old]);
  }, 120_000);

  it("pages by (createdAt, id) with no duplicates or gaps, ties included, in both directions", async () => {
    const t = Date.now() - HOUR;
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push(await addDelivery(i % 2 ? orgA : orgB, "failed", new Date(t - Math.floor(i / 3) * 1000)));
    const desc = await walk((p) => listDeliveries(ctx.deps, {}, p), "createdAt", "desc", 4);
    expect(desc).toHaveLength(11);
    expect(new Set(desc).size).toBe(11);
    expect(new Set(desc)).toEqual(new Set(ids));
    const asc = await walk((p) => listDeliveries(ctx.deps, {}, p), "createdAt", "asc", 3);
    expect(asc).toEqual([...desc].reverse());
  }, 120_000);

  it("refuses a sort field off the whitelist, a bad cursor, an unknown status and an over-wide or inverted window", async () => {
    expect(DELIVERY_SORT_FIELDS).toEqual(["createdAt"]);
    await expect(listDeliveries(ctx.deps, {}, page("toAddress"))).rejects.toMatchObject({ status: 400 });
    await expect(listDeliveries(ctx.deps, {}, page("createdAt", "desc", 10, { v: "x", id: "a" }))).rejects.toMatchObject({ status: 400 });
    await expect(listDeliveries(ctx.deps, { status: ["nope" as never] }, page("createdAt"))).rejects.toMatchObject({ status: 400 });
    const now = Date.now();
    await expect(listDeliveries(ctx.deps, { window: { from: new Date(now - 100 * DAY), to: new Date(now) } }, page("createdAt"))).rejects.toMatchObject({ status: 400 });
    await expect(listDeliveries(ctx.deps, { window: { from: new Date(now), to: new Date(now - DAY) } }, page("createdAt"))).rejects.toMatchObject({ status: 400 });
  }, 120_000);

  it("ranks workspaces by outbound failure rate in the window, with a minimum volume", async () => {
    const t = new Date(Date.now() - HOUR);
    for (let i = 0; i < 10; i++) await addDelivery(orgA, i < 2 ? "bounced" : "delivered", t); // 20%
    for (let i = 0; i < 10; i++) await addDelivery(orgB, i < 5 ? (i === 0 ? "complained" : "failed") : "sent", t); // 50%
    await addDelivery(orgB, "failed", new Date(Date.now() - 10 * DAY)); // outside the window
    await addDelivery(orgA, "rejected", t, { direction: "inbound" }); // inbound is not counted
    const top = await deliveryFailureRateByWorkspace(ctx.deps, { limit: 5 });
    expect(top.map((r) => r.orgId)).toEqual([orgB, orgA]);
    expect(top[0]).toEqual({ orgId: orgB, orgName: "Beta Co", ownerEmail: "b@beta.io", total: 10, failed: 5, bounced: 0, complained: 1, failureRate: 0.5 });
    expect(top[1]).toMatchObject({ total: 10, failed: 2, bounced: 2, failureRate: 0.2 });
    expect(await deliveryFailureRateByWorkspace(ctx.deps, { limit: 1 })).toHaveLength(1);
    expect(await deliveryFailureRateByWorkspace(ctx.deps, { minTotal: 11 })).toEqual([]);
  }, 120_000);
});

describe("domains", () => {
  it("lists across workspaces with status, workspace and name filters, without keys or tokens, and pages by name", async () => {
    await ctx.db.update(domains).set({ status: "failed" }).where(eq(domains.id, domainB));
    const all = await listDomains(ctx.deps, {}, page("name", "asc"));
    expect(all.items.map((d) => d.name)).toEqual(["alpha.io", "beta.io"]);
    expect(all.items[0]).toMatchObject({ orgId: orgA, orgName: "Alpha Co", status: "pending" });
    const json = JSON.stringify(all);
    for (const secret of ["dkimPrivateKeyEnc", "dkimPublicKey", "verificationToken", "providerRecords"]) expect(json).not.toContain(secret);
    const row = await ctx.db.select().from(domains).where(eq(domains.id, domainA)).get();
    expect(json).not.toContain(row!.verificationToken);
    expect(json).not.toContain(row!.dkimPrivateKeyEnc);
    expect((await listDomains(ctx.deps, { status: ["failed"] }, page("createdAt"))).items.map((d) => d.id)).toEqual([domainB]);
    expect((await listDomains(ctx.deps, { orgId: orgA }, page("createdAt"))).items.map((d) => d.id)).toEqual([domainA]);
    expect((await listDomains(ctx.deps, { q: "BETA" }, page("createdAt"))).items.map((d) => d.id)).toEqual([domainB]);
    expect(await walk((p) => listDomains(ctx.deps, {}, p), "name", "desc", 1)).toEqual([domainB, domainA]);
    expect(DOMAIN_SORT_FIELDS).toContain("lastCheckedAt");
    await expect(listDomains(ctx.deps, {}, page("dkimPrivateKeyEnc"))).rejects.toMatchObject({ status: 400 });
  }, 120_000);

  it("recheckDomain runs the live DNS check and records the outcome", async () => {
    const before = await recheckDomain(ctx.deps, domainA);
    expect(before).toMatchObject({ id: domainA, orgId: orgA, name: "alpha.io", before: "pending", status: "pending", verified: false, changed: false });
    expect(before.failingRecords.length).toBeGreaterThan(0);
    // Publish the records the domain asks for, then check again.
    const c = new Client(ctx.app);
    await c.login("a@alpha.io");
    const { body } = await c.get(`/api/domains/${domainA}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    const after = await recheckDomain(ctx.deps, domainA);
    expect(after).toMatchObject({ before: "pending", status: "verified", verified: true, changed: true });
    expect((await ctx.db.select().from(domains).where(eq(domains.id, domainA)).get())!.status).toBe("verified");
    expect((await listDomains(ctx.deps, { status: ["verified"] }, page("lastCheckedAt"))).items.map((d) => d.id)).toEqual([domainA]);
    await expect(recheckDomain(ctx.deps, "dom_missing")).rejects.toMatchObject({ status: 404 });
  }, 120_000);
});

describe("suppressions", () => {
  async function addSup(orgId: string, address: string, reason: (typeof suppressions.$inferSelect)["reason"], at = new Date()) {
    const id = newId("sup");
    await ctx.db.insert(suppressions).values({ id, orgId, address, reason, createdAt: at });
    return id;
  }

  it("filters by workspace, reason and address, bounds an unscoped list by window, pages by address, and removes one", async () => {
    const a1 = await addSup(orgA, "bounce@x.example", "hard_bounce");
    const a2 = await addSup(orgA, "angry@x.example", "complaint");
    const b1 = await addSup(orgB, "manual@y.example", "manual");
    const oldB = await addSup(orgB, "old@y.example", "hard_bounce", new Date(Date.now() - 40 * DAY));

    const recent = await listSuppressions(ctx.deps, {}, page("createdAt"));
    expect(new Set(recent.items.map((s) => s.id))).toEqual(new Set([a1, a2, b1])); // default 30 day window
    expect((await listSuppressions(ctx.deps, { orgId: orgB }, page("createdAt"))).items.map((s) => s.id)).toEqual([b1, oldB]); // the index bounds a workspace
    expect((await listSuppressions(ctx.deps, { reason: ["complaint"] }, page("createdAt"))).items.map((s) => s.id)).toEqual([a2]);
    expect((await listSuppressions(ctx.deps, { q: "MANUAL@" }, page("createdAt"))).items.map((s) => s.id)).toEqual([b1]);
    expect(await walk((p) => listSuppressions(ctx.deps, { orgId: orgA }, p), "address", "asc", 1)).toEqual([a2, a1]);
    expect(recent.items.find((s) => s.id === b1)).toMatchObject({ orgName: "Beta Co", address: "manual@y.example", reason: "manual" });
    expect(SUPPRESSION_SORT_FIELDS).toEqual(["createdAt", "address"]);
    await expect(listSuppressions(ctx.deps, {}, page("reason"))).rejects.toMatchObject({ status: 400 });

    expect(await removeSuppression(ctx.deps, a1)).toEqual({ id: a1, orgId: orgA, address: "bounce@x.example", reason: "hard_bounce" });
    expect(await ctx.db.select().from(suppressions).where(eq(suppressions.id, a1)).get()).toBeUndefined();
    await expect(removeSuppression(ctx.deps, a1)).rejects.toMatchObject({ status: 404 });
  }, 120_000);
});

describe("queued sends and the kill switch", () => {
  async function addHeld(orgId: string, mailboxId: string, dueAt: Date, held: string | null, kind: "send" | "snooze" = "send") {
    const id = newId("sch");
    const payload = { via: "person", input: { mailboxId, to: ["planted-to-a4Rk9@outside.example", "planted-to-b6Ln2@outside.example"], cc: ["planted-cc-c8Pq5@outside.example"], subject: "PLANTED-QUEUED-SUBJECT-w3Jt8", text: "PLANTED-QUEUED-BODY-e7Gz1" }, ...(held ? { held } : {}) };
    await ctx.db.insert(mailSchedules).values({ id, orgId, mailboxId, kind, status: "pending", dueAt, payload: JSON.stringify(payload) });
    return id;
  }

  it("lists only sends a limit held, across workspaces, without subject, body or recipients, and force-sends one", async () => {
    const midnight = new Date(Date.now() + 6 * HOUR);
    const hA = await addHeld(orgA, mailboxA, midnight, "New workspaces send to 20 outside recipients a day");
    const hB = await addHeld(orgB, mailboxB, new Date(midnight.getTime() + 1000), "Outside sending is at its limit for today");
    await addHeld(orgA, mailboxA, midnight, null); // a plain scheduled send
    await addHeld(orgB, mailboxB, midnight, null, "snooze");
    await addHeld(orgB, mailboxB, new Date(Date.now() + 30 * DAY), "Far away"); // outside the default window

    const list = await listQueuedSendsAll(ctx.deps, {}, page("dueAt", "asc"));
    expect(list.items.map((q) => q.id)).toEqual([hA, hB]);
    expect(list.items[0]).toMatchObject({ orgId: orgA, orgName: "Alpha Co", mailboxAddress: "hello@alpha.io", recipients: 3, forced: false, reason: "New workspaces send to 20 outside recipients a day" });
    const json = JSON.stringify(list);
    for (const s of ["PLANTED-QUEUED-SUBJECT-w3Jt8", "PLANTED-QUEUED-BODY-e7Gz1", "planted-to-a4Rk9", "planted-to-b6Ln2", "planted-cc-c8Pq5"]) expect(json).not.toContain(s);
    expect((await listQueuedSendsAll(ctx.deps, { orgId: orgB }, page("dueAt"))).items.map((q) => q.id)).toEqual([hB]);
    expect(await walk((p) => listQueuedSendsAll(ctx.deps, {}, p), "dueAt", "desc", 1)).toEqual([hB, hA]);
    expect(QUEUED_SEND_SORT_FIELDS).toContain("createdAt");
    await expect(listQueuedSendsAll(ctx.deps, {}, page("subject"))).rejects.toMatchObject({ status: 400 });

    const out = await forceQueuedSend(ctx.deps, orgA, hA);
    expect(out).toMatchObject({ ok: true, id: hA });
    const row = await ctx.db.select().from(mailSchedules).where(eq(mailSchedules.id, hA)).get();
    expect(JSON.parse(row!.payload!).force).toBe(true);
    expect(row!.dueAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await listQueuedSendsAll(ctx.deps, { orgId: orgA }, page("dueAt"))).items[0]!.forced).toBe(true);
    // The workspace must match: another workspace's id is not found.
    await expect(forceQueuedSend(ctx.deps, orgB, hA)).rejects.toMatchObject({ status: 404 });
  }, 120_000);

  it("setWorkspaceSending switches a workspace's sending off and back to its plan cap", async () => {
    expect(await setWorkspaceSending(ctx.deps, orgA, false)).toEqual({ orgId: orgA, sending: false, sendCapDaily: 0, before: { sendCapDaily: null } });
    expect((await ctx.db.select().from(organizations).where(eq(organizations.id, orgA)).get())!.sendCapDaily).toBe(0);
    expect((await ctx.db.select().from(organizations).where(eq(organizations.id, orgB)).get())!.sendCapDaily).toBeNull();
    expect(await setWorkspaceSending(ctx.deps, orgA, true)).toEqual({ orgId: orgA, sending: true, sendCapDaily: null, before: { sendCapDaily: 0 } });
    await expect(setWorkspaceSending(ctx.deps, "org_missing", true)).rejects.toMatchObject({ status: 404 });
  }, 120_000);
});

describe("mail connections and imports", () => {
  it("lists connections with status, workspace and address filters and no credentials or sync state", async () => {
    const ids: string[] = [];
    for (const [orgId, mailboxId, email, status] of [[orgA, mailboxA, "ann@gmail.com", "active"], [orgB, mailboxB, "bob@outlook.com", "auth_failed"]] as const) {
      const id = newId("conn");
      ids.push(id);
      await ctx.db.insert(mailConnections).values({ id, orgId, mailboxId, provider: "gmail", email, username: email, imapHost: "imap.example", imapPort: 993, imapSecurity: "tls", smtpHost: "smtp.example", smtpPort: 465, smtpSecurity: "tls", secretEnc: "PLANTED-CONN-SECRET-n5Bv3", syncState: "{\"PLANTED-SYNC-FOLDER-u2Xc6\":{\"uid\":42}}", status, lastError: status === "auth_failed" ? "Invalid credentials" : null });
    }
    const all = await listMailConnections(ctx.deps, {}, page("email", "asc"));
    expect(all.items.map((c) => c.email)).toEqual(["ann@gmail.com", "bob@outlook.com"]);
    expect(all.items[1]).toMatchObject({ orgId: orgB, orgName: "Beta Co", status: "auth_failed", lastError: "Invalid credentials", authKind: "password" });
    const json = JSON.stringify(all);
    for (const s of ["PLANTED-CONN-SECRET-n5Bv3", "secretEnc", "syncState", "PLANTED-SYNC-FOLDER-u2Xc6"]) expect(json).not.toContain(s);
    expect((await listMailConnections(ctx.deps, { status: ["auth_failed", "error"] }, page("createdAt"))).items.map((c) => c.id)).toEqual([ids[1]]);
    expect((await listMailConnections(ctx.deps, { orgId: orgA }, page("lastSyncAt"))).items.map((c) => c.id)).toEqual([ids[0]]);
    expect((await listMailConnections(ctx.deps, { q: "OUTLOOK" }, page("createdAt"))).items.map((c) => c.id)).toEqual([ids[1]]);
    expect(await walk((p) => listMailConnections(ctx.deps, {}, p), "email", "desc", 1)).toEqual([ids[1], ids[0]]);
    expect(MAIL_CONNECTION_SORT_FIELDS).toEqual(["createdAt", "lastSyncAt", "email"]);
    await expect(listMailConnections(ctx.deps, {}, page("secretEnc"))).rejects.toMatchObject({ status: 400 });
  }, 120_000);

  it("lists imports by status and workspace, bounds an unfiltered list by window, and never returns the source password", async () => {
    const add = async (orgId: string, mailboxId: string, status: (typeof importJobs.$inferSelect)["status"], at = new Date()) => {
      const id = newId("imp");
      await ctx.db.insert(importJobs).values({ id, orgId, mailboxId, provider: "imap", sourceHost: "imap.old.example", sourceUser: "me@old.example", secretEnc: "PLANTED-IMPORT-SECRET-k1Dw4", status, error: status === "failed" ? "Login failed" : null, createdAt: at });
      return id;
    };
    const failedA = await add(orgA, mailboxA, "failed");
    const doneB = await add(orgB, mailboxB, "done");
    const oldFailedB = await add(orgB, mailboxB, "failed", new Date(Date.now() - 60 * DAY));
    const all = await listImportJobs(ctx.deps, {}, page("createdAt"));
    expect(new Set(all.items.map((j) => j.id))).toEqual(new Set([failedA, doneB]));
    expect(JSON.stringify(all)).not.toContain("PLANTED-IMPORT-SECRET-k1Dw4");
    expect(JSON.stringify(all)).not.toContain("secretEnc");
    expect((await listImportJobs(ctx.deps, { status: ["failed"] }, page("createdAt"))).items.map((j) => j.id)).toEqual([failedA, oldFailedB]);
    expect((await listImportJobs(ctx.deps, { orgId: orgB }, page("createdAt", "asc"))).items.map((j) => j.id)).toEqual([oldFailedB, doneB]);
    expect((await listImportJobs(ctx.deps, { status: ["failed"] }, page("createdAt"))).items[0]).toMatchObject({ orgName: "Alpha Co", error: "Login failed", sourceHost: "imap.old.example" });
    expect(await walk((p) => listImportJobs(ctx.deps, { status: ["failed", "done"] }, p), "createdAt", "desc", 1)).toHaveLength(3);
    expect(IMPORT_JOB_SORT_FIELDS).toEqual(["createdAt"]);
    await expect(listImportJobs(ctx.deps, {}, page("status"))).rejects.toMatchObject({ status: 400 });
  }, 120_000);
});
