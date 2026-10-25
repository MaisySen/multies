import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { automations, mailboxAccess, mailThreadState, members, messages, notifications, sessions, users } from "@/server/db/schema";
import { deliverInbound } from "@/server/services/mail/delivery";
import { nextInRotation, parseAssignConfig, reopenOnInbound } from "@/server/services/suite/thread-rules";

/** R22.5: mail rules that assign shared inbox threads (a person or round robin), and the Waiting status. */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;

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
let owner: Client, kiran: Client, bea: Client, carl: Client;
let orgId: string, ownerId: string, kiranId: string, beaId: string, carlId: string;
let support: { id: string; address: string };
let n = 0;

async function joinAs(c: Client, email: string, name: string) {
  await c.signup(email, name, "");
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role: "member" });
  await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
  return u.id;
}

/** Delivers one inbound mail and returns its thread id. */
async function inbound(o: { subject?: string; to?: string; replyTo?: string; from?: string } = {}) {
  const id = `<r22rules${++n}@example.com>`;
  await deliverInbound(ctx.deps, { envelopeFrom: o.from ?? "casey@example.com", rcptTo: o.to ?? "support@acme.io", sizeBytes: 300, via: "test",
    email: { messageId: id, from: { address: o.from ?? "casey@example.com", name: "Casey" }, to: [{ address: o.to ?? "support@acme.io" }], cc: [], subject: o.subject ?? `Question ${n}`, text: "Hello", date: new Date(),
      ...(o.replyTo ? { inReplyTo: o.replyTo, references: o.replyTo } : {}), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} } });
  const m = (await ctx.db.select({ threadId: messages.threadId }).from(messages).where(eq(messages.messageIdHeader, id)).get())!;
  return { threadId: m.threadId, id };
}
const stateOf = async (threadId: string) => ctx.db.select().from(mailThreadState).where(and(eq(mailThreadState.orgId, orgId), eq(mailThreadState.threadId, threadId))).get();
const rule = (actionConfig: Record<string, unknown>, conditions: Record<string, unknown> = { mailboxId: support.id }) =>
  owner.post("/api/automations", { name: "Support rota", trigger: "email_received", conditions, action: "assign_thread", actionConfig });
async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
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
  await owner.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Sales" });
  kiran = new Client(ctx.app); bea = new Client(ctx.app); carl = new Client(ctx.app);
  kiranId = await joinAs(kiran, "kiran@acme.io", "Kiran Rao");
  beaId = await joinAs(bea, "bea@acme.io", "Bea Bell");
  carlId = await joinAs(carl, "carl@acme.io", "Carl Cole");
  await ctx.db.insert(mailboxAccess).values([{ orgId, userId: kiranId, mailboxId: support.id }, { orgId, userId: carlId, mailboxId: support.id }]);
});

