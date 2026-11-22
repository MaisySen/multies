/**
 * OPS1 shared fixes: the owner's email under a workspace's name in console lists (services/console/owners.ts). One
 * statement for a whole page of workspaces, under D1's 100 variable limit, the earliest owner when there are several,
 * and nothing for a workspace without an owner.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { d1Violations, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { members, users } from "@/server/db/schema";
import { ownerEmails, withOwnerEmail } from "@/server/services/console/owners";

let ctx: Ctx;
let orgA: string;
let orgB: string;

async function orgOf(email: string): Promise<string> {
  const u = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get())!;
  return (await ctx.db.select({ orgId: members.organizationId }).from(members).where(eq(members.userId, u.id)).get())!.orgId;
}

beforeAll(async () => {
  ctx = await makeTestApp();
  await signUpAs(ctx, "owner@alpha.test", null, "Alpha");
  await signUpAs(ctx, "owner@beta.test", null, "Beta");
  orgA = await orgOf("owner@alpha.test");
  orgB = await orgOf("owner@beta.test");
}, 120_000);

/** Counts the statements sent to SQLite while `fn` runs. */
async function statements(fn: () => Promise<unknown>): Promise<string[]> {
  type Raw = { prepare: (q: string) => unknown };
  const client = (ctx.db as unknown as { $client: Raw }).$client;
  const prepare = client.prepare;
  const seen: string[] = [];
  client.prepare = (q: string) => { seen.push(q); return prepare.call(client, q); };
  try { await fn(); } finally { client.prepare = prepare; }
  return seen;
}

describe("owner emails for a page of workspaces", () => {
  it("answers each workspace's owner in one statement, whatever the page size", async () => {
    const ids = [orgA, orgB, ...Array.from({ length: 150 }, (_, i) => `org_missing_${i}`), orgA, null, undefined];
    const before = d1Violations.length;
    let got = new Map<string, string>();
    const sent = await statements(async () => { got = await ownerEmails(ctx.deps, ids); });
    expect(sent.filter((q) => /from ["`]members["`]/i.test(q))).toHaveLength(1);
    expect(d1Violations.length).toBe(before);
    expect(got.get(orgA)).toBe("owner@alpha.test");
    expect(got.get(orgB)).toBe("owner@beta.test");
    expect(got.has("org_missing_0")).toBe(false);
  }, 60_000);

  it("adds ownerEmail to items, null without an owner, and reads nothing for an empty page", async () => {
    const items = await withOwnerEmail(ctx.deps, [{ orgId: orgA, n: 1 }, { orgId: null, n: 2 }, { orgId: "org_nobody", n: 3 }]);
    expect(items).toEqual([{ orgId: orgA, n: 1, ownerEmail: "owner@alpha.test" }, { orgId: null, n: 2, ownerEmail: null }, { orgId: "org_nobody", n: 3, ownerEmail: null }]);
    expect(await statements(() => ownerEmails(ctx.deps, []))).toHaveLength(0);
  }, 60_000);

  it("names the earliest owner when a workspace has two, and no one once the owner is gone", async () => {
    const { id: second } = await signUpAs(ctx, "second@alpha.test", null, "");
    await ctx.db.insert(members).values({ id: "mem_second_owner", organizationId: orgA, userId: second, role: "owner", createdAt: new Date(Date.now() + 60_000) });
    expect((await ownerEmails(ctx.deps, [orgA])).get(orgA)).toBe("owner@alpha.test");
    await ctx.db.update(members).set({ role: "member" }).where(and(eq(members.organizationId, orgB), eq(members.role, "owner")));
    expect((await ownerEmails(ctx.deps, [orgB])).has(orgB)).toBe(false);
  }, 60_000);
});
