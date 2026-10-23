import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { stepAt, totpCode, base32Decode, base32Encode, verifyTotp } from "@/server/lib/totp";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => { ctx = await makeTestApp(); });

const tokenOf = (link: string) => link.split("/").pop()!;

describe("TOTP primitives", () => {
  it("matches the RFC 6238 SHA-1 test vectors", async () => {
    const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
    // RFC 6238 Appendix B: T=59 -> 94287082, T=1111111109 -> 07081804 (8 digits; we use the last 6)
    expect(await totpCode(secret, Math.floor(59 / 30))).toBe("287082");
    expect(await totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(await totpCode(secret, Math.floor(2000000000 / 30))).toBe("279037");
  });
  it("round-trips base32 and refuses replays", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 7]);
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
    const secret = base32Encode(new Uint8Array(20).fill(7));
    const now = new Date();
    const code = await totpCode(secret, stepAt(now));
    const step = await verifyTotp(secret, code, now);
    expect(step).toBe(stepAt(now));
    expect(await verifyTotp(secret, code, now, step)).toBeNull();
  });
});

describe("password reset", () => {
  it("resets with an emailed link, signs out every session and refuses reuse", async () => {
    const a = new Client(ctx.app);
    await a.signup("reset@example.com");
    const anon = new Client(ctx.app);
    const r = await anon.post("/api/auth/password/forgot", { email: "reset@example.com" });
    expect(r.status).toBe(200);
    expect(r.body.devLink).toContain("/reset-password/");
    const token = tokenOf(r.body.devLink);
    expect((await anon.get(`/api/auth/password/reset/${token}`)).body.email).toMatch(/^re•+@example\.com$/);
    expect((await anon.post("/api/auth/password/reset", { token, password: "short" })).status).toBe(422);
    expect((await anon.post("/api/auth/password/reset", { token, password: "brand-new-password" })).status).toBe(200);
    expect((await a.get("/api/auth/me")).status).toBe(401);
    expect((await anon.post("/api/auth/password/reset", { token, password: "another-new-password" })).status).toBe(410);
    expect((await new Client(ctx.app).post("/api/auth/login", { email: "reset@example.com", password: "brand-new-password" })).status).toBe(200);
  });

  it("answers the same for unknown emails and never returns the link in production", async () => {
    const prod = await makeTestApp({ APP_MODE: "production" });
    const c = new Client(prod.app);
    await c.signup("prod@example.com");
    const known = await c.post("/api/auth/password/forgot", { email: "prod@example.com" });
    const unknown = await c.post("/api/auth/password/forgot", { email: "nobody@example.com" });
    expect(known.body).toEqual(unknown.body);
    expect(known.body.devLink).toBeUndefined();
  });
});

describe("email verification", () => {
  it("verifies with the link from the signup email", async () => {
    const a = new Client(ctx.app);
    await a.signup("verify@example.com");
    expect((await a.get("/api/auth/me")).body.user.emailVerified).toBe(false);
    const sent = await a.post("/api/auth/security/verify-email/send");
    expect(sent.body.devLink).toContain("/verify-email/");
    expect((await new Client(ctx.app).post("/api/auth/verify-email", { token: tokenOf(sent.body.devLink) })).status).toBe(200);
    expect((await a.get("/api/auth/me")).body.user.emailVerified).toBe(true);
    expect((await a.post("/api/auth/security/verify-email/send")).body.alreadyVerified).toBe(true);
  });
});

