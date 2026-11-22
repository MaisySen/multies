/**
 * OPS1 security review M2 (re-check): the console's two-step rule is about the SESSION. With the rule on, a session
 * must have proved a second factor (the code, a backup code, the enrolment that just accepted a code, or a passkey with
 * user verification), or have signed in through a method listed in OPERATOR_SSO_METHODS (empty by default). The account
 * flag alone, an OAuth or mobile exchange sign in, or a session from before the enrolment is refused.
 * Owners must ask a person to turn on two-step before giving them an operator role, and every owner is emailed when an
 * operator turns two-step on or off.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as OTPAuth from "otpauth";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { eq } from "drizzle-orm";
import { signUpAs } from "./console-kit";
import { Client, makeTestApp } from "./helpers";
import { appSettings, platformAuditLogs, sessions, users } from "@/server/db/schema";
import { loadConfig } from "@/server/config";
import { setJwksForTests } from "@/server/auth/tokens";
import { TWO_FACTOR_REQUIRED_MESSAGE } from "@/server/auth/operator";

const ON = { OPERATOR_REQUIRE_2FA: "on" };

async function enrol(c: Client) {
  const r = await c.post("/api/auth/two-factor/enable", { password: "a-strong-password" });
  expect(r.status).toBe(200);
  const totp = OTPAuth.URI.parse(r.body.totpURI) as OTPAuth.TOTP;
  expect((await c.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(200);
  return { totp, codes: r.body.backupCodes as string[] };
}

/** The refusal, and (when given) why: two-step is off on the account, or it is on but this session gave no code. */
async function refused(c: Client, reason?: "not_enrolled" | "no_second_factor_this_session") {
  const r = await c.get("/api/console/me");
  expect(r.status).toBe(403);
  expect(r.body.error).toMatchObject({ code: "two_factor_required", message: TWO_FACTOR_REQUIRED_MESSAGE });
  if (reason) expect(r.body.error.details).toEqual({ reason });
}

describe("M2: the session must prove a second factor", () => {
  it("password + code is accepted; the enrolment's own session counts (the code was just proven)", async () => {
    const ctx = await makeTestApp(ON);
    const op = await signUpAs(ctx, "ops@ops.test", "ops_admin", "Ops");
    await refused(op.c, "not_enrolled"); // password only, two-step off: the console card says to turn it on
    const { totp } = await enrol(op.c);
    expect((await op.c.get("/api/console/me")).status).toBe(200);
    const fresh = new Client(ctx.app);
    expect((await fresh.login("ops@ops.test")).body).toMatchObject({ twoFactorRedirect: true });
    expect((await fresh.get("/api/console/me")).status).toBe(401);
    expect((await fresh.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(200);
    expect((await fresh.get("/api/console/me")).status).toBe(200);
  }, 90_000);

  it("password + backup code is accepted", async () => {
    const ctx = await makeTestApp(ON);
    await signUpAs(ctx, "ops@ops.test", "admin", "Ops");
    const first = new Client(ctx.app);
    await first.login("ops@ops.test");
    const { codes } = await enrol(first);
    const c = new Client(ctx.app);
    expect((await c.login("ops@ops.test")).body).toMatchObject({ twoFactorRedirect: true });
    expect((await c.post("/api/auth/two-factor/verify-backup-code", { code: codes[0] })).status).toBe(200);
    expect((await c.get("/api/console/me")).status).toBe(200);
  }, 90_000);

  it("a session from before the enrolment (another device, password only) is refused", async () => {
    const ctx = await makeTestApp(ON);
    const op = await signUpAs(ctx, "ops@ops.test", "admin", "Ops");
    const other = new Client(ctx.app);
    expect((await other.login("ops@ops.test")).status).toBe(200);
    await enrol(op.c);
    expect((await other.get("/api/account/me")).body.user.twoFactor).toBe(true);
    // Two-step is on, this session just never gave the code: the console card says to sign in again, not to turn it on.
    await refused(other, "no_second_factor_this_session");
  }, 90_000);

  it("the reviewer's experiment: an enrolled operator's unmarked session with loginMethod auth0 is refused unless auth0 is listed", async () => {
    for (const listed of [false, true]) {
      const ctx = await makeTestApp(listed ? { ...ON, OPERATOR_SSO_METHODS: "auth0" } : ON);
      const op = await signUpAs(ctx, "ops@ops.test", "admin", "Ops");
      await ctx.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, op.id));
      await ctx.db.update(sessions).set({ loginMethod: "auth0" }).where(eq(sessions.userId, op.id));
      if (listed) expect((await op.c.get("/api/console/me")).status).toBe(200);
      else await refused(op.c, "no_second_factor_this_session");
    }
  }, 90_000);

  it("turning two-step off ends the marks: the console refuses until it is on again and the code is given", async () => {
    const ctx = await makeTestApp(ON);
    const op = await signUpAs(ctx, "ops@ops.test", "admin", "Ops");
    const { totp } = await enrol(op.c);
    const other = new Client(ctx.app);
    await other.login("ops@ops.test");
    await other.post("/api/auth/two-factor/verify-totp", { code: totp.generate() });
    expect((await other.get("/api/console/me")).status).toBe(200);
    expect((await op.c.post("/api/auth/two-factor/disable", { password: "a-strong-password" })).status).toBe(200);
    await refused(other);
    expect(await ctx.db.select().from(appSettings).where(eq(appSettings.key, `two_factor_session:${op.id}:x`)).get()).toBeUndefined();
    expect(await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "operator.two_factor_disabled")).get()).toMatchObject({ targetId: op.id });
  }, 90_000);

  it("an ordinary account's sign in with the code writes no mark", async () => {
    const ctx = await makeTestApp(ON);
    const u = await signUpAs(ctx, "plain@example.com", null, "Plain");
    await enrol(u.c);
    const marks = (await ctx.db.select().from(appSettings).all()).filter((r) => r.key.startsWith("two_factor_session:"));
    expect(marks).toEqual([]);
  }, 60_000);

  it("OPERATOR_SSO_METHODS is empty by default", () => {
    expect(loadConfig({ APP_SECRET: "t".repeat(40) }).operator.ssoMethods).toEqual([]);
    expect(loadConfig({ APP_SECRET: "t".repeat(40), OPERATOR_SSO_METHODS: "Auth0, okta" } as never).operator.ssoMethods).toEqual(["auth0", "okta"]);
  });
});

