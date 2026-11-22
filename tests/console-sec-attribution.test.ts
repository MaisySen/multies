/**
 * OPS1 security review L4: attribution. (a) A refused privileged attempt on a console change writes one platform audit
 * row access.denied (permission, method, path; never the body), rate limited per operator and route. (b) The outer
 * access log line for an /api/console request carries the operator's user id.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { signUpAs } from "./console-kit";
import { Client, makeTestApp } from "./helpers";
import { platformAuditLogs, sessions } from "@/server/db/schema";
import { resetDeniedLog } from "@/server/auth/operator";
import { clearAuthCache } from "@/server/auth/guards";

beforeEach(() => resetDeniedLog());

const denied = (ctx: Awaited<ReturnType<typeof makeTestApp>>) => ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "access.denied")).all();

describe("L4 (a): refused console changes are audited", () => {
  it("a role without the permission: one row with permission, method and path, never the body; rate limited", async () => {
    const ctx = await makeTestApp();
    const ro = await signUpAs(ctx, "ro@ops.test", "ops_readonly", "Ro");
    const cus = await signUpAs(ctx, "cus@example.com", null, "Cus");
    const SENTINEL = "BODY-SENTINEL-7f3a9c1e5d";
    for (let i = 0; i < 3; i++) expect((await ro.c.post(`/api/console/users/${cus.id}/ban`, { reason: SENTINEL })).status).toBe(403);
    const rows = await denied(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: ro.id, actorRole: "ops_readonly", targetType: "route" });
    expect(JSON.parse(rows[0]!.metadata!)).toMatchObject({ code: "forbidden", permission: "users.ban", method: "POST", path: `/api/console/users/${cus.id}/ban` });
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
    // Reads are not logged; a customer (no operator role) is not logged.
    expect((await ro.c.get("/api/console/audit/export")).status).toBe(403);
    expect((await cus.c.post(`/api/console/users/${ro.id}/ban`, { reason: "nope nope" })).status).toBe(403);
    expect(await denied(ctx)).toHaveLength(1);
  }, 60_000);

  it("varying the target id does not flood the table (per route, and a per operator cap)", async () => {
    const ctx = await makeTestApp();
    const ro = await signUpAs(ctx, "ro@ops.test", "ops_readonly", "Ro");
    for (let i = 0; i < 40; i++) await ro.c.post(`/api/console/users/usr_${i}/ban`, { reason: "flooding" });
    for (let i = 0; i < 40; i++) await ro.c.post(`/api/console/workspaces/org_${i}/suspend`, { reason: "flooding" });
    expect((await denied(ctx)).length).toBeLessThanOrEqual(2);
  }, 90_000);

  it("step_up_required, two_factor_required and impersonating are audited too", async () => {
    const ctx = await makeTestApp({ OPERATOR_REQUIRE_2FA: "on" });
    const owner = await signUpAs(ctx, "owner@ops.test", "admin", "Ops");
    const cus = await signUpAs(ctx, "cus@example.com", null, "Cus");
    // two_factor_required
    expect((await owner.c.post(`/api/console/users/${cus.id}/unban`, { reason: "testing" })).body.error.code).toBe("two_factor_required");
    // step_up_required: two-step on, a stale session
    const { users } = await import("@/server/db/schema");
    await ctx.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, owner.id));
    await ctx.db.update(sessions).set({ createdAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(sessions.userId, owner.id));
    clearAuthCache();
    expect((await owner.c.post(`/api/console/users/${cus.id}/ban`, { reason: "testing" })).body.error.code).toBe("step_up_required");
    const codes = (await denied(ctx)).map((r) => JSON.parse(r.metadata!).code).sort();
    expect(codes).toEqual(["step_up_required", "two_factor_required"]);
  }, 90_000);

  it("an impersonated session trying a console change is audited under the operator", async () => {
    const ctx = await makeTestApp();
    const op = await signUpAs(ctx, "op@ops.test", "ops_support", "Ops");
    const target = await signUpAs(ctx, "tara@example.com", null, "Target");
    expect((await op.c.post("/api/console/impersonation", { userId: target.id, mode: "view", reason: "Ticket 1: checking" })).status).toBe(201);
    const r = await op.c.post(`/api/console/users/${target.id}/verify`, { reason: "from inside" });
    expect(r.body.error.code).toBe("impersonating");
    const rows = await denied(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(op.id);
    expect(JSON.parse(rows[0]!.metadata!)).toMatchObject({ code: "impersonating", impersonating: target.id });
  }, 90_000);
});

describe("L4 (b): the access log names the operator", () => {
  it("an /api/console request's access line carries the user id (a refusal too)", async () => {
    const lines: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log = { info: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }), warn: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }), error: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }) };
    const ctx = await makeTestApp();
    const ro = await signUpAs(ctx, "ro@ops.test", "ops_readonly", "Ro");
    // The same database and config, with a logger that keeps the lines.
    const { createApp } = await import("@/server/app");
    const logged = new Client(createApp({ ...ctx.deps, log }));
    logged.cookie = ro.c.cookie;
    expect((await logged.get("/api/console/me")).status).toBe(200);
    expect((await logged.post("/api/console/jobs/replay-all", { reason: "testing the log" })).status).toBe(403);
    const access = lines.filter((l) => l.msg === "request" && String(l.fields?.path ?? "").startsWith("/api/console"));
    expect(access.length).toBeGreaterThanOrEqual(2);
    for (const l of access) expect(l.fields?.user, JSON.stringify(l.fields)).toBe(ro.id);
  }, 60_000);
});
