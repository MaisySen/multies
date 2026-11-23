/**
 * SA1: one row per network account. Connecting the same LinkedIn (or Facebook) account again refreshes the one
 * connection instead of adding a second; two different accounts stay two rows, each with its name. Connections made
 * before this (duplicates already on the platform) fold into the newest one the first time the accounts are listed,
 * and posts that pointed at the older one move with it. The 0134 unique index is the server side guard.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { auditLogs, members, socialAccountProfiles, socialPostTargets, users } from "../src/server/db/schema";
import { mockComposioFetch, newMockState, type MockComposioState } from "../src/server/services/integrations/mock";
import { MIGRATIONS } from "../src/server/db/migrations.generated";
import { LINKEDIN_PAGE_NOTE } from "../src/shared/integrations";

const ENV = { COMPOSIO_API_KEY: "ak_test_key_never_shown", COMPOSIO_BASE_URL: "https://composio.mock", APP_URL: "https://app.example.com" };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let mock: MockComposioState;
let owner: Client;

async function orgIdOf(email: string) {
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  return (await ctx.db.select().from(members).where(eq(members.userId, u.id)).get())!.organizationId;
}

/** Start, sign in on the stand in as someone (data picks who), come back and confirm, as the page does. */
async function connectAs(c: Client, app: string, who: Record<string, unknown> = {}) {
  const r = await c.post("/api/apps/connect", { app });
  expect(r.status).toBe(201);
  const id = new URL(r.body.redirectUrl).searchParams.get("connected_account_id")!;
  Object.assign(mock.accounts.get(id)!.data, who);
  const conf = await c.post(`/api/apps/accounts/${id}/confirm`);
  expect(conf.status).toBe(200);
  return { id, account: conf.body.account };
}

beforeEach(async () => {
  mock = newMockState();
  ctx = await makeTestApp(ENV, { fetch: mockComposioFetch(async () => { throw new Error("network disabled in tests"); }, mock) });
  owner = new Client(ctx.app);
  await owner.signup("owner-sa1@acme.io");
});