describe("two-factor authentication", () => {
  async function enable(c: Client) {
    const setup = await c.post("/api/auth/security/2fa/setup");
    expect(setup.body.uri).toMatch(/^otpauth:\/\/totp\//);
    const secret = setup.body.secret as string;
    expect((await c.post("/api/auth/security/2fa/enable", { code: "000000" })).status).toBe(422);
    const ok = await c.post("/api/auth/security/2fa/enable", { code: await totpCode(secret, stepAt(new Date())) });
    expect(ok.body.recoveryCodes).toHaveLength(10);
    return { secret, codes: ok.body.recoveryCodes as string[] };
  }

  it("requires a code after the password, and accepts each recovery code once", async () => {
    const a = new Client(ctx.app);
    await a.signup("mfa@example.com");
    const { secret, codes } = await enable(a);
    expect((await a.get("/api/auth/security")).body.twoFactor).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });

    const b = new Client(ctx.app);
    const first = await b.post("/api/auth/login", { email: "mfa@example.com", password: "a-strong-password" });
    expect(first.body).toMatchObject({ mfaRequired: true });
    expect(b.cookie).toBe("");
    expect((await b.get("/api/auth/me")).status).toBe(401);
    // The code used to enable 2FA can't be replayed, so use the next step's code.
    const next = await totpCode(secret, stepAt(new Date()) + 1);
    expect((await b.post("/api/auth/login/2fa", { ticket: first.body.ticket, code: next })).status).toBe(200);
    expect((await b.get("/api/auth/me")).status).toBe(200);

    const c = new Client(ctx.app);
    const t2 = (await c.post("/api/auth/login", { email: "mfa@example.com", password: "a-strong-password" })).body.ticket;
    const rc = await c.post("/api/auth/login/2fa", { ticket: t2, code: codes[0].toUpperCase() });
    expect(rc.body).toMatchObject({ ok: true, usedRecoveryCode: true });
    const d = new Client(ctx.app);
    const t3 = (await d.post("/api/auth/login", { email: "mfa@example.com", password: "a-strong-password" })).body.ticket;
    expect((await d.post("/api/auth/login/2fa", { ticket: t3, code: codes[0] })).status).toBe(422);
    expect((await a.get("/api/auth/security")).body.twoFactor.recoveryCodesLeft).toBe(9);
  });

  it("locks a ticket after five wrong codes and can be turned off with the password", async () => {
    const a = new Client(ctx.app);
    await a.signup("lock@example.com");
    await enable(a);
    const b = new Client(ctx.app);
    const t = (await b.post("/api/auth/login", { email: "lock@example.com", password: "a-strong-password" })).body.ticket;
    for (let i = 0; i < 4; i++) expect((await b.post("/api/auth/login/2fa", { ticket: t, code: "123456" })).status).toBe(422);
    expect((await b.post("/api/auth/login/2fa", { ticket: t, code: "123456" })).status).toBe(401);
    expect((await b.post("/api/auth/login/2fa", { ticket: t, code: "123456" })).status).toBe(401);
    expect((await a.post("/api/auth/security/2fa/disable", { password: "wrong" })).status).toBe(422);
    expect((await a.post("/api/auth/security/2fa/disable", { password: "a-strong-password" })).status).toBe(200);
    expect((await new Client(ctx.app).post("/api/auth/login", { email: "lock@example.com", password: "a-strong-password" })).body.ok).toBe(true);
  });
});

describe("sessions and devices", () => {
  it("lists devices and signs one out", async () => {
    const a = new Client(ctx.app);
    await a.signup("dev@example.com");
    const b = new Client(ctx.app);
    await b.call("POST", "/api/auth/login", { email: "dev@example.com", password: "a-strong-password" }, { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" });
    const list = await a.get("/api/auth/sessions");
    expect(list.body.sessions).toHaveLength(2);
    const phone = list.body.sessions.find((s: { current: boolean }) => !s.current);
    expect(phone.device).toMatchObject({ browser: "Safari", os: "iOS", mobile: true });
    const cur = list.body.sessions.find((s: { current: boolean }) => s.current);
    expect((await a.del(`/api/auth/sessions/${cur.id}`)).status).toBe(400);
    expect((await a.del(`/api/auth/sessions/${phone.id}`)).status).toBe(200);
    expect((await b.get("/api/auth/me")).status).toBe(401);
  });
});
