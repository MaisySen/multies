/**
 * Folding a second connection to the same outside account into one (SA1, widened to every app by PR 46) must be safe:
 * only an admin confirms a connection, a failure part way never leaves the workspace without the account's identity or
 * with posts pointing at a removed connection, a live connection is never reported as "not saved", and only an identity
 * that is provably the outside account (an OpenID Connect id_token's issuer and subject) can merge two connections.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { auditLogs, members, socialAccountProfiles, socialPages, socialPostTargets, users } from "../src/server/db/schema";
import { mockComposioFetch, newMockState, type MockComposioState } from "../src/server/services/integrations/mock";
import { identityFromAccount } from "../src/server/services/integrations/account-profiles";

const ENV = { COMPOSIO_API_KEY: "ak_test_key_never_shown", COMPOSIO_BASE_URL: "https://composio.mock", APP_URL: "https://app.example.com" };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let mock: MockComposioState;
let owner: Client;

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims: Record<string, unknown>) => `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u(claims)}.sig`;

async function orgIdOf(email: string) {
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  return (await ctx.db.select().from(members).where(eq(members.userId, u.id)).get())!.organizationId;
}

async function start(c: Client, app: string, who: Record<string, unknown> = {}) {
  const r = await c.post("/api/apps/connect", { app });
  expect(r.status).toBe(201);
  const id = new URL(r.body.redirectUrl).searchParams.get("connected_account_id")!;
  Object.assign(mock.accounts.get(id)!.data, who);
  return id;
}

async function connectAs(c: Client, app: string, who: Record<string, unknown> = {}) {
  const id = await start(c, app, who);
  const conf = await c.post(`/api/apps/accounts/${id}/confirm`);
  expect(conf.status).toBe(200);
  return { id, account: conf.body.account };
}

/** R2: a company Page chosen through a connection (SOC1). */
async function addPage(via: string) {
  const orgId = await orgIdOf("owner-merge@acme.io");
  await ctx.db.insert(socialPages).values({ orgId, app: "linkedin", pageId: "777", key: "page_li_777", viaAccountId: via, name: "Acme", addedAt: new Date() });
}
async function pageVia() {
  const orgId = await orgIdOf("owner-merge@acme.io");
  return (await ctx.db.select().from(socialPages).where(eq(socialPages.orgId, orgId)).all()).map((p) => p.viaAccountId);
}

async function profileRows() {
  const orgId = await orgIdOf("owner-merge@acme.io");
  return (await ctx.db.select().from(socialAccountProfiles).where(eq(socialAccountProfiles.orgId, orgId)).all())
    .map((r) => [r.accountId, r.externalId]).sort();
}

beforeEach(async () => {
  mock = newMockState();
  ctx = await makeTestApp(ENV, { fetch: mockComposioFetch(async () => { throw new Error("network disabled in tests"); }, mock) });
  owner = new Client(ctx.app);
  await owner.signup("owner-merge@acme.io");
});

describe("confirming a connection", () => {
  it("only an owner or admin can confirm, so a member cannot cause another connection to be removed", async () => {
    const first = await connectAs(owner, "linkedin");
    const id = await start(owner, "linkedin");
    const orgId = await orgIdOf("owner-merge@acme.io");
    const member = new Client(ctx.app);
    await member.signup("member-merge@acme.io", "Kiran Rao", "");
    const u = (await ctx.db.select().from(users).where(eq(users.email, "member-merge@acme.io")).get())!;
    await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role: "member" });
    await ctx.db.run(sql`update sessions set active_organization_id = ${orgId} where user_id = ${u.id}`);
    const r = await member.post(`/api/apps/accounts/${id}/confirm`);
    expect(r.status).toBe(403);
    expect(mock.accounts.has(first.id)).toBe(true);
    // And the older connection id itself cannot be confirmed by the member either.
    expect((await member.post(`/api/apps/accounts/${first.id}/confirm`)).status).toBe(403);
  });
});

