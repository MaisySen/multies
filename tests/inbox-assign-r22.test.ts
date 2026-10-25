import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { mailboxAccess, mailThreadState, members, messages, notifications, sessions, users } from "@/server/db/schema";
import { median, replyStats } from "@/server/services/mail/thread-state";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
const H = 3_600_000;
const DAY = 24 * H;

async function verifiedDomain(ctx: Ctx, c: Client, name: string) {
  const domainId = (await c.post("/api/domains", { name })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
  return domainId;
}

let ctx: Ctx;
let owner: Client;
let kiran: Client; // member with access to support only
let bea: Client; // member with no mailbox access
let orgId: string;
let ownerId: string, kiranId: string, beaId: string;
let support: { id: string; address: string };
let sales: { id: string; address: string };
let seq = 0;

/** One message row, straight into the table, at a fixed time. */
async function msg(o: { org?: string; mailboxId: string; threadId: string; at: number; out?: boolean; byUser?: string; byAgent?: string; subject?: string; from?: string }) {
  await ctx.db.insert(messages).values({
    id: `msg_t${++seq}`, orgId: o.org ?? orgId, mailboxId: o.mailboxId, folder: o.out ? "sent" : "inbox", threadId: o.threadId,
    fromAddress: o.from ?? (o.out ? "team@acme.io" : "customer@example.com"), fromName: o.out ? "Team" : "Casey Customer",
    subject: o.subject ?? `Thread ${o.threadId}`, snippet: "hello", sentByUserId: o.byUser ?? null, sentByAgentId: o.byAgent ?? null, date: new Date(o.at),
  });
}

async function joinAs(c: Client, email: string, name: string) {
  await c.signup(email, name, "");
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role: "member" });
  await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
  return u.id;
}

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const ids = (r: { body: { data: { id: string }[] } }) => r.body.data.map((t) => t.id);

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  const me = (await owner.get("/api/account/me")).body;
  orgId = me.organization.id; ownerId = me.user.id;
  const domainId = await verifiedDomain(ctx, owner, "acme.io");
  support = (await owner.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" })).body.mailbox;
  sales = (await owner.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Sales" })).body.mailbox;
  kiran = new Client(ctx.app); bea = new Client(ctx.app);
  kiranId = await joinAs(kiran, "kiran@acme.io", "Kiran Rao");
  beaId = await joinAs(bea, "bea@acme.io", "Bea Bell");
  await ctx.db.insert(mailboxAccess).values({ orgId, userId: kiranId, mailboxId: support.id });
});

