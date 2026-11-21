/**
 * OPS1: /api/console/workspaces. The list (search, filters, sort, paging), the detail reads, and each change: a reason
 * is required, the role must allow it, and a platform audit row (and the workspace's own row) is written.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { auditLogs, mailSchedules, mailboxes, organizations, platformAuditLogs } from "@/server/db/schema";

let ctx: Ctx;
let owner: Client; // operator, owner tier
let support: Client;
let billing: Client;
let readonly: Client;
let customer: Client;
let custOrg: string;

const orgOf = async (c: Client) => (await c.get("/api/account/me")).body.organization.id as string;
const lastAudit = async (action: string, targetId: string) => (await ctx.db.select().from(platformAuditLogs)
  .where(and(eq(platformAuditLogs.action, action), eq(platformAuditLogs.targetId, targetId))).all()).at(-1);

beforeAll(async () => {
  ctx = await makeTestApp();
  owner = (await signUpAs(ctx, "own@ops.test", "admin", "Ops Home")).c;
  support = (await signUpAs(ctx, "sup@ops.test", "ops_support", "Support Home")).c;
  billing = (await signUpAs(ctx, "bil@ops.test", "ops_billing", "Billing Home")).c;
  readonly = (await signUpAs(ctx, "ro@ops.test", "ops_readonly", "Readonly Home")).c;
  customer = (await signUpAs(ctx, "boss@zephyr-cust.test", null, "Zephyr Rockets")).c;
  custOrg = await orgOf(customer);
  await ctx.db.insert(organizations).values([
    { id: "org_pro_late", name: "Late Pro Co", timezone: "UTC", plan: "pro", pastDueSince: new Date() },
    { id: "org_susp", name: "Suspended Co", timezone: "UTC", suspendedAt: new Date(), suspendedReason: "spam" },
    { id: "org_demo", name: "Demo Co", timezone: "UTC", isDemo: true },
    { id: "org_comp", name: "Comp Co", timezone: "UTC", compPlan: true },
  ]);
}, 120_000);

describe("GET /api/console/workspaces", { timeout: 60_000 }, () => {
  it("searches, filters and sorts, and pages with nextCursor", async () => {
    const all = await readonly.get("/api/console/workspaces?limit=200");
    expect(all.status).toBe(200);
    expect(all.body.nextCursor).toBeNull();
    const total = all.body.items.length;
    expect(total).toBeGreaterThanOrEqual(9);

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await readonly.get(`/api/console/workspaces?limit=2&sort=name:asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(2);
      for (const w of r.body.items) { expect(seen.has(w.id)).toBe(false); seen.add(w.id); }
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    expect(seen.size).toBe(total);
    expect(pages).toBe(Math.ceil(total / 2));

    const names = async (qs: string) => (await readonly.get(`/api/console/workspaces?${qs}`)).body.items.map((w: { name: string }) => w.name).sort();
    expect(await names("q=zephyr")).toEqual(["Zephyr Rockets"]);
    expect(await names("q=boss@zephyr-cust")).toEqual(["Zephyr Rockets"]);
    expect(await names(`q=${custOrg}`)).toEqual(["Zephyr Rockets"]);
    expect(await names("state=suspended")).toEqual(["Suspended Co"]);
    expect(await names("state=pastDue")).toEqual(["Late Pro Co"]);
    expect(await names("state=demo")).toEqual(["Demo Co"]);
    expect(await names("state=comp")).toEqual(["Comp Co"]);
    expect(await names("plan=pro")).toEqual(["Late Pro Co"]);
    expect(await names("suspended=true")).toEqual(["Suspended Co"]);
    const z = (await readonly.get("/api/console/workspaces?q=zephyr")).body.items[0];
    expect(z).toMatchObject({ id: custOrg, ownerEmail: "boss@zephyr-cust.test", members: 1, plan: "starter" });
  });

  it("refuses a bad sort, cursor or filter, and non operators", async () => {
    expect((await readonly.get("/api/console/workspaces?sort=password:asc")).status).toBe(400);
    expect((await readonly.get("/api/console/workspaces?sort=name:sideways")).status).toBe(400);
    expect((await readonly.get("/api/console/workspaces?cursor=not-a-cursor")).body.error.code).toBe("bad_cursor");
    expect((await readonly.get("/api/console/workspaces?plan=gold")).status).toBe(400);
    expect((await readonly.get("/api/console/workspaces?state=weird")).status).toBe(400);
    expect((await customer.get("/api/console/workspaces")).status).toBe(403);
    expect((await new Client(ctx.app).get("/api/console/workspaces")).status).toBe(401);
  });
});

describe("workspace detail reads", { timeout: 60_000 }, () => {
  it("overview, members, usage, mail, agents, developer, audit and queued sends", async () => {
    const o = await readonly.get(`/api/console/workspaces/${custOrg}`);
    expect(o.status).toBe(200);
    expect(o.body.org).toMatchObject({ id: custOrg, name: "Zephyr Rockets", plan: "starter" });
    expect(o.body.writeBudget).toHaveProperty("budget");
    expect(o.body.counts.members).toBe(1);

    const m = await readonly.get(`/api/console/workspaces/${custOrg}/members?limit=1`);
    expect(m.status).toBe(200);
    expect(m.body.items[0]).toMatchObject({ email: "boss@zephyr-cust.test", role: "owner", kind: "human" });
    expect(m.body.nextCursor).toBeNull();
    expect((await readonly.get(`/api/console/workspaces/${custOrg}/members?sort=hash:asc`)).status).toBe(400);

    const u = await readonly.get(`/api/console/workspaces/${custOrg}/usage?days=7`);
    expect(u.status).toBe(200);
    expect(u.body.daily).toHaveLength(7);

    for (const part of ["mail", "agents", "developer"]) expect((await readonly.get(`/api/console/workspaces/${custOrg}/${part}`)).status).toBe(200);
    expect((await readonly.get(`/api/console/workspaces/${custOrg}/mail`)).body).toHaveProperty("domains");

    const a = await readonly.get(`/api/console/workspaces/${custOrg}/audit`);
    expect(a.status).toBe(200);
    expect(Array.isArray(a.body.items)).toBe(true);
    expect((await readonly.get(`/api/console/workspaces/${custOrg}/audit?source=platform`)).status).toBe(200);
    expect((await readonly.get(`/api/console/workspaces/${custOrg}/audit?source=elsewhere`)).status).toBe(400);

    const qs = await readonly.get(`/api/console/workspaces/${custOrg}/queued-sends`);
    expect(qs.body).toEqual({ items: [], nextCursor: null });
    expect((await readonly.get(`/api/console/workspaces/${custOrg}/queued-sends?sort=subject:asc`)).status).toBe(400);
  });

  it("an unknown workspace is a 404 on every read", async () => {
    for (const p of ["", "/members", "/usage", "/mail", "/agents", "/developer", "/audit", "/queued-sends"]) {
      expect((await readonly.get(`/api/console/workspaces/org_nope${p}`)).status, p).toBe(404);
    }
  });
});

describe("workspace changes", { timeout: 60_000 }, () => {
  it("suspend and restore: reason required, support allowed, readonly and billing refused, audited both places", async () => {
    expect((await support.post(`/api/console/workspaces/${custOrg}/suspend`, {})).status).toBe(422);
    expect((await support.post(`/api/console/workspaces/${custOrg}/suspend`, { reason: "no" })).status).toBe(422);
    expect((await readonly.post(`/api/console/workspaces/${custOrg}/suspend`, { reason: "Phishing reports" })).status).toBe(403);
    expect((await billing.post(`/api/console/workspaces/${custOrg}/suspend`, { reason: "Phishing reports" })).status).toBe(403);
    expect((await customer.post(`/api/console/workspaces/${custOrg}/suspend`, { reason: "Phishing reports" })).status).toBe(403);
    expect((await support.post("/api/console/workspaces/org_nope/suspend", { reason: "Phishing reports" })).status).toBe(404);

    const r = await support.post(`/api/console/workspaces/${custOrg}/suspend`, { reason: "Phishing reports from three people" });
    expect(r.status).toBe(200);
    const org = await ctx.db.select().from(organizations).where(eq(organizations.id, custOrg)).get();
    expect(org?.suspendedAt).toBeTruthy();
    expect(org?.suspendedReason).toBe("Phishing reports from three people");
    const row = await lastAudit("workspace.suspended", custOrg);
    expect(row).toMatchObject({ actorEmail: "sup@ops.test", actorRole: "ops_support", targetType: "workspace", orgId: custOrg, reason: "Phishing reports from three people" });
    expect(JSON.parse(row!.before!)).toMatchObject({ suspendedAt: null });
    const ws = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, custOrg), eq(auditLogs.action, "workspace.suspended"))).get();
    expect(JSON.parse(ws!.metadata!)).toMatchObject({ by: "operator", reason: "Phishing reports from three people" });
    expect((await readonly.get("/api/console/workspaces?state=suspended")).body.items.map((w: { id: string }) => w.id)).toContain(custOrg);

    expect((await support.post(`/api/console/workspaces/${custOrg}/unsuspend`, {})).status).toBe(422);
    expect((await readonly.post(`/api/console/workspaces/${custOrg}/unsuspend`, { reason: "Reviewed, all fine" })).status).toBe(403);
    const u = await owner.post(`/api/console/workspaces/${custOrg}/unsuspend`, { reason: "Reviewed, all fine" });
    expect(u.status).toBe(200);
    expect((await ctx.db.select().from(organizations).where(eq(organizations.id, custOrg)).get())?.suspendedAt).toBeNull();
    expect(await lastAudit("workspace.unsuspended", custOrg)).toMatchObject({ actorEmail: "own@ops.test", reason: "Reviewed, all fine" });

    const audit = await readonly.get(`/api/console/workspaces/${custOrg}/audit?source=platform`);
    expect(audit.body.items.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(["workspace.suspended", "workspace.unsuspended"]));
    // Targets by name (withAuditNames) and the operator's id, as on the global audit log.
    const suspendedRow = audit.body.items.find((x: { action: string }) => x.action === "workspace.suspended");
    expect(suspendedRow).toMatchObject({ targetType: "workspace", targetId: custOrg, targetLabel: "Zephyr Rockets", actorEmail: "sup@ops.test" });
    expect(typeof suspendedRow.actorUserId).toBe("string");
  });

  it("send cap, sending switch and call minutes cap", async () => {
    const cap = (body: unknown) => support.put(`/api/console/workspaces/${custOrg}/send-cap`, body);
    expect((await cap({ cap: 25 })).status).toBe(422);
    expect((await cap({ cap: -1, reason: "Testing a limit" })).status).toBe(422);
    expect((await readonly.put(`/api/console/workspaces/${custOrg}/send-cap`, { cap: 25, reason: "Too many bounces" })).status).toBe(403);
    expect((await billing.put(`/api/console/workspaces/${custOrg}/send-cap`, { cap: 25, reason: "Too many bounces" })).status).toBe(403);
    expect((await cap({ cap: 25, reason: "Too many bounces" })).body).toEqual({ ok: true, sendCapDaily: 25 });
    expect((await ctx.db.select().from(organizations).where(eq(organizations.id, custOrg)).get())?.sendCapDaily).toBe(25);
    const row = await lastAudit("workspace.send_cap_changed", custOrg);
    expect(row).toMatchObject({ reason: "Too many bounces", orgId: custOrg });
    expect(JSON.parse(row!.before!)).toEqual({ cap: null });
    expect(JSON.parse(row!.after!)).toEqual({ cap: 25 });

    const sending = (body: unknown) => support.put(`/api/console/workspaces/${custOrg}/sending`, body);
    expect((await sending({ enabled: false })).status).toBe(422);
    expect((await readonly.put(`/api/console/workspaces/${custOrg}/sending`, { enabled: false, reason: "Spam wave" })).status).toBe(403);
    expect((await sending({ enabled: false, reason: "Spam wave" })).body).toEqual({ ok: true, sending: false, sendCapDaily: 0 });
    expect(await lastAudit("workspace.sending_off", custOrg)).toMatchObject({ reason: "Spam wave" });
    expect((await sending({ enabled: true, reason: "Spam wave over" })).body).toEqual({ ok: true, sending: true, sendCapDaily: null });
    expect(await lastAudit("workspace.sending_on", custOrg)).toMatchObject({ reason: "Spam wave over" });

    const meet = (c: Client, body: unknown) => c.put(`/api/console/workspaces/${custOrg}/meeting-cap`, body);
    expect((await meet(support, { cap: 500 })).status).toBe(422);
    expect((await meet(readonly, { cap: 500, reason: "Call abuse" })).status).toBe(403);
    expect((await meet(support, { cap: 500, reason: "Call abuse" })).body).toEqual({ ok: true, meetingMinutesCap: 500 });
    expect((await ctx.db.select().from(organizations).where(eq(organizations.id, custOrg)).get())?.meetingMinutesCap).toBe(500);
    expect(await lastAudit("workspace.meeting_cap_changed", custOrg)).toMatchObject({ reason: "Call abuse" });
    expect((await meet(owner, { cap: null, reason: "Back to the plan" })).body).toEqual({ ok: true, meetingMinutesCap: null });
  });

  it("lists held sends without content and sends one anyway", async () => {
    const d = await customer.post("/api/domains", { name: "zephyr-held.example" });
    expect(d.status).toBe(201);
    const mailboxId = "mbx_held_from";
    await ctx.db.insert(mailboxes).values({ id: mailboxId, orgId: custOrg, domainId: d.body.domain.id, localPart: "hello", address: "hello@zephyr-held.example", displayName: "Hello", quotaMb: 100 });
    const payload = { via: "person", input: { mailboxId, to: ["held-to-Qz81Lm@outside.example"], subject: "HELD-SUBJECT-SENTINEL-7Hq2Wx", text: "HELD-BODY-SENTINEL-p4Kd9V" }, held: "New workspaces send to 20 outside recipients a day" };
    await ctx.db.insert(mailSchedules).values({ id: "sch_held_1", orgId: custOrg, mailboxId, kind: "send", status: "pending", dueAt: new Date(Date.now() + 3_600_000), payload: JSON.stringify(payload) });
    const list = await readonly.get(`/api/console/workspaces/${custOrg}/queued-sends`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: "sch_held_1", recipients: 1, forced: false });
    const text = JSON.stringify(list.body);
    expect(text).not.toContain("HELD-SUBJECT-SENTINEL-7Hq2Wx");
    expect(text).not.toContain("HELD-BODY-SENTINEL-p4Kd9V");
    expect(text).not.toContain("held-to-Qz81Lm");

    const path = `/api/console/workspaces/${custOrg}/queued-sends/sch_held_1/send`;
    expect((await support.post(path, {})).status).toBe(422);
    expect((await readonly.post(path, { reason: "Customer asked" })).status).toBe(403);
    expect((await support.post(`/api/console/workspaces/${custOrg}/queued-sends/sch_nope/send`, { reason: "Customer asked" })).status).toBe(404);
    const r = await support.post(path, { reason: "Customer asked" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: "sch_held_1" });
    expect(await lastAudit("message.queued_send_forced", "sch_held_1")).toMatchObject({ orgId: custOrg, reason: "Customer asked", targetType: "schedule" });
    expect((await readonly.get(`/api/console/workspaces/${custOrg}/queued-sends`)).body.items[0].forced).toBe(true);
  });
});
