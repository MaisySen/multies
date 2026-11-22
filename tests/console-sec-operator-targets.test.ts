/**
 * OPS1 security review L3: support can't touch operator accounts. Clear lockout and verify refuse operator and
 * PLATFORM_ADMIN_EMAILS accounts; the System page's lockout clear (by email) does too, unless the caller is an owner.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { signUpAs } from "./console-kit";
import { makeTestApp } from "./helpers";
import { loginThrottle, users } from "@/server/db/schema";
import { recordFailure } from "@/server/services/lockout";

async function lockOut(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string) {
  for (let i = 0; i < 12; i++) await recordFailure(ctx.db, email, ctx.deps.now());
}

describe("L3: operator targets", () => {
  it("users/:id/clear-lockout and /verify refuse an operator; an ordinary account is fine", async () => {
    const ctx = await makeTestApp();
    const sup = await signUpAs(ctx, "sup@ops.test", "ops_support", "Sup");
    const op = await signUpAs(ctx, "ro@ops.test", "ops_readonly", "Ro");
    const plain = await signUpAs(ctx, "plain@example.com", null, "Plain");
    const lock = await sup.c.post(`/api/console/users/${op.id}/clear-lockout`, { reason: "Locked out on the phone" });
    expect(lock.status).toBe(403);
    expect(lock.body.error.code).toBe("target_is_operator");
    expect((await sup.c.post(`/api/console/users/${op.id}/verify`, { reason: "Customer says the mail never came" })).status).toBe(409);
    expect((await sup.c.post(`/api/console/users/${plain.id}/clear-lockout`, { reason: "Locked out on the phone" })).status).toBe(200);
  }, 60_000);

  it("system/lockouts/clear: support is refused for an operator or a listed address; an owner may", async () => {
    const ctx = await makeTestApp({ PLATFORM_ADMIN_EMAILS: "not-yet@example.com" });
    const owner = await signUpAs(ctx, "owner@ops.test", "admin", "Ops");
    const sup = await signUpAs(ctx, "sup@ops.test", "ops_support", "Sup");
    await signUpAs(ctx, "ro@ops.test", "ops_readonly", "Ro");
    await signUpAs(ctx, "plain@example.com", null, "Plain");
    for (const email of ["ro@ops.test", "not-yet@example.com", "plain@example.com"]) await lockOut(ctx, email);
    for (const email of ["ro@ops.test", "not-yet@example.com", "RO@ops.test"]) {
      const r = await sup.c.post("/api/console/system/lockouts/clear", { email, reason: "Locked out on the phone" });
      expect(r.status, email).toBe(403);
      expect(r.body.error.code).toBe("target_is_operator");
    }
    expect((await ctx.db.select().from(loginThrottle).where(eq(loginThrottle.email, "ro@ops.test")).get())?.failures).toBeGreaterThan(0);
    expect((await sup.c.post("/api/console/system/lockouts/clear", { email: "plain@example.com", reason: "Locked out on the phone" })).status).toBe(200);
    expect((await owner.c.post("/api/console/system/lockouts/clear", { email: "ro@ops.test", reason: "Owner unlocking a teammate" })).status).toBe(200);
    void users;
  }, 60_000);
});
