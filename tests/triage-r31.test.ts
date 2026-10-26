import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { presetTime, zoneOffsetMinutes, validZone, DEFAULT_SNOOZE_ZONE } from "@/server/services/suite/notify-triage";
import { digestText, DECISION_RE } from "@/server/services/suite/catchup";

/** R31: notification triage (Inbox / Later / Done, snooze, bulk done) and catch-up digests, app + v1 + MCP. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
const T0 = new Date("2026-10-26T00:00:00.000Z").getTime(); // 10 am in Brisbane, 11 am in Sydney

async function setup() {
  ctx = await makeTestApp();
  clock = T0;
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
}
async function teammate(email = "mate@acme.io", name = "Sam Mate", role: "member" | "admin" = "member") {
  const invite = await c.post("/api/team/invites", { email, role });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const me = (await m.get("/api/account/me")).body;
  return { client: m, id: me.user.id as string };
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
const general = async (cl: Client = c) => ((await cl.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
const raw = (q: string) => (ctx.db as unknown as { $client: { prepare: (q: string) => { run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } } }).$client.prepare(q);

/** Three notifications for Sam: two assignments and a mention. */
async function seed(role: "member" | "admin" = "member") {
  const mate = await teammate("mate@acme.io", "Sam Mate", role);
  const p = (await c.post("/api/projects", { name: "Ops" })).body.project;
  const t1 = (await c.post("/api/tasks", { title: "Check BAS", projectId: p.id, assigneeId: `member:${mate.id}` })).body.task;
  await c.post("/api/tasks", { title: "Pay super", projectId: p.id, assigneeId: `member:${mate.id}` });
  await c.post(`/api/tasks/${t1.id}/comments`, { body: "@Sam please look today" });
  const list = (await mate.client.get("/api/notifications")).body;
  expect(list.notifications).toHaveLength(3);
  return { mate, p, t1, list };
}

describe("snooze presets", () => {
  it("uses the person's zone, or UTC+10", () => {
    expect(validZone(null)).toBe(DEFAULT_SNOOZE_ZONE);
    expect(validZone("Not/AZone")).toBe(DEFAULT_SNOOZE_ZONE);
    expect(zoneOffsetMinutes("Australia/Brisbane", new Date(T0))).toBe(600);
    expect(zoneOffsetMinutes("Australia/Sydney", new Date(T0))).toBe(660);
    const now = new Date(T0); // Monday 10:00 Brisbane
    expect(presetTime("later_today", now, "Australia/Brisbane").toISOString()).toBe("2026-10-26T08:00:00.000Z"); // 6 pm
    expect(presetTime("tomorrow", now, "Australia/Brisbane").toISOString()).toBe("2026-10-26T23:00:00.000Z"); // Tue 9 am
    expect(presetTime("next_week", now, "Australia/Brisbane").toISOString()).toBe("2026-11-01T23:00:00.000Z"); // next Mon 9 am
    expect(presetTime("tomorrow", now, "Australia/Sydney").toISOString()).toBe("2026-10-26T22:00:00.000Z");
    const late = new Date("2026-10-26T06:30:00.000Z"); // 4:30 pm Brisbane: three hours on
    expect(presetTime("later_today", late, "Australia/Brisbane").getTime()).toBe(late.getTime() + 3 * 3600_000);
  });
});

