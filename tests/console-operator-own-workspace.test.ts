/**
 * OPS1: the operator's own workspace rules never stop platform work. An operator whose workspace is over its daily
 * write budget, or requires SSO they did not use, still reaches /api/console and /api/admin (reads and changes), while
 * the same rules still apply to their ordinary workspace routes.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import { signUpAs } from "./console-kit";
import { members, organizations, usageCounters } from "@/server/db/schema";
import { WORKSPACE_ROWS_METRIC, isBudgetExempt, resetWorkspaceBudget } from "@/server/services/workspace-budget";

describe("an operator's own workspace rules", () => {
  beforeEach(() => resetWorkspaceBudget());

  it("over its write budget: workspace writes get 429, console and admin work goes through", async () => {
    const ctx = await makeTestApp({ WORKSPACE_DAILY_WRITES: "1000" });
    const { c: ops } = await signUpAs(ctx, "ops@ops.test", "admin");
    const { id: newId } = await signUpAs(ctx, "new@ops.test", null);
    const { c: cus } = await signUpAs(ctx, "cus@else.test", null, "Else");
    const orgId = (await ops.get("/api/account/me")).body.organization.id as string;
    const cusOrg = (await cus.get("/api/account/me")).body.organization.id as string;
    await ctx.db.insert(usageCounters).values({ orgId, period: new Date().toISOString().slice(0, 10), metric: WORKSPACE_ROWS_METRIC, count: 5000 });
    resetWorkspaceBudget();

    expect((await ops.patch("/api/org", { name: "Still Ops" })).status).toBe(429);
    expect((await ops.post(`/api/admin/workspaces/${cusOrg}/suspend`, { reason: "Under review" })).status).toBe(200);
    expect((await ops.post("/api/console/operators", { email: "new@ops.test", role: "ops_readonly", reason: "Grant while busy" })).status).toBe(201);
    expect((await ops.get("/api/console/me")).status).toBe(200);
    expect(newId).toBeTruthy();
    for (const p of ["/api/console/operators", "/api/console", "/api/admin/workspaces/x/suspend"]) expect(isBudgetExempt("POST", p)).toBe(true);
    expect(isBudgetExempt("POST", "/api/consoles")).toBe(false);
    expect(isBudgetExempt("POST", "/api/administration")).toBe(false);
  });

  it("requiring SSO: workspace routes get sso_required, console and admin work goes through", async () => {
    const ctx = await makeTestApp();
    const { c: ops, id } = await signUpAs(ctx, "ops@ops.test", "admin");
    const { c: cus } = await signUpAs(ctx, "cus@else.test", null, "Else");
    const cusOrg = (await cus.get("/api/account/me")).body.organization.id as string;
    const orgId = (await ops.get("/api/account/me")).body.organization.id as string;
    // The operator is a plain member of a workspace that requires SSO, signed in with a password.
    await ctx.db.update(organizations).set({ requireSso: true }).where(eq(organizations.id, orgId));
    await ctx.db.update(members).set({ role: "member" }).where(eq(members.userId, id));

    const blocked = await ops.get("/api/org");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("sso_required");
    expect((await ops.get("/api/console/me")).status).toBe(200);
    expect((await ops.get("/api/console/overview")).status).toBe(200);
    expect((await ops.get("/api/admin/overview")).status).toBe(200);
    expect((await ops.put(`/api/admin/workspaces/${cusOrg}/send-cap`, { cap: 5 })).body).toEqual({ ok: true, sendCapDaily: 5 });
  });
});
