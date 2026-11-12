import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { invitations, members, organizations, sessions } from "@/server/db/schema";
import { Runner } from "../scripts/dogfood/org-setup";

/**
 * R25 wave 3: Haajir HQ dogfood findings DF-4, DF-7, DF-12 and DF-15, each walked through its
 * own steps. DF-12 and DF-15 were fixed in round 13 (74b25b4); DF-7 mostly in round 12 (b16ed20)
 * and finished here with /api/v1/invites; DF-4's titles and bios came in d6b33e2 and invitations
 * carry them from here (migration 0055).
 */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
let key: string;
let orgId: string;

async function api(k: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${k}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

/** Signs up a new person and accepts an invitation link with their session. */
async function join(email: string, inviteId: string, name = "Board Chair") {
  const c = new Client(ctx.app);
  await c.signup(email, name, "");
  const r = await c.post(`/api/invites/${inviteId}/accept`);
  expect(r.status).toBe(200);
  return c;
}

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@haajir.test", "Olive Owner");
  orgId = (await owner.get("/api/account/me")).body.organization.id;
  await ctx.db.update(organizations).set({ name: "Haajir HQ" }).where(eq(organizations.id, orgId));
  key = (await owner.post("/api/developer/keys", { name: "Org setup script" })).body.secret;
});

describe("DF-4: titles and bios for members, and on invitations", () => {
  it("Settings, Team already edits a title and bio (d6b33e2); the guard walks it", async () => {
    const src = readFileSync("src/web/pages/app/team.tsx", "utf8");
    expect(src).toContain("Edit title and bio");
    const me = (await owner.get("/api/account/me")).body.user.id;
    const r = await owner.patch(`/api/team/people/${me}`, { title: "Founder", bio: "Runs Haajir." });
    expect(r.status).toBe(200);
    expect(r.body.person).toMatchObject({ title: "Founder", bio: "Runs Haajir." });
  });

  it("an invitation made in the app carries a title and bio, and the member starts with them", async () => {
    const r = await owner.post("/api/team/invites", { email: "chair@haajir.test", role: "member", title: "Board chair", bio: "Chairs the board." });
    expect(r.status).toBe(201);
    const team = (await owner.get("/api/team")).body;
    expect(team.invites[0]).toMatchObject({ email: "chair@haajir.test", title: "Board chair", bio: "Chairs the board." });
    await join("chair@haajir.test", r.body.id);
    const people = (await owner.get("/api/team/people")).body.people as { email?: string; title: string | null; bio: string | null }[];
    expect(people.find((p) => p.email === "chair@haajir.test")).toMatchObject({ title: "Board chair", bio: "Chairs the board." });
  });

  it("an invitation without a title writes nothing extra and the member starts with none", async () => {
    const r = await owner.post("/api/team/invites", { email: "plain@haajir.test" });
    expect(r.status).toBe(201);
    const row = await ctx.db.select().from(invitations).where(eq(invitations.id, r.body.id)).get();
    expect(row).toMatchObject({ title: null, bio: null });
    await join("plain@haajir.test", r.body.id, "Plain Person");
    const m = (await ctx.db.select().from(members).where(eq(members.organizationId, orgId))).find((x) => x.role === "member");
    expect(m).toMatchObject({ title: null, bio: null });
  });

  it("inviting the same address again takes the new role and title (Better Auth kept the old ones)", async () => {
    const first = await owner.post("/api/team/invites", { email: "cfo@haajir.test", role: "member", title: "Advisor" });
    const again = await owner.post("/api/team/invites", { email: "cfo@haajir.test", role: "admin", title: "CFO" });
    expect(again.body.id).toBe(first.body.id);
    const row = await ctx.db.select().from(invitations).where(eq(invitations.id, first.body.id)).get();
    expect(row).toMatchObject({ role: "admin", title: "CFO", status: "pending" });
  });

  it("nobody is invited as owner: ownership moves by transfer once they have joined", async () => {
    const r = await owner.post("/api/team/invites", { email: "founder2@haajir.test", role: "owner" });
    expect(r.status).toBe(422);
    const v = await api(key, "POST", "/invites", { email: "founder2@haajir.test", role: "owner" });
    expect(v.status).toBe(422);
  });
});