describe("M2: sign ins that never ask for the code", () => {
  const DOMAIN = "multies-test.us.auth0.com";
  const IDP = { AUTH0_DOMAIN: DOMAIN, AUTH0_CLIENT_ID: "web-client", AUTH0_CLIENT_SECRET: "web-secret", AUTH0_NATIVE_CLIENT_ID: "native-client", AUTH_LOCAL_PASSWORD: "on" };
  let privateKey: CryptoKey;
  beforeAll(async () => {
    const kp = await generateKeyPair("RS256", { extractable: true });
    privateKey = kp.privateKey as CryptoKey;
    const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    setJwksForTests(DOMAIN, createLocalJWKSet({ keys: [jwk] }) as never);
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const idToken = async (email: string) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ email_verified: true, email }).setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${DOMAIN}/`).setAudience("native-client").setSubject("auth0|ops").setIssuedAt(now - 5).setExpirationTime(now + 600).sign(privateKey);
  };

  for (const listed of [false, true]) {
    it(`a mobile exchange (OAuth provider) session of an enrolled operator is ${listed ? "accepted when auth0 is listed" : "refused"}`, async () => {
      const ctx = await makeTestApp({ ...IDP, ...ON, ...(listed ? { OPERATOR_SSO_METHODS: "auth0" } : {}) });
      const op = await signUpAs(ctx, "ops@ops.test", "admin", "Ops");
      await enrol(op.c);
      const phone = new Client(ctx.app);
      const r = await phone.post("/api/auth/mobile/exchange", { idToken: await idToken("ops@ops.test") });
      expect(r.status).toBe(200);
      expect((await phone.get("/api/account/me")).body.session.loginMethod).toBe("auth0");
      if (listed) expect((await phone.get("/api/console/me")).status).toBe(200);
      else await refused(phone);
    }, 90_000);
  }

  it("a passkey sign in counts (user verification is required), for an enrolled operator", async () => {
    const ctx = await makeTestApp({ ...ON, PASSKEY_DES1: "on" });
    const op = await signUpAs(ctx, "ops@ops.test", "admin", "Ops");
    await enrol(op.c);
    const auth = new SoftAuthenticator();
    const o = await op.c.post("/api/passkeys/register/options", {});
    expect((await op.c.post("/api/passkeys/register", { response: auth.create(o.body.options), name: "Laptop" })).status).toBe(201);
    const c = new Client(ctx.app);
    const so = await c.post("/api/passkeys/sign-in/options", {});
    expect((await c.post("/api/passkeys/sign-in", { response: auth.get(so.body.options) })).status).toBe(200);
    expect((await c.get("/api/console/me")).status).toBe(200);
  }, 90_000);
});

describe("M2 re-check: a session that gave no code cannot mint itself a second factor", () => {
  const PK = { ...ON, PASSKEY_DES1: "on" };

  it("an unmarked session of an enrolled operator may not add a passkey; the marked one may, and owners are told", async () => {
    const ctx = await makeTestApp(PK);
    const op = await signUpAs(ctx, "ops@ops.test", "ops_admin", "Ops");
    await signUpAs(ctx, "owner@ops.test", "admin", "Owner");
    const other = new Client(ctx.app);
    expect((await other.login("ops@ops.test")).status).toBe(200); // password only, before the enrolment
    await enrol(op.c);
    await refused(other, "no_second_factor_this_session");
    const auth = new SoftAuthenticator();
    for (const path of ["/api/passkeys/register/options", "/api/passkeys/register"]) {
      const r = await other.post(path, path.endsWith("options") ? {} : { response: auth.create({ challenge: "x" }), name: "Thief" });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatchObject({ code: "two_factor_required", details: { reason: "no_second_factor_this_session" } });
    }
    // The experiment: nothing registered, so a passkey sign in finds no credential and the console stays shut.
    const c = new Client(ctx.app);
    const so = await c.post("/api/passkeys/sign-in/options", {});
    expect((await c.post("/api/passkeys/sign-in", { response: auth.get(so.body.options) })).status).toBe(401);
    // The enrolment's own (marked) session may add one: audited, and every owner is emailed.
    ctx.outbound.sent.length = 0;
    const o = await op.c.post("/api/passkeys/register/options", {});
    expect((await op.c.post("/api/passkeys/register", { response: auth.create(o.body.options), name: "Laptop" })).status).toBe(201);
    expect(await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "operator.passkey_added")).get()).toMatchObject({ targetId: op.id, actorUserId: op.id });
    const mail = ctx.outbound.sent.filter((m) => m.subject.includes("An operator added a passkey"));
    expect(mail.map((m) => m.to).flat()).toEqual(["owner@ops.test"]);
    expect(mail[0]!.text).toContain("ops@ops.test");
  }, 90_000);

  it("a not enrolled operator is told to turn on two-step before adding a passkey", async () => {
    const ctx = await makeTestApp(PK);
    const op = await signUpAs(ctx, "ops@ops.test", "ops_support", "Ops");
    const r = await op.c.post("/api/passkeys/register/options", {});
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: "two_factor_required", details: { reason: "not_enrolled" } });
    expect(r.body.error.message).toMatch(/Turn it on in Account and security/);
  }, 60_000);

  it("a passkey added from an unmarked session (before the role) does not count when it signs in", async () => {
    const ctx = await makeTestApp(PK);
    const u = await signUpAs(ctx, "later@ops.test", null, "Later");
    const auth = new SoftAuthenticator();
    const o = await u.c.post("/api/passkeys/register/options", {}); // an ordinary account: allowed, but not marked
    expect((await u.c.post("/api/passkeys/register", { response: auth.create(o.body.options), name: "Old" })).status).toBe(201);
    await enrol(u.c);
    await ctx.db.update(users).set({ role: "ops_admin" }).where(eq(users.id, u.id));
    const c = new Client(ctx.app);
    const so = await c.post("/api/passkeys/sign-in/options", {});
    expect((await c.post("/api/passkeys/sign-in", { response: auth.get(so.body.options) })).status).toBe(200);
    await refused(c, "no_second_factor_this_session");
  }, 90_000);

  it("an unmarked session may not read the authenticator secret or make new backup codes; the marked one may", async () => {
    const ctx = await makeTestApp(ON);
    const op = await signUpAs(ctx, "ops@ops.test", "ops_admin", "Ops");
    const other = new Client(ctx.app);
    await other.login("ops@ops.test");
    await enrol(op.c);
    for (const path of ["/api/auth/two-factor/get-totp-uri", "/api/auth/two-factor/generate-backup-codes"]) {
      const r = await other.post(path, { password: "a-strong-password" });
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain("otpauth://");
      expect(r.body).not.toHaveProperty("backupCodes");
    }
    expect((await op.c.post("/api/auth/two-factor/get-totp-uri", { password: "a-strong-password" })).status).toBe(200);
    expect((await op.c.post("/api/auth/two-factor/generate-backup-codes", { password: "a-strong-password" })).status).toBe(200);
    // An ordinary account's sessions are not limited (no mark is ever written for them).
    const plain = await signUpAs(ctx, "plain@example.com", null, "Plain");
    await enrol(plain.c);
    expect((await plain.c.post("/api/auth/two-factor/get-totp-uri", { password: "a-strong-password" })).status).toBe(200);
  }, 90_000);

  it("the reviewer's experiment: an unmarked session may not turn two-step off and on again to mint its own factor", async () => {
    const ctx = await makeTestApp(ON);
    await signUpAs(ctx, "owner1@ops.test", "admin", "Owner");
    const op = await signUpAs(ctx, "ops@ops.test", "ops_admin", "Ops");
    const thief = new Client(ctx.app);
    expect((await thief.login("ops@ops.test")).status).toBe(200); // password only, before the enrolment
    const { totp } = await enrol(op.c);
    ctx.outbound.sent.length = 0;
    // Better Auth's /disable needs only a session and the password; on an enrolled operator it now needs the code too.
    for (const path of ["/api/auth/two-factor/disable", "/api/auth/two-factor/enable"]) {
      const r = await thief.post(path, { password: "a-strong-password" });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
      expect(JSON.stringify(r.body)).not.toContain("otpauth://");
    }
    expect((await ctx.db.select({ twoFactorEnabled: users.twoFactorEnabled }).from(users).where(eq(users.id, op.id)).get())?.twoFactorEnabled).toBe(true);
    await refused(thief, "no_second_factor_this_session");
    expect((await op.c.get("/api/console/me")).status).toBe(200); // the victim's session still counts
    expect(ctx.outbound.sent).toEqual([]);
    const rows = (await ctx.db.select().from(platformAuditLogs).all()).filter((r) => r.action.startsWith("operator.two_factor_"));
    expect(rows.map((r) => r.action)).toEqual(["operator.two_factor_enrolled"]);
    // A session that gave the code may still turn it off.
    const c = new Client(ctx.app);
    await c.login("ops@ops.test");
    expect((await c.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(200);
    expect((await c.post("/api/auth/two-factor/disable", { password: "a-strong-password" })).status).toBe(200);
  }, 90_000);

  const twoFactorOn = async (ctx: Awaited<ReturnType<typeof makeTestApp>>, id: string) =>
    !!(await ctx.db.select({ on: users.twoFactorEnabled }).from(users).where(eq(users.id, id)).get())?.on;
  const markKeys = async (ctx: Awaited<ReturnType<typeof makeTestApp>>) =>
    (await ctx.db.select().from(appSettings).all()).map((r) => r.key).filter((k) => k.startsWith("two_factor_session:"));

  it("the checker's experiment: while a setup waits for its first code, a session that gave no code cannot read its secret or backup codes, or finish it", async () => {
    const cases = [
      { email: "ops@ops.test", role: "ops_admin" as const, env: ON },
      { email: "boss@ops.test", role: null, env: { ...ON, PLATFORM_ADMIN_EMAILS: "boss@ops.test" } },
    ];
    for (const who of cases) {
      const ctx = await makeTestApp(who.env);
      const op = await signUpAs(ctx, who.email, who.role, "Ops");
      const thief = new Client(ctx.app);
      expect((await thief.login(who.email)).status).toBe(200); // password only
      const started = await op.c.post("/api/auth/two-factor/enable", { password: "a-strong-password" });
      expect(started.status).toBe(200);
      const totp = OTPAuth.URI.parse(started.body.totpURI) as OTPAuth.TOTP;
      expect(await twoFactorOn(ctx, op.id)).toBe(false); // Better Auth: a pending row, two-step still off
      for (const c of [thief, op.c]) { // the setup's own session already has them from /enable
        for (const path of ["/api/auth/two-factor/get-totp-uri", "/api/auth/two-factor/generate-backup-codes"]) {
          const r = await c.post(path, { password: "a-strong-password" });
          expect(r.status).toBe(403);
          expect(r.body).toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
          expect(JSON.stringify(r.body)).not.toContain("otpauth://");
          expect(r.body).not.toHaveProperty("backupCodes");
        }
      }
      // Even holding a good code (leaked or guessed), the thief cannot finish the setup and get a marked session.
      const stolen = await thief.post("/api/auth/two-factor/verify-totp", { code: totp.generate() });
      expect(stolen.status).toBe(403);
      expect(stolen.body).toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
      expect(await twoFactorOn(ctx, op.id)).toBe(false);
      expect(await markKeys(ctx)).toEqual([]);
      // The setup's own session finishes it and opens the console; the thief stays shut out.
      expect((await op.c.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(200);
      expect((await op.c.get("/api/console/me")).status).toBe(200);
      await refused(thief, "no_second_factor_this_session");
      expect(await ctx.db.select().from(appSettings).where(eq(appSettings.key, `two_factor_enrolment:${op.id}`)).get()).toBeUndefined();
    }
  }, 120_000);

  it("the first setup still works through enable then verify-totp, and may be started again from another session", async () => {
    const ctx = await makeTestApp(ON);
    await signUpAs(ctx, "owner1@ops.test", "admin", "Owner");
    const op = await signUpAs(ctx, "ops@ops.test", "ops_support", "Ops");
    // Started on one device and abandoned; started again (a new secret) on another, which finishes it.
    const laptop = await op.c.post("/api/auth/two-factor/enable", { password: "a-strong-password" });
    expect(laptop.status).toBe(200);
    const phone = new Client(ctx.app);
    await phone.login("ops@ops.test");
    const again = await phone.post("/api/auth/two-factor/enable", { password: "a-strong-password" });
    expect(again.status).toBe(200);
    expect(again.body.backupCodes).toHaveLength(10);
    const totp = OTPAuth.URI.parse(again.body.totpURI) as OTPAuth.TOTP;
    expect((await op.c.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(403); // not where it started now
    ctx.outbound.sent.length = 0;
    expect((await phone.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(200);
    expect(await twoFactorOn(ctx, op.id)).toBe(true);
    expect((await phone.get("/api/console/me")).status).toBe(200);
    expect(ctx.outbound.sent.filter((m) => m.subject.includes("turned on two-step"))).toHaveLength(1);
    // Signing in later with the code opens the console too.
    const later = new Client(ctx.app);
    expect((await later.login("ops@ops.test")).body).toMatchObject({ twoFactorRedirect: true });
    expect((await later.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(200);
    expect((await later.get("/api/console/me")).status).toBe(200);
  }, 90_000);

  it("an ordinary account (and an operator with the rule off) is unaffected while a setup waits for its first code", async () => {
    for (const env of [ON, { OPERATOR_REQUIRE_2FA: "off" }]) {
      const ctx = await makeTestApp(env);
      const u = env === ON ? await signUpAs(ctx, "plain@example.com", null, "Plain") : await signUpAs(ctx, "ops@ops.test", "ops_admin", "Ops");
      const email = env === ON ? "plain@example.com" : "ops@ops.test";
      const other = new Client(ctx.app);
      await other.login(email);
      expect((await u.c.post("/api/auth/two-factor/enable", { password: "a-strong-password" })).status).toBe(200);
      const r = await other.post("/api/auth/two-factor/get-totp-uri", { password: "a-strong-password" });
      expect(r.status).toBe(200); // Better Auth's own behaviour, unchanged
      const totp = OTPAuth.URI.parse(r.body.totpURI) as OTPAuth.TOTP;
      expect((await other.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(200);
      expect(await twoFactorOn(ctx, u.id)).toBe(true);
      expect((await other.post("/api/auth/two-factor/generate-backup-codes", { password: "a-strong-password" })).status).toBe(200);
      if (env === ON) expect((await ctx.db.select().from(appSettings).all()).filter((s) => s.key.startsWith("two_factor_"))).toEqual([]);
    }
  }, 90_000);

  it("a session that gave a backup code may turn two-step off; an ordinary account's unmarked session is not limited", async () => {
    const ctx = await makeTestApp(ON);
    const op = await signUpAs(ctx, "ops@ops.test", "ops_support", "Ops");
    const { codes } = await enrol(op.c);
    const c = new Client(ctx.app);
    expect((await c.login("ops@ops.test")).body).toMatchObject({ twoFactorRedirect: true });
    expect((await c.post("/api/auth/two-factor/verify-backup-code", { code: codes[0] })).status).toBe(200);
    expect((await c.post("/api/auth/two-factor/disable", { password: "a-strong-password" })).status).toBe(200);
    const plain = await signUpAs(ctx, "plain@example.com", null, "Plain");
    const other = new Client(ctx.app);
    await other.login("plain@example.com");
    await enrol(plain.c);
    expect((await other.post("/api/auth/two-factor/disable", { password: "a-strong-password" })).status).toBe(200);
  }, 90_000);

  it("turning two-step on again after it was turned off always emails owners, even within the hour of an earlier on", async () => {
    const ctx = await makeTestApp(ON);
    await signUpAs(ctx, "owner1@ops.test", "admin", "Owner");
    const op = await signUpAs(ctx, "ops@ops.test", "ops_admin", "Ops");
    const thief = new Client(ctx.app);
    await thief.login("ops@ops.test"); // password only, before the enrolment
    ctx.outbound.sent.length = 0;
    await enrol(op.c);
    expect((await op.c.post("/api/auth/two-factor/disable", { password: "a-strong-password" })).status).toBe(200);
    // The account is not enrolled now, so whoever holds the password and a session can turn it on: owners must hear.
    await enrol(thief);
    expect(ctx.outbound.sent.filter((m) => m.subject.includes("turned on two-step")).map((m) => m.to).flat()).toEqual(["owner1@ops.test", "owner1@ops.test"]);
    expect(ctx.outbound.sent.filter((m) => m.subject.includes("turned off two-step"))).toHaveLength(1);
  }, 90_000);
});

describe("M2: the owner alert fires for real changes only, once an hour", () => {
  it("a signed in re-check of a code on a session that rolls forward is not an enrolment", async () => {
    const ctx = await makeTestApp(ON);
    await signUpAs(ctx, "owner1@ops.test", "admin", "Owner");
    const sup = await signUpAs(ctx, "sup@ops.test", "ops_readonly", "Sup");
    const { totp } = await enrol(sup.c);
    const enrolledRows = async () => (await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "operator.two_factor_enrolled")).all()).length;
    expect(await enrolledRows()).toBe(1);
    ctx.outbound.sent.length = 0;
    // Due to roll forward (expiresIn 30 days, updateAge 1 day): Better Auth sets newSession on this request, same id.
    await ctx.db.update(sessions).set({ expiresAt: new Date(Date.now() + 29 * 86_400_000 - 60_000) }).where(eq(sessions.userId, sup.id));
    const r = await sup.c.post("/api/auth/two-factor/verify-totp", { code: totp.generate() });
    expect(r.status).toBe(200);
    expect(await enrolledRows()).toBe(1);
    expect(ctx.outbound.sent.filter((m) => m.subject.includes("two-step"))).toEqual([]);
    expect((await sup.c.get("/api/console/me")).status).toBe(200); // still the enrolment's marked session
  }, 90_000);

  it("turning two-step off and on again within the hour is audited each time; off emails once, on again after off always emails", async () => {
    const ctx = await makeTestApp();
    await signUpAs(ctx, "owner1@ops.test", "admin", "Owner");
    const sup = await signUpAs(ctx, "sup@ops.test", "ops_readonly", "Sup");
    ctx.outbound.sent.length = 0;
    for (let i = 0; i < 2; i++) {
      await enrol(sup.c);
      expect((await sup.c.post("/api/auth/two-factor/disable", { password: "a-strong-password" })).status).toBe(200);
    }
    const rows = (await ctx.db.select().from(platformAuditLogs).all()).filter((r) => r.action.startsWith("operator.two_factor_"));
    expect(rows.map((r) => r.action).sort()).toEqual(["operator.two_factor_disabled", "operator.two_factor_disabled", "operator.two_factor_enrolled", "operator.two_factor_enrolled"]);
    expect(ctx.outbound.sent.filter((m) => m.subject.includes("turned on two-step"))).toHaveLength(2);
    expect(ctx.outbound.sent.filter((m) => m.subject.includes("turned off two-step"))).toHaveLength(1);
  }, 90_000);
});

describe("M2: self enrolment by whoever holds the password, reduced", () => {
  it("granting or changing an operator role needs two-step on first (409)", async () => {
    const ctx = await makeTestApp();
    const owner = await signUpAs(ctx, "owner@ops.test", "admin", "Ops");
    const cand = await signUpAs(ctx, "new@ops.test", null, "New");
    const r = await owner.c.post("/api/console/operators", { email: "new@ops.test", role: "ops_support", reason: "Joining support" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "two_factor_off" });
    expect(r.body.error.message).toMatch(/Ask them to turn it on/);
    await ctx.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, cand.id));
    expect((await owner.c.post("/api/console/operators", { email: "new@ops.test", role: "ops_support", reason: "Joining support" })).status).toBe(201);
    await ctx.db.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, cand.id));
    expect((await owner.c.call("PATCH", `/api/console/operators/${cand.id}`, { role: "ops_admin", reason: "Promotion" })).status).toBe(409);
  }, 60_000);

  it("an operator turning two-step on or off emails every owner and is audited", async () => {
    const ctx = await makeTestApp();
    await signUpAs(ctx, "owner1@ops.test", "admin", "Ops");
    await signUpAs(ctx, "owner2@ops.test", "admin", "Ops2");
    const op = await signUpAs(ctx, "sup@ops.test", "ops_support", "Sup");
    ctx.outbound.sent.length = 0;
    await enrol(op.c);
    const on = ctx.outbound.sent.filter((m) => m.subject.includes("turned on two-step sign in"));
    expect(on.map((m) => m.to).flat().sort()).toEqual(["owner1@ops.test", "owner2@ops.test"]);
    expect(on[0]!.text).toContain("sup@ops.test");
    expect(await ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "operator.two_factor_enrolled")).get()).toMatchObject({ targetId: op.id });
    expect((await op.c.post("/api/auth/two-factor/disable", { password: "a-strong-password" })).status).toBe(200);
    expect(ctx.outbound.sent.filter((m) => m.subject.includes("turned off two-step sign in"))).toHaveLength(2);
    // An ordinary account's change emails nobody.
    const plain = await signUpAs(ctx, "plain@example.com", null, "Plain");
    ctx.outbound.sent.length = 0;
    await enrol(plain.c);
    expect(ctx.outbound.sent.filter((m) => m.subject.includes("two-step"))).toEqual([]);
  }, 90_000);

  it("a bootstrap owner (PLATFORM_ADMIN_EMAILS) without two-step is promoted but cannot open the console until they enrol and give the code", async () => {
    const ctx = await makeTestApp({ ...ON, PLATFORM_ADMIN_EMAILS: "boss@ops.test" });
    const boss = await signUpAs(ctx, "boss@ops.test", null, "Boss");
    expect((await boss.c.get("/api/account/me")).body.user.platformAdmin).toBe(true);
    await refused(boss.c);
    const { totp } = await enrol(boss.c);
    expect((await boss.c.get("/api/console/me")).status).toBe(200);
    const again = new Client(ctx.app);
    await again.login("boss@ops.test");
    await again.post("/api/auth/two-factor/verify-totp", { code: totp.generate() });
    expect((await again.get("/api/console/me")).status).toBe(200);
  }, 90_000);
});

/** A software passkey (ES256, attestation "none"), as in tests/passkeys-des1.test.ts. User verified flag set. */
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const s = Buffer.from(v, "utf8"); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}
class SoftAuthenticator {
  key = generateKeyPairSync("ec", { namedCurve: "P-256" });
  credId = randomBytes(32);
  counter = 0;
  origin = "http://localhost:5173";
  get id() { return b64u(this.credId); }
  private rpHash() { return createHash("sha256").update("localhost").digest(); }
  private counterBytes() { const b = Buffer.alloc(4); b.writeUInt32BE(this.counter); return b; }
  private cose() {
    const jwk = (this.key.publicKey as KeyObject).export({ format: "jwk" }) as { x: string; y: string };
    return cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  }
  create(options: { challenge: string }) {
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x45]), this.counterBytes(), Buffer.alloc(16), idLen, this.credId, this.cose()]);
    const att = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ["internal"] } };
  }
  get(options: { challenge: string }) {
    this.counter += 1;
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x05]), this.counterBytes()]);
    const sig = edSign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), this.key.privateKey);
    return { id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) } };
  }
}
