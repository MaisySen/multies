/**
 * OPS1: /api/console/moderation. Lists page through nextCursor and filter; every change needs a reason, is refused to a
 * role without its permission, and writes one platform audit row with the action, target and reason.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { abuseEvents, contentReports, organizations, platformAuditLogs, sessions, users } from "@/server/db/schema";

let ctx: Ctx;
let owner: Client, support: Client, readonly: Client, billing: Client, customer: Client;
let supportId: string, custId: string, custOrg: string, otherId: string, otherOrg: string;
const H = 3600_000;

const orgOf = async (c: Client) => (await c.get("/api/account/me")).body.organization.id as string;
const auditRows = (action: string) => ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, action)).all();

async function walk(c: Client, path: string, limit = 2) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await c.get(`${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    ids.push(...r.body.items.map((x: { id?: string; orgId?: string }) => x.id ?? x.orgId));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return ids;
}

async function report(id: string, extra: Partial<typeof contentReports.$inferInsert> = {}) {
  await ctx.db.insert(contentReports).values({
    id, reporterUserId: custId, orgId: custOrg, targetType: "user", targetUserId: otherId, reason: "spam", createdAt: new Date(Date.now() - 2 * H), ...extra,
  });
}

beforeAll(async () => {
  ctx = await makeTestApp();
  ({ c: owner } = await signUpAs(ctx, "owner@ops.test", "admin"));
  ({ c: support, id: supportId } = await signUpAs(ctx, "support@ops.test", "ops_support"));
  ({ c: readonly } = await signUpAs(ctx, "readonly@ops.test", "ops_readonly"));
  ({ c: billing } = await signUpAs(ctx, "billing@ops.test", "ops_billing"));
  ({ c: customer, id: custId } = await signUpAs(ctx, "cara@customer.test", null, "Cara Co"));
  const other = await signUpAs(ctx, "odd@other.test", null, "Other Org");
  otherId = other.id;
  custOrg = await orgOf(customer);
  otherOrg = await orgOf(other.c);
}, 120_000);

describe("reports", () => {
  it("pages through nextCursor, filters by status, reason and workspace, and refuses a bad sort", async () => {
    for (let i = 0; i < 5; i++) await report(`rpt_page${i}`, { reason: i % 2 ? "harassment" : "spam", createdAt: new Date(Date.now() - (i + 1) * H) });
    await report("rpt_closed", { status: "dismissed" });
    await report("rpt_other", { orgId: otherOrg, note: "zebra-needle-note" });
    const open = await walk(readonly, "/api/console/moderation/reports");
    expect(open).toEqual(expect.arrayContaining(["rpt_page0", "rpt_page1", "rpt_page2", "rpt_page3", "rpt_page4", "rpt_other"]));
    expect(new Set(open).size).toBe(open.length);
    expect(open).not.toContain("rpt_closed");
    const all = await readonly.get("/api/console/moderation/reports?status=all");
    expect(all.body.items.map((r: { id: string }) => r.id)).toContain("rpt_closed");
    const harassment = await readonly.get("/api/console/moderation/reports?reason=harassment");
    expect(harassment.body.items.map((r: { id: string }) => r.id).sort()).toEqual(["rpt_page1", "rpt_page3"]);
    const ws = await readonly.get(`/api/console/moderation/reports?workspace=${otherOrg}`);
    expect(ws.body.items.map((r: { id: string }) => r.id)).toEqual(["rpt_other"]);
    expect(ws.body.items[0]).toMatchObject({ workspaceName: "Other Org", ownerEmail: "odd@other.test" });
    const q = await readonly.get("/api/console/moderation/reports?q=zebra-needle");
    expect(q.body.items.map((r: { id: string }) => r.id)).toEqual(["rpt_other"]);
    expect((await readonly.get("/api/console/moderation/reports?sort=name:asc")).status).toBe(400);
    expect((await readonly.get("/api/console/moderation/reports?status=bogus")).status).toBe(422);
    expect((await readonly.get("/api/console/moderation/reports?cursor=not-a-cursor")).status).toBe(400);
    const counts = await readonly.get("/api/console/moderation/reports/counts");
    expect(counts.status).toBe(200);
    expect(counts.body.open).toBeGreaterThanOrEqual(6);
  });

  it("acting on a report needs a reason and moderation.act, and is audited", async () => {
    await report("rpt_act1");
    const path = "/api/console/moderation/reports/rpt_act1/action";
    expect((await support.post(path, { action: "dismiss" })).status).toBe(422);
    expect((await support.post(path, { action: "dismiss", reason: "x" })).status).toBe(422);
    const ro = await readonly.post(path, { action: "dismiss", reason: "Not a real problem" });
    expect(ro.status).toBe(403);
    expect(ro.body.error.code).toBe("forbidden");
    expect((await billing.post(path, { action: "dismiss", reason: "Not a real problem" })).status).toBe(403);
    expect((await customer.post(path, { action: "dismiss", reason: "Not a real problem" })).status).toBe(403);
    expect((await new Client(ctx.app).post(path, { action: "dismiss", reason: "Not a real problem" })).status).toBe(401);

    const ok = await support.post(path, { action: "dismiss", reason: "Reviewed, not spam" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.report.status).toBe("dismissed");
    const row = (await auditRows("report.dismissed")).find((r) => r.targetId === "rpt_act1")!;
    expect(row).toMatchObject({ targetType: "report", reason: "Reviewed, not spam", orgId: custOrg, actorEmail: "support@ops.test", actorRole: "ops_support" });
    expect(JSON.parse(row.before!)).toMatchObject({ status: "open" });
    expect(JSON.parse(row.after!)).toMatchObject({ status: "dismissed" });
    // A second action on a closed report is a conflict, and an unknown report is 404.
    expect((await support.post(path, { action: "resolve", reason: "Again please" })).status).toBe(409);
    expect((await support.post("/api/console/moderation/reports/rpt_nope/action", { action: "dismiss", reason: "Nothing here" })).status).toBe(404);
  });

  it("suspending the reported person bans them, needs a recent sign in, and refuses an operator account", async () => {
    await report("rpt_op", { targetUserId: supportId });
    const refused = await owner.post("/api/console/moderation/reports/rpt_op/action", { action: "suspend_user", reason: "Abusive messages" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("operator_account");
    expect((await ctx.db.select({ banned: users.banned }).from(users).where(eq(users.id, supportId)).get())!.banned).toBeFalsy();

    await report("rpt_ban");
    const { id: staleId, c: stale } = await signUpAs(ctx, "stale@ops.test", "ops_support");
    await ctx.db.update(sessions).set({ createdAt: new Date(Date.now() - 2 * H) }).where(eq(sessions.userId, staleId));
    const step = await stale.post("/api/console/moderation/reports/rpt_ban/action", { action: "suspend_user", reason: "Abusive messages" });
    expect(step.status).toBe(403);
    expect(step.body.error.code).toBe("step_up_required");

    const ok = await support.post("/api/console/moderation/reports/rpt_ban/action", { action: "suspend_user", reason: "Abusive messages" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await ctx.db.select({ banned: users.banned }).from(users).where(eq(users.id, otherId)).get())!.banned).toBe(true);
    const row = (await auditRows("report.user_suspended")).find((r) => r.targetId === "rpt_ban")!;
    expect(row.reason).toBe("Abusive messages");
    await ctx.db.update(users).set({ banned: false, banReason: null }).where(eq(users.id, otherId));
  });
});

describe("abuse signals", () => {
  it("lists open signals with paging and a workspace summary, and refuses a bad sort", async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.db.insert(abuseEvents).values({ id: `abe_${i}`, orgId: i < 3 ? custOrg : otherOrg, kind: i % 2 ? "bounce_rate" : "spam_reports", score: 10 * (i + 1), createdAt: new Date(Date.now() - i * H) });
    }
    await ctx.db.insert(abuseEvents).values({ id: "abe_done", orgId: custOrg, kind: "spam_reports", score: 99, resolvedAt: new Date(), createdAt: new Date() });
    const ids = await walk(readonly, "/api/console/moderation/abuse");
    expect(ids.sort()).toEqual(["abe_0", "abe_1", "abe_2", "abe_3", "abe_4"]);
    const byScore = await readonly.get("/api/console/moderation/abuse?sort=score:desc");
    expect(byScore.body.items[0].id).toBe("abe_4");
    const kind = await readonly.get("/api/console/moderation/abuse?kind=bounce_rate");
    expect(kind.body.items.map((e: { id: string }) => e.id).sort()).toEqual(["abe_1", "abe_3"]);
    const resolved = await readonly.get("/api/console/moderation/abuse?status=resolved");
    expect(resolved.body.items.map((e: { id: string }) => e.id)).toEqual(["abe_done"]);
    expect((await readonly.get("/api/console/moderation/abuse?sort=kind:asc")).status).toBe(400);
    const summary = await readonly.get("/api/console/moderation/abuse/summary");
    expect(summary.body.items.map((s: { orgId: string }) => s.orgId)).toEqual([otherOrg, custOrg]);
    expect(summary.body.items[1]).toMatchObject({ workspaceName: "Cara Co", ownerEmail: "cara@customer.test", openEvents: 3, topScore: 30 });
    expect(kind.body.items.every((e: { ownerEmail: string | null }) => typeof e.ownerEmail === "string")).toBe(true);
  });

  it("resolving needs a reason and moderation.act, works by ids or for a workspace, and is audited", async () => {
    const path = "/api/console/moderation/abuse/resolve";
    expect((await support.post(path, { ids: ["abe_0"] })).status).toBe(422);
    expect((await support.post(path, { ids: ["abe_0"], workspace: custOrg, reason: "Both given" })).status).toBe(422);
    expect((await readonly.post(path, { ids: ["abe_0"], reason: "False alarm" })).status).toBe(403);
    const one = await support.post(path, { ids: ["abe_0"], reason: "False alarm" });
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.resolved).toBe(1);
    const ws = await support.post(path, { workspace: custOrg, reason: "Checked the sender, fine" });
    expect(ws.body.resolved).toBe(2);
    expect((await support.post(path, { workspace: "org_missing", reason: "Checked the sender" })).status).toBe(404);
    const rows = await auditRows("abuse.resolved");
    expect(rows.find((r) => r.targetType === "abuse_event" && r.targetId === "abe_0")?.reason).toBe("False alarm");
    expect(rows.find((r) => r.targetType === "workspace" && r.targetId === custOrg)).toMatchObject({ orgId: custOrg, reason: "Checked the sender, fine" });
    const open = await ctx.db.select().from(abuseEvents).where(and(eq(abuseEvents.orgId, custOrg))).all();
    expect(open.every((e) => e.resolvedAt)).toBe(true);
  });
});

describe("suspended workspaces", () => {
  it("suspend and restore need workspaces.suspend and a reason; the list shows who suspended", async () => {
    const path = `/api/console/moderation/workspaces/${custOrg}/suspend`;
    expect((await support.post(path, {})).status).toBe(422);
    expect((await readonly.post(path, { reason: "Phishing campaign" })).status).toBe(403);
    expect((await billing.post(path, { reason: "Phishing campaign" })).status).toBe(403);
    expect((await support.post("/api/console/moderation/workspaces/org_missing/suspend", { reason: "Phishing campaign" })).status).toBe(404);
    const ok = await support.post(path, { reason: "Phishing campaign" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await support.post(path, { reason: "Phishing campaign" })).status).toBe(409);
    const audit = (await auditRows("workspace.suspended")).find((r) => r.targetId === custOrg)!;
    expect(audit).toMatchObject({ targetType: "workspace", orgId: custOrg, reason: "Phishing campaign" });

    await ctx.db.update(organizations).set({ suspendedAt: new Date(Date.now() - H), suspendedReason: "Automatic: spam score" }).where(eq(organizations.id, otherOrg));
    const ids = await walk(readonly, "/api/console/moderation/suspended", 1);
    expect(ids.sort()).toEqual([custOrg, otherOrg].sort());
    const list = await readonly.get("/api/console/moderation/suspended");
    const mine = list.body.items.find((s: { orgId: string }) => s.orgId === custOrg);
    expect(mine).toMatchObject({ reason: "Phishing campaign", automatic: false, suspendedBy: { email: "support@ops.test" } });
    expect(list.body.items.find((s: { orgId: string }) => s.orgId === otherOrg)).toMatchObject({ automatic: true, suspendedBy: null });
    expect((await readonly.get("/api/console/moderation/suspended?sort=plan:asc")).status).toBe(400);

    const restore = `/api/console/moderation/workspaces/${custOrg}/unsuspend`;
    expect((await support.post(restore, {})).status).toBe(422);
    expect((await readonly.post(restore, { reason: "Owner fixed it" })).status).toBe(403);
    const back = await support.post(restore, { reason: "Owner fixed it" });
    expect(back.status).toBe(200);
    expect((await ctx.db.select({ s: organizations.suspendedAt }).from(organizations).where(eq(organizations.id, custOrg)).get())!.s).toBeNull();
    expect((await auditRows("workspace.unsuspended")).find((r) => r.targetId === custOrg)?.reason).toBe("Owner fixed it");
    expect((await support.post(restore, { reason: "Owner fixed it" })).status).toBe(409);
  });
});
