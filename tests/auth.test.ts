import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => { ctx = await makeTestApp(); });

describe("auth (Better Auth)", () => {
  it("signs up, reads the session, signs out", async () => {
    const c = new Client(ctx.app);
    await c.signup("ada@example.com");
    expect(c.jar.has("mymail.session_token")).toBe(true);
    const me = await c.get("/api/account/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("ada@example.com");
    expect(me.body.organization).toMatchObject({ name: "Acme", plan: "starter", role: "owner" });
    expect((await c.post("/api/auth/sign-out")).status).toBe(200);
    expect((await c.get("/api/account/me")).status).toBe(401);
  });

  it("gives every new account its own workspace", async () => {
    const c = new Client(ctx.app);
    await c.post("/api/auth/sign-up/email", { name: "Grace Hopper", email: "grace@example.com", password: "a-strong-password" });
    const me = await c.get("/api/account/me");
    expect(me.body.organization).toMatchObject({ name: "Grace's workspace", role: "owner" });
  });

  it("rejects duplicate emails, case-insensitively", async () => {
    await new Client(ctx.app).signup("dup@example.com");
    const r = await new Client(ctx.app).post("/api/auth/sign-up/email", { name: "X", email: "DUP@example.com", password: "a-strong-password" });
    expect(r.status).toBe(422);
  });

  it("enforces the password length policy", async () => {
    const r = await new Client(ctx.app).post("/api/auth/sign-up/email", { name: "Shorty", email: "s@example.com", password: "short" });
    expect(r.status).toBe(400);
  });

  it("signs in with the right password only, and keeps existing PBKDF2 hashes valid", async () => {
    await new Client(ctx.app).signup("bob@example.com");
    const acct = await ctx.db.query.accounts.findFirst();
    expect(acct?.password).toMatch(/^pbkdf2/);
    const bad = await new Client(ctx.app).login("bob@example.com", "wrong-password");
    expect(bad.status).toBe(401);
    const c = new Client(ctx.app);
    expect((await c.login("Bob@Example.com")).status).toBe(200);
    expect((await c.get("/api/account/me")).body.user.email).toBe("bob@example.com");
  });

  it("signs the session cookie", async () => {
    const c = new Client(ctx.app);
    await c.signup();
    const [row] = await ctx.db.query.sessions.findMany();
    const cookie = decodeURIComponent(c.jar.get("mymail.session_token")!);
    expect(cookie.startsWith(`${row.token}.`)).toBe(true);
    // A cookie carrying the bare token (no valid signature) is not a session.
    const forged = new Client(ctx.app);
    forged.cookie = `mymail.session_token=${row.token}`;
    expect((await forged.get("/api/account/me")).status).toBe(401);
  });

  it("blocks cross-site and non-JSON writes", async () => {
    const c = new Client(ctx.app);
    const cross = await c.call("POST", "/api/auth/sign-in/email", { email: "a@b.co", password: "x" }, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    const form = await ctx.app.request("/api/auth/sign-in/email", { method: "POST", headers: { host: "localhost", "content-type": "application/x-www-form-urlencoded" }, body: "a=b" });
    expect(form.status).toBe(403);
  });

  it("rate limits repeated failed sign-ins", async () => {
    const c = new Client(ctx.app);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await c.call("POST", "/api/auth/sign-in/email", { email: "rl@example.com", password: "nope-nope-nope" }, { "x-real-ip": "203.0.113.9" })).status;
    expect(last).toBe(429);
  });

  it("reports which sign-in providers are configured", async () => {
    expect((await new Client(ctx.app).get("/api/account/providers")).body).toEqual({ google: false, github: false, auth0: false });
    const c2 = await makeTestApp({ AUTH0_DOMAIN: "https://mymail.us.auth0.com/", AUTH0_CLIENT_ID: "id", AUTH0_CLIENT_SECRET: "secret", GITHUB_CLIENT_ID: "g", GITHUB_CLIENT_SECRET: "s" });
    expect((await new Client(c2.app).get("/api/account/providers")).body).toEqual({ google: false, github: true, auth0: true });
    expect(c2.deps.config.auth.auth0?.domain).toBe("mymail.us.auth0.com");
  });
});
