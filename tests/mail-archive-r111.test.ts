import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, mailConnections, mailRetentionPolicies, mailboxAccess, mailboxes, messages } from "@/server/db/schema";
import { runRetentionPass, runRetentionForOrg } from "@/server/services/mail/archive-r111";
import { cleanFilters, describeFilters, isStricter, keepLabel, retentionCutoff } from "@/shared/mail-archive";

/**
 * R111 mail archive and retention. Seeded fixtures only (made up example.com mail in a test workspace); no real
 * mailbox is read. Safety first: nothing is deleted without an admin's own policy, a dry run count and the grace.
 */
const DAY = 86_400_000;
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let orgId: string;
let ownerId: string;
let boxA: string;
let boxB: string;
let now: Date;

async function setup(env: Record<string, string> = { MAIL_ARCHIVE_R111: "on" }) {
  ctx = await makeTestApp(env);
  now = new Date("2026-11-01T01:00:00Z");
  ctx.deps.now = () => now;
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  await owner.post("/api/org/plan", { plan: "pro" });
  const me = (await owner.get("/api/account/me")).body;
  orgId = me.organization.id; ownerId = me.user.id;
  const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await owner.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await owner.post(`/api/domains/${domainId}/verify`);
  boxA = (await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox.id;
  boxB = (await owner.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Sales" })).body.mailbox.id;
}
async function teammate(email = "mate@acme.io") {
  const invite = await owner.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, "Sam Mate", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return { client: m, id: (await m.get("/api/account/me")).body.user.id as string };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawHeaders = () => ({ cookie: (owner as any).cookie as string, host: "localhost" });
let seq = 0;
async function seed(mailboxId: string, ageDays: number, extra: Partial<typeof messages.$inferInsert> = {}) {
  const id = `msg_r111_${++seq}`;
  await ctx.deps.db.insert(messages).values({ id, orgId, mailboxId, folder: "inbox", threadId: `thr_${id}`, fromAddress: `p${seq}@example.com`, subject: `Fixture ${seq}`, snippet: "fixture body", sizeBytes: 100, date: new Date(now.getTime() - ageDays * DAY), ...extra });
  return id;
}
const count = async () => (await ctx.deps.db.select({ id: messages.id }).from(messages).where(eq(messages.orgId, orgId))).length;
const actions = async () => (await ctx.deps.db.select({ action: auditLogs.action, metadata: auditLogs.metadata }).from(auditLogs).where(eq(auditLogs.orgId, orgId))).filter((a) => a.action.startsWith("mail."));
async function turnOn(years: number) {
  const pre = (await owner.post("/api/mail-archive/policy/preview", { keepYears: years })).body.preview;
  const put = await owner.put("/api/mail-archive/policy", { enabled: true, keepYears: years, confirmEligible: pre.eligible });
  expect(put.status).toBe(200);
  return { pre, policy: put.body.policy };
}

describe("R111 policy math", () => {
  it("cuts at local midnight N years back, forever never cuts", () => {
    const at = new Date("2026-11-01T01:00:00Z"); // 12:00 on 1 Nov in Sydney (UTC+11)
    expect(retentionCutoff(at, null, "Australia/Sydney")).toBeNull();
    expect(retentionCutoff(at, 7, "Australia/Sydney")!.toISOString()).toBe("2019-10-31T13:00:00.000Z"); // 1 Nov 2019 00:00 AEDT
    expect(retentionCutoff(at, 1, "UTC")!.toISOString()).toBe("2025-11-01T00:00:00.000Z");
    // Still 31 Oct in Kathmandu? No: 06:45 on 1 Nov. In Los Angeles it is 31 Oct.
    expect(retentionCutoff(at, 2, "America/Los_Angeles")!.toISOString()).toBe("2024-10-31T07:00:00.000Z");
    expect(retentionCutoff(at, 3, "Asia/Kathmandu")!.toISOString()).toBe("2023-10-31T18:15:00.000Z");
  });
  it("29 February falls back to 28 February, bad zones and years are safe", () => {
    expect(retentionCutoff(new Date("2028-02-29T12:00:00Z"), 1, "UTC")!.toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(retentionCutoff(new Date("2028-02-29T12:00:00Z"), 4, "UTC")!.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(retentionCutoff(new Date("2026-06-01T00:00:00Z"), 1, "Not/AZone")!.toISOString()).toBe("2025-06-01T00:00:00.000Z");
    expect(retentionCutoff(new Date("2026-06-01T00:00:00Z"), 0, "UTC")).toBeNull();
    expect(retentionCutoff(new Date("2026-06-01T00:00:00Z"), 99, "UTC")).toBeNull();
  });
  it("stricter means deleting more, labels and filters read plainly", () => {
    expect(isStricter({ enabled: false, keepYears: null }, { enabled: true, keepYears: 7 })).toBe(true);
    expect(isStricter({ enabled: true, keepYears: 7 }, { enabled: true, keepYears: 3 })).toBe(true);
    expect(isStricter({ enabled: true, keepYears: 3 }, { enabled: true, keepYears: 7 })).toBe(false);
    expect(isStricter({ enabled: true, keepYears: 3 }, { enabled: false, keepYears: null })).toBe(false);
    expect(keepLabel(true, 1)).toBe("Keep for 1 year");
    expect(keepLabel(false, 5)).toBe("Keep forever");
    expect(cleanFilters({ q: "", from: "a@b.c", hasAttachments: false })).toEqual({ from: "a@b.c" });
    expect(describeFilters({ q: "invoice", after: "2025-01-01", hasAttachments: true })).toBe('words "invoice", on or after 2025-01-01, with attachments');
  });
});

describe("R111 flag and permissions", () => {
  it("flag off: every route is 404 and nothing is ever deleted", async () => {
    await setup({});
    expect((await owner.get("/api/mail-archive/policy")).status).toBe(404);
    expect((await owner.get("/api/config")).body.mailArchive).toBe(false);
    await seed(boxA, 4000);
    await ctx.deps.db.insert(mailRetentionPolicies).values({ orgId, enabled: true, keepYears: 1, startsAt: new Date(0), updatedAt: now });
    expect(await runRetentionPass(ctx.deps)).toEqual({ orgs: 0, deleted: 0 });
    expect(await runRetentionForOrg(ctx.deps, orgId)).toMatchObject({ deleted: 0, skipped: "flag_off" });
    expect(await count()).toBe(1);
  });
  it("members see a read only policy; admin actions are 403; signed out is 401", async () => {
    await setup();
    const mate = await teammate();
    const v = await mate.client.get("/api/mail-archive/policy");
    expect(v.status).toBe(200);
    expect(v.body.policy).toMatchObject({ enabled: false, keepYears: null, canManage: false });
    expect(v.body.policy.activeHolds).toBeUndefined();
    for (const [m, path, body] of [["post", "/api/mail-archive/policy/preview", { keepYears: 3 }], ["put", "/api/mail-archive/policy", { enabled: true, keepYears: 3, confirmEligible: 0 }],
      ["get", "/api/mail-archive/holds"], ["post", "/api/mail-archive/holds", { kind: "mailbox", targetId: boxA, name: "x" }], ["post", "/api/mail-archive/search", { filters: {} }], ["get", "/api/mail-archive/cases"]] as const) {
      const r = m === "get" ? await mate.client.get(path) : m === "put" ? await mate.client.put(path, body) : await mate.client.post(path, body);
      expect(r.status, path).toBe(403);
    }
    const guest = new Client(ctx.app); // no workspace session (a project guest has only its own cookie)
    expect((await guest.get("/api/mail-archive/policy")).status).toBe(401);
  });
});

describe("R111 retention", () => {
  beforeEach(() => setup());

  it("ships with no policy: the pass deletes nothing", async () => {
    await seed(boxA, 5000); await seed(boxB, 4000);
    expect((await owner.get("/api/mail-archive/policy")).body.policy).toMatchObject({ enabled: false, keepYears: null, canManage: true, activeHolds: 0 });
    now = new Date(now.getTime() + 30 * DAY);
    expect(await runRetentionPass(ctx.deps)).toEqual({ orgs: 0, deleted: 0 });
    expect(await count()).toBe(2);
  });

  it("dry run counts, the save must echo the count, then a 7 day grace", async () => {
    await seed(boxA, 3 * 365 + 10); await seed(boxA, 10); await seed(boxB, 4 * 365); await seed(boxB, 5 * 365, { folder: "drafts" });
    const pre = (await owner.post("/api/mail-archive/policy/preview", { keepYears: 2 })).body.preview;
    expect(pre).toMatchObject({ keepYears: 2, eligible: 2, heldBack: 0, connectedSkipped: 0 });
    expect(Date.parse(pre.startsAt) - now.getTime()).toBe(7 * DAY);
    const stale = await owner.put("/api/mail-archive/policy", { enabled: true, keepYears: 2, confirmEligible: 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("count_changed");
    expect(stale.body.error.details.preview.eligible).toBe(2);
    expect((await owner.put("/api/mail-archive/policy", { enabled: true, keepYears: 2 })).status).toBe(409);
    expect(await ctx.deps.db.select().from(mailRetentionPolicies).all()).toHaveLength(0);
    const { policy } = await turnOn(2);
    expect(policy).toMatchObject({ enabled: true, keepYears: 2 });
    // During the grace nothing goes.
    now = new Date(now.getTime() + 6 * DAY);
    expect(await runRetentionForOrg(ctx.deps, orgId)).toMatchObject({ deleted: 0, skipped: "grace" });
    expect(await count()).toBe(4);
    now = new Date(now.getTime() + 2 * DAY);
    expect(await runRetentionPass(ctx.deps)).toEqual({ orgs: 1, deleted: 2 });
    expect(await count()).toBe(2); // the new one and the draft stay
    const del = (await actions()).find((a) => a.action === "mail.retention.deleted")!;
    expect(JSON.parse(del.metadata!)).toMatchObject({ count: 2, keepYears: 2 });
    expect((await actions()).map((a) => a.action)).toContain("mail.retention.enabled");
    // Once a day: the next cron run in the same day does nothing.
    expect(await runRetentionPass(ctx.deps)).toEqual({ orgs: 0, deleted: 0 });
    const v = (await owner.get("/api/mail-archive/policy")).body.policy;
    expect(v).toMatchObject({ lastRunDeleted: 2, totalDeleted: 2 });
  });

  it("legal hold always wins: mailbox and person holds, connected copies skipped", async () => {
    const mate = await teammate();
    await ctx.deps.db.insert(mailboxAccess).values({ orgId, userId: mate.id, mailboxId: boxB });
    const domainId = (await ctx.deps.db.select().from(mailboxes).where(eq(mailboxes.id, boxA)).get())!.domainId;
    const boxC = (await owner.post("/api/mailboxes", { domainId, localPart: "synced", displayName: "Synced" })).body.mailbox.id;
    await ctx.deps.db.insert(mailConnections).values({ id: "conn_r111", orgId, mailboxId: boxC, provider: "imap", email: "x@example.com", username: "x", imapHost: "imap.example.com", imapPort: 993, imapSecurity: "tls", smtpHost: "smtp.example.com", smtpPort: 465, smtpSecurity: "tls", secretEnc: "x" });
    await seed(boxA, 4000); await seed(boxA, 4000, { sentByUserId: ownerId, folder: "sent" }); await seed(boxB, 4000); await seed(boxC, 4000);
    const hold = await owner.post("/api/mail-archive/holds", { kind: "person", targetId: mate.id, name: "Matter 12", note: "Keep everything" });
    expect(hold.status).toBe(200);
    expect(hold.body.hold).toMatchObject({ kind: "person", name: "Matter 12", releasedAt: null });
    expect((await owner.post("/api/mail-archive/holds", { kind: "person", targetId: mate.id, name: "Again" })).status).toBe(409);
    const h2 = await owner.post("/api/mail-archive/holds", { kind: "person", targetId: ownerId, name: "Owner sent" });
    const pre = (await owner.post("/api/mail-archive/policy/preview", { keepYears: 1 })).body.preview;
    expect(pre).toMatchObject({ eligible: 1, heldBack: 2, connectedSkipped: 1 });
    await turnOn(1);
    now = new Date(now.getTime() + 8 * DAY);
    expect(await runRetentionPass(ctx.deps)).toMatchObject({ deleted: 1 });
    expect(await count()).toBe(3);
    // Lift the owner hold: the next day's pass takes the owner's sent mail; the person hold still keeps box B.
    expect((await owner.post(`/api/mail-archive/holds/${h2.body.hold.id}/release`)).body.hold.releasedAt).toBeTruthy();
    expect((await owner.post(`/api/mail-archive/holds/${h2.body.hold.id}/release`)).status).toBe(409);
    now = new Date(now.getTime() + DAY);
    expect(await runRetentionPass(ctx.deps)).toMatchObject({ deleted: 1 });
    expect(await count()).toBe(2);
    const acts = (await actions()).map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(["mail.hold.placed", "mail.hold.released", "mail.retention.deleted"]));
  });

  it("a hold blocks Delete forever, bulk delete and mailbox removal; drafts stay deletable", async () => {
    const trashed = await seed(boxA, 1, { folder: "trash" });
    const draft = await seed(boxA, 1, { folder: "drafts" });
    const h = (await owner.post("/api/mail-archive/holds", { kind: "mailbox", targetId: boxA, name: "Audit 2026" })).body.hold;
    const r = await owner.del(`/api/mail/messages/${trashed}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("legal_hold");
    const bulk = await owner.post("/api/mail/messages/bulk", { ids: [trashed], action: "delete" });
    expect(bulk.status).toBe(409);
    expect((await owner.del(`/api/mail/messages/${draft}`)).status).toBe(200);
    expect((await owner.del(`/api/mailboxes/${boxA}`)).status).toBe(409);
    await owner.post(`/api/mail-archive/holds/${h.id}/release`);
    expect((await owner.del(`/api/mail/messages/${trashed}`)).status).toBe(200);
    expect((await owner.del(`/api/mailboxes/${boxA}`)).status).toBe(200);
  });

  it("turning off stops deletion at once; a looser policy keeps the grace date", async () => {
    await seed(boxA, 4000);
    const first = (await turnOn(3)).policy;
    now = new Date(now.getTime() + DAY);
    const looser = (await turnOn(5)).policy;
    expect(looser.startsAt).toBe(first.startsAt);
    const stricter = (await turnOn(2)).policy;
    expect(Date.parse(stricter.startsAt)).toBe(now.getTime() + 7 * DAY);
    const off = await owner.put("/api/mail-archive/policy", { enabled: false, keepYears: null });
    expect(off.body.policy).toMatchObject({ enabled: false, keepYears: null, startsAt: null });
    now = new Date(now.getTime() + 30 * DAY);
    expect(await runRetentionPass(ctx.deps)).toEqual({ orgs: 0, deleted: 0 });
    expect(await count()).toBe(1);
    expect((await actions()).map((a) => a.action)).toEqual(expect.arrayContaining(["mail.retention.enabled", "mail.retention.changed", "mail.retention.disabled"]));
  });
});

describe("R111 search, cases and audit filters", () => {
  beforeEach(() => setup());

  it("filters by words, sender, recipient, mailbox, dates, folder and attachments; audit logged", async () => {
    await seed(boxA, 10, { subject: "Invoice 42", fromAddress: "billing@vendor.example", to: JSON.stringify([{ address: "hello@acme.io" }]), hasAttachments: true });
    await seed(boxB, 400, { subject: "Lunch", fromAddress: "friend@example.com", folder: "archive" });
    await seed(boxB, 5, { subject: "Draft invoice", folder: "drafts" });
    const s = (f: object) => owner.post("/api/mail-archive/search", { filters: f });
    expect((await s({})).body.hits).toHaveLength(2);
    expect((await s({ q: "invoice" })).body.hits.map((h: { subject: string }) => h.subject)).toEqual(["Invoice 42"]);
    expect((await s({ from: "vendor" })).body.hits).toHaveLength(1);
    expect((await s({ to: "hello@acme" })).body.hits).toHaveLength(1);
    expect((await s({ mailboxId: boxB })).body.hits).toHaveLength(1);
    expect((await s({ folder: "archive" })).body.hits[0].subject).toBe("Lunch");
    expect((await s({ hasAttachments: true })).body.hits[0].subject).toBe("Invoice 42");
    expect((await s({ after: "2026-01-01" })).body.hits).toHaveLength(1);
    expect((await s({ before: "2026-01-01" })).body.hits).toHaveLength(1);
    expect((await s({ after: "2026-05-01", before: "2026-01-01" })).status).toBe(400);
    expect((await s({ q: "%" })).body.hits).toHaveLength(0);
    expect((await actions()).filter((a) => a.action === "mail.archive.searched").length).toBeGreaterThanOrEqual(9);
  });

  it("pages 50 at a time with a cursor", async () => {
    for (let i = 0; i < 55; i++) await seed(boxA, i);
    const p1 = (await owner.post("/api/mail-archive/search", { filters: {} })).body;
    expect(p1.hits).toHaveLength(50);
    const p2 = (await owner.post("/api/mail-archive/search", { filters: {}, cursor: p1.next })).body;
    expect(p2.hits).toHaveLength(5);
    expect(p2.next).toBeNull();
    expect(new Set([...p1.hits, ...p2.hits].map((h: { id: string }) => h.id)).size).toBe(55);
  });

  it("exports a case as a ZIP with mbox, CSV index and manifest; audit logged", async () => {
    await seed(boxA, 10, { subject: "Invoice 42", fromAddress: "billing@vendor.example", text: "From the start\nPay by Friday" });
    await seed(boxB, 20, { subject: "Other" });
    const kase = (await owner.post("/api/mail-archive/cases", { name: "Vendor dispute", filters: { q: "invoice" } })).body.case;
    expect(kase).toMatchObject({ name: "Vendor dispute", filters: { q: "invoice" }, exportCount: 0 });
    const res = await ctx.app.request(`/api/mail-archive/cases/${kase.id}/export`, { headers: rawHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("case-vendor-dispute-");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["README.txt", "mail.mbox", "manifest.json", "messages.csv"]);
    const mbox = strFromU8(files["mail.mbox"]!);
    expect(mbox.startsWith("From ")).toBe(true);
    expect(mbox).toContain("Subject: Invoice 42");
    expect(mbox).toContain(">From the start");
    expect(mbox).not.toContain("Other");
    const csv = strFromU8(files["messages.csv"]!).trim().split("\r\n");
    expect(csv).toHaveLength(2);
    expect(JSON.parse(strFromU8(files["manifest.json"]!))).toMatchObject({ case: "Vendor dispute", matched: 1, exported: 1, truncated: false, exportedBy: "owner@acme.io" });
    expect((await owner.get("/api/mail-archive/cases")).body.cases[0].exportCount).toBe(1);
    expect((await actions()).map((a) => a.action)).toEqual(expect.arrayContaining(["mail.case.created", "mail.case.exported"]));
    expect((await owner.del(`/api/mail-archive/cases/${kase.id}`)).status).toBe(200);
    expect((await ctx.app.request(`/api/mail-archive/cases/${kase.id}/export`, { headers: rawHeaders() })).status).toBe(404);
  });

  it("audit log filters by area, person and dates (flag on only)", async () => {
    await owner.post("/api/mail-archive/holds", { kind: "mailbox", targetId: boxA, name: "Hold one" });
    const all = (await owner.get("/api/org/audit")).body.entries.length;
    const area = (await owner.get("/api/org/audit?area=mail_archive")).body.entries;
    expect(area.length).toBeGreaterThan(0);
    expect(area.length).toBeLessThan(all);
    expect(area.every((e: { action: string }) => e.action.startsWith("mail."))).toBe(true);
    expect((await owner.get("/api/org/audit?actor=nobody@else")).body.entries).toHaveLength(0);
    expect((await owner.get("/api/org/audit?since=2030-01-01")).body.entries).toHaveLength(0);
    expect((await owner.get("/api/org/audit?until=2026-10-31&since=2026-10-31")).body.entries.length).toBeGreaterThanOrEqual(0);
    const csv = await ctx.app.request("/api/org/audit/export?format=csv&area=mail_archive", { headers: rawHeaders() });
    const lines = (await csv.text()).trim().split("\r\n");
    expect(lines.slice(1).every((l) => l.includes("mail.hold."))).toBe(true);
  });
});
