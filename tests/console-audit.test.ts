/**
 * OPS1: the platform audit log. The older /api/admin changes keep their answers and their workspace audit rows, and now
 * also write a platform audit row (actor, role, reason when given, IP). /api/console/audit lists them with filters and
 * pages; the CSV export is for owners and is itself audited.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import { signUpAs } from "./console-kit";
import { auditLogs, contentReports, organizations, platformAuditLogs, users } from "@/server/db/schema";
import { recordAbuse } from "@/server/services/abuse";
import { enqueue, runDueJobs } from "@/server/services/jobs";
import { reasonSchema } from "@/server/services/console/audit";

describe("platform audit log", () => {
  it("audits the older /api/admin changes, keeps their answers and the workspace's own rows", async () => {
    const ctx = await makeTestApp();
    const { c: ops } = await signUpAs(ctx, "ops@acme.test", "admin");
    const { c: cus } = await signUpAs(ctx, "cus@else.test", null, "Else Inc");
    const orgId = (await cus.get("/api/account/me")).body.organization.id as string;

    const sus = await ops.call("POST", `/api/admin/workspaces/${orgId}/suspend`, { reason: "Phishing reports" }, { "cf-connecting-ip": "203.0.113.9", "user-agent": "ops-test" });
    expect(sus.body).toEqual({ ok: true });
    expect((await ops.put(`/api/admin/workspaces/${orgId}/send-cap`, { cap: 10, reason: "Slow it down" })).body).toEqual({ ok: true, sendCapDaily: 10 });
    expect((await ops.put(`/api/admin/workspaces/${orgId}/sending`, { enabled: false })).body).toEqual({ ok: true, sending: false, sendCapDaily: 0 });

    await recordAbuse(ctx.deps, orgId, "message_held", 12, "Spam score 12");
    const ev = (await ops.get("/api/admin/abuse")).body.events[0].id;
    expect((await ops.post("/api/admin/abuse/resolve", { ids: [ev] })).body).toEqual({ ok: true });

    await enqueue(ctx.deps, "test.unknown" as never, {}, { maxAttempts: 1 });
    await runDueJobs(ctx.deps, 10);
    const dead = (await ops.get("/api/admin/jobs")).body.dead[0].id;
    expect((await ops.post("/api/admin/jobs/replay", { ids: [dead], reason: "Provider is back" })).body).toEqual({ replayed: 1 });

    expect((await ops.put("/api/admin/app-config", { reason: "Ship the banner", message: "Hello there" })).status).toBe(200);
    expect((await ops.put("/api/admin/app-config", { reason: "x" })).status).toBe(422);

    const { id: victimId } = await signUpAs(ctx, "gone@else.test", null, "Gone");
    expect((await ops.call("DELETE", `/api/admin/users/${victimId}`, { reason: "Asked to be removed" })).body).toEqual({ ok: true });

    const rows = await ctx.db.select().from(platformAuditLogs).all();
    const by = (a: string) => rows.find((r) => r.action === a);
    expect(by("workspace.suspended")).toMatchObject({ actorEmail: "ops@acme.test", actorRole: "admin", orgId, targetType: "workspace", targetId: orgId, reason: "Phishing reports", ip: "203.0.113.9", userAgent: "ops-test" });
    expect(JSON.parse(by("workspace.send_cap_changed")!.after!)).toEqual({ cap: 10 });
    expect(by("workspace.sending_off")).toBeTruthy();
    expect(by("abuse.resolved")).toMatchObject({ targetType: "abuse_event" });
    expect(JSON.parse(by("abuse.resolved")!.metadata!)).toMatchObject({ ids: [ev], count: 1 });
    expect(by("jobs.replayed")).toMatchObject({ reason: "Provider is back" });
    expect(JSON.parse(by("jobs.replayed")!.after!)).toEqual({ replayed: 1 });
    expect(by("app_config.updated")).toMatchObject({ reason: "Ship the banner", targetType: "app_config" });
    expect(by("user.deleted")).toMatchObject({ targetId: victimId, reason: "Asked to be removed" });
    expect(JSON.parse(by("user.deleted")!.before!)).toEqual({ email: "gone@else.test" });

    // The workspace still sees operator actions on its own Activity page, with the reason.
    const ws = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "workspace.suspended"))).get();
    expect(JSON.parse(ws!.metadata!)).toMatchObject({ by: "operator", reason: "Phishing reports" });
    expect((await cus.get("/api/org/audit")).body.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["workspace.suspended", "workspace.send_cap_changed", "workspace.sending_off"]));
  });

  it("audits moderation actions on the older reports route", async () => {
    const ctx = await makeTestApp();
    const { c: ops } = await signUpAs(ctx, "ops@acme.test", "ops_support");
    const { id: reporterId, c: cus } = await signUpAs(ctx, "cus@else.test", null, "Else");
    const { id: otherId } = await signUpAs(ctx, "other@else.test", null, "Other");
    const orgId = (await cus.get("/api/account/me")).body.organization.id as string;
    await ctx.db.insert(contentReports).values({ id: "rpt_ops1", reporterUserId: reporterId, orgId, targetType: "user", targetUserId: otherId, reason: "spam" });
    const rep = { body: { id: "rpt_ops1" } };
    const act = await ops.post(`/api/admin/reports/${rep.body.id}/action`, { action: "dismiss", note: "Not spam" });
    expect(act.status).toBe(200);
    expect(act.body.report).toMatchObject({ status: "dismissed" });
    const row = await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "report.dismiss")).get();
    expect(row).toMatchObject({ targetType: "report", targetId: rep.body.id, reason: "Not spam", actorRole: "ops_support" });
  });

  it("lists, filters and pages the log; export is owner only and audited", async () => {
    const ctx = await makeTestApp();
    const { c: owner } = await signUpAs(ctx, "own@ops.test", "admin");
    const { c: ro } = await signUpAs(ctx, "ro@ops.test", "ops_readonly");
    const { c: cus } = await signUpAs(ctx, "cus@else.test", null, "Else");
    const orgId = (await cus.get("/api/account/me")).body.organization.id as string;
    for (const cap of [1, 2, 3]) await owner.put(`/api/admin/workspaces/${orgId}/send-cap`, { cap });
    await owner.post(`/api/admin/workspaces/${orgId}/suspend`, { reason: "Review" });

    const first = await ro.get("/api/console/audit?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items[0].action).toBe("workspace.suspended");
    expect(first.body.nextCursor).toBeTruthy();
    const second = await ro.get(`/api/console/audit?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(4);

    expect((await ro.get("/api/console/audit?action=workspace.send_cap")).body.items).toHaveLength(3);
    expect((await ro.get(`/api/console/audit?orgId=${orgId}&action=workspace.suspended`)).body.items[0]).toMatchObject({ reason: "Review", orgId });
    expect((await ro.get("/api/console/audit?actor=own@")).body.items).toHaveLength(4);
    expect((await ro.get("/api/console/audit?actor=nobody")).body.items).toHaveLength(0);
    expect((await ro.get("/api/console/audit?q=Review")).body.items).toHaveLength(1);
    expect((await ro.get("/api/console/audit?cursor=nonsense")).status).toBe(400);
    expect((await ro.get("/api/console/audit?from=not-a-date")).status).toBe(422);

    expect((await ro.get("/api/console/audit/export")).status).toBe(403);
    const csv = await owner.get("/api/console/audit/export?action=workspace.");
    expect(csv.status).toBe(200);
    expect(String(csv.body).split("\n")).toHaveLength(5); // header + 4 rows
    expect(String(csv.body).split("\n")[0]).toContain("actorEmail");
    expect(await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "audit.exported")).get()).toBeTruthy();
    void users; void organizations;
  });

  it("a reason is 3 to 300 characters", () => {
    expect(reasonSchema.safeParse("ok").success).toBe(false);
    expect(reasonSchema.safeParse("  ok  ").success).toBe(false);
    expect(reasonSchema.safeParse("why").success).toBe(true);
    expect(reasonSchema.safeParse("x".repeat(301)).success).toBe(false);
  });
});