describe("R22.1 thread assignment", () => {
  it("assigns, reassigns and unassigns, notifying the assignee but not a self assign", async () => {
    const now = Date.now();
    await msg({ mailboxId: support.id, threadId: "t1", at: now - H, subject: "Refund for order 77" });
    const a = await owner.post("/api/threads/t1/assign", { userId: kiranId });
    expect(a.status).toBe(200);
    expect(a.body.state).toMatchObject({ threadId: "t1", status: "open", assignee: { id: kiranId, name: "Kiran Rao" } });
    const n = await ctx.db.select().from(notifications).where(eq(notifications.userId, kiranId));
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: "thread_assigned", entityType: "thread", entityId: "t1", title: "Assigned to you: Refund for order 77", actorName: "Olive Owner" });
    // The notification opens the thread in the shared inbox.
    const list = (await kiran.get("/api/notifications")).body;
    expect(JSON.stringify(list)).toContain("/app/inbox?thread=t1");

    // Reassign to me (self): no notification for me.
    expect((await owner.post("/api/threads/t1/assign", { userId: ownerId })).body.state.assignee.id).toBe(ownerId);
    expect(await ctx.db.select().from(notifications).where(eq(notifications.userId, ownerId))).toHaveLength(0);
    // Kiran assigns it to himself: no new notification for him.
    expect((await kiran.post("/api/threads/t1/assign", { userId: kiranId })).status).toBe(200);
    expect(await ctx.db.select().from(notifications).where(eq(notifications.userId, kiranId))).toHaveLength(1);
    // Unassign.
    expect((await kiran.post("/api/threads/t1/assign", { userId: null })).body.state.assignee).toBeNull();
    const row = await ctx.db.select().from(mailThreadState).where(and(eq(mailThreadState.orgId, orgId), eq(mailThreadState.threadId, "t1"))).get();
    expect(row).toMatchObject({ assigneeUserId: null, mailboxId: support.id, status: "open" });
    // The state and the people who can open it, for the Assign menu: owner and Kiran, not Bea.
    const st = (await owner.get("/api/threads/t1/state")).body;
    expect(st.members.map((m: { id: string }) => m.id).sort()).toEqual([kiranId, ownerId].sort());
  });

  it("refuses an assignee who can't open the mailbox, a stranger, another org's thread and a member without access", async () => {
    await msg({ mailboxId: sales.id, threadId: "ts", at: Date.now() - H });
    await msg({ mailboxId: support.id, threadId: "tk", at: Date.now() - H });
    const r = await owner.post("/api/threads/ts/assign", { userId: kiranId });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("can't open this thread's mailbox");
    expect((await owner.post("/api/threads/ts/assign", { userId: "usr_nobody" })).body.error.message).toContain("isn't in this workspace");

    // Another workspace and its thread.
    const other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve Other", "Other");
    const otherOrg = (await other.get("/api/account/me")).body.organization.id;
    const otherDomain = await verifiedDomain(ctx, other, "other.io");
    const made = await other.post("/api/mailboxes", { domainId: otherDomain, localPart: "hello", displayName: "Hello" });
    expect(made.body).toMatchObject({ mailbox: { address: "hello@other.io" } });
    const box = made.body.mailbox;
    await msg({ org: otherOrg, mailboxId: box.id, threadId: "tx", at: Date.now() - H });
    expect((await owner.post("/api/threads/tx/assign", { userId: ownerId })).status).toBe(404);
    expect((await owner.post("/api/threads/tx/status", { status: "done" })).status).toBe(404);
    expect((await owner.get("/api/threads/tx/state")).status).toBe(404);
    // Eve can't assign our thread to herself either.
    expect((await other.post("/api/threads/tk/assign", { userId: (await other.get("/api/account/me")).body.user.id })).status).toBe(404);

    // Bea has no mailbox access: the thread is not there for her.
    expect((await bea.post("/api/threads/tk/assign", { userId: beaId })).status).toBe(404);
    expect((await bea.post("/api/threads/tk/status", { status: "done" })).status).toBe(404);
    // Kiran can't touch the sales thread.
    expect((await kiran.post("/api/threads/ts/assign", { userId: kiranId })).status).toBe(404);
    expect(await ctx.db.select().from(mailThreadState)).toHaveLength(0);
  });

  it("lists views: open, mine, unassigned, assigned to a person, done, with pagination", async () => {
    const now = Date.now();
    for (let i = 1; i <= 6; i++) await msg({ mailboxId: support.id, threadId: `v${i}`, at: now - i * H });
    await owner.post("/api/threads/v1/assign", { userId: ownerId });
    await owner.post("/api/threads/v2/assign", { userId: kiranId });
    await owner.post("/api/threads/v3/assign", { userId: kiranId });
    await owner.post("/api/threads/v3/status", { status: "done" });
    await owner.post("/api/threads/v4/status", { status: "done" });
    await owner.post("/api/threads/v5/assign", { userId: ownerId });

    expect(ids(await owner.get("/api/agents/threads"))).toEqual(["v1", "v2", "v5", "v6"]);
    expect(ids(await owner.get("/api/agents/threads?view=all"))).toEqual(["v1", "v2", "v3", "v4", "v5", "v6"]);
    expect(ids(await owner.get("/api/agents/threads?view=mine"))).toEqual(["v1", "v5"]);
    expect(ids(await kiran.get("/api/agents/threads?view=mine"))).toEqual(["v2"]);
    expect(ids(await owner.get("/api/agents/threads?view=unassigned"))).toEqual(["v6"]);
    expect(ids(await owner.get(`/api/agents/threads?view=assigned&assignee=${kiranId}`))).toEqual(["v2"]);
    expect(ids(await owner.get("/api/agents/threads?view=assigned"))).toEqual(["v1", "v2", "v5"]);
    expect(ids(await owner.get("/api/agents/threads?view=done"))).toEqual(["v3", "v4"]);
    const first = (await owner.get("/api/agents/threads?view=open&limit=2")).body;
    expect(first.data.map((t: { id: string }) => t.id)).toEqual(["v1", "v2"]);
    expect(first.data[0]).toMatchObject({ assignee: { id: ownerId, name: "Olive Owner" }, status: "open" });
    expect(first.data[1].assignee).toMatchObject({ id: kiranId });
    const second = (await owner.get(`/api/agents/threads?view=open&limit=2&before=${first.nextCursor}`)).body;
    expect(second.data.map((t: { id: string }) => t.id)).toEqual(["v5", "v6"]);
    expect(second.data[1]).toMatchObject({ assignee: null, status: "open" });
    // Reopen brings a thread back.
    await owner.post("/api/threads/v4/status", { status: "open" });
    expect(ids(await owner.get("/api/agents/threads?view=unassigned"))).toEqual(["v4", "v6"]);
    // The agent API's thread list keeps showing everything (no view by default).
  });

  it("puts open assigned threads in My Work, newest first, and drops them when done", async () => {
    const now = Date.now();
    await msg({ mailboxId: support.id, threadId: "m1", at: now - 3 * H, subject: "Older one" });
    await msg({ mailboxId: support.id, threadId: "m2", at: now - 2 * H, subject: "Newer one" });
    await msg({ mailboxId: support.id, threadId: "m3", at: now - H, subject: "Not mine" });
    await owner.post("/api/threads/m1/assign", { userId: kiranId });
    await owner.post("/api/threads/m2/assign", { userId: kiranId });
    await owner.post("/api/threads/m3/assign", { userId: ownerId });
    const w = (await kiran.get("/api/my-work")).body;
    expect(w.assignedThreads.map((t: { title: string }) => t.title)).toEqual(["Newer one", "Older one"]);
    expect(w.assignedThreads[0]).toMatchObject({ id: "m2", url: "/app/inbox?thread=m2", subtitle: "From Casey Customer" });
    await kiran.post("/api/threads/m2/status", { status: "done" });
    expect((await kiran.get("/api/my-work")).body.assignedThreads.map((t: { id: string }) => t.id)).toEqual(["m1"]);
    // Lose access to the mailbox: the thread leaves My Work too.
    await ctx.db.delete(mailboxAccess).where(eq(mailboxAccess.userId, kiranId));
    expect((await kiran.get("/api/my-work")).body.assignedThreads).toEqual([]);
  });
});

