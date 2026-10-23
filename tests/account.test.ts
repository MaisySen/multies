import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => { ctx = await makeTestApp(); });

describe("account security", () => {
  it("changes the password and signs out other sessions", async () => {
    const a = new Client(ctx.app);
    await a.signup("pw@example.com");
    const b = new Client(ctx.app);
    await b.post("/api/auth/login", { email: "pw@example.com", password: "a-strong-password" });
    const wrong = await a.post("/api/auth/password", { currentPassword: "nope", newPassword: "another-strong-one" });
    expect(wrong.status).toBe(422);
    expect((await a.post("/api/auth/password", { currentPassword: "a-strong-password", newPassword: "another-strong-one" })).status).toBe(200);
    expect((await a.get("/api/auth/me")).status).toBe(200);
    expect((await b.get("/api/auth/me")).status).toBe(401);
    expect((await new Client(ctx.app).post("/api/auth/login", { email: "pw@example.com", password: "another-strong-one" })).status).toBe(200);
  });

  it("deletes the account and its private workspace", async () => {
    const a = new Client(ctx.app);
    await a.signup("bye@example.com");
    await a.post("/api/domains", { name: "bye.io" });
    expect((await a.call("DELETE", "/api/auth/account", { password: "wrong" })).status).toBe(422);
    expect((await a.call("DELETE", "/api/auth/account", { password: "a-strong-password" })).status).toBe(200);
    expect(await ctx.db.query.users.findMany()).toHaveLength(0);
    expect(await ctx.db.query.domains.findMany()).toHaveLength(0);
    expect((await a.get("/api/auth/me")).status).toBe(401);
  });
});
