/**
 * Round 2: password hashing by runtime. Workers cap PBKDF2 at 100,000 iterations, so the hosted service stays there. A
 * Node server (self host) hashes new passwords at 600,000 (OWASP's PBKDF2-SHA256 figure) and upgrades an older hash the
 * next time its owner signs in with the right password.
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { accounts, users } from "@/server/db/schema";
import { hashPassword, passwordIterations, PBKDF2_ITERATIONS, PBKDF2_ITERATIONS_NODE, verifyPassword } from "@/server/lib/crypto";

const PW = "a-strong-password";

async function stored(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string) {
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  return (await ctx.db.select().from(accounts).where(and(eq(accounts.userId, u.id), eq(accounts.providerId, "credential"))).get())!;
}

describe("Round 2: password hashes by runtime", () => {
  it("the iteration counts", () => {
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    expect(PBKDF2_ITERATIONS_NODE).toBe(600_000);
    expect(passwordIterations("workers")).toBe(100_000);
    expect(passwordIterations("node")).toBe(600_000);
  });

  it("Node: a new password is hashed at 600,000; an older 100,000 hash is upgraded on a right sign in, not a wrong one", async () => {
    const ctx = await makeTestApp();
    ctx.deps.runtime = "node";
    const c = new Client(ctx.app);
    await c.signup("node@acme.io");
    expect((await stored(ctx, "node@acme.io")).password).toMatch(/^pbkdf2_sha256\$600000\$/);

    // An account from before: 100,000.
    const acc = await stored(ctx, "node@acme.io");
    await ctx.db.update(accounts).set({ password: await hashPassword(PW, 100_000) }).where(eq(accounts.id, acc.id));
    expect((await new Client(ctx.app).login("node@acme.io", "wrong-password-here")).status).toBe(401);
    expect((await stored(ctx, "node@acme.io")).password).toMatch(/^pbkdf2_sha256\$100000\$/);
    expect((await new Client(ctx.app).login("node@acme.io")).status).toBe(200);
    const after = (await stored(ctx, "node@acme.io")).password!;
    expect(after).toMatch(/^pbkdf2_sha256\$600000\$/);
    expect(await verifyPassword(PW, after)).toBe(true);
    // And the upgraded hash still signs in.
    expect((await new Client(ctx.app).login("node@acme.io")).status).toBe(200);
  }, 60_000);

  it("Workers: 100,000 and no rehash", async () => {
    const ctx = await makeTestApp();
    ctx.deps.runtime = "workers";
    const c = new Client(ctx.app);
    await c.signup("cf@acme.io");
    const before = (await stored(ctx, "cf@acme.io")).password!;
    expect(before).toMatch(/^pbkdf2_sha256\$100000\$/);
    expect((await new Client(ctx.app).login("cf@acme.io")).status).toBe(200);
    expect((await stored(ctx, "cf@acme.io")).password).toBe(before);
  }, 60_000);
});