describe("R22.5 reply times", () => {
  it("medians", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(3); // (2 + 3) / 2 rounded
  });

  it("works out first response and resolution per mailbox and per person, scoped to what the caller can open", async () => {
    const t0 = Date.now() - 10 * DAY;
    // s1: Kiran answers after 1h, done after 5h. s2: owner answers after 3h, open. s3: no answer, done after 2h.
    await msg({ mailboxId: support.id, threadId: "s1", at: t0 });
    await msg({ mailboxId: support.id, threadId: "s1", at: t0 + 30 * 60_000 }); // a second inbound changes nothing
    await msg({ mailboxId: support.id, threadId: "s1", at: t0 + H, out: true, byUser: kiranId });
    await msg({ mailboxId: support.id, threadId: "s1", at: t0 + 2 * H, out: true, byUser: ownerId });
    await msg({ mailboxId: support.id, threadId: "s2", at: t0 + DAY });
    await msg({ mailboxId: support.id, threadId: "s2", at: t0 + DAY + 3 * H, out: true, byUser: ownerId });
    await msg({ mailboxId: support.id, threadId: "s3", at: t0 + 2 * DAY });
    // Sales: owner answers after 4h. A thread that started 40 days ago falls outside the default range.
    await msg({ mailboxId: sales.id, threadId: "s4", at: t0 + 3 * DAY });
    await msg({ mailboxId: sales.id, threadId: "s4", at: t0 + 3 * DAY + 4 * H, out: true, byUser: ownerId });
    await msg({ mailboxId: sales.id, threadId: "old", at: Date.now() - 40 * DAY });
    await msg({ mailboxId: sales.id, threadId: "old", at: Date.now() - 40 * DAY + H, out: true, byUser: ownerId });
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(t0 + 5 * H);
    await owner.post("/api/threads/s1/status", { status: "done" });
    ctx.deps.now = () => new Date(t0 + 2 * DAY + 2 * H);
    await owner.post("/api/threads/s3/status", { status: "done" });
    ctx.deps.now = real;

    const byBox = (await owner.get("/api/threads/stats/replies")).body;
    expect(byBox).toMatchObject({ groupBy: "mailbox", hours: "calendar", sampled: false, threadsScanned: 4 });
    const sup = byBox.rows.find((r: { key: string }) => r.key === support.id);
    expect(sup).toMatchObject({ label: support.address, threads: 3, replied: 2, medianFirstResponseMs: 2 * H, averageFirstResponseMs: 2 * H, resolved: 2, medianResolutionMs: 3.5 * H });
    expect(byBox.rows.find((r: { key: string }) => r.key === sales.id)).toMatchObject({ threads: 1, medianFirstResponseMs: 4 * H, resolved: 0, medianResolutionMs: null });
    expect(byBox.total).toMatchObject({ threads: 4, replied: 3, medianFirstResponseMs: 3 * H });

    const byPerson = (await owner.get("/api/threads/stats/replies?groupBy=person")).body;
    const row = (k: string) => byPerson.rows.find((r: { key: string }) => r.key === k);
    expect(row(`person:${kiranId}`)).toMatchObject({ label: "Kiran Rao", type: "person", threads: 1, medianFirstResponseMs: H });
    expect(row(`person:${ownerId}`)).toMatchObject({ label: "Olive Owner", threads: 2, medianFirstResponseMs: 3.5 * H });
    expect(row("nobody")).toMatchObject({ threads: 1, replied: 0 });

    // A wider range takes the old thread in; more than 90 days is refused.
    const from = new Date(Date.now() - 60 * DAY).toISOString();
    expect((await owner.get(`/api/threads/stats/replies?from=${from}`)).body.threadsScanned).toBe(5);
    expect((await owner.get(`/api/threads/stats/replies?from=${new Date(Date.now() - 120 * DAY).toISOString()}`)).status).toBe(400);

    // Kiran sees only support; asking for sales is a 404. Bea sees nothing.
    const k = (await kiran.get("/api/threads/stats/replies")).body;
    expect(k.rows.map((r: { key: string }) => r.key)).toEqual([support.id]);
    expect((await kiran.get(`/api/threads/stats/replies?mailboxId=${sales.id}`)).status).toBe(404);
    expect((await bea.get("/api/threads/stats/replies")).body).toMatchObject({ threadsScanned: 0, rows: [], total: null });
  });

  it("says sampled when it hits the cap", async () => {
    const t0 = Date.now() - DAY;
    for (let i = 0; i < 4; i++) await msg({ mailboxId: support.id, threadId: `c${i}`, at: t0 + i * 1000 });
    const actor = { orgId, userId: ownerId, email: "owner@acme.io", name: "Olive", role: "owner" as const };
    expect(await replyStats(ctx.deps, actor, {})).toMatchObject({ sampled: false, threadsScanned: 4 });
    // The newest threads are kept when the scan is cut.
    const cut = await replyStats(ctx.deps, actor, { cap: 3 });
    expect(cut).toMatchObject({ sampled: true, threadsScanned: 3 });
    expect(cut.total?.threads).toBe(3);
  });
});