describe("folding a second connection to the same account, with a failure at each step", () => {
  // pointers (9 statements, with the chosen Pages since R2), the older profile row, the waiting markers moved to the
  // kept connection (F1), then the kept profile row: one unit.
  const STEPS = 12;

  for (let step = 0; step < STEPS; step++) {
    it(`a failure at write ${step + 1} of ${STEPS} changes nothing, keeps both connections, and still reports the new one connected`, async () => {
      const first = await connectAs(owner, "linkedin");
      const later = new Date(Date.now() + 86_400_000).toISOString();
      const post = await owner.post("/api/social/posts", { text: "Planned", runAt: later, targets: [{ accountId: first.id }] });
      expect(post.status).toBe(201);
      const before = await profileRows();
      await addPage(first.id);
      const id = await start(owner, "linkedin");

      const realRun = ctx.db.run.bind(ctx.db);
      let seen = 0;
      const spy = vi.spyOn(ctx.db, "run").mockImplementation(((q: Parameters<typeof ctx.db.run>[0]) => {
        const text = typeof q === "string" ? q : (ctx.db as unknown as { dialect: { sqlToQuery(s: unknown): { sql: string } } }).dialect.sqlToQuery(q).sql;
        if (/social_/i.test(text) && seen++ === step) throw new Error(`injected failure at write ${step + 1}`);
        return realRun(q);
      }) as typeof ctx.db.run);
      let conf;
      try { conf = await owner.post(`/api/apps/accounts/${id}/confirm`); } finally { spy.mockRestore(); }

      expect(seen).toBeGreaterThan(step);
      expect(conf.status).toBe(200);
      expect(conf.body.account).toMatchObject({ id, status: "active" });
      expect(conf.body.account.refreshed).not.toBe(true);
      expect(conf.body.account.warning).toMatch(/disconnect the older one/i);
      // All or nothing: the older connection keeps its identity and its posts, and is still on the platform.
      expect(mock.accounts.has(first.id)).toBe(true);
      expect(mock.accounts.has(id)).toBe(true);
      expect(await profileRows()).toEqual(before);
      const targets = await ctx.db.select().from(socialPostTargets).where(eq(socialPostTargets.postId, post.body.post.id)).all();
      expect(targets.map((t) => t.accountId)).toEqual([first.id]);
      expect(await pageVia()).toEqual([first.id]);
      // The connection is live, so it is audited as connected.
      const orgId = await orgIdOf("owner-merge@acme.io");
      const connected = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "integration.connected"), eq(auditLogs.targetId, id))).all();
      expect(connected).toHaveLength(1);
    });
  }

  it("a chosen Page asked through the older connection moves to the kept one (R2)", async () => {
    const first = await connectAs(owner, "linkedin");
    await addPage(first.id);
    const id = await start(owner, "linkedin");
    const conf = await owner.post(`/api/apps/accounts/${id}/confirm`);
    expect(conf.body.account).toMatchObject({ refreshed: true });
    expect(mock.accounts.has(first.id)).toBe(false);
    expect(await pageVia()).toEqual([id]);
  });

  it("the older connection is removed on the platform only after the database holds the new identity", async () => {
    const first = await connectAs(owner, "linkedin");
    const id = await start(owner, "linkedin");
    const orgId = await orgIdOf("owner-merge@acme.io");
    let rowsAtRemove: unknown[] | null = null;
    const realFetch = ctx.deps.fetch;
    ctx.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE" && String(input).includes(first.id)) {
        rowsAtRemove = (await ctx.db.select().from(socialAccountProfiles).where(eq(socialAccountProfiles.orgId, orgId)).all()).map((r) => r.accountId);
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const conf = await owner.post(`/api/apps/accounts/${id}/confirm`);
    expect(conf.body.account).toMatchObject({ refreshed: true });
    expect(rowsAtRemove).toEqual([id]);
  });

  it("a platform refusal to remove the older connection still keeps the merge and says connected", async () => {
    const first = await connectAs(owner, "linkedin");
    const id = await start(owner, "linkedin");
    const realFetch = ctx.deps.fetch;
    ctx.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE" && String(input).includes(first.id)) return Response.json({ error: "down" }, { status: 500 });
      return realFetch(input, init);
    }) as typeof fetch;
    const conf = await owner.post(`/api/apps/accounts/${id}/confirm`);
    expect(conf.status).toBe(200);
    expect(conf.body.account).toMatchObject({ id, status: "active", refreshed: true });
    // R3: the older connection keeps a marker row saying it waits to be removed (sorted after the kept row's id).
    expect(await profileRows()).toEqual([[first.id, `removal-pending:${id}:${first.id}`], [id, "person:mock1"]].sort());
  });
});

