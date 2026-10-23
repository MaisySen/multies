import { describe, it, expect, beforeEach } from "vitest";
import * as OTPAuth from "otpauth";
import { makeTestApp, Client } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => { ctx = await makeTestApp(); });

/** The newest link the app emailed to `to` (the log transport records every account email). */
function linkSentTo(to: string, contains: string) {
  const msg = [...ctx.outbound.sent].reverse().find((m) => m.to.includes(to) && m.text.includes(contains));
  if (!msg) throw new Error(`no email to ${to} containing ${contains}`);
  return msg.text.match(/https?:\/\/\S+/g)!.find((u) => u.includes(contains))!;
}

describe("password reset", () => {
  it("resets with an emailed link, signs out every session and refuses reuse", async () => {
    const a = new Client(ctx.app);
    await a.signup("reset@example.com");
    const anon = new Client(ctx.app);
    const r = await anon.post("/api/auth/request-password-reset", { email: "reset@example.com", redirectTo: "/reset-password" });
    expect(r.status).toBe(200);
    const link = linkSentTo("reset@example.com", "/api/auth/reset-password/");
    // The emailed link checks the token, then hands it to the reset page.
    const res = await ctx.app.request(new URL(link).pathname + new URL(link).search, { headers: { host: "localhost" } });
    expect(res.status).toBe(302);
    const token = new URL(res.headers.get("location")!, "http://x").searchParams.get("token")!;
    expect(token).toBeTruthy();
    expect((await anon.post("/api/auth/reset-password", { token, newPassword: "short" })).status).toBe(400);
    expect((await anon.post("/api/auth/reset-password", { token, newPassword: "brand-new-password" })).status).toBe(200);
    expect((await a.get("/api/account/me")).status).toBe(401);
    expect((await anon.post("/api/auth/reset-password", { token, newPassword: "another-new-password" })).status).toBe(400);
    expect((await new Client(ctx.app).login("reset@example.com", "brand-new-password")).status).toBe(200);
  });

  it("answers the same for unknown emails", async () => {
    const c = new Client(ctx.app);
    await c.signup("known@example.com");
    const known = await c.post("/api/auth/request-password-reset", { email: "known@example.com", redirectTo: "/reset-password" });
    const unknown = await c.post("/api/auth/request-password-reset", { email: "nobody@example.com", redirectTo: "/reset-password" });
    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });
});

describe("email verification", () => {
  it("emails a link on signup that marks the address verified", async () => {
    const a = new Client(ctx.app);
    await a.signup("verify@example.com");
    expect((await a.get("/api/account/me")).body.user.emailVerified).toBe(false);
    const link = new URL(linkSentTo("verify@example.com", "/api/auth/verify-email"));
    const res = await ctx.app.request(link.pathname + link.search, { headers: { host: "localhost" } });
    expect([200, 302]).toContain(res.status);
    expect((await a.get("/api/account/me")).body.user.emailVerified).toBe(true);
  });
});

describe("two-factor authentication", () => {
  async function enable(c: Client) {
    const r = await c.post("/api/auth/two-factor/enable", { password: "a-strong-password" });
    expect(r.status).toBe(200);
    expect(r.body.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(r.body.backupCodes).toHaveLength(10);
    const totp = OTPAuth.URI.parse(r.body.totpURI) as OTPAuth.TOTP;
    expect((await c.post("/api/auth/two-factor/verify-totp", { code: "000000" })).status).toBe(401);
    expect((await c.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(200);
    return { totp, codes: r.body.backupCodes as string[] };
  }

  it("asks for a code after the password, and accepts each backup code once", async () => {
    const a = new Client(ctx.app);
    await a.signup("mfa@example.com");
    const { totp, codes } = await enable(a);
    expect((await a.get("/api/account/me")).body.user.twoFactor).toBe(true);

    const b = new Client(ctx.app);
    const first = await b.login("mfa@example.com");
    expect(first.body).toMatchObject({ twoFactorRedirect: true });
    expect(b.jar.has("mymail.session_token")).toBe(false);
    expect((await b.get("/api/account/me")).status).toBe(401);
    expect((await b.post("/api/auth/two-factor/verify-totp", { code: totp.generate() })).status).toBe(200);
    expect((await b.get("/api/account/me")).status).toBe(200);

    const c = new Client(ctx.app);
    await c.login("mfa@example.com");
    expect((await c.post("/api/auth/two-factor/verify-backup-code", { code: codes[0] })).status).toBe(200);
    expect((await c.get("/api/account/me")).status).toBe(200);
    const d = new Client(ctx.app);
    await d.login("mfa@example.com");
    expect((await d.post("/api/auth/two-factor/verify-backup-code", { code: codes[0] })).status).toBe(401);
  });

  it("turns off only with the password", async () => {
    const a = new Client(ctx.app);
    await a.signup("off@example.com");
    await enable(a);
    expect((await a.post("/api/auth/two-factor/disable", { password: "wrong-password" })).status).toBe(400);
    expect((await a.post("/api/auth/two-factor/disable", { password: "a-strong-password" })).status).toBe(200);
    const b = new Client(ctx.app);
    expect((await b.login("off@example.com")).body.twoFactorRedirect).toBeUndefined();
  });
});

describe("sessions", () => {
  it("lists sessions with device details and revokes the others", async () => {
    const a = new Client(ctx.app);
    await a.signup("multi@example.com");
    const b = new Client(ctx.app);
    await b.call("POST", "/api/auth/sign-in/email", { email: "multi@example.com", password: "a-strong-password" }, { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" });
    const list = await a.get("/api/auth/list-sessions");
    expect(list.body).toHaveLength(2);
    expect(list.body.some((s: { userAgent: string }) => s.userAgent.includes("iPhone"))).toBe(true);
    expect((await a.post("/api/auth/revoke-other-sessions")).status).toBe(200);
    expect((await b.get("/api/account/me")).status).toBe(401);
    expect((await a.get("/api/account/me")).status).toBe(200);
  });

  it("changes the password and signs out other sessions", async () => {
    const a = new Client(ctx.app);
    await a.signup("pw@example.com");
    const b = new Client(ctx.app);
    await b.login("pw@example.com");
    const wrong = await a.post("/api/auth/change-password", { currentPassword: "nope-nope-nope", newPassword: "another-strong-one", revokeOtherSessions: true });
    expect(wrong.status).toBe(400);
    expect((await a.post("/api/auth/change-password", { currentPassword: "a-strong-password", newPassword: "another-strong-one", revokeOtherSessions: true })).status).toBe(200);
    expect((await a.get("/api/account/me")).status).toBe(200);
    expect((await b.get("/api/account/me")).status).toBe(401);
    expect((await new Client(ctx.app).login("pw@example.com", "another-strong-one")).status).toBe(200);
  });

  it("deletes the account and its private workspace", async () => {
    const a = new Client(ctx.app);
    await a.signup("bye@example.com");
    await a.post("/api/domains", { name: "bye.io" });
    expect((await a.post("/api/auth/delete-user", { password: "wrong-password" })).status).toBe(400);
    expect((await a.post("/api/auth/delete-user", { password: "a-strong-password" })).status).toBe(200);
    expect(await ctx.db.query.users.findMany()).toHaveLength(0);
    expect(await ctx.db.query.domains.findMany()).toHaveLength(0);
    expect((await a.get("/api/account/me")).status).toBe(401);
  });
});