describe("R22.5 rules that assign threads", () => {
  it("assigns a new thread to one person and notifies them; a reply never reassigns", async () => {
    const r = await rule({ mode: "person", userId: kiranId });
    expect(r.status).toBe(201);
    expect(r.body.automation).toMatchObject({ action: "assign_thread", actionConfig: { mode: "person", userId: kiranId } });
    const t = await inbound({ subject: "Broken login" });
    expect((await stateOf(t.threadId))).toMatchObject({ assigneeUserId: kiranId, status: "open" });
    const note = await ctx.db.select().from(notifications).where(eq(notifications.userId, kiranId));
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({ type: "thread_assigned", entityId: t.threadId, title: "Assigned to you: Broken login", actorName: "Automation: Support rota" });
    // Someone moves it to the owner; the customer's reply keeps it there and runs no rule.
    await owner.post(`/api/threads/${t.threadId}/assign`, { userId: ownerId });
    const reply = await inbound({ subject: "Re: Broken login", replyTo: t.id });
    expect(reply.threadId).toBe(t.threadId);
    expect((await stateOf(t.threadId))?.assigneeUserId).toBe(ownerId);
    const row = (await owner.get("/api/automations")).body.automations[0];
    expect(row.runCount).toBe(1);
    // Mail to another mailbox doesn't match the rule.
    const other = await inbound({ to: "sales@acme.io" });
    expect(await stateOf(other.threadId)).toBeUndefined();
  });

  it("round robin cycles A, B, C, A and skips someone who lost mailbox access or left", async () => {
    const r = await rule({ mode: "round_robin", userIds: [ownerId, kiranId, carlId] });
    expect(r.status).toBe(201);
    const got: string[] = [];
    for (let i = 0; i < 4; i++) got.push((await stateOf((await inbound()).threadId))!.assigneeUserId!);
    expect(got).toEqual([ownerId, kiranId, carlId, ownerId]);
    const saved = (await ctx.db.select().from(automations).where(eq(automations.id, r.body.automation.id)).get())!;
    expect(JSON.parse(saved.actionConfig)).toMatchObject({ last: ownerId });
    expect(saved.runCount).toBe(4);
    // Carl loses access to support: he is skipped.
    await ctx.db.delete(mailboxAccess).where(and(eq(mailboxAccess.userId, carlId), eq(mailboxAccess.mailboxId, support.id)));
    const more: string[] = [];
    for (let i = 0; i < 3; i++) more.push((await stateOf((await inbound()).threadId))!.assigneeUserId!);
    expect(more).toEqual([kiranId, ownerId, kiranId]);
    // Kiran leaves the workspace: only the owner is left.
    await ctx.db.delete(members).where(eq(members.userId, kiranId));
    expect((await stateOf((await inbound()).threadId))!.assigneeUserId).toBe(ownerId);
    expect((await stateOf((await inbound()).threadId))!.assigneeUserId).toBe(ownerId);
  });

  it("records an error and leaves the thread unassigned when nobody in the rule can open the mailbox", async () => {
    // No mailbox on the rule, so the save check can only check membership; Bea can't open support.
    expect((await rule({ mode: "person", userId: beaId }, { subjectContains: "invoice" })).status).toBe(201);
    const t = await inbound({ subject: "Invoice 12" });
    expect(await stateOf(t.threadId)).toBeUndefined();
    const row = (await owner.get("/api/automations")).body.automations[0];
    expect(row.lastError).toMatch(/can open that mailbox/);
  });

  it("refuses at save time a person who can't open the rule's mailbox, bad rotations and other workspaces' ids", async () => {
    const no = await rule({ mode: "person", userId: beaId });
    expect(no.status).toBe(422);
    expect(no.body.error.message).toBe("Someone in this rule can't open that mailbox. Give them access to it first.");
    expect((await rule({ mode: "round_robin", userIds: [kiranId, beaId] })).status).toBe(422);
    expect((await rule({ mode: "round_robin", userIds: [kiranId] })).body.error.message).toBe("Round robin needs 2 to 20 people.");
    expect((await rule({ mode: "round_robin", userIds: [kiranId, kiranId] })).status).toBe(422);
    expect((await rule({ mode: "round_robin", userIds: Array.from({ length: 21 }, (_, i) => `usr_${i}`) })).status).toBe(422);
    expect((await rule({ mode: "person" })).status).toBe(422);
    expect((await rule({ mode: "team" })).status).toBe(422);
    // Another workspace's person and mailbox.
    const other = new Client(ctx.app);
    await other.signup("zed@other.io", "Zed Other");
    const zed = (await other.get("/api/account/me")).body;
    expect((await rule({ mode: "person", userId: zed.user.id })).body.error.message).toBe("Someone in this rule isn't in this workspace.");
    const otherBox = await verifiedDomain(ctx, other, "other.io").then((d) => other.post("/api/mailboxes", { domainId: d, localPart: "help", displayName: "Help" }));
    expect((await rule({ mode: "person", userId: ownerId }, { mailboxId: otherBox.body.mailbox.id })).body.error.message).toBe("That mailbox isn't in this workspace.");
    // Only rules for new email can assign.
    expect((await owner.post("/api/automations", { name: "x", trigger: "status_changed", conditions: {}, action: "assign_thread", actionConfig: { mode: "person", userId: ownerId } })).status).toBe(422);
    // Members can't make rules at all; another workspace can't edit this one.
    expect((await kiran.post("/api/automations", { name: "x", trigger: "email_received", conditions: { mailboxId: support.id }, action: "assign_thread", actionConfig: { mode: "person", userId: kiranId } })).status).toBe(403);
    const ok = await rule({ mode: "person", userId: kiranId });
    expect(ok.status).toBe(201);
    expect((await other.patch(`/api/automations/${ok.body.automation.id}`, { enabled: false })).status).toBe(404);
    // A patch that names someone without access is refused too.
    expect((await owner.patch(`/api/automations/${ok.body.automation.id}`, { actionConfig: { mode: "person", userId: beaId } })).status).toBe(422);
    expect((await owner.patch(`/api/automations/${ok.body.automation.id}`, { actionConfig: { mode: "round_robin", userIds: [kiranId, carlId] } })).status).toBe(200);
  });

  it("a turned off rule assigns nothing (a patch of only enabled keeps the rule's conditions)", async () => {
    const r = await rule({ mode: "person", userId: kiranId });
    const off = await owner.patch(`/api/automations/${r.body.automation.id}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.automation).toMatchObject({ enabled: false, conditions: { mailboxId: support.id }, actionConfig: { mode: "person", userId: kiranId } });
    expect(await stateOf((await inbound()).threadId)).toBeUndefined();
  });

  it("rotation helpers: order, wrap, skip and a pointer that left the list", () => {
    const all = new Set(["a", "b", "c"]);
    expect(nextInRotation(["a", "b", "c"], null, all)).toBe("a");
    expect(nextInRotation(["a", "b", "c"], "c", all)).toBe("a");
    expect(nextInRotation(["a", "b", "c"], "a", new Set(["a", "c"]))).toBe("c");
    expect(nextInRotation(["a", "b", "c"], "x", all)).toBe("a");
    expect(nextInRotation(["a", "b"], "a", new Set())).toBeNull();
    expect(parseAssignConfig({ mode: "round_robin", userIds: ["a", "b"], last: "z" })).toEqual({ mode: "round_robin", userIds: ["a", "b"], last: null });
  });
});

describe("R22.5 Waiting status", () => {
  it("waiting and done go back to open on new inbound mail; views list waiting on its own", async () => {
    const a = await inbound({ subject: "Waiting one" });
    const b = await inbound({ subject: "Done one" });
    await inbound({ subject: "Open one" });
    const w = await owner.post(`/api/threads/${a.threadId}/status`, { status: "waiting" });
    expect(w.status).toBe(200);
    expect(w.body.state).toMatchObject({ status: "waiting", doneAt: null });
    await owner.post(`/api/threads/${b.threadId}/status`, { status: "done" });
    expect(ids(await owner.get("/api/agents/threads?view=waiting"))).toEqual([a.threadId]);
    expect(ids(await owner.get("/api/agents/threads?view=open"))).not.toContain(a.threadId);
    expect(ids(await owner.get("/api/agents/threads?view=unassigned"))).not.toContain(a.threadId);
    expect(ids(await owner.get("/api/agents/threads?view=all"))).toContain(a.threadId);
    await owner.post(`/api/threads/${a.threadId}/assign`, { userId: kiranId });
    expect(ids(await owner.get(`/api/agents/threads?view=waiting&assignee=${kiranId}`))).toEqual([a.threadId]);
    expect(ids(await owner.get(`/api/agents/threads?view=waiting&assignee=${ownerId}`))).toEqual([]);
    expect(ids(await kiran.get("/api/agents/threads?view=mine"))).toEqual([]);
    // The customer writes back: both are open again, done_at cleared, assignee kept.
    await inbound({ replyTo: a.id, subject: "Re: Waiting one" });
    await inbound({ replyTo: b.id, subject: "Re: Done one" });
    expect(await stateOf(a.threadId)).toMatchObject({ status: "open", assigneeUserId: kiranId });
    expect(await stateOf(b.threadId)).toMatchObject({ status: "open", doneAt: null });
    expect(ids(await owner.get("/api/agents/threads?view=waiting"))).toEqual([]);
    expect(ids(await kiran.get("/api/agents/threads?view=mine"))).toEqual([a.threadId]);
  });

  it("writes nothing when nothing changes, and lists carry lastInboundAt", async () => {
    const t = await inbound();
    expect(await reopenOnInbound(ctx.deps, orgId, t.threadId)).toBe(false); // no row
    await owner.post(`/api/threads/${t.threadId}/assign`, { userId: ownerId });
    const before = (await stateOf(t.threadId))!.updatedAt;
    expect(await reopenOnInbound(ctx.deps, orgId, t.threadId)).toBe(false); // open already
    expect((await stateOf(t.threadId))!.updatedAt).toEqual(before);
    await owner.post(`/api/threads/${t.threadId}/status`, { status: "waiting" });
    expect(await reopenOnInbound(ctx.deps, orgId, t.threadId)).toBe(true);
    const row = (await owner.get("/api/agents/threads")).body.data.find((x: { id: string }) => x.id === t.threadId);
    expect(row.status).toBe("open");
    expect(typeof row.lastInboundAt).toBe("string");
  });

  it("permissions: a member can't set waiting on a thread they can't open, nor another workspace's", async () => {
    const t = await inbound({ to: "sales@acme.io" });
    expect((await kiran.post(`/api/threads/${t.threadId}/status`, { status: "waiting" })).status).toBe(404);
    expect(ids(await kiran.get("/api/agents/threads?view=all"))).not.toContain(t.threadId);
    const other = new Client(ctx.app);
    await other.signup("zed@other.io", "Zed Other");
    expect((await other.post(`/api/threads/${t.threadId}/status`, { status: "waiting" })).status).toBe(404);
    expect((await owner.post(`/api/threads/${t.threadId}/status`, { status: "later" })).status).toBe(422);
  });

  it("REST and MCP accept waiting; read only keys can't set it", async () => {
    const t = await inbound();
    const key = (await owner.post("/api/developer/keys", { name: "Ops" })).body.secret;
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    expect((await api(ro, "POST", `/threads/${t.threadId}/status`, { status: "waiting" })).status).toBe(403);
    expect((await api(key, "POST", `/threads/${t.threadId}/status`, { status: "waiting" })).body.state.status).toBe("waiting");
    expect((await api(ro, "GET", "/threads?view=waiting")).body.data.map((x: { id: string }) => x.id)).toEqual([t.threadId]);
    const mcp = await mcpFor(key);
    expect(data(await mcp.callTool({ name: "set_thread_status", arguments: { threadId: t.threadId, status: "open" } })).state.status).toBe("open");
    expect(data(await mcp.callTool({ name: "set_thread_status", arguments: { threadId: t.threadId, status: "waiting" } })).state.status).toBe("waiting");
    const r = await mcpFor(ro);
    expect(data(await r.callTool({ name: "list_threads_by_view", arguments: { view: "waiting" } })).data.map((x: { id: string }) => x.id)).toEqual([t.threadId]);
    expect((await r.callTool({ name: "set_thread_status", arguments: { threadId: t.threadId, status: "done" } })).isError).toBe(true);
  });

  it("reply stats still resolve on done only", async () => {
    const t = await inbound();
    await owner.post(`/api/threads/${t.threadId}/status`, { status: "waiting" });
    const s = (await owner.get("/api/threads/stats/replies")).body;
    expect(s.total.resolved).toBe(0);
    await owner.post(`/api/threads/${t.threadId}/status`, { status: "done" });
    expect((await owner.get("/api/threads/stats/replies")).body.total.resolved).toBe(1);
  });
});
