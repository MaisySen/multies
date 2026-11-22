/**
 * OPS1 security review H2: an address an operator marked confirmed must never bootstrap an owner
 * (PLATFORM_ADMIN_EMAILS) or silently join a pending invite. The console's Verify refuses operator and listed accounts
 * (409), the bootstrap in resolveAuth skips an address with a user.email_verified platform audit row, and so does the
 * first sign in invite join. Listed user ids keep working.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { signUpAs } from "./console-kit";
import { Client, makeTestApp } from "./helpers";
import { platformAuditLogs, users } from "@/server/db/schema";
import { clearAuthCache } from "@/server/auth/guards";

describe("H2: operator verified addresses", () => {
  it("the review's exact escalation: support verifies a squatted listed address; it is refused and never becomes owner", async () => {
    const ctx = await makeTestApp({ PLATFORM_ADMIN_EMAILS: "newboss@ops.test" });
    const sup = await signUpAs(ctx, "sup@ops.test", "ops_support", "Sup");
    const att = new Client(ctx.app);
    const s = await att.call("POST", "/api/auth/sign-up/email", { name: "Mallory", email: "newboss@ops.test", password: "a-strong-password" }, { "cf-connecting-ip": "203.0.113.9" });
    expect(s.status).toBe(200);
    expect((await att.get("/api/account/me")).body.user.platformAdmin).toBe(false);
    const u = (await ctx.db.select().from(users).where(eq(users.email, "newboss@ops.test")).get())!;
    expect(u.emailVerified).toBe(false);
    const v = await sup.c.post(`/api/console/users/${u.id}/verify`, { reason: "customer says the mail never came" });
    expect(v.status).toBe(409);
    expect(v.body.error.code).toBe("protected_account");
    clearAuthCache();
    expect((await att.get("/api/account/me")).body.user.platformAdmin).toBe(false);
    expect((await ctx.db.select({ role: users.role, v: users.emailVerified }).from(users).where(eq(users.id, u.id)).get())).toEqual({ role: "user", v: false });
    expect((await att.get("/api/console/me")).status).toBe(403);
  }, 60_000);

  it("verify refuses an operator account and a listed user id (409); an ordinary account is verified", async () => {
    const ctx = await makeTestApp();
    const owner = await signUpAs(ctx, "owner@ops.test", "admin", "Ops");
    const op = await signUpAs(ctx, "ro@ops.test", "ops_readonly", "Ro");
    const listed = await signUpAs(ctx, "byid@example.com", null, "ById");
    ctx.deps.config.platformAdmins.push(listed.id.toLowerCase());
    const plain = await signUpAs(ctx, "plain@example.com", null, "Plain");
    await ctx.db.update(users).set({ emailVerified: false }).where(eq(users.id, plain.id));
    for (const id of [op.id, listed.id]) {
      const r = await owner.c.post(`/api/console/users/${id}/verify`, { reason: "testing the refusal" });
      expect(r.status, id).toBe(409);
    }
    expect((await owner.c.post(`/api/console/users/${plain.id}/verify`, { reason: "mail bounced, checked by phone" })).status).toBe(200);
  }, 60_000);

  it("the bootstrap never promotes an address an operator verified; a listed user id still is", async () => {
    const ctx = await makeTestApp({ PLATFORM_ADMIN_EMAILS: "boss@example.com" });
    const att = new Client(ctx.app);
    await att.call("POST", "/api/auth/sign-up/email", { name: "Mallory", email: "boss@example.com", password: "a-strong-password" }, { "cf-connecting-ip": "203.0.113.10" });
    const u = (await ctx.db.select().from(users).where(eq(users.email, "boss@example.com")).get())!;
    // As if an earlier build (or any later path) had let an operator confirm it: the audit row is what the guard reads.
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.id, u.id));
    await ctx.db.insert(platformAuditLogs).values({ id: "pal_sec_h2", actorUserId: "usr_op", actorEmail: "op@ops.test", actorRole: "ops_support", action: "user.email_verified", targetType: "user", targetId: u.id });
    clearAuthCache();
    expect((await att.get("/api/account/me")).body.user.platformAdmin).toBe(false);
    expect((await ctx.db.select({ role: users.role }).from(users).where(eq(users.id, u.id)).get())!.role).toBe("user");
    // Listed by id: promoted regardless.
    ctx.deps.config.platformAdmins.push(u.id.toLowerCase());
    clearAuthCache();
    expect((await att.get("/api/account/me")).body.user.platformAdmin).toBe(true);
  }, 60_000);

  it("an address an operator verified never auto-joins a pending invite on first sign in", async () => {
    const ctx = await makeTestApp();
    const sup = await signUpAs(ctx, "sup@ops.test", "ops_support", "Sup");
    const owner = new Client(ctx.app);
    await owner.signup("olive@example.com", "Olive Owner", "Harbor");
    const email = "invited-sec@example.com";
    expect((await owner.post("/api/team/invites", { email, role: "member" })).status).toBe(201);
    const att = new Client(ctx.app);
    att.autoVerify = false;
    expect((await att.post("/api/auth/sign-up/email", { name: "Mallory", email, password: "a-strong-password" })).status).toBe(200);
    const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
    // No signed in request yet, so no workspace: the next one is the "first sign in" path.
    expect((await sup.c.post(`/api/console/users/${u.id}/verify`, { reason: "customer says the mail never came" })).status).toBe(200);
    clearAuthCache();
    const me = await att.get("/api/account/me");
    expect(me.status).toBe(200);
    expect(me.body.organization.name).not.toBe("Harbor");
    expect(me.body.organization.role).toBe("owner");
  }, 60_000);
});
