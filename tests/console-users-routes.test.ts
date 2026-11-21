/**
 * OPS1: /api/console/users. Paged list with search, filters and sort; detail and sessions; every change needs a reason,
 * is refused for a role without the permission, on yourself and (ban, delete, sessions) on an operator, and leaves a
 * platform audit row with the action, target and reason.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { platformAuditLogs, sessions, users } from "@/server/db/schema";
import { LOCKOUT, lockedUntil, recordFailure } from "@/server/services/lockout";

const auditRows = async (ctx: Ctx, action: string, targetId: string) =>
  ctx.db.select().from(platformAuditLogs).where(and(eq(platformAuditLogs.action, action), eq(platformAuditLogs.targetId, targetId)));
const sessionCount = async (ctx: Ctx, userId: string) => (await ctx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).length;
const userRow = async (ctx: Ctx, id: string) => ctx.db.select().from(users).where(eq(users.id, id)).get();

describe("users list, detail and sessions", () => {
  let ctx: Ctx;
  let ro: Client;
  let roId: string;
  let ada: { c: Client; id: string };
  beforeAll(async () => {
    ctx = await makeTestApp();
    ({ c: ro, id: roId } = await signUpAs(ctx, "ro@ops.test", "ops_readonly"));
    ada = await signUpAs(ctx, "ada@acme.test", null, "Acme");
    await signUpAs(ctx, "bob@beta.test", null, "Beta");
    await ctx.db.update(users).set({ banned: true, banReason: "spam" }).where(eq(users.email, "bob@beta.test"));
  }, 60_000);

  it("pages with nextCursor, sorts, searches and filters", async () => {
    const first = await ro.get("/api/console/users?limit=1&sort=email:asc");
    expect(first.status).toBe(200);
    expect(first.body.items.map((u: { email: string }) => u.email)).toEqual(["ada@acme.test"]);
    expect(typeof first.body.nextCursor).toBe("string");
    const second = await ro.get(`/api/console/users?limit=1&sort=email:asc&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items.map((u: { email: string }) => u.email)).toEqual(["bob@beta.test"]);
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { body: { items: { email: string }[]; nextCursor: string | null } } = await ro.get(`/api/console/users?limit=2&sort=createdAt:desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      all.push(...r.body.items.map((u) => u.email));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(all.sort()).toEqual(["ada@acme.test", "bob@beta.test", "ro@ops.test"]);

    expect((await ro.get("/api/console/users?q=ACME")).body.items.map((u: { email: string }) => u.email)).toEqual(["ada@acme.test"]);
    expect((await ro.get(`/api/console/users?q=${ada.id}`)).body.items).toHaveLength(1);
    expect((await ro.get("/api/console/users?banned=true")).body.items.map((u: { email: string }) => u.email)).toEqual(["bob@beta.test"]);
    expect((await ro.get("/api/console/users?operator=true")).body.items.map((u: { email: string }) => u.email)).toEqual(["ro@ops.test"]);
    expect((await ro.get("/api/console/users?operator=false&banned=false")).body.items.map((u: { email: string }) => u.email)).toEqual(["ada@acme.test"]);
    expect((await ro.get("/api/console/users?twoFactor=false&sort=email:asc")).body.items).toHaveLength(3);
    const row = (await ro.get("/api/console/users?q=ada@")).body.items[0];
    expect(row).toMatchObject({ id: ada.id, workspaces: 1, banned: false, operator: false, emailVerified: true });
    expect(JSON.stringify(row)).not.toMatch(/password|token/i);
  }, 60_000);

  it("bad sort, bad cursor and bad filters are 4xx", async () => {
    expect((await ro.get("/api/console/users?sort=password:asc")).status).toBe(400);
    expect((await ro.get("/api/console/users?sort=email:sideways")).status).toBe(400);
    expect((await ro.get("/api/console/users?cursor=not-a-cursor")).status).toBe(400);
    expect((await ro.get("/api/console/users?banned=maybe")).status).toBe(422);
  });

  it("detail and sessions: 404 for an unknown person, and no secrets", async () => {
    const d = await ro.get(`/api/console/users/${ada.id}`);
    expect(d.status).toBe(200);
    expect(d.body.profile).toMatchObject({ id: ada.id, email: "ada@acme.test", operator: false });
    expect(d.body.memberships.map((m: { orgName: string }) => m.orgName)).toEqual(["Acme"]);
    expect(d.body.accounts[0]).toMatchObject({ providerId: "credential", hasPassword: true });
    expect(JSON.stringify(d.body)).not.toMatch(/"password"|accessToken|refreshToken|idToken|secret/i);
    const s = await ro.get(`/api/console/users/${ada.id}/sessions`);
    expect(s.status).toBe(200);
    expect(s.body.items.length).toBeGreaterThanOrEqual(1);
    expect(s.body.nextCursor).toBeNull();
    const token = (await ctx.db.select({ token: sessions.token }).from(sessions).where(eq(sessions.userId, ada.id)).get())!.token;
    expect(JSON.stringify(s.body)).not.toContain(token);
    expect(Object.keys(s.body.items[0])).not.toContain("token");
    expect((await ro.get("/api/console/users/usr_nobody")).status).toBe(404);
    expect((await ro.get("/api/console/users/usr_nobody/sessions")).status).toBe(404);
  });

  it("non operators get 401 or 403", async () => {
    expect((await new Client(ctx.app).get("/api/console/users")).status).toBe(401);
    expect((await ada.c.get("/api/console/users")).status).toBe(403);
    expect((await ada.c.get(`/api/console/users/${roId}`)).status).toBe(403);
    expect((await ada.c.post(`/api/console/users/${roId}/clear-lockout`, { reason: "Trying my luck" })).status).toBe(403);
  });
});

describe("users changes", () => {
  let ctx: Ctx;
  let owner: { c: Client; id: string };
  let sup: { c: Client; id: string };
  let billing: { c: Client; id: string };
  let ro: { c: Client; id: string };
  let opsAdmin: { c: Client; id: string };
  beforeAll(async () => {
    ctx = await makeTestApp();
    owner = await signUpAs(ctx, "owner@ops.test", "admin");
    sup = await signUpAs(ctx, "sup@ops.test", "ops_support");
    billing = await signUpAs(ctx, "bill@ops.test", "ops_billing");
    ro = await signUpAs(ctx, "ro@ops.test", "ops_readonly");
    opsAdmin = await signUpAs(ctx, "opsadmin@ops.test", "ops_admin");
  }, 90_000);

  it("revokes one session and all sessions (users.sessions), audited", async () => {
    const cus = await signUpAs(ctx, "cus1@cust.test", null);
    await cus.c.login("cus1@cust.test"); // a second session
    expect(await sessionCount(ctx, cus.id)).toBe(2);
    const list = (await sup.c.get(`/api/console/users/${cus.id}/sessions`)).body.items as { id: string }[];
    const one = list[0]!.id;

    expect((await sup.c.post(`/api/console/users/${cus.id}/sessions/${one}/revoke`, {})).status).toBe(422);
    expect((await ro.c.post(`/api/console/users/${cus.id}/sessions/${one}/revoke`, { reason: "Lost laptop" })).status).toBe(403);
    expect((await sup.c.post(`/api/console/users/${cus.id}/sessions/ses_nope/revoke`, { reason: "Lost laptop" })).status).toBe(404);
    const r = await sup.c.post(`/api/console/users/${cus.id}/sessions/${one}/revoke`, { reason: "Lost laptop" });
    expect(r.status).toBe(200);
    expect(await sessionCount(ctx, cus.id)).toBe(1);
    const [row] = await auditRows(ctx, "user.session_revoked", cus.id);
    expect(row).toMatchObject({ actorUserId: sup.id, actorRole: "ops_support", targetType: "user", reason: "Lost laptop" });

    expect((await billing.c.post(`/api/console/users/${cus.id}/sessions/revoke-all`, { reason: "x" })).status).toBe(422);
    const all = await billing.c.post(`/api/console/users/${cus.id}/sessions/revoke-all`, { reason: "Account takeover report" });
    expect(all.body).toEqual({ ok: true, sessionsEnded: 1 });
    expect(await sessionCount(ctx, cus.id)).toBe(0);
    expect((await cus.c.get("/api/account/me")).status).toBe(401);
    expect((await auditRows(ctx, "user.sessions_revoked", cus.id))[0]).toMatchObject({ actorRole: "ops_billing", reason: "Account takeover report" });
  }, 60_000);

  it("bans with an expiry and unbans (users.ban, step up), audited; the person can't sign in while banned", async () => {
    const cus = await signUpAs(ctx, "cus2@cust.test", null);
    expect((await sup.c.post(`/api/console/users/${cus.id}/ban`, { expiresInDays: 7 })).status).toBe(422);
    expect((await sup.c.post(`/api/console/users/${cus.id}/ban`, { reason: "Spam", expiresInDays: 0 })).status).toBe(422);
    expect((await billing.c.post(`/api/console/users/${cus.id}/ban`, { reason: "Spam run" })).status).toBe(403);
    expect((await ro.c.post(`/api/console/users/${cus.id}/ban`, { reason: "Spam run" })).status).toBe(403);
    const b = await sup.c.post(`/api/console/users/${cus.id}/ban`, { reason: "Spam run", expiresInDays: 7 });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ ok: true, banned: true, banReason: "Spam run", sessionsEnded: 1 });
    const u = await userRow(ctx, cus.id);
    expect(u!.banned).toBe(true);
    expect(u!.banExpires!.getTime() - ctx.deps.now().getTime()).toBeGreaterThan(6 * 86_400_000);
    expect(await sessionCount(ctx, cus.id)).toBe(0);
    expect((await cus.c.get("/api/account/me")).status).toBe(401);
    expect((await new Client(ctx.app).login("cus2@cust.test")).status).toBe(403);
    const [row] = await auditRows(ctx, "user.banned", cus.id);
    expect(row).toMatchObject({ actorUserId: sup.id, reason: "Spam run", targetType: "user" });
    expect(JSON.parse(row!.before!)).toMatchObject({ banned: false });
    expect(JSON.parse(row!.after!)).toMatchObject({ banned: true });
    expect((await sup.c.get("/api/console/users?banned=true")).body.items.map((x: { id: string }) => x.id)).toEqual([cus.id]);

    expect((await sup.c.post(`/api/console/users/${cus.id}/unban`, {})).status).toBe(422);
    const ub = await opsAdmin.c.post(`/api/console/users/${cus.id}/unban`, { reason: "Appeal accepted" });
    expect(ub.body).toMatchObject({ ok: true, banned: false, banReason: null, banExpires: null });
    expect((await new Client(ctx.app).login("cus2@cust.test")).status).toBe(200);
    expect((await auditRows(ctx, "user.unbanned", cus.id))[0]).toMatchObject({ actorRole: "ops_admin", reason: "Appeal accepted" });
  }, 60_000);

  it("ban asks for a recent sign in", async () => {
    const cus = await signUpAs(ctx, "cus3@cust.test", null);
    const stale = await signUpAs(ctx, "stale@ops.test", "ops_support");
    await ctx.db.update(sessions).set({ createdAt: new Date("2001-01-01T00:00:00Z") }).where(eq(sessions.userId, stale.id));
    const r = await stale.c.post(`/api/console/users/${cus.id}/ban`, { reason: "Spam run" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("step_up_required");
    expect((await userRow(ctx, cus.id))!.banned).toBeFalsy();
    // Unlock is not a step up action.
    expect((await stale.c.post(`/api/console/users/${cus.id}/clear-lockout`, { reason: "Locked out" })).status).toBe(200);
  }, 60_000);

  it("clears a lockout (users.unlock) and marks an address verified (users.verify), audited", async () => {
    const cus = await signUpAs(ctx, "cus4@cust.test", null);
    await ctx.db.update(users).set({ emailVerified: false }).where(eq(users.id, cus.id));
    const now = ctx.deps.now();
    for (let i = 0; i < LOCKOUT.MAX_FAILURES; i++) await recordFailure(ctx.db, "cus4@cust.test", now);
    expect(await lockedUntil(ctx.db, "cus4@cust.test", now)).not.toBeNull();

    expect((await sup.c.post(`/api/console/users/${cus.id}/clear-lockout`, {})).status).toBe(422);
    expect((await ro.c.post(`/api/console/users/${cus.id}/clear-lockout`, { reason: "Locked out" })).status).toBe(403);
    expect((await billing.c.post(`/api/console/users/${cus.id}/clear-lockout`, { reason: "Locked out on the phone" })).body).toEqual({ ok: true, wasLocked: true });
    expect(await lockedUntil(ctx.db, "cus4@cust.test", ctx.deps.now())).toBeNull();
    expect((await auditRows(ctx, "user.lockout_cleared", cus.id))[0]).toMatchObject({ actorRole: "ops_billing", reason: "Locked out on the phone" });

    expect((await sup.c.post(`/api/console/users/${cus.id}/verify`, { reason: "" })).status).toBe(422);
    expect((await ro.c.post(`/api/console/users/${cus.id}/verify`, { reason: "Checked by phone" })).status).toBe(403);
    expect((await sup.c.post(`/api/console/users/${cus.id}/verify`, { reason: "Checked by phone" })).body).toEqual({ ok: true, alreadyVerified: false });
    expect((await userRow(ctx, cus.id))!.emailVerified).toBe(true);
    expect((await auditRows(ctx, "user.email_verified", cus.id))[0]).toMatchObject({ actorUserId: sup.id, reason: "Checked by phone" });
    expect((await sup.c.post("/api/console/users/usr_nobody/verify", { reason: "Checked by phone" })).status).toBe(404);
  }, 60_000);

  it("deletes an account (users.delete, owners only, step up) through the account delete path, audited", async () => {
    const cus = await signUpAs(ctx, "cus5@cust.test", null, "Solo");
    expect((await owner.c.call("DELETE", `/api/console/users/${cus.id}`, {})).status).toBe(422);
    expect((await opsAdmin.c.call("DELETE", `/api/console/users/${cus.id}`, { reason: "Asked to be deleted" })).status).toBe(403);
    expect((await sup.c.call("DELETE", `/api/console/users/${cus.id}`, { reason: "Asked to be deleted" })).status).toBe(403);
    const r = await owner.c.call("DELETE", `/api/console/users/${cus.id}`, { reason: "Asked to be deleted" });
    expect(r.status).toBe(200);
    expect(await userRow(ctx, cus.id)).toBeUndefined();
    expect((await owner.c.get("/api/console/users?q=cus5")).body.items).toEqual([]);
    expect((await auditRows(ctx, "user.deleted", cus.id))[0]).toMatchObject({ actorUserId: owner.id, reason: "Asked to be deleted" });
    expect((await owner.c.call("DELETE", `/api/console/users/${cus.id}`, { reason: "Asked to be deleted" })).status).toBe(404);
  }, 60_000);

  it("refuses acting on yourself, and ban, delete and sessions on an operator", async () => {
    expect((await sup.c.post(`/api/console/users/${sup.id}/clear-lockout`, { reason: "Myself" })).body.error.code).toBe("self");
    expect((await owner.c.call("DELETE", `/api/console/users/${owner.id}`, { reason: "Myself" })).body.error.code).toBe("self");
    for (const [method, path] of [
      ["POST", `/api/console/users/${ro.id}/ban`],
      ["POST", `/api/console/users/${ro.id}/sessions/revoke-all`],
      ["DELETE", `/api/console/users/${ro.id}`],
    ] as const) {
      const r = await owner.c.call(method, path, { reason: "Testing the rule" });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error.code).toBe("target_is_operator");
    }
    const sid = (await ctx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, ro.id)).get())!.id;
    expect((await owner.c.post(`/api/console/users/${ro.id}/sessions/${sid}/revoke`, { reason: "Testing the rule" })).body.error.code).toBe("target_is_operator");
    expect((await userRow(ctx, ro.id))!.banned).toBeFalsy();
    expect(await sessionCount(ctx, ro.id)).toBeGreaterThan(0);
    // Help with sign in still works on an operator.
    expect((await owner.c.post(`/api/console/users/${ro.id}/clear-lockout`, { reason: "Locked out" })).status).toBe(200);
  }, 60_000);
});