describe("listing accounts (R4)", () => {
  it("a member's listing reads only: it never folds or removes a connection; an admin's listing still does", async () => {
    const first = await connectAs(owner, "linkedin");
    const id = await start(owner, "linkedin"); // signed in on the platform, not confirmed yet
    const orgId = await orgIdOf("owner-merge@acme.io");
    const member = new Client(ctx.app);
    await member.signup("member-list@acme.io", "Kiran Rao", "");
    const u = (await ctx.db.select().from(users).where(eq(users.email, "member-list@acme.io")).get())!;
    await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role: "member" });
    await ctx.db.run(sql`update sessions set active_organization_id = ${orgId} where user_id = ${u.id}`);
    const before = await profileRows();
    const r = await member.get("/api/apps/accounts");
    expect(r.status).toBe(200);
    expect((r.body.accounts as { id: string }[]).map((a) => a.id).sort()).toEqual([first.id, id].sort());
    expect(mock.accounts.has(first.id)).toBe(true);
    expect(mock.accounts.has(id)).toBe(true);
    expect(await profileRows()).toEqual(before);
    // The owner's listing settles the new connection and folds the older one into it, as before.
    await owner.get("/api/apps/accounts");
    expect(mock.accounts.has(first.id)).toBe(false);
    expect(mock.accounts.has(id)).toBe(true);
  });
});

describe("after the platform refused to remove the older connection (R3)", () => {
  it("a connection still waiting when its kept one is folded into a newer one never takes the newer one's place (F1)", async () => {
    const o1 = await connectAs(owner, "linkedin");
    const k = await start(owner, "linkedin");
    const realFetch = ctx.deps.fetch;
    ctx.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE" && String(input).includes(o1.id)) return Response.json({ error: "down" }, { status: 500 });
      return realFetch(input, init);
    }) as typeof fetch;
    expect((await owner.post(`/api/apps/accounts/${k}/confirm`)).body.account).toMatchObject({ refreshed: true });
    const n = await start(owner, "linkedin");
    let removedN = false;
    const withK = ctx.deps.fetch;
    ctx.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE" && String(input).includes(n)) removedN = true;
      return withK(input, init);
    }) as typeof fetch;
    expect((await owner.post(`/api/apps/accounts/${n}/confirm`)).body.account).toMatchObject({ refreshed: true });
    expect(mock.accounts.has(k)).toBe(false); // K's removal went through
    const shown = async () => ((await owner.get("/api/apps/accounts")).body.accounts as { id: string; app: string }[]).filter((a) => a.app === "linkedin").map((a) => a.id);
    expect(await shown()).toEqual([n]);
    const t = Date.now() + 2 * 3_600_000;
    ctx.deps.now = () => new Date(t);
    expect(await shown()).toEqual([n]);
    expect(removedN).toBe(false);
    expect(mock.accounts.has(n)).toBe(true);
    expect(mock.accounts.has(o1.id)).toBe(true); // the platform still refuses; it stays hidden and waiting
  });

  it("two connections waiting to be removed into the same kept one each keep their marker (F2)", async () => {
    const first = await connectAs(owner, "linkedin");
    const id = await start(owner, "linkedin");
    const orgId = await orgIdOf("owner-merge@acme.io");
    // Another older connection already waits to be removed into the same kept one (as a repointed marker leaves it).
    const other = await start(owner, "linkedin");
    await ctx.db.insert(socialAccountProfiles).values({ orgId, accountId: other, app: "linkedin", externalId: `removal-pending:${id}`, checkedAt: new Date() });
    const realFetch = ctx.deps.fetch;
    ctx.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE" && !String(input).includes(id)) return Response.json({ error: "down" }, { status: 500 });
      if ((init?.method ?? "GET") === "DELETE") throw new Error(`the kept connection ${id} must never be removed`);
      return realFetch(input, init);
    }) as typeof fetch;
    expect((await owner.post(`/api/apps/accounts/${id}/confirm`)).body.account).toMatchObject({ refreshed: true });
    const rows = new Map((await ctx.db.select().from(socialAccountProfiles).where(eq(socialAccountProfiles.orgId, orgId)).all()).map((r) => [r.accountId, r.externalId]));
    expect(rows.get(first.id)).toMatch(new RegExp(`^removal-pending:${id}`));
    // The next listing shows only the kept connection, and it is still there.
    const shown = ((await owner.get("/api/apps/accounts")).body.accounts as { id: string; app: string }[]).filter((a) => a.app === "linkedin").map((a) => a.id);
    expect(shown).toEqual([id]);
    expect(mock.accounts.has(id)).toBe(true);
  });

  it("the next listing neither shows it nor folds the new sign in into it, and removal is retried later", async () => {
    const first = await connectAs(owner, "linkedin");
    const id = await start(owner, "linkedin");
    const realFetch = ctx.deps.fetch;
    let refuse = true;
    let deletes = 0;
    ctx.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE" && String(input).includes(first.id)) { deletes++; if (refuse) return Response.json({ error: "down" }, { status: 500 }); }
      if ((init?.method ?? "GET") === "DELETE" && String(input).includes(id)) throw new Error(`the new connection ${id} must never be removed`);
      return realFetch(input, init);
    }) as typeof fetch;
    expect((await owner.post(`/api/apps/accounts/${id}/confirm`)).body.account).toMatchObject({ refreshed: true });
    expect(mock.accounts.has(first.id)).toBe(true); // still on the platform
    const shown = async () => ((await owner.get("/api/apps/accounts")).body.accounts as { id: string; app: string }[]).filter((a) => a.app === "linkedin").map((a) => a.id);
    expect(await shown()).toEqual([id]);
    expect(await shown()).toEqual([id]);
    expect(mock.accounts.has(id)).toBe(true);
    expect(deletes).toBe(1); // not retried within the hour
    // An hour later the removal is tried again, and now the platform takes it.
    refuse = false;
    const t = Date.now() + 2 * 3_600_000;
    ctx.deps.now = () => new Date(t);
    expect(await shown()).toEqual([id]);
    expect(deletes).toBe(2);
    expect(mock.accounts.has(first.id)).toBe(false);
    expect(await shown()).toEqual([id]);
    expect(await profileRows()).toEqual([[id, "person:mock1"]]);
  });
});

