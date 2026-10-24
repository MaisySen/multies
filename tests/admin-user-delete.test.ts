import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { users } from "@/server/db/schema";

describe("operator user delete", () => {
  it("finds and deletes an account, for platform admins only", async () => {
    const ctx = await makeTestApp();
    const ops = new Client(ctx.app);
    await ops.signup("ops@acme.io");
    const left = new Client(ctx.app);
    await left.signup("mate-r8-test@example.com", "Ben Carter", "Leftover");
    expect((await ops.get("/api/admin/users?q=ben")).status).toBe(403);
    expect((await left.get("/api/admin/users")).status).toBe(403);
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    const found = (await ops.get("/api/admin/users?q=mate-r8")).body.users;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ email: "mate-r8-test@example.com", name: "Ben Carter" });
    expect((await left.call("DELETE", `/api/admin/users/${found[0].id}`)).status).toBe(403);
    expect((await ops.call("DELETE", `/api/admin/users/${found[0].id}`)).body).toEqual({ ok: true });
    expect((await ops.get("/api/admin/users?q=mate-r8")).body.users).toHaveLength(0);
    expect((await left.get("/api/account/me")).status).toBe(401);
    expect(await ctx.db.query.organizations.findMany()).toHaveLength(1);
    expect((await ops.call("DELETE", "/api/admin/users/usr_missing")).status).toBe(404);
  });
});
