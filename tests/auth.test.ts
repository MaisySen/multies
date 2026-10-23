import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => { ctx = await makeTestApp(); });

describe("auth", () => {
  it("signs up, reads the session, logs out", async () => {
    const c = new Client(ctx.app);
    await c.signup("ada@example.com");
    const me = await c.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("ada@example.com");
    expect(me.body.organization).toMatchObject({ name: "Acme", plan: "starter", role: "owner" });
    expect((await c.post("/api/auth/logout")).status).toBe(200);
    expect((await c.get("/api/auth/me")).status).toBe(401);
  });

  it("rejects duplicate emails, case-insensitively", async () => {
    await new Client(ctx.app).signup("dup@example.com");
    const r = await new Client(ctx.app).post("/api/auth/signup", { name: "X", email: "DUP@example.com", password: "a-strong-password" });
    expect(r.status).toBe(409);
  });

  it("validates input with field errors", async () => {
    const r = await new Client(ctx.app).post("/api/auth/signup", { name: "", email: "nope", password: "short" });
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.error.details.fields)).toEqual(expect.arrayContaining(["name", "email", "password"]));
  });

  it("logs in with the right password only", async () => {
    await new Client(ctx.app).signup("bob@example.com");
    const bad = await new Client(ctx.app).post("/api/auth/login", { email: "bob@example.com", password: "wrong-password" });
    expect(bad.status).toBe(401);
    const c = new Client(ctx.app);
    const ok = await c.post("/api/auth/login", { email: "Bob@Example.com", password: "a-strong-password" });
    expect(ok.status).toBe(200);
    expect((await c.get("/api/auth/me")).body.user.email).toBe("bob@example.com");
  });

  it("stores only a hash of the session token", async () => {
    const c = new Client(ctx.app);
    await c.signup();
    const token = c.cookie.split("=")[1];
    const rows = await ctx.db.query.sessions.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toContain(token);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("blocks cross-site and non-JSON writes", async () => {
    const c = new Client(ctx.app);
    const cross = await c.call("POST", "/api/auth/login", { email: "a@b.co", password: "x" }, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    const form = await ctx.app.request("/api/auth/login", { method: "POST", headers: { host: "localhost", "content-type": "application/x-www-form-urlencoded" }, body: "a=b" });
    expect(form.status).toBe(403);
  });

  it("rate limits repeated failed logins", async () => {
    const c = new Client(ctx.app);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await c.post("/api/auth/login", { email: "rl@example.com", password: "nope" })).status;
    expect(last).toBe(429);
  });
});