describe("which identities can merge two connections", () => {
  const acct = (data: Record<string, unknown>, val?: Record<string, unknown>) => ({ id: "ca_1", user_id: "h:org", status: "ACTIVE", toolkit: { slug: "gmail" }, data, ...(val ? { state: { val } } : {}) });

  it("a bare id, username, email or sub in the platform's data is not trusted", () => {
    expect(identityFromAccount(acct({ id: "12345" }))).toBeNull();
    expect(identityFromAccount(acct({ username: "ada" }))).toBeNull();
    expect(identityFromAccount(acct({ email: "ada@gmail.com", name: "Ada" }))).toBeNull();
    expect(identityFromAccount(acct({}, { id: "conn_77", access_token: "tok" }))).toBeNull();
    expect(identityFromAccount(acct({ access_token: "mock-secret-token" }))).toBeNull();
  });

  it("an OpenID Connect id_token's issuer and subject are the outside account", () => {
    const tok = idToken({ iss: "https://accounts.google.com", sub: "1093", email: "ada@gmail.com", name: "Ada", picture: "https://lh3.example.com/a.png" });
    expect(identityFromAccount(acct({}, { id_token: tok }))).toEqual({ externalId: "oidc:https://accounts.google.com|1093", name: "Ada", avatarUrl: "https://lh3.example.com/a.png" });
    expect(identityFromAccount(acct({ id_token: tok }))?.externalId).toBe("oidc:https://accounts.google.com|1093");
    expect(identityFromAccount(acct({}, { id_token: idToken({ sub: "1093" }) }))).toBeNull();
    expect(identityFromAccount(acct({}, { id_token: "not-a-jwt" }))).toBeNull();
  });

  it("two Gmail connections with only an email in the platform's data stay two rows", async () => {
    await connectAs(owner, "gmail", { email: "ada@gmail.com", name: "Ada" });
    const second = await connectAs(owner, "gmail", { email: "ada@gmail.com", name: "Ada" });
    expect(second.account.refreshed).not.toBe(true);
    expect(((await owner.get("/api/apps/accounts")).body.accounts as { app: string }[]).filter((a) => a.app === "gmail")).toHaveLength(2);
  });
});