describe("SA1 social accounts: one row per network account", () => {
  it("the same Gmail account connected again is one row", async () => {
    const first = await connectAs(owner, "gmail", { email: "ada@gmail.com", name: "Ada" });
    const second = await connectAs(owner, "gmail", { email: "ada@gmail.com", name: "Ada" });
    expect(second.account.refreshed).toBe(true);
    const list = ((await owner.get("/api/apps/accounts")).body.accounts as { id: string; app: string }[]).filter((a) => a.app === "gmail");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(second.id);
    expect(mock.accounts.has(first.id)).toBe(false);
  });

  it("connecting the same LinkedIn account twice keeps one row with a fresh sign in and its name", async () => {
    const first = await connectAs(owner, "linkedin");
    expect(first.account).toMatchObject({ app: "linkedin", name: "Ada", refreshed: false });
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const post = await owner.post("/api/social/posts", { text: "Planned for tomorrow", runAt: later, targets: [{ accountId: first.id }] });
    expect(post.status).toBe(201);

    const second = await connectAs(owner, "linkedin");
    expect(second.account).toMatchObject({ name: "Ada", refreshed: true });
    const list = (await owner.get("/api/apps/accounts")).body.accounts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: second.id, app: "linkedin", name: "Ada", status: "active" });
    // The older connection is gone from the platform, and the planned post now goes through the kept one.
    expect(mock.accounts.has(first.id)).toBe(false);
    const targets = await ctx.db.select().from(socialPostTargets).where(eq(socialPostTargets.postId, post.body.post.id)).all();
    expect(targets.map((t) => t.accountId)).toEqual([second.id]);
    const orgId = await orgIdOf("owner-sa1@acme.io");
    const audit = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "integration.merged"))).all();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("mock-secret-token");
  });

  it("two different LinkedIn accounts stay two rows, each with its own name and picture", async () => {
    await connectAs(owner, "linkedin", { sub: "p1", name: "Ada Lovelace", picture: "https://media.example.com/ada.jpg" });
    await connectAs(owner, "linkedin", { sub: "p2", name: "Grace Hopper" });
    const list = (await owner.get("/api/apps/accounts")).body.accounts;
    expect(list.map((a: { name: string }) => a.name).sort()).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(list.find((a: { name: string }) => a.name === "Ada Lovelace").avatarUrl).toBe("https://media.example.com/ada.jpg");
    expect(list.find((a: { name: string }) => a.name === "Grace Hopper").avatarUrl).toBeNull();
  });

  it("Facebook: the same profile again is one row; another profile is a second row", async () => {
    await connectAs(owner, "facebook");
    const again = await connectAs(owner, "facebook");
    expect(again.account.refreshed).toBe(true);
    await connectAs(owner, "facebook", { fbId: "fbu_2", name: "Kiran Rao" });
    const list = (await owner.get("/api/apps/accounts")).body.accounts;
    expect(list.map((a: { name: string }) => a.name).sort()).toEqual(["Ada Lovelace", "Kiran Rao"]);
  });

  it("duplicates made before this fold into the newest connection when the accounts are listed, posts moved", async () => {
    const orgId = await orgIdOf("owner-sa1@acme.io");
    const userId = `app.example.com:${orgId}`;
    // Two connections to the same LinkedIn member already on the platform, with no profile rows yet.
    const make = (id: string, at: string) => mock.accounts.set(id, { id, user_id: userId, status: "ACTIVE", toolkit: { slug: "linkedin" }, auth_config: { id: "ac_x" }, alias: null, created_at: at, data: {} });
    make("ca_old1", "2026-10-31T08:00:00.000Z");
    make("ca_new1", "2026-11-01T08:00:00.000Z");
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const post = await owner.post("/api/social/posts", { text: "Planned on the older one", runAt: later, targets: [{ accountId: "ca_old1" }] });
    expect(post.status).toBe(201);

    const list = (await owner.get("/api/apps/accounts")).body.accounts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "ca_new1", name: "Ada" });
    expect(mock.accounts.has("ca_old1")).toBe(false);
    const targets = await ctx.db.select().from(socialPostTargets).where(eq(socialPostTargets.postId, post.body.post.id)).all();
    expect(targets.map((t) => t.accountId)).toEqual(["ca_new1"]);
    const rows = await ctx.db.select().from(socialAccountProfiles).where(eq(socialAccountProfiles.orgId, orgId)).all();
    expect(rows.map((r) => [r.accountId, r.externalId])).toEqual([["ca_new1", "person:mock1"]]);
    // A second list asks nobody again (the profile is fresh) and stays one row.
    const proxied = mock.proxied.length;
    expect((await owner.get("/api/apps/accounts")).body.accounts).toHaveLength(1);
    expect(mock.proxied.length).toBe(proxied);
  });

  it("a connection whose sign in fails is never merged or removed", async () => {
    const a = await connectAs(owner, "linkedin");
    const b = await connectAs(owner, "linkedin", { expired: true });
    expect(b.account.refreshed).toBe(false);
    expect((await owner.get("/api/apps/accounts")).body.accounts).toHaveLength(2);
    expect(mock.accounts.has(a.id)).toBe(true);
  });

  it("members see the names; the LinkedIn page note is plain", async () => {
    await connectAs(owner, "linkedin");
    const orgId = await orgIdOf("owner-sa1@acme.io");
    const member = new Client(ctx.app);
    await member.signup("member-sa1@acme.io", "Kiran Rao", "");
    const u = (await ctx.db.select().from(users).where(eq(users.email, "member-sa1@acme.io")).get())!;
    await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role: "member" });
    await ctx.db.run(sql`update sessions set active_organization_id = ${orgId} where user_id = ${u.id}`);
    const list = (await member.get("/api/apps/accounts")).body.accounts;
    expect(list[0]).toMatchObject({ name: "Ada" });
    expect(LINKEDIN_PAGE_NOTE).not.toMatch(/[\u2013\u2014]| - /);
  });
});

describe("SA1 migration 0134", () => {
  it("creates the profile table with the unique guard on workspace, network and network id", async () => {
    const m = MIGRATIONS.find((x) => x.name === "0134_sa1_social_account_profiles");
    expect(m).toBeTruthy();
    expect(m!.statements.join("\n")).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS `social_account_profiles_ext_uq`/);
    const orgId = await orgIdOf("owner-sa1@acme.io");
    const row = { orgId, app: "linkedin", externalId: "person:x", name: "A", avatarUrl: null, checkedAt: new Date() };
    await ctx.db.insert(socialAccountProfiles).values({ ...row, accountId: "ca_1" });
    await expect(ctx.db.insert(socialAccountProfiles).values({ ...row, accountId: "ca_2" })).rejects.toThrow();
    // Connections we could not identify (no network id) do not collide.
    await ctx.db.insert(socialAccountProfiles).values({ ...row, externalId: null, accountId: "ca_3" });
    await ctx.db.insert(socialAccountProfiles).values({ ...row, externalId: null, accountId: "ca_4" });
    expect(await ctx.db.select().from(socialAccountProfiles).where(eq(socialAccountProfiles.orgId, orgId)).all()).toHaveLength(3);
  });
});