describe("notification triage (app)", () => {
  beforeEach(setup);

  it("keeps the old list shape and adds doneAt, snoozedUntil and viewCounts", async () => {
    const { list } = await seed();
    expect(list.view).toBe("inbox");
    expect(list.viewCounts).toEqual({ inbox: 3, later: 0, done: 0 });
    expect(list.notifications[0]).toMatchObject({ doneAt: null, snoozedUntil: null, read: false });
    expect(list.unread).toBe(3);
    expect(list.counts.assignment).toBe(2);
  });

  it("done moves to Done (read), undone brings it back; the badge counts the Inbox only", async () => {
    const { mate, list } = await seed();
    const id = list.notifications[0].id;
    const d = await mate.client.post(`/api/notifications/${id}/done`, {});
    expect(d.status).toBe(200);
    expect(d.body.notification).toMatchObject({ id, read: true });
    expect(d.body.notification.doneAt).toBeTruthy();
    const inbox = (await mate.client.get("/api/notifications")).body;
    expect(inbox.notifications.map((n: { id: string }) => n.id)).not.toContain(id);
    expect(inbox.viewCounts).toEqual({ inbox: 2, later: 0, done: 1 });
    expect(inbox.unread).toBe(2);
    const done = (await mate.client.get("/api/notifications?view=done")).body;
    expect(done.notifications.map((n: { id: string }) => n.id)).toEqual([id]);
    expect((await mate.client.post(`/api/notifications/${id}/done`, {})).body.notification.doneAt).toBe(d.body.notification.doneAt);
    expect((await mate.client.post(`/api/notifications/${id}/undone`, {})).body.notification.doneAt).toBeNull();
    expect((await mate.client.get("/api/notifications")).body.viewCounts).toEqual({ inbox: 3, later: 0, done: 0 });
    expect((await mate.client.get("/api/notifications?view=nope")).status).toBe(422);
  });

  it("snooze moves to Later, then back to the top of the Inbox, unread, when the time passes", async () => {
    const { mate, list } = await seed();
    const oldest = list.notifications[2].id;
    await mate.client.post("/api/notifications/read", { ids: [oldest] });
    const s = await mate.client.post(`/api/notifications/${oldest}/snooze`, { preset: "tomorrow" });
    expect(s.status).toBe(200);
    expect(s.body.until).toBe("2026-10-26T23:00:00.000Z"); // no zone on Sam: UTC+10
    expect(s.body.notification).toMatchObject({ read: false, snoozedUntil: "2026-10-26T23:00:00.000Z" });
    let inbox = (await mate.client.get("/api/notifications")).body;
    expect(inbox.viewCounts).toEqual({ inbox: 2, later: 1, done: 0 });
    expect(inbox.unread).toBe(2);
    const later = (await mate.client.get("/api/notifications?view=later")).body;
    expect(later.notifications.map((n: { id: string }) => n.id)).toEqual([oldest]);
    clock = new Date("2026-10-27T00:00:00.000Z").getTime();
    inbox = (await mate.client.get("/api/notifications")).body;
    expect(inbox.notifications[0]).toMatchObject({ id: oldest, read: false, snoozedUntil: null });
    expect(inbox.viewCounts).toEqual({ inbox: 3, later: 0, done: 0 });
    expect(inbox.unread).toBe(3);
  });

  it("validates snooze times and uses the person's zone for presets", async () => {
    const { mate, list } = await seed();
    const id = list.notifications[0].id;
    expect((await mate.client.post(`/api/notifications/${id}/snooze`, { until: "2026-10-25T00:00:00.000Z" })).status).toBe(422);
    expect((await mate.client.post(`/api/notifications/${id}/snooze`, { until: "2027-03-01T00:00:00.000Z" })).status).toBe(422);
    expect((await mate.client.post(`/api/notifications/${id}/snooze`, { until: "soon" })).status).toBe(422);
    expect((await mate.client.post(`/api/notifications/${id}/snooze`, {})).status).toBe(422);
    expect((await mate.client.post(`/api/notifications/${id}/snooze`, { preset: "someday" })).status).toBe(422);
    const ok = await mate.client.post(`/api/notifications/${id}/snooze`, { until: "2026-10-28T09:00:00.000Z" });
    expect(ok.body.until).toBe("2026-10-28T09:00:00.000Z");
    raw("update users set timezone = 'Australia/Sydney' where id = ?").run(mate.id);
    expect((await mate.client.post(`/api/notifications/${id}/snooze`, { preset: "tomorrow" })).body.until).toBe("2026-10-26T22:00:00.000Z");
  });

  it("bulk done takes 150 ids in chunks under the D1 variable limit and skips other people's", async () => {
    const { mate, list } = await seed();
    const ownerItem = raw("select id from notifications where user_id != ? limit 1").all(mate.id) as { id: string }[];
    const ids = [...list.notifications.map((n: { id: string }) => n.id), ...Array.from({ length: 150 }, (_, i) => `ntf_missing_${i}`), ...ownerItem.map((r) => r.id)];
    const r = await mate.client.post("/api/notifications/done", { ids });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(3);
    expect((await mate.client.get("/api/notifications")).body.viewCounts).toEqual({ inbox: 0, later: 0, done: 3 });
    expect((await mate.client.post("/api/notifications/done", { ids: [] })).status).toBe(422);
  });

  it("nobody triages another person's notification", async () => {
    const { list } = await seed();
    const id = list.notifications[0].id;
    expect((await c.post(`/api/notifications/${id}/done`, {})).status).toBe(404);
    expect((await c.post(`/api/notifications/${id}/snooze`, { preset: "tomorrow" })).status).toBe(404);
    expect((await c.post(`/api/notifications/${id}/undone`, {})).status).toBe(404);
  });
});