describe("R22 REST and MCP", () => {
  it("assigns and lists over REST; a read only key reads but can't assign", async () => {
    await msg({ mailboxId: support.id, threadId: "r1", at: Date.now() - H });
    await msg({ mailboxId: support.id, threadId: "r1", at: Date.now() - H / 2, out: true, byUser: ownerId });
    const key = (await owner.post("/api/developer/keys", { name: "Ops" })).body.secret;
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    expect((await api(ro, "POST", "/threads/r1/assign", { userId: kiranId })).status).toBe(403);
    expect((await api(ro, "POST", "/threads/r1/status", { status: "done" })).status).toBe(403);
    const a = await api(key, "POST", "/threads/r1/assign", { userId: kiranId });
    expect(a.status).toBe(200);
    expect(a.body.state.assignee).toMatchObject({ id: kiranId });
    expect((await api(ro, "GET", `/threads?view=assigned&assignee=${kiranId}`)).body.data.map((t: { id: string }) => t.id)).toEqual(["r1"]);
    expect((await api(ro, "GET", "/threads/r1/state")).body.state.assignee.id).toBe(kiranId);
    expect((await api(key, "POST", "/threads/r1/status", { status: "done" })).body.state.status).toBe("done");
    expect((await api(ro, "GET", "/threads")).body.data).toEqual([]);
    expect((await api(ro, "GET", "/threads?view=done")).body.data[0]).toMatchObject({ id: "r1", status: "done" });
    const stats = await api(ro, "GET", "/stats/replies?groupBy=person");
    expect(stats.status).toBe(200);
    expect(stats.body.rows[0]).toMatchObject({ key: `person:${ownerId}`, threads: 1 });
    expect((await api(key, "POST", "/threads/nope/assign", { userId: null })).status).toBe(404);
    expect((await api(key, "POST", "/threads/r1/status", { status: "waiting" })).status).toBe(422);
  });

  it("MCP tools assign, list by view, set status and read stats; read only keys can't write", async () => {
    await msg({ mailboxId: support.id, threadId: "p1", at: Date.now() - H });
    const key = (await owner.post("/api/developer/keys", { name: "Agent" })).body.secret;
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    const mcp = await mcpFor(key);
    expect(data(await mcp.callTool({ name: "assign_thread", arguments: { threadId: "p1", userId: kiranId } })).state.assignee.id).toBe(kiranId);
    expect(data(await mcp.callTool({ name: "list_threads_by_view", arguments: { view: "assigned", assignee: kiranId } })).data.map((t: { id: string }) => t.id)).toEqual(["p1"]);
    expect(data(await mcp.callTool({ name: "unassign_thread", arguments: { threadId: "p1" } })).state.assignee).toBeNull();
    expect(data(await mcp.callTool({ name: "list_threads_by_view", arguments: { view: "unassigned" } })).data.map((t: { id: string }) => t.id)).toEqual(["p1"]);
    expect(data(await mcp.callTool({ name: "set_thread_status", arguments: { threadId: "p1", status: "done" } })).state.status).toBe("done");
    expect(data(await mcp.callTool({ name: "get_reply_stats", arguments: {} }))).toMatchObject({ threadsScanned: 1, groupBy: "mailbox" });
    const r = await mcpFor(ro);
    const refused = await r.callTool({ name: "assign_thread", arguments: { threadId: "p1", userId: ownerId } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("read_only_key");
    expect((await r.callTool({ name: "set_thread_status", arguments: { threadId: "p1", status: "open" } })).isError).toBe(true);
    expect(data(await r.callTool({ name: "list_threads_by_view", arguments: { view: "done" } })).data).toHaveLength(1);
  });
});
