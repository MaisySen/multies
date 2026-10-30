import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

// DELETE /api/account: the store-required in-app account deletion (phone app and /delete-account).
describe("delete my account", () => {
  it("needs the confirm word and the password, then deletes the account and its solo workspace", async () => {
    const { app } = await makeTestApp();
    const c = new Client(app);
    await c.signup("solo@acme.io");
    expect((await c.call("DELETE", "/api/account", {})).body.error.code).toBe("confirm_required");
    expect((await c.call("DELETE", "/api/account", { confirm: "DELETE" })).body.error.code).toBe("password_required");
    const wrong = await c.call("DELETE", "/api/account", { confirm: "DELETE", password: "not-my-password" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe("wrong_password");
    const ok = await c.call("DELETE", "/api/account", { confirm: "DELETE", password: "a-strong-password" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, deletedWorkspaces: 1 });
    expect((await c.get("/api/account/me")).status).toBe(401);
    const again = new Client(app);
    expect((await again.post("/api/auth/sign-in/email", { email: "solo@acme.io", password: "a-strong-password" })).status).not.toBe(200);
  });

  it("refuses while the person is the only owner of a workspace with other members", async () => {
    const { app } = await makeTestApp();
    const owner = new Client(app);
    await owner.signup("owner@acme.io");
    const invite = await owner.post("/api/team/invites", { email: "mate@example.com", role: "member" });
    const mate = new Client(app);
    await mate.signup("mate@example.com", "Teammate", "");
    expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    const res = await owner.call("DELETE", "/api/account", { confirm: "DELETE", password: "a-strong-password" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("transfer_ownership_first");
    expect(res.body.workspaces).toHaveLength(1);
    // A member can still delete their own account; their own empty workspace goes, the shared one stays.
    const left = await mate.call("DELETE", "/api/account", { confirm: "DELETE", password: "a-strong-password" });
    expect(left.body).toEqual({ ok: true, deletedWorkspaces: 1 });
    expect((await owner.get("/api/account/me")).status).toBe(200);
  });

  it("deletes a demo sandbox on the confirm word alone, even after the session is no longer fresh", async () => {
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    const c = new Client(ctx.app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    ctx.deps.now = () => new Date(Date.now() + 60 * 60_000);
    const res = await c.call("DELETE", "/api/account", { confirm: "DELETE" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deletedWorkspaces: 1 });
    expect(await ctx.db.query.users.findMany()).toHaveLength(0);
    expect(await ctx.db.query.organizations.findMany()).toHaveLength(0);
    expect((await c.get("/api/account/me")).status).toBe(401);
  });

  it("a demo seed still queued after the sandbox is deleted finishes quietly", async () => {
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    const c = new Client(ctx.app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    expect((await c.call("DELETE", "/api/account", { confirm: "DELETE" })).status).toBe(200);
    const { runDueJobs } = await import("@/server/services/jobs");
    await import("@/server/services/suite/demo-seed");
    const r = await runDueJobs(ctx.deps, 5, { types: ["demo.seed_suite"] });
    expect(r).toMatchObject({ failed: 0, dead: 0 });
  });

  it("is refused without a session", async () => {
    const { app } = await makeTestApp();
    expect((await new Client(app).call("DELETE", "/api/account", { confirm: "DELETE" })).status).toBe(401);
  });
});