describe("notification triage (v1 + MCP)", () => {
  beforeEach(setup);

  it("v1 lists by view and marks done, undone and snoozed; read keys are refused writes", async () => {
    const { mate, list } = await seed("admin");
    const made = await mate.client.post("/api/developer/keys", { name: "sam" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const key = made.body.secret as string;
    const readKey = (await mate.client.post("/api/developer/keys", { name: "reader", scope: "read" })).body.secret as string;
    const l = await api(key, "GET", "/notifications?view=inbox");
    expect(l.status).toBe(200);
    expect(l.body.viewCounts).toEqual({ inbox: 3, later: 0, done: 0 });
    const id = list.notifications[0].id;
    expect((await api(key, "POST", `/notifications/${id}/done`)).body.notification.doneAt).toBeTruthy();
    expect((await api(key, "POST", `/notifications/${id}/undone`)).body.notification.doneAt).toBeNull();
    expect((await api(key, "POST", `/notifications/${id}/snooze`, { preset: "next_week" })).body.until).toBe("2026-11-01T23:00:00.000Z");
    expect((await api(key, "GET", "/notifications?view=later")).body.notifications).toHaveLength(1);
    expect((await api(key, "POST", "/notifications/done", { ids: [list.notifications[1].id] })).body.updated).toBe(1);
    expect((await api(readKey, "GET", "/notifications")).status).toBe(200);
    expect((await api(readKey, "POST", `/notifications/${id}/done`)).status).toBe(403);
    expect((await api(key, "GET", "/notifications?view=bad")).status).toBe(422);
  });

  it("MCP notification_list, notification_done, notification_snooze, notification_undone", async () => {
    const { mate, list } = await seed("admin");
    const key = (await mate.client.post("/api/developer/keys", { name: "sam" })).body.secret as string;
    const mcp = await mcpFor(key);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    for (const n of ["notification_list", "notification_done", "notification_snooze", "notification_undone", "catchup_get"]) expect(names).toContain(n);
    const id = list.notifications[0].id;
    expect(data(await mcp.callTool({ name: "notification_list", arguments: { view: "inbox" } })).viewCounts).toEqual({ inbox: 3, later: 0, done: 0 });
    expect(data(await mcp.callTool({ name: "notification_done", arguments: { id } })).notification.doneAt).toBeTruthy();
    expect(data(await mcp.callTool({ name: "notification_undone", arguments: { id } })).notification.doneAt).toBeNull();
    expect(data(await mcp.callTool({ name: "notification_snooze", arguments: { id, preset: "tomorrow" } })).until).toBe("2026-10-26T23:00:00.000Z");
    expect(data(await mcp.callTool({ name: "notification_done", arguments: { ids: [list.notifications[1].id, list.notifications[2].id] } })).updated).toBe(2);
    expect(data(await mcp.callTool({ name: "notification_list", arguments: { view: "done" } })).notifications).toHaveLength(2);
  });
});

describe("catch-up", () => {
  beforeEach(setup);

  it("digest helpers", () => {
    expect(DECISION_RE.test("We agreed to ship Friday")).toBe(true);
    expect(DECISION_RE.test("Just checking in")).toBe(false);
    expect(digestText({ type: "channel", id: "x", since: null, hasNew: true, mode: "digest", counts: { messages: 1, replies: 0, comments: 0, edits: 0, statusChanges: 0, assigneeChanges: 0, mentions: 1 }, actors: [{ name: "Sam", count: 1 }], decisions: [], latest: [], canSummarise: false }))
      .toContain("1 new message, 1 mention of you");
  });

  it("a channel: first visit records the time; then new messages from others, mentions and decisions show; my own don't", async () => {
    const mate = await teammate();
    const g = await general();
    const first = (await c.get(`/api/catchup?type=channel&id=${g.id}&visit=1`)).body.catchup;
    expect(first.hasNew).toBe(false);
    expect(first.mode).toBe("digest");
    await c.post(`/api/chat/channels/${g.id}/messages`, { body: "My own note" });
    await mate.client.post(`/api/chat/channels/${g.id}/messages`, { body: `We decided to move launch to Friday <@member:${(await c.get("/api/account/me")).body.user.id}>` });
    await mate.client.post(`/api/chat/channels/${g.id}/messages`, { body: "Also the logo is in" });
    const d = (await c.get(`/api/catchup?type=channel&id=${g.id}&visit=1`)).body.catchup;
    expect(d.hasNew).toBe(true);
    expect(d.counts).toMatchObject({ messages: 2, mentions: 1 });
    expect(d.actors).toEqual([{ name: "Sam Mate", count: 2 }]);
    expect(d.decisions[0].text).toContain("We decided to move launch to Friday @Olive Owner");
    expect(d.latest[0].text).toBe("Also the logo is in");
    expect(d.canSummarise).toBe(false);
    // Within a minute the visit is not rewritten, so the digest still counts from the first visit.
    expect((await c.get(`/api/catchup?type=channel&id=${g.id}`)).body.catchup.counts.messages).toBe(2);
    // Mark as caught up: nothing new.
    expect((await c.post("/api/catchup/visit", { type: "channel", id: g.id })).body.written).toBe(true);
    expect((await c.get(`/api/catchup?type=channel&id=${g.id}`)).body.catchup.hasNew).toBe(false);
  });

  it("visits write at most once a minute per item", async () => {
    const g = await general();
    expect((await c.post("/api/catchup/visit", { type: "channel", id: g.id, force: false })).body.written).toBe(true);
    expect((await c.post("/api/catchup/visit", { type: "channel", id: g.id, force: false })).body.written).toBe(false);
    clock += 61_000;
    expect((await c.post("/api/catchup/visit", { type: "channel", id: g.id, force: false })).body.written).toBe(true);
    const rows = raw("select count(*) as n from item_visits").all() as { n: number }[];
    expect(rows[0].n).toBe(1);
  });

  it("a task: comments, status and assignee changes by others, with decisions", async () => {
    const mate = await teammate();
    const p = (await c.post("/api/projects", { name: "Ops" })).body.project;
    const t = (await c.post("/api/tasks", { title: "Quote", projectId: p.id })).body.task;
    await c.post("/api/catchup/visit", { type: "task", id: t.id });
    await mate.client.post(`/api/tasks/${t.id}/comments`, { body: "Client approved the quote" });
    await mate.client.patch(`/api/tasks/${t.id}`, { status: "done" });
    await mate.client.patch(`/api/tasks/${t.id}`, { assigneeId: `member:${mate.id}` });
    await c.post(`/api/tasks/${t.id}/comments`, { body: "Mine, not counted" });
    const d = (await c.get(`/api/catchup?type=task&id=${t.ref}`)).body.catchup;
    expect(d.id).toBe(t.id);
    expect(d.counts).toMatchObject({ comments: 1, statusChanges: 1, assigneeChanges: 1 });
    expect(d.actors[0]).toEqual({ name: "Sam Mate", count: 3 });
    expect(d.decisions.map((x: { kind: string }) => x.kind).sort()).toEqual(["assignee", "comment", "status"]);
    expect(d.latest.map((x: { text: string }) => x.text)).toEqual(["Client approved the quote"]);
  });

  it("a doc: edits by others; 404 for an unknown item; agent keys refused; no AI key means 409 on summary", async () => {
    const mate = await teammate();
    const doc = (await c.post("/api/docs", { title: "Plan" })).body.doc;
    await c.post("/api/catchup/visit", { type: "doc", id: doc.id });
    await mate.client.patch(`/api/docs/${doc.id}`, { title: "Plan v2" });
    const d = (await c.get(`/api/catchup?type=doc&id=${doc.id}`)).body.catchup;
    expect(d.counts.edits).toBe(1);
    expect(d.actors).toEqual([{ name: "Sam Mate", count: 1 }]);
    expect((await c.get("/api/catchup?type=doc&id=doc_nope")).status).toBe(404);
    expect((await c.get("/api/catchup?type=thing&id=x")).status).toBe(422);
    const s = await c.post("/api/catchup/summary", { type: "doc", id: doc.id });
    expect(s.status).toBe(409);
    expect(s.body.error.code).toBe("ai_key_required");
  });

  it("v1 GET /catchup and MCP catchup_get", async () => {
    const mate = await teammate();
    const g = await general();
    const key = (await c.post("/api/developer/keys", { name: "olive" })).body.secret as string;
    expect((await api(key, "POST", "/catchup/visit", { type: "channel", id: g.id })).body.written).toBe(true);
    await mate.client.post(`/api/chat/channels/${g.id}/messages`, { body: "Hello" });
    const r = await api(key, "GET", `/catchup?type=channel&id=${g.id}`);
    expect(r.status).toBe(200);
    expect(r.body.catchup.counts.messages).toBe(1);
    expect((await api(key, "GET", "/catchup?type=channel")).status).toBe(422);
    const mcp = await mcpFor(key);
    expect(data(await mcp.callTool({ name: "catchup_get", arguments: { type: "channel", id: g.id } })).catchup.counts.messages).toBe(1);
  });
});
