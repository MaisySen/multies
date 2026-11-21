/**
 * OPS1: who can open the console (/api/console/me) and operator management (/api/console/operators): owner only,
 * a recent sign in, a reason, audited; env listed owners and the last owner are protected.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { signUpAs } from "./console-kit";
import { platformAuditLogs, sessions, users } from "@/server/db/schema";
import { permissionsOf } from "@/shared/operator-permissions";

const roleOf = async (ctx: Awaited<ReturnType<typeof makeTestApp>>, id: string) => (await ctx.db.select({ role: users.role }).from(users).where(eq(users.id, id)).get())?.role;

describe("/api/console/me", () => {
  it("tells an operator their role and permissions; others get 401 or 403", async () => {
    const ctx = await makeTestApp();
    const { c: sup } = await signUpAs(ctx, "sup@ops.test", "ops_support");
    const { c: cus } = await signUpAs(ctx, "cus@else.test", null);
    const me = await sup.get("/api/console/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: "ops_support", roleLabel: "Support", user: { email: "sup@ops.test" }, fresh: true, freshMinutes: 15, envManaged: false });
    expect(me.body.permissions).toEqual(permissionsOf("ops_support"));
    expect(me.body.permissions).not.toContain("billing.manage");
    expect((await cus.get("/api/console/me")).body.error.code).toBe("forbidden");
    expect((await new Client(ctx.app).get("/api/console/me")).status).toBe(401);
    expect((await cus.get("/api/console/nothing-here")).status).toBe(403); // unknown paths say nothing to non operators
    expect((await sup.get("/api/console/nothing-here")).status).toBe(404);
    // Any operator role counts as an operator in the app shell.
    expect((await sup.get("/api/account/me")).body.user.platformAdmin).toBe(true);
    expect((await cus.get("/api/account/me")).body.user.platformAdmin).toBe(false);
  });

  it("asks for two-step sign in when OPERATOR_REQUIRE_2FA is on (an approved SSO sign in also counts)", async () => {
    const ctx = await makeTestApp({ OPERATOR_REQUIRE_2FA: "on" });
    const { c: ops, id } = await signUpAs(ctx, "ops@ops.test", "admin");
    const r = await ops.get("/api/console/me");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("two_factor_required");
    expect((await ops.get("/api/admin/overview")).body.error.code).toBe("two_factor_required");
    await ctx.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, id));
    expect((await ops.get("/api/console/me")).status).toBe(200);
    await ctx.db.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, id));
    await ctx.db.update(sessions).set({ loginMethod: "auth0" }).where(eq(sessions.userId, id));
    expect((await ops.get("/api/console/me")).status).toBe(200);
    // Off by default outside production; on in production unless "off".
    const { loadConfig } = await import("@/server/config");
    expect(loadConfig({ APP_SECRET: "t".repeat(40) }).operator.requireTwoFactor).toBe(false);
    expect(loadConfig({ APP_SECRET: "t".repeat(40), APP_MODE: "production", APP_URL: "https://x.example", OPERATOR_REQUIRE_2FA: "off" } as never).operator.requireTwoFactor).toBe(false);
  });

  it("refuses an impersonation session", async () => {
    const ctx = await makeTestApp();
    const { c: ops, id } = await signUpAs(ctx, "ops@ops.test", "admin");
    await ctx.db.update(sessions).set({ impersonatedBy: "usr_someone" }).where(eq(sessions.userId, id));
    const r = await ops.get("/api/console/me");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("impersonating");
    expect((await ops.get("/api/admin/overview")).status).toBe(403);
  });
});

describe("/api/console/operators", () => {
  it("owners list, grant, change and remove operators, each audited with its reason", async () => {
    const ctx = await makeTestApp();
    const { c: owner } = await signUpAs(ctx, "own@ops.test", "admin");
    const { id: newId } = await signUpAs(ctx, "new@ops.test", null);
    const list = await owner.get("/api/console/operators");
    expect(list.body.items.map((o: { email: string }) => o.email)).toEqual(["own@ops.test"]);
    expect(list.body.items[0]).toMatchObject({ role: "admin", roleLabel: "Owner", envManaged: false, twoFactor: false });
    expect(list.body.nextCursor).toBeNull();

    expect((await owner.post("/api/console/operators", { email: "new@ops.test", role: "ops_support" })).status).toBe(422); // no reason
    expect((await owner.post("/api/console/operators", { email: "new@ops.test", role: "ops_support", reason: "no" })).status).toBe(422);
    expect((await owner.post("/api/console/operators", { email: "nobody@ops.test", role: "ops_support", reason: "New hire" })).status).toBe(404);
    const g = await owner.post("/api/console/operators", { email: "new@ops.test", role: "ops_support", reason: "New hire on support" });
    expect(g.status).toBe(201);
    expect(await roleOf(ctx, newId)).toBe("ops_support");
    expect((await owner.post("/api/console/operators", { email: "new@ops.test", role: "ops_admin", reason: "Again" })).body.error.code).toBe("already_operator");

    expect((await owner.patch(`/api/console/operators/${newId}`, { role: "ops_billing", reason: "Moved to billing" })).body).toEqual({ ok: true, role: "ops_billing" });
    expect(await roleOf(ctx, newId)).toBe("ops_billing");
    expect((await owner.get("/api/console/operators?q=new@")).body.items).toHaveLength(1);

    expect((await owner.call("DELETE", `/api/console/operators/${newId}`, { reason: "Left the team" })).body).toEqual({ ok: true });
    expect(await roleOf(ctx, newId)).toBe("user");
    expect((await owner.patch(`/api/console/operators/${newId}`, { role: "admin", reason: "Not an operator" })).status).toBe(404);

    const rows = await ctx.db.select().from(platformAuditLogs).all();
    const by = (a: string) => rows.find((r) => r.action === a)!;
    expect(by("operator.granted")).toMatchObject({ targetId: newId, reason: "New hire on support", actorRole: "admin" });
    expect(JSON.parse(by("operator.granted").before!)).toEqual({ role: "user" });
    expect(JSON.parse(by("operator.role_changed").before!)).toEqual({ role: "ops_support" });
    expect(JSON.parse(by("operator.role_changed").after!)).toMatchObject({ role: "ops_billing" });
    expect(by("operator.removed")).toMatchObject({ reason: "Left the team" });
  });

  it("only owners manage operators; lower tiers can read the list", async () => {
    const ctx = await makeTestApp();
    const { c: opsAdmin } = await signUpAs(ctx, "adm@ops.test", "ops_admin");
    const { id: targetId } = await signUpAs(ctx, "ro@ops.test", "ops_readonly");
    expect((await opsAdmin.get("/api/console/operators")).status).toBe(200);
    expect((await opsAdmin.patch(`/api/console/operators/${targetId}`, { role: "admin", reason: "Promote myself" })).status).toBe(403);
    expect((await opsAdmin.post("/api/console/operators", { email: "adm@ops.test", role: "admin", reason: "Promote myself" })).status).toBe(403);
    expect(await roleOf(ctx, targetId)).toBe("ops_readonly");
  });

  it("needs a recent sign in", async () => {
    const ctx = await makeTestApp();
    const { c: owner, id } = await signUpAs(ctx, "own@ops.test", "admin");
    const { id: targetId } = await signUpAs(ctx, "ro@ops.test", "ops_readonly");
    await ctx.db.update(sessions).set({ createdAt: new Date(Date.now() - 16 * 60_000) }).where(eq(sessions.userId, id));
    const r = await owner.patch(`/api/console/operators/${targetId}`, { role: "ops_support", reason: "Promotion" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("step_up_required");
    expect((await owner.get("/api/console/me")).body.fresh).toBe(false);
    expect((await owner.get("/api/console/operators")).status).toBe(200); // reading needs no fresh sign in
    expect(await roleOf(ctx, targetId)).toBe("ops_readonly");
  });

  it("refuses to change env listed owners and to remove the last owner", async () => {
    const ctx = await makeTestApp({ PLATFORM_ADMIN_EMAILS: "boss@ops.test" });
    const { c: boss, id: bossId } = await signUpAs(ctx, "boss@ops.test", null);
    expect((await boss.get("/api/console/me")).body).toMatchObject({ role: "admin", envManaged: true });
    const { c: second, id: secondId } = await signUpAs(ctx, "two@ops.test", "admin");
    const envChange = await second.patch(`/api/console/operators/${bossId}`, { role: "ops_readonly", reason: "Demote the boss" });
    expect(envChange.status).toBe(409);
    expect(envChange.body.error.code).toBe("env_managed");
    expect((await second.call("DELETE", `/api/console/operators/${bossId}`, { reason: "Remove the boss" })).body.error.code).toBe("env_managed");
    expect((await second.get("/api/console/operators")).body.items.find((o: { id: string }) => o.id === bossId).envManaged).toBe(true);

    // Two owners: one may step down. Then the last one can't.
    expect((await second.patch(`/api/console/operators/${secondId}`, { role: "ops_admin", reason: "Stepping down" })).status).toBe(200);
    const ctx2 = await makeTestApp();
    const { c: only, id: onlyId } = await signUpAs(ctx2, "only@ops.test", "admin");
    const last = await only.call("DELETE", `/api/console/operators/${onlyId}`, { reason: "Leaving" });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe("last_owner");
    expect((await only.patch(`/api/console/operators/${onlyId}`, { role: "ops_admin", reason: "Leaving" })).body.error.code).toBe("last_owner");
  });
});
