/**
 * OPS1 security review M2: the console's two-step rule is about the session, not only the account flag, and no
 * sign in method counts as two-step unless OPERATOR_SSO_METHODS lists it.
 */
import { describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import { eq } from "drizzle-orm";
import { signUpAs } from "./console-kit";
import { Client, makeTestApp } from "./helpers";
import { platformAuditLogs, sessions } from "@/server/db/schema";
import { loadConfig } from "@/server/config";
import { twoFactorEnrolledAt } from "@/server/auth/two-factor-enrolment";

async function enrol(c: Client) {
  const r = await c.post("/api/auth/two-factor/enable", { password: "a-strong-password" });
  expect(r.status).toBe(200);
  const totp = OTPAuth.URI.parse(r.body.totpURI) as OTPAuth.TOTP;
  expect((await c.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(200);
  return totp;
}

describe("M2: the two-step rule is about the session", () => {
  it("enrol, then the console with that same session is refused; a fresh sign in with the code is accepted", async () => {
    const ctx = await makeTestApp({ OPERATOR_REQUIRE_2FA: "on" });
    const op = await signUpAs(ctx, "ops@ops.test", "ops_admin", "Ops");
    // Password only: no console.
    const before = await op.c.get("/api/console/me");
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe("two_factor_required");
    // Whoever holds the password enrols an authenticator; Better Auth swaps the session, the account flag is on.
    const totp = await enrol(op.c);
    expect((await op.c.get("/api/account/me")).body.user.twoFactor).toBe(true);
    expect(await twoFactorEnrolledAt(ctx.db, op.id)).toBeInstanceOf(Date);
    const same = await op.c.get("/api/console/me");
    expect(same.status).toBe(403);
    expect(same.body.error.code).toBe("two_factor_required");
    expect(same.body.error.message).toMatch(/Sign in again/);
    // A fresh sign in asks for the code; with it the console opens.
    const fresh = new Client(ctx.app);
    expect((await fresh.login("ops@ops.test")).body).toMatchObject({ twoFactorRedirect: true });
    expect((await fresh.get("/api/console/me")).status).toBe(401);
    expect((await fresh.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(200);
    expect((await fresh.get("/api/console/me")).status).toBe(200);
    // The operator's enrolment is on the platform audit log.
    expect(await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "operator.two_factor_enrolled")).get()).toMatchObject({ targetId: op.id });
  }, 90_000);

  it("a session older than the enrolment stays refused (another device signed in with the password before)", async () => {
    const ctx = await makeTestApp({ OPERATOR_REQUIRE_2FA: "on" });
    const op = await signUpAs(ctx, "ops@ops.test", "admin", "Ops");
    const other = new Client(ctx.app);
    expect((await other.login("ops@ops.test")).status).toBe(200);
    await enrol(op.c);
    expect((await other.get("/api/account/me")).body.user.twoFactor).toBe(true);
    expect((await other.get("/api/console/me")).status).toBe(403);
  }, 90_000);

  it("an account with no recorded enrolment (enrolled before this check) is not refused", async () => {
    const ctx = await makeTestApp({ OPERATOR_REQUIRE_2FA: "on" });
    const op = await signUpAs(ctx, "ops@ops.test", "admin", "Ops");
    const { users } = await import("@/server/db/schema");
    await ctx.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, op.id));
    expect((await op.c.get("/api/console/me")).status).toBe(200);
  }, 60_000);

  it("OPERATOR_SSO_METHODS is empty by default: an SSO sign in alone does not count", async () => {
    expect(loadConfig({ APP_SECRET: "t".repeat(40) }).operator.ssoMethods).toEqual([]);
    expect(loadConfig({ APP_SECRET: "t".repeat(40), OPERATOR_SSO_METHODS: "Auth0, okta" } as never).operator.ssoMethods).toEqual(["auth0", "okta"]);
    const ctx = await makeTestApp({ OPERATOR_REQUIRE_2FA: "on" });
    const op = await signUpAs(ctx, "ops@ops.test", "admin", "Ops");
    await ctx.db.update(sessions).set({ loginMethod: "auth0" }).where(eq(sessions.userId, op.id));
    expect((await op.c.get("/api/console/me")).body.error.code).toBe("two_factor_required");
  }, 60_000);
});