describe("DF-7: the public API covers an org setup", () => {
  it("the OpenAPI document lists members, invites, channel update, pins, template create and doc delete", async () => {
    const doc = (await ctx.app.request("/api/v1/openapi.json", { headers: { host: "localhost" } }));
    const paths = (await doc.json()).paths as Record<string, Record<string, unknown>>;
    expect(paths["/people"]?.get).toBeTruthy();
    expect(paths["/invites"]?.get).toBeTruthy();
    expect(paths["/invites"]?.post).toBeTruthy();
    expect(paths["/invites/{id}"]?.delete).toBeTruthy();
    expect(paths["/chat/channels/{id}"]?.patch).toBeTruthy();
    expect(paths["/chat/messages/{id}/pin"]?.post).toBeTruthy();
    expect(paths["/templates"]?.post).toBeTruthy();
    expect(paths["/docs/{id}"]?.delete).toBeTruthy();
  });

  it("a workspace key invites, lists and revokes; the invite email goes out and the title reaches the member", async () => {
    const sentBefore = ctx.outbound.sent.length;
    const r = await api(key, "POST", "/invites", { email: "Design@Haajir.test", title: "Head of Design", bio: "Brand and product design." });
    expect(r.status).toBe(201);
    expect(r.body.link).toContain(`/invite/${r.body.id}`);
    // AIS1 (audit row 1): a key's invite waits for a person. Nothing is emailed until the owner confirms it in the app.
    expect(r.body).toMatchObject({ status: "awaiting_approval", emailed: false });
    expect(ctx.outbound.sent.slice(sentBefore).find((m) => m.to.includes("design@haajir.test"))).toBeUndefined();
    expect((await owner.post(`/api/team/invites/${r.body.id}/confirm`)).status).toBe(200);
    const mail = ctx.outbound.sent.slice(sentBefore).find((m) => m.to.includes("design@haajir.test"));
    expect(mail?.subject).toBe("Olive Owner invited you to Haajir HQ on Multies");
    const list = await api(key, "GET", "/invites");
    expect(list.body.invites).toEqual([expect.objectContaining({ email: "design@haajir.test", role: "member", title: "Head of Design", invitedByName: "Olive Owner" })]);
    // The app sees the same invitation.
    expect((await owner.get("/api/team")).body.invites[0].id).toBe(r.body.id);
    await join("design@haajir.test", r.body.id, "Dee Signer");
    const people = (await api(key, "GET", "/people")).body.people as { email?: string; title: string | null }[];
    expect(people.find((p) => p.email === "design@haajir.test")?.title).toBe("Head of Design");

    const second = await api(key, "POST", "/invites", { email: "growth@haajir.test" });
    expect((await api(key, "DELETE", `/invites/${second.body.id}`)).status).toBe(200);
    expect((await api(key, "GET", "/invites")).body.invites).toEqual([]);
    expect((await api(key, "DELETE", `/invites/${second.body.id}`)).status).toBe(404);
    // An accepted invitation and a revoked one can't be revoked; inviting a member again is a conflict.
    expect((await api(key, "DELETE", `/invites/${r.body.id}`)).status).toBe(404);
    expect((await api(key, "POST", "/invites", { email: "design@haajir.test" })).status).toBe(409);
  });

  it("an admin invite needs a key made by the owner; seats apply; a key whose creator left can't invite", async () => {
    const admin = await api(key, "POST", "/invites", { email: "cto@haajir.test", role: "admin" });
    expect(admin.status).toBe(201);
    expect((await owner.post(`/api/team/invites/${admin.body.id}/confirm`)).status).toBe(200); // AIS1: a person confirms a key's invite
    const cto = await join("cto@haajir.test", admin.body.id, "Cee Tee");
    const ctoKey = (await cto.post("/api/developer/keys", { name: "CTO script" })).body.secret as string;
    expect(ctoKey).toMatch(/^mm_live_/);
    const r = await api(ctoKey, "POST", "/invites", { email: "vp@haajir.test", role: "admin" });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe("Only the workspace owner can invite admins.");
    expect((await api(ctoKey, "POST", "/invites", { email: "vp@haajir.test" })).status).toBe(201);
    // Starter has 3 seats: owner, CTO and one pending invitation.
    const full = await api(key, "POST", "/invites", { email: "fourth@haajir.test" });
    expect(full.body.error.code).toBe("plan_limit");
    // A key outlives its creator only as a plain workspace key: it can no longer invite.
    const ctoId = (await cto.get("/api/account/me")).body.user.id;
    expect((await owner.del(`/api/team/members/${ctoId}`)).status).toBe(200);
    const left = await api(ctoKey, "POST", "/invites", { email: "late@haajir.test" });
    expect(left.status).toBe(403);
    expect(left.body.error.message).toContain("no longer in the workspace");
  });

  it("read only keys and agent member keys can't invite", async () => {
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret as string;
    expect((await api(ro, "POST", "/invites", { email: "x@haajir.test" })).body.error.code).toBe("read_only_key");
    expect((await api(ro, "GET", "/invites")).status).toBe(200);
    const agent = await api(key, "POST", "/agent-members", { name: "Builder" });
    const agentKey = (agent.body.apiKey?.secret ?? agent.body.key?.secret ?? agent.body.secret) as string;
    expect(agentKey).toMatch(/^mm_live_/);
    expect((await api(agentKey, "POST", "/invites", { email: "x@haajir.test" })).status).toBe(403);
    expect((await api(agentKey, "DELETE", "/invites/whatever")).status).toBe(403);
  });

  it("each org setup route is scoped to the key's workspace (404) and refuses a read only key (403)", async () => {
    const other = new Client(ctx.app);
    await other.signup("other@else.test", "Other Owner", "Elsewhere");
    const otherKey = (await other.post("/api/developer/keys", { name: "theirs" })).body.secret as string;
    const ch = (await api(otherKey, "POST", "/chat/channels", { name: "general", topic: "theirs" })).body.channel;
    const msg = (await api(otherKey, "POST", `/chat/channels/${ch.id}/messages`, { body: "hello" })).body.message;
    const doc = (await api(otherKey, "POST", "/docs", { title: "Their doc", text: "x" })).body.doc;
    const inv = (await api(otherKey, "POST", "/invites", { email: "theirs@else.test" })).body;
    expect(doc?.id).toBeTruthy();

    expect((await api(key, "PATCH", `/chat/channels/${ch.id}`, { topic: "mine now", archived: true })).status).toBe(404);
    expect((await api(key, "POST", `/chat/messages/${msg.id}/pin`)).status).toBe(404);
    expect((await api(key, "DELETE", `/docs/${doc.id}`)).status).toBe(404);
    expect((await api(key, "DELETE", `/invites/${inv.id}`)).status).toBe(404);
    expect((await api(otherKey, "GET", "/invites")).body.invites).toHaveLength(1);

    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret as string;
    const mine = (await api(key, "POST", "/chat/channels", { name: "eng" })).body.channel;
    const post = (await api(key, "POST", `/chat/channels/${mine.id}/messages`, { body: "Welcome." })).body.message;
    const myDoc = (await api(key, "POST", "/docs", { title: "Team directory", text: "x" })).body.doc;
    for (const [m, p, b] of [["PATCH", `/chat/channels/${mine.id}`, { topic: "Builds" }], ["POST", `/chat/messages/${post.id}/pin`, undefined], ["DELETE", `/docs/${myDoc.id}`, undefined], ["POST", "/templates", { kind: "doc", name: "Brief", data: { title: "Brief", text: "Goal" } }]] as const) {
      const r = await api(ro, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body.error.code).toBe("read_only_key");
    }
    // And the workspace key does each of them.
    expect((await api(key, "PATCH", `/chat/channels/${mine.id}`, { topic: "Builds", archived: true })).body.channel).toMatchObject({ topic: "Builds" });
    expect((await api(key, "POST", `/chat/messages/${post.id}/pin`)).status).toBe(200);
    expect((await api(key, "POST", "/templates", { kind: "doc", name: "Brief", data: { title: "Brief", text: "Goal" } })).status).toBe(201);
    expect((await api(key, "DELETE", `/docs/${myDoc.id}`)).status).toBe(200);
  });
});

