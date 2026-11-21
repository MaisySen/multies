/**
 * OPS1: Better Auth's admin endpoints (impersonate, set role, ban, set password, create and remove users) are closed
 * over HTTP for everyone, operators included. The console calls the ones it needs in process after its own guard.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { signUpAs } from "./console-kit";
import { sessions, users } from "@/server/db/schema";
import { authFor } from "@/server/auth/options";

const PATHS = [
  ["POST", "/api/auth/admin/impersonate-user"], ["POST", "/api/auth/admin/stop-impersonating"], ["POST", "/api/auth/admin/set-role"],
  ["POST", "/api/auth/admin/ban-user"], ["POST", "/api/auth/admin/unban-user"], ["POST", "/api/auth/admin/set-user-password"],
  ["POST", "/api/auth/admin/create-user"], ["POST", "/api/auth/admin/remove-user"], ["POST", "/api/auth/admin/list-users"],
  ["GET", "/api/auth/admin/list-users"], ["POST", "/api/auth/admin/revoke-user-sessions"], ["POST", "/api/auth/admin/list-user-sessions"],
  ["POST", "/api/auth/admin/update-user"], ["GET", "/api/auth/admin/get-user"], ["POST", "/api/auth/admin/has-permission"], ["GET", "/api/auth/admin"],
] as const;

describe("/api/auth/admin is closed", () => {
  it("answers 404 to operators, customers and anonymous callers, and changes nothing", async () => {
    const ctx = await makeTestApp();
    const { c: ops } = await signUpAs(ctx, "ops@acme.test", "admin");
    const { c: cus, id: cusId } = await signUpAs(ctx, "cus@else.test", null, "Else");
    const anon = new Client(ctx.app);
    let n = 0;
    for (const [method, path] of PATHS) {
      for (const who of [ops, cus, anon]) {
        // Each from its own address, so the /api/auth rate limit never answers first.
        const r = await who.call(method, path, method === "GET" ? undefined : { userId: cusId, role: "admin", newPassword: "another-strong-pass" }, { "cf-connecting-ip": `192.0.2.${++n}` });
        expect(r.status, `${method} ${path}`).toBe(404);
        expect(r.body.error.code).toBe("not_found");
      }
    }
    const row = await ctx.db.select().from(users).where(eq(users.id, cusId)).get();
    expect(row).toMatchObject({ role: "user", banned: false });
    expect((await cus.get("/api/account/me")).status).toBe(200);
    // Impersonation made no session for the customer.
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, cusId)).all()).toHaveLength(1);
  });

  it("the in process API still works for the console's own guarded calls", async () => {
    const ctx = await makeTestApp();
    const { c: ops } = await signUpAs(ctx, "ops@acme.test", "admin");
    const { id: cusId, c: cus } = await signUpAs(ctx, "cus@else.test", null, "Else");
    await authFor(ctx.deps).api.banUser({ headers: new Headers({ cookie: ops.cookie }), body: { userId: cusId } });
    expect((await ctx.db.select().from(users).where(eq(users.id, cusId)).get())!.banned).toBe(true);
    expect((await cus.get("/api/account/me")).status).toBe(401);
  });
});
