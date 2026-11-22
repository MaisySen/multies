/**
 * Operator user delete. OPS1 security: moved from the retired DELETE /api/admin/users/:id to the console
 * (GET /api/console/users?q=, DELETE /api/console/users/:id with a reason, owners only, recent sign in), keeping what
 * it proves: platform admins only, the account and its solo workspace go, the session ends, unknown ids are 404, and
 * the only owner of a shared workspace is refused (409).
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { members, users } from "@/server/db/schema";

const reason = { reason: "Asked to be removed" };

describe("operator user delete", () => {
  it("finds and deletes an account, for platform admins only", async () => {
    const ctx = await makeTestApp();
    const ops = new Client(ctx.app);
    await ops.signup("ops@acme.io");
    const left = new Client(ctx.app);
    await left.signup("mate-r8-test@example.com", "Ben Carter", "Leftover");
    expect((await ops.get("/api/console/users?q=ben")).status).toBe(403);
    expect((await left.get("/api/console/users")).status).toBe(403);
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    const found = (await ops.get("/api/console/users?q=mate-r8")).body.items;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ email: "mate-r8-test@example.com", name: "Ben Carter" });
    expect((await left.call("DELETE", `/api/console/users/${found[0].id}`, reason)).status).toBe(403);
    expect((await ops.call("DELETE", `/api/console/users/${found[0].id}`, reason)).body).toEqual({ ok: true });
    expect((await ops.get("/api/console/users?q=mate-r8")).body.items).toHaveLength(0);
    expect((await left.get("/api/account/me")).status).toBe(401);
    expect(await ctx.db.query.organizations.findMany()).toHaveLength(1);
    expect((await ops.call("DELETE", "/api/console/users/usr_missing", reason)).status).toBe(404);
  }, 60_000);

  it("refuses (409) to delete the only owner of a workspace other people are in", async () => {
    const ctx = await makeTestApp();
    const ops = new Client(ctx.app);
    await ops.signup("ops@acme.io");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    const owner = new Client(ctx.app);
    await owner.signup("solo-owner@example.com", "Sole Owner", "Shared Co");
    const mate = new Client(ctx.app);
    await mate.signup("mate@example.com", "Mate", "Mate Co");
    const ownerRow = (await ctx.db.select().from(users).where(eq(users.email, "solo-owner@example.com")).get())!;
    const mateRow = (await ctx.db.select().from(users).where(eq(users.email, "mate@example.com")).get())!;
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, ownerRow.id)).get())!.organizationId;
    await ctx.db.insert(members).values({ id: "mem_mate_shared", organizationId: orgId, userId: mateRow.id, role: "member" });
    const r = await ops.call("DELETE", `/api/console/users/${ownerRow.id}`, reason);
    expect(r.status).toBe(409);
    expect(await ctx.db.select().from(users).where(eq(users.id, ownerRow.id)).get()).toBeTruthy();
  }, 60_000);

  it("never deletes an operator or a PLATFORM_ADMIN_EMAILS account, even from the service itself", async () => {
    const ctx = await makeTestApp({ PLATFORM_ADMIN_EMAILS: "second-owner@example.com" });
    const ops = new Client(ctx.app);
    await ops.signup("ops@acme.io");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "ops@acme.io"));
    const other = new Client(ctx.app);
    await other.signup("other-owner@example.com", "Other Owner", "Other Co");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "other-owner@example.com"));
    const listed = new Client(ctx.app);
    await listed.signup("second-owner@example.com", "Listed", "Listed Co");
    for (const email of ["other-owner@example.com", "second-owner@example.com"]) {
      const id = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!.id;
      const r = await ops.call("DELETE", `/api/console/users/${id}`, reason);
      expect(r.status, email).toBe(403);
      expect(r.body.error.code).toBe("target_is_operator");
      const { deleteUserAccount } = await import("@/server/services/console/users");
      await expect(deleteUserAccount(ctx.deps, id)).rejects.toMatchObject({ status: 403 });
      expect(await ctx.db.select().from(users).where(eq(users.id, id)).get()).toBeTruthy();
    }
  }, 60_000);
});