describe("DF-12: a new sign in opens the workspace used last (fixed in 74b25b4)", () => {
  it("after creating and switching workspaces, a sign in on another device opens the last one used", async () => {
    const second = await owner.post("/api/account/workspaces", { name: "Second Co" });
    expect(second.status).toBe(201);
    expect((await owner.get("/api/account/me")).body.organization.id).toBe(second.body.id);
    const phone = new Client(ctx.app);
    expect((await phone.login("owner@haajir.test")).status).toBe(200);
    expect((await phone.get("/api/account/me")).body.organization.id).toBe(second.body.id);
    // Switching back (Better Auth's set active) counts as use too.
    await new Promise((r) => setTimeout(r, 5));
    expect((await phone.post(`/api/account/workspaces/${orgId}/switch`)).status).toBe(200);
    const laptop = new Client(ctx.app);
    await laptop.login("owner@haajir.test");
    expect((await laptop.get("/api/account/me")).body.organization.id).toBe(orgId);
    // Existing sessions keep their own workspace.
    expect((await owner.get("/api/account/me")).body.organization.id).toBe(second.body.id);
  });

  it("a workspace the person has left is skipped", async () => {
    const second = await owner.post("/api/account/workspaces", { name: "Second Co" });
    await ctx.db.delete(members).where(eq(members.organizationId, second.body.id));
    const c = new Client(ctx.app);
    await c.login("owner@haajir.test");
    expect((await c.get("/api/account/me")).body.organization.id).toBe(orgId);
    expect((await ctx.db.select().from(sessions)).length).toBeGreaterThan(1);
  });
});

