/**
 * OPS1 impersonation: "View as" from the operator console, end to end through the real app (cookie jar included).
 * Start and Stop, the 30 minute limit and the missing dont_remember hazard, every refusal, view mode and act mode,
 * the always blocked list (walked from IMPERSONATION_ALWAYS_BLOCKED), no sign in side effects, SSO, /me, the person's
 * sessions list, ending a session from the console, both audit rows, and the admin plugin's role map.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { authFor } from "@/server/auth/options";
import { clearAuthCache } from "@/server/auth/guards";
import { authHeaders } from "@/server/lib/host-cookie";
import { auditLogs, invitations, members, operatorImpersonations, organizations, platformAuditLogs, sessions, users } from "@/server/db/schema";
import { IMPERSONATION_ALWAYS_BLOCKED, impersonationBlock } from "@/server/services/console/impersonation";
import { OPERATOR_ROLES, type OperatorRole } from "@/shared/operator-permissions";

const MIN = 60_000;
const REASON = "Ticket 4821: customer cannot find their invoices";
const DEV = { token: "mymail.session_token", dontRemember: "mymail.dont_remember", admin: "mymail.admin_session" };

beforeEach(() => clearAuthCache());

async function world(role: OperatorRole = "ops_support", env: Record<string, string> = {}) {
  const ctx = await makeTestApp(env);
  const op = await signUpAs(ctx, `olive.${role}@ops.test`, role, "Ops");
  const target = await signUpAs(ctx, "tara@example.com", null, "Target Co");
  const orgId = (await ctx.db.select().from(members).where(eq(members.userId, target.id)).get())!.organizationId;
  return { ctx, op, target, orgId };
}

const start = (c: Client, body: Record<string, unknown>) => c.post("/api/console/impersonation", { reason: REASON, ...body });
const row = (ctx: Ctx, operatorUserId: string) => ctx.db.select().from(operatorImpersonations).where(eq(operatorImpersonations.operatorUserId, operatorUserId)).get();

describe("start and stop", () => {
  it("round trip: the operator's own session comes back, dont_remember is cleared, both audit rows are written", async () => {
    const { ctx, op, target, orgId } = await world();
    const opToken = op.c.jar.get(DEV.token)!;
    const s = await start(op.c, { userId: target.id, mode: "view" });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.impersonation).toMatchObject({ mode: "view", userId: target.id, orgId });
    // Every Set-Cookie line was forwarded: the operator's session parked in admin_session, the new one, dont_remember.
    expect(op.c.jar.get(DEV.token)).not.toBe(opToken);
    expect(op.c.jar.get(DEV.admin)).toBeTruthy();
    expect(op.c.jar.get(DEV.dontRemember)).toBeTruthy();

    const imp = (await row(ctx, op.id))!;
    expect(imp).toMatchObject({ targetUserId: target.id, targetOrgId: orgId, mode: "view", reason: REASON, endedAt: null });
    const sess = (await ctx.db.select().from(sessions).where(eq(sessions.id, imp.sessionId!)).get())!;
    expect(sess.impersonatedBy).toBe(op.id);
    expect(sess.activeOrganizationId).toBe(orgId);
    const ttl = imp.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(29 * MIN);
    expect(ttl).toBeLessThanOrEqual(30 * MIN);
    expect(new Date(sess.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 30 * MIN + 1000);

    // The app runs as the person, and /me carries the banner data.
    const me = await op.c.get("/api/account/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: target.id, email: "tara@example.com", platformAdmin: false });
    expect(me.body.session.impersonation).toMatchObject({ mode: "view", operatorEmail: `olive.ops_support@ops.test` });
    expect(me.body.session.impersonation.secondsLeft).toBeGreaterThan(29 * 60);
    expect(me.body.session.impersonation.secondsLeft).toBeLessThanOrEqual(30 * 60);
    expect(me.body.onboarding).toEqual({ needed: false, workspace: false });

    // Audit: the platform row and the customer's own activity row.
    const p = (await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "impersonation.started")).get())!;
    expect(p).toMatchObject({ actorUserId: op.id, actorRole: "ops_support", targetType: "user", targetId: target.id, orgId, reason: REASON, impersonationId: imp.id });
    const w = (await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "support.session_started"))).get())!;
    expect(w.actorUserId).toBe(op.id);
    expect(JSON.parse(w.metadata!)).toMatchObject({ by: "operator", email: "tara@example.com", mode: "view", reason: REASON });
    // The customer sees it in their own activity log.
    const log = await target.c.get("/api/org/audit");
    expect(JSON.stringify(log.body)).toContain("support.session_started");

    const stop = await op.c.post("/api/console/impersonation/stop");
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(stop.body).toMatchObject({ ok: true, signedOut: false, returnTo: `/console/users/${target.id}` });
    expect(op.c.jar.get(DEV.token)).toBe(opToken);
    expect(op.c.jar.has(DEV.admin)).toBe(false);
    expect(op.c.jar.has(DEV.dontRemember)).toBe(false);
    expect(await ctx.db.select().from(sessions).where(eq(sessions.id, imp.sessionId!)).get()).toBeUndefined();
    expect((await row(ctx, op.id))!).toMatchObject({ endedReason: "stopped" });
    expect((await op.c.get("/api/account/me")).body.user.id).toBe(op.id);
    expect((await op.c.get("/api/console/me")).status).toBe(200);
    expect(await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "impersonation.stopped")).get()).toMatchObject({ actorUserId: op.id, targetId: target.id, impersonationId: imp.id });
    expect(await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "support.session_ended"))).get()).toBeTruthy();
  }, 60_000);

  it("orgId picks the workspace the session opens", async () => {
    const { ctx, op, target } = await world();
    const other = await signUpAs(ctx, "owner2@example.com", null, "Second Co");
    const org2 = (await ctx.db.select().from(members).where(eq(members.userId, other.id)).get())!.organizationId;
    await ctx.db.insert(members).values({ id: "mem_imp_second", organizationId: org2, userId: target.id, role: "member" });
    expect((await start(op.c, { userId: target.id, orgId: org2 })).status).toBe(201);
    expect((await op.c.get("/api/account/me")).body.organization.id).toBe(org2);
  }, 60_000);

  it("Stop when the operator's own session is gone ends the impersonation and signs the browser out", async () => {
    const { ctx, op, target } = await world();
    expect((await start(op.c, { userId: target.id })).status).toBe(201);
    const imp = (await row(ctx, op.id))!;
    await ctx.db.delete(sessions).where(eq(sessions.userId, op.id));
    const stop = await op.c.post("/api/console/impersonation/stop");
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(stop.body.signedOut).toBe(true);
    expect(await ctx.db.select().from(sessions).where(eq(sessions.id, imp.sessionId!)).get()).toBeUndefined();
    expect(op.c.jar.has(DEV.token)).toBe(false);
    expect(op.c.jar.has(DEV.admin)).toBe(false);
    expect(op.c.jar.has(DEV.dontRemember)).toBe(false);
    expect((await row(ctx, op.id))!.endedReason).toBe("operator_session_gone");
    expect((await op.c.get("/api/account/me")).status).toBe(401);
  }, 60_000);

  it("Stop from a normal operator session is a 400 (nothing to stop)", async () => {
    const { op } = await world();
    const r = await op.c.post("/api/console/impersonation/stop");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("not_impersonating");
  }, 60_000);
});

describe("expiry", () => {
  it("our 30 minute limit holds even when Better Auth stretched the session to 30 days (missing dont_remember)", async () => {
    const { ctx, op, target } = await world();
    expect((await start(op.c, { userId: target.id })).status).toBe(201);
    const imp = (await row(ctx, op.id))!;
    // The hazard: without dont_remember Better Auth rolls the 30 minute session forward to 30 days on the next read.
    op.c.jar.delete(DEV.dontRemember);
    expect((await op.c.get("/api/tasks")).status).toBe(200);
    const stretched = new Date((await ctx.db.select().from(sessions).where(eq(sessions.id, imp.sessionId!)).get())!.expiresAt).getTime();
    expect(stretched - Date.now()).toBeGreaterThan(29 * 24 * 60 * MIN);
    // 31 minutes later (our clock): the cached copy is not trusted, the session is deleted and reads as signed out.
    const realNow = ctx.deps.now;
    ctx.deps.now = () => new Date(Date.now() + 31 * MIN);
    try {
      expect((await op.c.get("/api/tasks")).status).toBe(401);
      expect(await ctx.db.select().from(sessions).where(eq(sessions.id, imp.sessionId!)).get()).toBeUndefined();
      expect((await row(ctx, op.id))!.endedReason).toBe("expired");
      expect((await op.c.get("/api/account/me")).status).toBe(401);
    } finally { ctx.deps.now = realNow; }
  }, 60_000);

  it("an operator who loses the permission (or is banned) loses the session at once", async () => {
    const { ctx, op, target } = await world();
    expect((await start(op.c, { userId: target.id })).status).toBe(201);
    expect((await op.c.get("/api/tasks")).status).toBe(200);
    await ctx.db.update(users).set({ role: "ops_readonly" }).where(eq(users.id, op.id));
    expect((await op.c.get("/api/tasks")).status).toBe(401);
    expect((await row(ctx, op.id))!.endedReason).toBe("invalid");
  }, 60_000);

  it("a session with no impersonation row is refused and deleted", async () => {
    const { ctx, op, target } = await world();
    expect((await start(op.c, { userId: target.id })).status).toBe(201);
    const imp = (await row(ctx, op.id))!;
    await ctx.db.delete(operatorImpersonations).where(eq(operatorImpersonations.id, imp.id));
    expect((await op.c.get("/api/account/me")).status).toBe(401);
    expect(await ctx.db.select().from(sessions).where(eq(sessions.id, imp.sessionId!)).get()).toBeUndefined();
  }, 60_000);
});

describe("refusals", () => {
  it("self, every operator tier, banned, missing, non member workspace, no workspace, bad body", async () => {
    const { ctx, op, target } = await world();
    const self = await start(op.c, { userId: op.id });
    expect([self.status, self.body.error.code]).toEqual([400, "cannot_impersonate_self"]);
    for (const tier of OPERATOR_ROLES) {
      const o = await signUpAs(ctx, `target.${tier}@ops.test`, tier);
      const r = await start(op.c, { userId: o.id });
      expect([r.status, r.body.error.code], tier).toEqual([403, "cannot_impersonate_operator"]);
    }
    const missing = await start(op.c, { userId: "usr_nobody" });
    expect(missing.status).toBe(404);
    await ctx.db.update(users).set({ banned: true }).where(eq(users.id, target.id));
    expect((await start(op.c, { userId: target.id })).body.error.code).toBe("user_banned");
    await ctx.db.update(users).set({ banned: false }).where(eq(users.id, target.id));
    const otherOrg = (await ctx.db.select().from(members).where(eq(members.userId, op.id)).get())!.organizationId;
    const nm = await start(op.c, { userId: target.id, orgId: otherOrg });
    expect([nm.status, nm.body.error.code]).toEqual([404, "not_a_member"]);
    const lonely = await signUpAs(ctx, "lonely@example.com", null);
    await ctx.db.delete(members).where(eq(members.userId, lonely.id));
    expect((await start(op.c, { userId: lonely.id })).body.error.code).toBe("no_workspace");
    const noReason = await op.c.post("/api/console/impersonation", { userId: target.id, mode: "view" });
    expect(noReason.status).toBe(422);
    const badMode = await start(op.c, { userId: target.id, mode: "admin" });
    expect(badMode.status).toBe(422);
    // Nothing was started by any of these.
    expect(await ctx.db.select().from(operatorImpersonations).all()).toEqual([]);
    expect((await ctx.db.select().from(sessions).where(eq(sessions.userId, target.id)).all()).filter((x) => x.impersonatedBy)).toEqual([]);
  }, 120_000);

  it("roles: readonly and billing cannot start; support cannot act; ops_admin can act; step up is required", async () => {
    const { ctx, op, target } = await world("ops_support");
    const act = await start(op.c, { userId: target.id, mode: "act" });
    expect([act.status, act.body.error.code]).toEqual([403, "forbidden"]);
    for (const role of ["ops_readonly", "ops_billing"] as const) {
      const o = await signUpAs(ctx, `nope.${role}@ops.test`, role);
      const r = await start(o.c, { userId: target.id });
      expect([r.status, r.body.error.code], role).toEqual([403, "forbidden"]);
    }
    const customer = await signUpAs(ctx, "cust@example.com", null);
    expect((await start(customer.c, { userId: target.id })).status).toBe(403);
    expect((await start(new Client(ctx.app), { userId: target.id })).status).toBe(401);
    // No step up: the operator signed in more than 15 minutes ago.
    await ctx.db.update(sessions).set({ createdAt: new Date(Date.now() - 60 * MIN) }).where(eq(sessions.userId, op.id));
    const stale = await start(op.c, { userId: target.id });
    expect([stale.status, stale.body.error.code]).toEqual([403, "step_up_required"]);
    const admin = await signUpAs(ctx, "boss@ops.test", "ops_admin");
    expect((await start(admin.c, { userId: target.id, mode: "act" })).status).toBe(201);
  }, 120_000);

  it("a PLATFORM_ADMIN_EMAILS listed person is not impersonable, and an impersonated page load never promotes", async () => {
    const { ctx, op, target } = await world("ops_support", { PLATFORM_ADMIN_EMAILS: "listed@example.com" });
    // signUpAs confirms the address after sign up, so this person has not been promoted yet.
    const listed = await signUpAs(ctx, "listed@example.com", null);
    expect((await ctx.db.select().from(users).where(eq(users.id, listed.id)).get())!.role).not.toBe("admin");
    const r = await start(op.c, { userId: listed.id });
    expect([r.status, r.body.error.code]).toEqual([403, "cannot_impersonate_operator"]);
    // Impersonating someone who becomes listed later: their page loads while viewed do not promote them.
    expect((await start(op.c, { userId: target.id })).status).toBe(201);
    ctx.deps.config.platformAdmins.push("tara@example.com");
    try {
      const me = await op.c.get("/api/account/me");
      expect(me.status).toBe(200);
      expect(me.body.user.platformAdmin).toBe(false);
      expect((await ctx.db.select().from(users).where(eq(users.id, target.id)).get())!.role).not.toBe("admin");
      expect((await op.c.get("/api/console/me")).body.error.code).toBe("impersonating");
    } finally { ctx.deps.config.platformAdmins.pop(); }
  }, 60_000);
});

describe("view mode", () => {
  it("allows reads and blocks writes on feature routes", async () => {
    const { op, target } = await world();
    expect((await start(op.c, { userId: target.id, mode: "view" })).status).toBe(201);
    for (const p of ["/api/account/me", "/api/account/workspaces", "/api/tasks", "/api/contacts", "/api/docs", "/api/org"]) {
      expect((await op.c.get(p)).status, p).toBe(200);
    }
    const writes: [string, string, unknown][] = [
      ["POST", "/api/tasks", { title: "x" }],
      ["PATCH", "/api/org", { name: "Renamed" }],
      ["POST", "/api/contacts", { name: "x" }],
      ["POST", "/api/docs", { title: "x" }],
      ["POST", "/api/projects", { name: "x" }],
      ["PATCH", "/api/account/preferences", { timezone: "Europe/London" }],
      ["POST", "/api/account/workspaces", { name: "x" }],
      ["POST", "/api/account/onboarding", { name: "x", timezone: "UTC", locale: "en" }],
    ];
    for (const [m, p, b] of writes) {
      const r = await op.c.call(m, p, b);
      expect([r.status, r.body?.error?.code], `${m} ${p}`).toEqual([403, "impersonation_blocked"]);
      expect(r.body.error.message).toBe("You are viewing as this person. Changes are turned off.");
    }
  }, 60_000);

  it("the policy function: reads pass, writes are view-blocked, Stop is never blocked", () => {
    expect(impersonationBlock("view", "GET", "/api/tasks")).toBeNull();
    expect(impersonationBlock("view", "POST", "/api/tasks")).toBe("view");
    expect(impersonationBlock("act", "POST", "/api/tasks")).toBeNull();
    expect(impersonationBlock("view", "POST", "/api/console/impersonation/stop")).toBeNull();
    expect(impersonationBlock("act", "GET", "/api/auth/get-session")).toBeNull();
    expect(impersonationBlock("act", "GET", "/api/vault/state")).toBe("always");
    // Mail leaving the workspace: writes refused in both modes, reads and removals stay open in act mode.
    for (const [m, p] of [["POST", "/api/mail/rules"], ["PATCH", "/api/mail/rules/r1"], ["POST", "/api/mail/rules/r1/run-recent"], ["POST", "/api/aliases"],
      ["PATCH", "/api/aliases/a1"], ["PUT", "/api/mailboxes/m1/sharing/u1"], ["PATCH", "/api/mailboxes/m1"]]) {
      expect(impersonationBlock("act", m, p), `${m} ${p}`).toBe("always");
    }
    for (const p of ["/api/mail/rules", "/api/mail/rules/r1", "/api/aliases", "/api/mailboxes", "/api/mailboxes/m1/sharing"]) expect(impersonationBlock("act", "GET", p), p).toBeNull();
    for (const p of ["/api/mail/rules/r1", "/api/aliases/a1", "/api/mailboxes/m1/sharing/u1"]) expect(impersonationBlock("act", "DELETE", p), p).toBeNull();
  });
});

describe("act mode", () => {
  it("normal writes work and their audit entries name the operator (impersonatedBy)", async () => {
    const { ctx, op, target, orgId } = await world("ops_admin");
    expect((await start(op.c, { userId: target.id, mode: "act" })).status).toBe(201);
    const r = await op.c.patch("/api/org", { name: "Renamed by support" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).get())!.name).toBe("Renamed by support");
    const renamed = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "workspace.renamed"))).all();
    const a = renamed.find((x) => JSON.parse(x.metadata ?? "{}").name === "Renamed by support")!;
    expect(a.actorUserId).toBe(target.id);
    expect(JSON.parse(a.metadata!)).toMatchObject({ impersonatedBy: op.id });
    // The person's own writes carry no such stamp.
    await target.c.patch("/api/org", { name: "Renamed by the owner" });
    const own = (await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "workspace.renamed"))).all()).find((x) => JSON.parse(x.metadata ?? "{}").name === "Renamed by the owner")!;
    expect(JSON.parse(own.metadata!)).not.toHaveProperty("impersonatedBy");
  }, 60_000);
});

describe("always blocked, both modes (walks IMPERSONATION_ALWAYS_BLOCKED)", () => {
  for (const mode of ["view", "act"] as const) {
    it(`${mode} mode`, async () => {
      // Flagged routes on, so the request reaches the route's own guard (MOBILE_WEB_LINK answers 404 while off).
      const { ctx, op, target } = await world(mode === "act" ? "ops_admin" : "ops_support", { MOBILE_WEB_LINK: "on", PASSKEY_DES1: "on", VAULT_R128: "on", MAIL_ARCHIVE_R111: "on", DASHBOARDS_PLUS: "on", CLIENT_PORTAL: "on", CHAT_CHANNELS: "on", SCHEDULING_ENABLED: "true", BOOKING_PLUS: "true" });
      expect((await start(op.c, { userId: target.id, mode })).status).toBe(201);
      const imp = (await row(ctx, op.id))!;
      for (const rule of IMPERSONATION_ALWAYS_BLOCKED) {
        const { method, path } = rule.example;
        expect(impersonationBlock(mode, method, path), `${rule.group} ${path}`).toBe("always");
        const r = await op.c.call(method, path, method === "GET" || method === "HEAD" ? undefined : {});
        const code = r.body?.error?.code ?? r.body?.code;
        if (rule.enforcedBy === "requireAuth") expect([r.status, code], `${method} ${path}`).toEqual([403, "impersonation_blocked"]);
        else if (rule.enforcedBy === "operatorSession") expect([r.status, code], `${method} ${path}`).toEqual([403, "impersonating"]);
        else expect([r.status, code], `${method} ${path}`).toEqual([403, "IMPERSONATION_BLOCKED"]);
      }
      // Better Auth's own endpoints, one by one (the betterAuth rule covers /api/auth/* as a whole).
      // (set-password is server only in Better Auth, and passkeys are the app's own /api/passkeys, both in the walk above.)
      for (const p of ["/api/auth/change-password", "/api/auth/change-email", "/api/auth/update-user", "/api/auth/two-factor/enable",
        "/api/auth/two-factor/disable", "/api/auth/revoke-session", "/api/auth/revoke-sessions", "/api/auth/revoke-other-sessions",
        "/api/auth/sign-out", "/api/auth/link-social", "/api/auth/unlink-account", "/api/auth/send-verification-email"]) {
        const r = await op.c.post(p, {});
        expect([r.status, r.body?.code], p).toEqual([403, "IMPERSONATION_BLOCKED"]);
      }
      expect((await op.c.get("/api/auth/list-sessions")).status).toBe(403);
      // Closed over HTTP for everyone (app.ts): still 404.
      for (const p of ["/api/auth/delete-user", "/api/auth/admin/stop-impersonating", "/api/auth/admin/impersonate-user"]) expect((await op.c.post(p, {})).status, p).toBe(404);
      // Reading its own session is allowed, and none of the above ended it.
      const gs = await op.c.get("/api/auth/get-session");
      expect(gs.status).toBe(200);
      expect(gs.body.user.id).toBe(target.id);
      expect(await ctx.db.select().from(sessions).where(eq(sessions.id, imp.sessionId!)).get()).toBeTruthy();
      expect((await op.c.post("/api/console/impersonation/stop")).status).toBe(200);
    }, 120_000);
  }
});

describe("no sign in side effects", () => {
  it("a pending invite is not accepted and no workspace is made while viewed", async () => {
    const { ctx, op, target, orgId } = await world();
    const inviter = await signUpAs(ctx, "inviter@example.com", null, "Inviter Co");
    const inviterOrg = (await ctx.db.select().from(members).where(eq(members.userId, inviter.id)).get())!.organizationId;
    await ctx.db.insert(invitations).values({ id: "inv_imp_pending", organizationId: inviterOrg, email: "tara@example.com", role: "member", status: "pending", expiresAt: new Date(Date.now() + 7 * 24 * 60 * MIN), inviterId: inviter.id });
    expect((await start(op.c, { userId: target.id })).status).toBe(201);
    expect((await op.c.get("/api/account/me")).body.pendingInvites).toEqual([]);
    // The person leaves their only workspace while viewed: a normal sign in would now join the invite or make a workspace.
    const orgsBefore = (await ctx.db.select().from(organizations).all()).length;
    await ctx.db.delete(members).where(and(eq(members.userId, target.id), eq(members.organizationId, orgId)));
    clearAuthCache();
    expect((await op.c.get("/api/account/me")).status).toBe(401);
    expect((await ctx.db.select().from(invitations).where(eq(invitations.id, "inv_imp_pending")).get())!.status).toBe("pending");
    expect(await ctx.db.select().from(members).where(eq(members.userId, target.id)).all()).toEqual([]);
    expect((await ctx.db.select().from(organizations).all()).length).toBe(orgsBefore);
  }, 60_000);

  it("an SSO-required workspace can be viewed (the SSO block is skipped for support)", async () => {
    const { ctx, op, target, orgId } = await world();
    await ctx.db.update(members).set({ role: "admin" }).where(eq(members.userId, target.id));
    await ctx.db.update(organizations).set({ requireSso: true }).where(eq(organizations.id, orgId));
    expect((await target.c.get("/api/tasks")).body.error?.code).toBe("sso_required"); // the person's own password session
    expect((await start(op.c, { userId: target.id })).status).toBe(201);
    expect((await op.c.get("/api/tasks")).status).toBe(200);
    expect((await op.c.get("/api/account/me")).body.session.ssoBlocked).toBe(false);
  }, 60_000);
});

describe("the person's view and the console's", () => {
  it("the person's sessions list hides the support session", async () => {
    const { ctx, op, target } = await world();
    expect((await start(op.c, { userId: target.id })).status).toBe(201);
    const imp = (await row(ctx, op.id))!;
    const list = (await target.c.get("/api/account/sessions")).body.sessions as { id: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((s) => s.id)).not.toContain(imp.sessionId);
  }, 60_000);

  it("lists sessions and ends one from the console; the read cache stops serving it at once", async () => {
    const { ctx, op, target, orgId } = await world();
    const boss = await signUpAs(ctx, "boss@ops.test", "ops_admin");
    expect((await start(op.c, { userId: target.id })).status).toBe(201);
    const imp = (await row(ctx, op.id))!;
    const list = await boss.c.get("/api/console/impersonation?status=active");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: imp.id, operatorUserId: op.id, targetEmail: "tara@example.com", orgId, mode: "view", active: true });
    // The Support sessions tab's names: the operator's name and the workspace's owner, looked up for the whole page.
    const opName = (await ctx.db.select({ name: users.name }).from(users).where(eq(users.id, op.id)).get())!.name;
    expect(list.body.items[0]).toMatchObject({ operatorName: opName, orgOwnerEmail: "tara@example.com" });
    expect(typeof list.body.items[0].orgName).toBe("string");
    expect((await boss.c.get("/api/console/impersonation?sort=nope:up")).status).toBe(200);
    expect((await boss.c.get("/api/console/impersonation?cursor=garbage")).status).toBe(400);
    // A read just before the end (an impersonated session is never kept in the 15 second read cache).
    expect((await op.c.get("/api/tasks")).status).toBe(200);
    // Support cannot end sessions; a reason is required.
    const support2 = await signUpAs(ctx, "s2@ops.test", "ops_support");
    expect((await support2.c.post(`/api/console/impersonation/${imp.id}/end`, { reason: "nope" })).status).toBe(403);
    expect((await boss.c.post(`/api/console/impersonation/${imp.id}/end`, {})).status).toBe(422);
    const end = await boss.c.post(`/api/console/impersonation/${imp.id}/end`, { reason: "Customer asked us to stop" });
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect(await ctx.db.select().from(sessions).where(eq(sessions.id, imp.sessionId!)).get()).toBeUndefined();
    expect((await row(ctx, op.id))!.endedReason).toBe("revoked");
    expect((await op.c.get("/api/tasks")).status).toBe(401);
    expect((await boss.c.post(`/api/console/impersonation/${imp.id}/end`, { reason: "again please" })).status).toBe(409);
    expect((await boss.c.get("/api/console/impersonation?status=active")).body.items).toEqual([]);
    expect((await boss.c.get("/api/console/impersonation?status=ended")).body.items[0]).toMatchObject({ id: imp.id, endedReason: "revoked", active: false });
    expect(await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "impersonation.ended")).get()).toMatchObject({ actorUserId: boss.id, reason: "Customer asked us to stop", orgId });
    expect(await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "support.session_ended"))).get()).toBeTruthy();
  }, 60_000);
});

describe("the Support sessions list names the workspace's first owner", () => {
  it("not the person viewed as, nor a later owner; none when the workspace has no owner", async () => {
    const { ctx, op } = await world();
    const boss = await signUpAs(ctx, "boss@ops.test", "ops_admin");
    const ann = await signUpAs(ctx, "ann@example.com", null, "Ann Co");
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, ann.id)).get())!.organizationId;
    const bob = await signUpAs(ctx, "bob@example.com", null, "Bob Co");
    const mia = await signUpAs(ctx, "mia@example.com", null, "Mia Co");
    const later = new Date(Date.now() + 60_000);
    await ctx.db.insert(members).values({ id: "mem_bob_owner", organizationId: orgId, userId: bob.id, role: "owner", createdAt: later });
    await ctx.db.insert(members).values({ id: "mem_mia_member", organizationId: orgId, userId: mia.id, role: "member", createdAt: later });
    expect((await start(op.c, { userId: mia.id, orgId })).status).toBe(201);
    const owner = async () => (await boss.c.get("/api/console/impersonation?status=active")).body.items[0].orgOwnerEmail;
    expect(await owner()).toBe("ann@example.com");
    // Search matches the names the table shows: the person's name and the workspace's name.
    await ctx.db.update(users).set({ name: "Mia Lopez" }).where(eq(users.id, mia.id));
    for (const q of ["Lopez", "Ann Co", "mia@example"]) {
      expect((await boss.c.get(`/api/console/impersonation?status=all&q=${encodeURIComponent(q)}`)).body.items, q).toHaveLength(1);
    }
    expect((await boss.c.get("/api/console/impersonation?status=all&q=Nobody")).body.items).toEqual([]);
    await ctx.db.update(members).set({ role: "admin" }).where(and(eq(members.organizationId, orgId), eq(members.userId, ann.id)));
    expect(await owner()).toBe("bob@example.com");
    await ctx.db.update(members).set({ role: "member" }).where(eq(members.id, "mem_bob_owner"));
    expect(await owner()).toBeNull();
  }, 90_000);
});

describe("every way a session ends is recorded", () => {
  const ended = (ctx: Ctx, orgId: string) => ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "support.session_ended"))).all();

  it("signing the person out from Users (one session, then every session) ends the View as session and names who did it", async () => {
    const { ctx, op, target, orgId } = await world();
    const boss = await signUpAs(ctx, "boss@ops.test", "ops_admin");
    expect((await start(op.c, { userId: target.id })).status).toBe(201);
    const imp = (await row(ctx, op.id))!;
    // Revoking one of the person's own sessions leaves the support session alone.
    const own = (await ctx.db.select().from(sessions).where(eq(sessions.userId, target.id)).all()).find((s) => s.id !== imp.sessionId)!;
    expect((await boss.c.post(`/api/console/users/${target.id}/sessions/${own.id}/revoke`, { reason: "Lost laptop" })).status).toBe(200);
    expect((await row(ctx, op.id))!.endedAt).toBeNull();
    // Revoking the support session ends it: not listed as active, the reason says how, the workspace log says who.
    expect((await boss.c.post(`/api/console/users/${target.id}/sessions/${imp.sessionId}/revoke`, { reason: "Ticket closed" })).status).toBe(200);
    expect((await op.c.get("/api/tasks")).status).toBe(401);
    expect((await row(ctx, op.id))!).toMatchObject({ endedReason: "signed_out" });
    expect((await boss.c.get("/api/console/impersonation?status=active")).body.items).toEqual([]);
    expect((await boss.c.get("/api/console/impersonation?status=ended")).body.items[0]).toMatchObject({ id: imp.id, endedReason: "signed_out", active: false });
    const rows = await ended(ctx, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: boss.id, actorEmail: "boss@ops.test", targetId: target.id });
    expect(JSON.parse(rows[0]!.metadata!)).toMatchObject({ email: "tara@example.com", endedReason: "signed_out", mode: "view" });

    // Every session: a second support session ends the same way.
    const again = new Client(ctx.app);
    expect((await again.login(`olive.ops_support@ops.test`)).status).toBe(200);
    expect((await start(again, { userId: target.id })).status).toBe(201);
    expect((await boss.c.get("/api/console/impersonation?status=active")).body.items).toHaveLength(1);
    expect((await boss.c.post(`/api/console/users/${target.id}/sessions/revoke-all`, { reason: "Account recovery" })).status).toBe(200);
    expect((await boss.c.get("/api/console/impersonation?status=active")).body.items).toEqual([]);
    const all = await ctx.db.select().from(operatorImpersonations).where(eq(operatorImpersonations.operatorUserId, op.id)).all();
    expect(all.map((r) => r.endedReason)).toEqual(["signed_out", "signed_out"]);
    expect(await ended(ctx, orgId)).toHaveLength(2);
  }, 90_000);

  it("the time limit noticed and an operator losing access both write the workspace's ended entry", async () => {
    const { ctx, op, target, orgId } = await world();
    expect((await start(op.c, { userId: target.id })).status).toBe(201);
    const realNow = ctx.deps.now;
    ctx.deps.now = () => new Date(Date.now() + 31 * MIN);
    try {
      expect((await op.c.get("/api/tasks")).status).toBe(401);
    } finally { ctx.deps.now = realNow; }
    let rows = await ended(ctx, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: op.id });
    expect(JSON.parse(rows[0]!.metadata!)).toMatchObject({ endedReason: "expired" });

    // Demoted by an owner: endImpersonationsNotAllowed ends it at once ("revoked").
    const owner = await signUpAs(ctx, "owner@ops.test", "admin");
    const again = new Client(ctx.app);
    expect((await again.login(`olive.ops_support@ops.test`)).status).toBe(200);
    expect((await start(again, { userId: target.id })).status).toBe(201);
    await ctx.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, op.id)); // a role change needs it on
    expect((await owner.c.call("PATCH", `/api/console/operators/${op.id}`, { role: "ops_readonly", reason: "Moved to read only" })).status).toBe(200);
    rows = await ended(ctx, orgId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => JSON.parse(r.metadata!).endedReason).sort()).toEqual(["expired", "revoked"]);
  }, 90_000);
});

describe("the admin plugin", () => {
  it("/api/auth/admin/* stays 404 over HTTP for operators", async () => {
    const { op, target } = await world("admin" as OperatorRole);
    for (const p of ["impersonate-user", "stop-impersonating", "ban-user", "list-user-sessions"]) {
      expect((await op.c.post(`/api/auth/admin/${p}`, { userId: target.id })).status, p).toBe(404);
    }
  }, 60_000);

  it("role map: ops_support can ban in process, ops_readonly cannot", async () => {
    const { ctx, op, target } = await world("ops_support");
    const reader = await signUpAs(ctx, "reader@ops.test", "ops_readonly");
    const auth = authFor(ctx.deps);
    const h = (c: Client) => authHeaders(new Headers({ cookie: c.cookie, host: "localhost" }), false);
    expect((await auth.api.banUser({ headers: h(reader.c), body: { userId: target.id }, asResponse: true })).status).toBe(403);
    expect((await auth.api.banUser({ headers: h(op.c), body: { userId: target.id }, asResponse: true })).status).toBe(200);
    expect((await ctx.db.select().from(users).where(eq(users.id, target.id)).get())!.banned).toBe(true);
    expect((await auth.api.unbanUser({ headers: h(op.c), body: { userId: target.id }, asResponse: true })).status).toBe(200);
  }, 60_000);
});

describe("production cookie names", () => {
  it("start and stop survive the __Host- rewrite and clear __Secure-mymail.dont_remember", async () => {
    const { ctx, op, target } = await world("ops_support", { APP_MODE: "production", PASSWORD_BREACH_CHECK: "false", OPERATOR_REQUIRE_2FA: "off" });
    const opToken = op.c.jar.get("__Host-mymail.session_token");
    expect(opToken).toBeTruthy();
    const s = await start(op.c, { userId: target.id });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(op.c.jar.get("__Secure-mymail.dont_remember")).toBeTruthy();
    expect(op.c.jar.get("__Secure-mymail.admin_session")).toBeTruthy();
    expect((await op.c.get("/api/account/me")).body.user.id).toBe(target.id);
    expect((await op.c.post("/api/tasks", { title: "x" })).body.error.code).toBe("impersonation_blocked");
    const stop = await op.c.post("/api/console/impersonation/stop");
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(op.c.jar.get("__Host-mymail.session_token")).toBe(opToken);
    expect(op.c.jar.has("__Secure-mymail.admin_session")).toBe(false);
    expect(op.c.jar.has("__Secure-mymail.dont_remember")).toBe(false);
    expect((await op.c.get("/api/account/me")).body.user.id).toBe(op.id);
    void ctx;
  }, 60_000);
});
