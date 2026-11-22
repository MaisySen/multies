/**
 * OPS1 security review H1 + M3: the legacy /api/admin write routes skipped the console's checks (an ops_support
 * operator with a stale session banned the platform owner through POST /api/admin/reports/:id/action, and one owner
 * could delete another through DELETE /api/admin/users/:id). They were retired, and the services refuse operator and
 * PLATFORM_ADMIN_EMAILS targets themselves, so no caller can skip it.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { signUpAs } from "./console-kit";
import { Client, makeTestApp } from "./helpers";
import { contentReports, members, sessions, users } from "@/server/db/schema";
import { clearAuthCache } from "@/server/auth/guards";
import { actOnReport } from "@/server/services/suite/reports-r35";
import { banUser } from "@/server/services/console/users";

describe("H1: an ops_support operator cannot ban the owner", () => {
  it("the review's exact escalation: legacy route is 404, console route refuses, owner keeps access", async () => {
    const ctx = await makeTestApp();
    const owner = await signUpAs(ctx, "owner@ops.test", "admin", "Ops");
    const sup = await signUpAs(ctx, "sup@ops.test", "ops_support", "Sup");
    const ownerOrg = (await ctx.db.select().from(members).where(eq(members.userId, owner.id)).get())!.organizationId;
    await ctx.db.insert(members).values({ id: "mem_sup_x", organizationId: ownerOrg, userId: sup.id, role: "member" });
    await ctx.db.update(sessions).set({ createdAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(sessions.userId, sup.id));
    clearAuthCache();
    const rep = await sup.c.post("/api/reports", { targetType: "user", userId: owner.id, reason: "other" });
    expect(rep.status).toBe(201);
    const consoleTry = await sup.c.post(`/api/console/moderation/reports/${rep.body.id}/action`, { action: "suspend_user", reason: "testing the gate" });
    expect(consoleTry.status).toBe(403);
    const legacy = await sup.c.post(`/api/admin/reports/${rep.body.id}/action`, { action: "suspend_user" });
    expect(legacy.status).toBe(404);
    const o = await ctx.db.select({ banned: users.banned }).from(users).where(eq(users.id, owner.id)).get();
    expect(!!o?.banned).toBe(false);
    expect((await owner.c.get("/api/console/me")).status).toBe(200);
    expect((await new Client(ctx.app).login("owner@ops.test")).status).toBe(200);
  }, 60_000);

  it("one owner cannot delete another (the legacy delete is 404; the console refuses an operator target)", async () => {
    const ctx = await makeTestApp();
    const a = await signUpAs(ctx, "a@ops.test", "admin", "A");
    const b = await signUpAs(ctx, "b@ops.test", "admin", "B");
    expect((await a.c.call("DELETE", `/api/admin/users/${b.id}`, { reason: "take over" })).status).toBe(404);
    const r = await a.c.call("DELETE", `/api/console/users/${b.id}`, { reason: "take over" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("target_is_operator");
    expect(await ctx.db.select().from(users).where(eq(users.id, b.id)).get()).toBeTruthy();
  }, 60_000);
});

describe("defence in depth in the services", () => {
  it("actOnReport refuses an operator, a listed account, and a report that is not open", async () => {
    const ctx = await makeTestApp({ PLATFORM_ADMIN_EMAILS: "listed@example.com" });
    const sup = await signUpAs(ctx, "sup@ops.test", "ops_support", "Sup");
    const op = await signUpAs(ctx, "op@ops.test", "ops_readonly", "Op");
    const listed = await signUpAs(ctx, "listed@example.com", null, "Listed");
    // The listed address was confirmed outside the console; it is promoted on its next request, but before that the
    // services must already refuse it. Put the role back to a plain user to test the listing alone.
    await ctx.db.update(users).set({ role: "user" }).where(eq(users.id, listed.id));
    const cus = await signUpAs(ctx, "cus@example.com", null, "Cus");
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, cus.id)).get())!.organizationId;
    let n = 0;
    const report = async (targetUserId: string, status: "open" | "dismissed" = "open") => {
      const id = `rpt_sec_${++n}`;
      await ctx.db.insert(contentReports).values({ id, reporterUserId: cus.id, orgId, targetType: "user", targetUserId, reason: "spam", status });
      return id;
    };
    await expect(actOnReport(ctx.deps, { userId: sup.id }, await report(op.id), { action: "suspend_user" })).rejects.toMatchObject({ status: 409, code: "operator_account" });
    await expect(actOnReport(ctx.deps, { userId: sup.id }, await report(listed.id), { action: "suspend_user" })).rejects.toMatchObject({ status: 409, code: "operator_account" });
    await expect(actOnReport(ctx.deps, { userId: sup.id }, await report(cus.id, "dismissed"), { action: "suspend_user" })).rejects.toMatchObject({ status: 409, code: "already_closed" });
    for (const id of [op.id, listed.id, cus.id]) {
      expect(!!(await ctx.db.select({ banned: users.banned }).from(users).where(eq(users.id, id)).get())!.banned).toBe(false);
    }
    // An ordinary account on an open report is still suspended.
    const ok = await actOnReport(ctx.deps, { userId: sup.id }, await report(cus.id), { action: "suspend_user" });
    expect(ok.action).toBe("user_suspended");
  }, 60_000);

  it("banUser refuses an operator and a listed account itself", async () => {
    const ctx = await makeTestApp({ PLATFORM_ADMIN_EMAILS: "listed@example.com" });
    const op = await signUpAs(ctx, "op@ops.test", "ops_billing", "Op");
    const listed = await signUpAs(ctx, "listed@example.com", null, "Listed");
    await ctx.db.update(users).set({ role: "user" }).where(eq(users.id, listed.id));
    for (const id of [op.id, listed.id]) {
      await expect(banUser(ctx.deps, id, { reason: "testing the service" })).rejects.toMatchObject({ status: 403, code: "target_is_operator" });
    }
  }, 60_000);
});