describe("DF-12: org setup names the empty sign up workspace instead of making a second", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const route = () => vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const u = new URL(url);
    return ctx.app.request(u.pathname + u.search, { ...init, headers: { ...(init.headers as Record<string, string>), host: "localhost" } });
  });

  it("a brand new account's only workspace is renamed; an account with a real workspace gets a new one", async () => {
    const founder = new Client(ctx.app);
    await founder.signup("founder@new.test", "Fay Founder", "");
    const before = (await founder.get("/api/account/workspaces")).body.workspaces;
    expect(before).toHaveLength(1);
    expect(before[0].name).toBe("Fay's workspace");
    route();
    const run = new Runner("http://localhost", { workspace: { name: "Haajir Labs" } } as never, "/tmp/never-written.json", false, false);
    run.cookie = founder.cookie;
    vi.spyOn(console, "log").mockImplementation(() => {});
    await run.workspace();
    const after = (await founder.get("/api/account/workspaces")).body.workspaces;
    expect(after).toEqual([expect.objectContaining({ id: before[0].id, name: "Haajir Labs" })]);
    expect(run.log).toContain("Named the sign up workspace Haajir Labs");

    // The owner above named and onboarded nothing, but their workspace is "Haajir HQ", not the sign up name: a second is made.
    const run2 = new Runner("http://localhost", { workspace: { name: "Haajir Labs" } } as never, "/tmp/never-written.json", false, false);
    run2.cookie = owner.cookie;
    await run2.workspace();
    expect((await owner.get("/api/account/workspaces")).body.workspaces).toHaveLength(2);
  });
});

describe("DF-15: the sidebar is grouped (fixed in 74b25b4)", () => {
  const src = readFileSync("src/web/layouts/app.tsx", "utf8");
  const items = [...src.matchAll(/\{ to: "(\/app[^"]*)", label: "([^"]+)", icon: \w+,(?: end: true,)? group: "(work|mail|admin)" \}/g)].map((m) => ({ to: m[1], label: m[2], group: m[3] }));

  it("every item sits in one of three headed groups, in order Work, Mail, then Workspace, with nothing removed", () => {
    expect(items.length).toBeGreaterThanOrEqual(25);
    const order = items.map((i) => i.group).filter((g, i, a) => i === 0 || a[i - 1] !== g);
    expect(order).toEqual(["work", "mail", "admin"]);
    expect(src).toContain('const GROUP_LABEL = { work: "Work", mail: "Mail", admin: "Settings" } as const;'); // P1 layout: Workspace is Settings
    expect(src).toContain('data-testid="nav-group"');
    for (const to of ["/app/chat", "/app/tasks", "/app/docs", "/app/goals", "/app/mail", "/app/inbox", "/app/domains", "/app/settings", "/app/agents"]) {
      expect(items.map((i) => i.to)).toContain(to);
    }
  });

  it("Mail and the shared inbox are both under Mail, and no item is called Team inbox", () => {
    expect(items.filter((i) => i.group === "mail").map((i) => i.label)).toEqual(expect.arrayContaining(["Mail", "Shared inbox"]));
    expect(items.map((i) => i.label)).not.toContain("Team inbox");
    expect(new Set(items.map((i) => i.label)).size).toBe(items.length);
    // Settings is last.
    expect(items.at(-1)?.label).toBe("Settings");
  });
});
