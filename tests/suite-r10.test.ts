import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { nextOccurrence, normaliseRule, describeRule } from "@/server/services/suite/recurrence";
import { parseMarkup, plainText } from "@/server/services/suite/chat";
import { numberProgress, suggestHealth } from "@/server/services/suite/goals";
import { categoryOf } from "@/server/services/suite/notify";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = new Date("2026-10-20T00:00:00.000Z").getTime();

async function setup() {
  ctx = await makeTestApp();
  clock = new Date("2026-10-20T00:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
}
async function teammate(email = "mate@acme.io", name = "Sam Mate") {
  const invite = await c.post("/api/team/invites", { email, role: "member" });
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

describe("chat markup", () => {
  it("parses mentions and links and renders plain text", () => {
    const p = parseMarkup("hi <@member:usr_1> and <@agent:agt_2>, see <#task:tsk_9> <!channel>");
    expect(p.mentions).toEqual([{ type: "member", id: "usr_1" }, { type: "agent", id: "agt_2" }]);
    expect(p.links).toEqual([{ type: "task", id: "tsk_9" }]);
    expect(p.everyone).toBe(true);
    expect(plainText("hi <@member:usr_1> see <#task:tsk_9>", [{ type: "member", id: "usr_1", name: "Sam" }], [{ type: "task", id: "tsk_9", ref: "OPS-1", title: "x" }])).toBe("hi @Sam see OPS-1");
  });
});

describe("team chat", () => {
  beforeEach(setup);

  it("makes #general, posts with a mention, notifies, counts unread and marks read", async () => {
    const mate = await teammate();
    const g = await general();
    expect(g).toBeTruthy();
    // Sam joins by reading the channel; Olive mentions Sam.
    expect((await mate.client.post(`/api/chat/channels/${g.id}/read`, {})).status).toBe(200);
    const post = await c.post(`/api/chat/channels/${g.id}/messages`, { body: `Morning <@member:${mate.id}>, can you check the quote?` });
    expect(post.status).toBe(201);
    expect(post.body.message.mentions).toEqual([{ type: "member", id: mate.id, name: "Sam Mate" }]);
    const unread = (await mate.client.get("/api/chat/unread")).body;
    expect(unread).toMatchObject({ total: 1, mentions: 1 });
    expect(unread.channels[g.id]).toEqual({ unread: 1, mentions: 1 });
    const inbox = (await mate.client.get("/api/notifications?category=mention")).body;
    expect(inbox.notifications[0]).toMatchObject({ type: "chat.mention", category: "mention", entityType: "chat_message", entityId: post.body.message.id, read: false });
    expect(inbox.notifications[0].link).toBe(`/app/chat/${g.id}?m=${post.body.message.id}`);
    expect(inbox.counts.mention).toBe(1);
    // Push routing: a message id gives its channel.
    expect((await mate.client.get(`/api/chat/messages/${post.body.message.id}`)).body.channel.id).toBe(g.id);
    await mate.client.post(`/api/chat/channels/${g.id}/read`, {});
    expect((await mate.client.get("/api/chat/unread")).body.total).toBe(0);
    // The author's own message never counts as unread for them.
    expect((await c.get("/api/chat/unread")).body.total).toBe(0);
  });

  it("threads, edits, deletes, attachments and polling with since", async () => {
    const mate = await teammate();
    const g = await general();
    const root = (await mate.client.post(`/api/chat/channels/${g.id}/messages`, { body: "Who has the Harbour logo?" })).body.message;
    const since = new Date(clock).toISOString();
    const reply = await c.post(`/api/chat/channels/${g.id}/messages`, { body: "Here it is", parentId: root.id, attachments: [{ filename: "logo.svg", contentType: "image/svg+xml", contentBase64: Buffer.from("<svg/>").toString("base64") }] });
    expect(reply.status).toBe(201);
    expect(reply.body.message.attachments[0]).toMatchObject({ filename: "logo.svg", size: 6 });
    const thread = (await c.get(`/api/chat/messages/${root.id}/thread`)).body;
    expect(thread.message.replyCount).toBe(1);
    expect(thread.replies.map((r: { body: string }) => r.body)).toEqual(["Here it is"]);
    // Polling picks up the parent whose reply count changed; replies stay out of the channel list.
    const polled = (await mate.client.get(`/api/chat/channels/${g.id}/messages?since=${encodeURIComponent(since)}`)).body.messages;
    expect(polled.map((m: { id: string }) => m.id)).toEqual([root.id]);
    expect((await mate.client.get("/api/notifications")).body.notifications[0].type).toBe("chat.reply");
    const dl = await ctx.app.request(`/api/chat/files/${reply.body.message.attachments[0].id}`, { headers: { cookie: mate.client.cookie, host: "localhost" } });
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(await dl.text()).toBe("<svg/>");
    // The signed link works with no session (phones open files in the system browser), and only unaltered.
    const url = reply.body.message.attachments[0].url as string;
    expect(url).toMatch(/^\/api\/chat\/files\/[^/]+\/download\?exp=\d+&sig=[a-f0-9]{64}$/);
    const signed = await ctx.app.request(url, { headers: { host: "localhost" } });
    expect(signed.status).toBe(200);
    expect(await signed.text()).toBe("<svg/>");
    expect((await ctx.app.request(url.replace(/sig=([a-f0-9]+)/, (_m, h: string) => `sig=${[...h].reverse().join("")}`), { headers: { host: "localhost" } })).status).toBe(404);
    expect((await ctx.app.request(url.replace(/exp=\d+/, "exp=1"), { headers: { host: "localhost" } })).status).toBe(404);
    // Only the author edits; an owner may delete.
    expect((await c.patch(`/api/chat/messages/${root.id}`, { body: "changed" })).status).toBe(403);
    expect((await mate.client.patch(`/api/chat/messages/${root.id}`, { body: "Who has the new logo?" })).body.message.editedAt).toBeTruthy();
    expect((await mate.client.del(`/api/chat/messages/${reply.body.message.id}`)).status).toBe(403);
    expect((await c.del(`/api/chat/messages/${reply.body.message.id}`)).status).toBe(200);
    const after = (await c.get(`/api/chat/messages/${root.id}/thread`)).body.replies[0];
    expect(after).toMatchObject({ deleted: true, body: "", attachments: [] });
  });

  it("keeps DMs and private channels to their members, and API keys to public channels", async () => {
    const mate = await teammate();
    const other = await teammate("third@acme.io", "Tia Third");
    const dm = await c.post("/api/chat/dms", { userIds: [mate.id] });
    expect(dm.status).toBe(201);
    expect(dm.body.channel).toMatchObject({ kind: "dm", name: "Sam Mate" });
    expect((await c.post("/api/chat/dms", { userIds: [mate.id] })).status).toBe(200);
    await c.post(`/api/chat/channels/${dm.body.channel.id}/messages`, { body: "Lunch?" });
    expect((await mate.client.get("/api/notifications?category=chat")).body.notifications[0].type).toBe("chat.dm");
    expect((await other.client.get(`/api/chat/channels/${dm.body.channel.id}/messages`)).status).toBe(404);
    const priv = (await c.post("/api/chat/channels", { name: "Leadership", private: true, memberIds: [mate.id] })).body.channel;
    expect(priv).toMatchObject({ name: "leadership", private: true });
    expect(((await other.client.get("/api/chat/channels")).body.channels as { id: string }[]).some((x) => x.id === priv.id)).toBe(false);
    expect((await mate.client.get(`/api/chat/channels/${priv.id}`)).status).toBe(200);
    expect((await c.post("/api/chat/channels", { name: "leadership" })).status).toBe(409);
    const key = (await c.post("/api/developer/keys", { name: "Chat bot" })).body.secret;
    const list = await api(key, "GET", "/chat/channels");
    expect(list.status).toBe(200);
    expect(list.body.channels.map((x: { name: string }) => x.name)).toEqual(["general"]);
    expect((await api(key, "GET", `/chat/channels/${dm.body.channel.id}/messages`)).status).toBe(404);
    expect((await api(key, "GET", `/chat/channels/${priv.id}/messages`)).status).toBe(404);
  });

  it("turns a message into a task and links tasks and threads", async () => {
    const g = await general();
    const p = (await c.post("/api/projects", { name: "Ops" })).body.project;
    const t = (await c.post("/api/tasks", { title: "Quote for Harbour", projectId: p.id })).body.task;
    const m = (await c.post(`/api/chat/channels/${g.id}/messages`, { body: `Status of <#task:${t.id}>? Also send the invoice` })).body.message;
    expect(m.links).toEqual([{ type: "task", id: t.id, ref: t.ref, title: "Quote for Harbour" }]);
    const made = await c.post(`/api/chat/messages/${m.id}/task`, { projectId: p.id, title: "Send the invoice" });
    expect(made.status).toBe(201);
    expect(made.body.task.title).toBe("Send the invoice");
    expect(made.body.task.notes).toContain("From Olive Owner in #general.");
    const again = (await c.get(`/api/chat/messages/${m.id}`)).body.message;
    expect(again.links.map((l: { ref: string }) => l.ref)).toEqual([t.ref, made.body.task.ref]);
  });

  it("lets guests see only channels shared with their project", async () => {
    const p = (await c.post("/api/projects", { name: "Harbour site" })).body.project;
    const shared = (await c.post("/api/chat/channels", { name: "harbour-client", projectId: p.id, guestAccess: true })).body.channel;
    const internal = (await c.post("/api/chat/channels", { name: "harbour-internal", projectId: p.id })).body.channel;
    expect((await c.patch(`/api/chat/channels/${internal.id}`, { guestAccess: false })).status).toBe(200);
    await c.post(`/api/chat/channels/${shared.id}/messages`, { body: "Welcome Mia" });
    await c.post(`/api/chat/channels/${internal.id}/messages`, { body: "Budget is tight" });
    await c.post("/api/guests", { projectId: p.id, email: "mia@harbour.coffee", name: "Mia" });
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const token = sent.map((x) => x.text).reverse().find((x) => x.includes("/g/"))?.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1];
    const g = new Client(ctx.app);
    expect((await g.get("/api/guest/chat/channels")).status).toBe(401);
    expect((await g.post("/api/guest/accept", { token })).status).toBe(200);
    const list = (await g.get("/api/guest/chat/channels")).body.channels;
    expect(list.map((x: { name: string }) => x.name)).toEqual(["harbour-client"]);
    expect(JSON.stringify(list)).not.toContain("members");
    expect((await g.get(`/api/guest/chat/channels/${internal.id}/messages`)).status).toBe(404);
    const msgs = (await g.get(`/api/guest/chat/channels/${shared.id}/messages`)).body.messages;
    expect(msgs.map((x: { body: string }) => x.body)).toEqual(["Welcome Mia"]);
    const posted = await g.post(`/api/guest/chat/channels/${shared.id}/messages`, { body: "Thanks! <!channel> <#task:x>" });
    expect(posted.status).toBe(201);
    expect(posted.body.message).toMatchObject({ author: { type: "guest", name: "Mia (guest)" }, body: "Thanks! @channel", mentions: [], links: [] });
    // The guest session opens nothing else in chat.
    expect((await g.get("/api/chat/channels")).status).toBe(401);
  });
});

describe("notifications inbox", () => {
  beforeEach(setup);

  it("maps types to categories", () => {
    expect(categoryOf("task.assigned")).toBe("assignment");
    expect(categoryOf("approval.requested")).toBe("approval");
    expect(categoryOf("something.new")).toBe("status");
  });

  it("filters, marks read by category and id, and honours settings", async () => {
    const mate = await teammate();
    const p = (await c.post("/api/projects", { name: "Ops" })).body.project;
    const t = (await c.post("/api/tasks", { title: "Check BAS", projectId: p.id, assigneeId: `member:${mate.id}` })).body.task;
    await c.post(`/api/tasks/${t.id}/comments`, { body: "@Sam please look today" });
    const all = (await mate.client.get("/api/notifications")).body;
    expect(all.notifications.map((n: { type: string }) => n.type)).toEqual(["task.mentioned", "task.assigned"]);
    expect(all.unread).toBe(2);
    expect(all.notifications[1].actor.name).toBe("Olive Owner");
    expect((await mate.client.get("/api/notifications?category=assignment")).body.notifications).toHaveLength(1);
    expect((await mate.client.get("/api/notifications?category=nope")).status).toBe(422);
    expect((await mate.client.post("/api/notifications/read", { category: "mention" })).body.updated).toBe(1);
    expect((await mate.client.get("/api/notifications?unread=1")).body.notifications.map((n: { type: string }) => n.type)).toEqual(["task.assigned"]);
    const id = all.notifications[1].id;
    await mate.client.post("/api/notifications/read", { ids: [id] });
    expect((await mate.client.post(`/api/notifications/${id}/unread`, {})).status).toBe(200);
    expect((await mate.client.post("/api/notifications/read", {})).body.updated).toBe(1);
    // Settings: turning assignments off keeps them out of the inbox.
    const s = (await mate.client.get("/api/notifications/settings")).body.settings;
    expect(s.assignment).toMatchObject({ inApp: true, push: true }); // R97 adds a mail field
    const put = await mate.client.put("/api/notifications/settings", { settings: { assignment: { inApp: false, push: false } } });
    expect(put.body.settings.assignment).toMatchObject({ inApp: false, push: false });
    await c.post("/api/tasks", { title: "Another", projectId: p.id, assigneeId: `member:${mate.id}` });
    expect((await mate.client.get("/api/notifications?unread=1")).body.unread).toBe(0);
    expect((await mate.client.put("/api/notifications/settings", { settings: { bogus: { push: true } } })).status).toBe(422);
    // Nobody reads another person's inbox.
    expect((await c.get("/api/notifications")).body.notifications.every((n: { title: string }) => !n.title.includes("assigned to you"))).toBe(true);
  });
});

describe("repeating tasks", () => {
  beforeEach(setup);

  it("works out the next date for each rule", () => {
    const d = new Date("2026-10-20T09:00:00.000Z"); // a Tuesday
    expect(nextOccurrence({ freq: "daily", interval: 2 }, d)!.toISOString()).toBe("2026-10-22T09:00:00.000Z");
    expect(nextOccurrence({ freq: "weekly", weekdays: [1, 4] }, d)!.toISOString()).toBe("2026-10-22T09:00:00.000Z");
    expect(nextOccurrence({ freq: "weekly", weekdays: [1] }, d)!.toISOString()).toBe("2026-10-26T09:00:00.000Z");
    expect(nextOccurrence({ freq: "weekly", interval: 2, weekdays: [1] }, d)!.toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(nextOccurrence({ freq: "monthly", monthDay: 31 }, new Date("2027-01-31T00:00:00.000Z"))!.toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(nextOccurrence({ freq: "yearly" }, d)!.toISOString()).toBe("2027-10-20T09:00:00.000Z");
    expect(nextOccurrence({ freq: "daily", until: "2026-10-20" }, d)).toBeNull();
    expect(describeRule({ freq: "weekly", interval: 2, weekdays: [1, 3] })).toBe("Every 2 weeks on Mon, Wed");
    expect(() => normaliseRule({ freq: "hourly" })).toThrow();
  });

  it("makes the next task when a repeating one is done", async () => {
    const p = (await c.post("/api/projects", { name: "Admin" })).body.project;
    const t = (await c.post("/api/tasks", { title: "Pay super", projectId: p.id, due: "2026-10-28", repeat: { freq: "monthly", monthDay: 28 } })).body.task;
    expect(t.repeat).toMatchObject({ freq: "monthly", monthDay: 28, text: "Every month on day 28" });
    await c.post("/api/tasks", { title: "Check payslips", parentId: t.id });
    const done = await c.patch(`/api/tasks/${t.id}`, { status: "done" });
    expect(done.body.task.repeat).toBeNull();
    const list = (await c.get(`/api/tasks?projectId=${p.id}`)).body.tasks as { id: string; title: string; due: string; status: string; repeat: unknown; subtasks: { total: number } }[];
    const next = list.find((x) => x.id !== t.id && x.title === "Pay super")!;
    expect(next).toMatchObject({ status: "todo", due: "2026-11-28T00:00:00.000Z" });
    expect(next.repeat).toMatchObject({ freq: "monthly" });
    expect(next.subtasks.total).toBe(1);
    // Reopening and finishing the old one again does not make a second copy.
    await c.patch(`/api/tasks/${t.id}`, { status: "todo" });
    await c.patch(`/api/tasks/${t.id}`, { status: "done" });
    expect(((await c.get(`/api/tasks?projectId=${p.id}`)).body.tasks as { title: string }[]).filter((x) => x.title === "Pay super")).toHaveLength(2);
    // Stop repeating.
    expect((await c.patch(`/api/tasks/${next.id}`, { repeat: null })).body.task.repeat).toBeNull();
  });
});

describe("templates", () => {
  beforeEach(setup);

  it("lists the starter gallery and makes a project from one", async () => {
    const list = (await c.get("/api/templates")).body.templates as { id: string; name: string; builtin: boolean }[];
    expect(list.filter((t) => t.builtin).map((t) => t.name)).toEqual(["Client onboarding", "Content calendar", "Sales pipeline", "Bug tracker", "Two week sprint", "Hiring", "Product launch", "Support desk", "Meeting notes", "Project brief", "Retro board", "User flow", "Org chart"]);
    const used = await c.post("/api/templates/starter-client-onboarding/use", { name: "Onboard Harbour Coffee", startDate: "2026-11-02" });
    expect(used.status).toBe(201);
    expect(used.body.project.name).toBe("Onboard Harbour Coffee");
    expect(used.body.project.statuses.map((s: { name: string }) => s.name)).toContain("Waiting on client");
    const tasks = (await c.get(`/api/tasks?projectId=${used.body.project.id}`)).body.tasks as { title: string; due: string | null; statusName: string }[];
    expect(tasks).toHaveLength(6);
    expect(tasks.find((t) => t.title === "30 day check-in")!.due).toBe("2026-12-02T00:00:00.000Z");
    expect(tasks.find((t) => t.title.startsWith("Collect logins"))!.statusName).toBe("Waiting on client");
    expect((await c.get(`/api/fields?projectId=${used.body.project.id}`)).body.fields.map((f: { name: string }) => f.name)).toEqual(["Client", "Contract value", "Signed"]);
    const cc = await c.post("/api/templates/starter-content-calendar/use", {});
    const news = ((await c.get(`/api/tasks?projectId=${cc.body.project.id}`)).body.tasks as { title: string; repeat: unknown }[]).find((t) => t.title === "Weekly newsletter")!;
    expect(news.repeat).toMatchObject({ freq: "weekly" });
  });

  it("saves a project and a task as templates and uses them", async () => {
    const p = (await c.post("/api/projects", { name: "Event", statuses: [{ name: "Plan", category: "todo" }, { name: "Book", category: "doing" }, { name: "Done", category: "done" }] })).body.project;
    const t = (await c.post("/api/tasks", { title: "Book venue", projectId: p.id, due: "2026-11-10", priority: "high" })).body.task;
    await c.post("/api/tasks", { title: "Send invites", projectId: p.id, due: "2026-11-13" });
    await c.post("/api/tasks", { title: "Get three quotes", parentId: t.id });
    const saved = await c.post("/api/templates", { kind: "project", fromProjectId: p.id, name: "Event kit" });
    expect(saved.status).toBe(201);
    expect(saved.body.template.data.tasks.map((x: { title: string; dueInDays: number }) => [x.title, x.dueInDays])).toEqual([["Book venue", 0], ["Send invites", 3]]);
    const made = (await c.post(`/api/templates/${saved.body.template.id}/use`, { name: "Xmas party", startDate: "2026-12-01" })).body;
    const tasks = (await c.get(`/api/tasks?projectId=${made.project.id}&includeSubtasks=true`)).body.tasks as { title: string; due: string | null; priority: string }[];
    expect(tasks.find((x) => x.title === "Send invites")!.due).toBe("2026-12-04T00:00:00.000Z");
    expect(tasks.some((x) => x.title === "Get three quotes")).toBe(true);
    const tt = (await c.post("/api/templates", { kind: "task", fromTaskId: t.ref })).body.template;
    expect(tt.kind).toBe("task");
    const one = await c.post(`/api/templates/${tt.id}/use`, { projectId: p.id });
    expect(one.body.task).toMatchObject({ title: "Book venue", priority: "high" });
    expect((await c.post(`/api/templates/${tt.id}/use`, {})).status).toBe(422);
    expect((await c.del("/api/templates/starter-bug-tracker")).status).toBe(422);
    expect((await c.del(`/api/templates/${tt.id}`)).status).toBe(200);
    expect((await c.get(`/api/templates/${tt.id}`)).status).toBe(404);
  });
});

describe("goals and OKRs", () => {
  beforeEach(setup);

  it("works out progress and health", () => {
    expect(numberProgress(0, 100, 25)).toBe(0.25);
    expect(numberProgress(100, 50, 75)).toBe(0.5);
    expect(numberProgress(0, 10, 20)).toBe(1);
    expect(suggestHealth(0.5, 0.55)).toBe("on_track");
    expect(suggestHealth(0.3, 0.5)).toBe("at_risk");
    expect(suggestHealth(0.1, 0.6)).toBe("off_track");
  });

  it("rolls up key results from numbers and tasks through child goals", async () => {
    const p = (await c.post("/api/projects", { name: "Launch" })).body.project;
    const a = (await c.post("/api/tasks", { title: "Landing page", projectId: p.id })).body.task;
    const b = (await c.post("/api/tasks", { title: "Pricing", projectId: p.id })).body.task;
    const top = (await c.post("/api/goals", { name: "Grow revenue", due: "2026-12-31", keyResults: [{ name: "Monthly revenue", kind: "currency", start: 10000, target: 20000, current: 15000 }] })).body.goal;
    expect(top.keyResults[0]).toMatchObject({ unit: "AUD", progress: 50 });
    expect(top.progress).toBe(50);
    const child = (await c.post("/api/goals", { name: "Launch the new site", parentId: top.id })).body.goal;
    const kr = (await c.post(`/api/goals/${child.id}/key-results`, { name: "Launch tasks done", kind: "tasks", taskIds: [a.id, b.ref] })).body.keyResult;
    expect(kr).toMatchObject({ kind: "tasks", tasks: { total: 2, done: 0 }, progress: 0 });
    await c.patch(`/api/tasks/${a.id}`, { status: "done" });
    const tree = (await c.get("/api/goals")).body;
    expect(tree.goals).toHaveLength(1);
    expect(tree.goals[0].children[0].progress).toBe(50);
    expect(tree.goals[0].progress).toBe(50); // average of 50 (revenue) and 50 (child)
    // A countdown with no start counts from its current value (dogfood F5).
    const bugs = (await c.post(`/api/goals/${top.id}/key-results`, { name: "Open high severity bugs", kind: "number", target: 0, current: 10 })).body.keyResult;
    expect(bugs).toMatchObject({ start: 10, target: 0, current: 10, progress: 0 });
    expect((await c.patch(`/api/key-results/${bugs.id}`, { current: 4 })).body.keyResult.progress).toBe(60);
    await c.call("DELETE", `/api/key-results/${bugs.id}`);
    await c.patch(`/api/key-results/${top.keyResults[0].id}`, { current: 20000 });
    expect((await c.get(`/api/goals/${top.id}`)).body.goal.progress).toBe(75);
    // A whole project as a key result.
    const kr2 = (await c.post(`/api/goals/${child.id}/key-results`, { name: "Project done", projectId: p.id })).body.keyResult;
    expect(kr2.tasks).toEqual({ total: 2, done: 1 });
    expect(tree.summary).toMatchObject({ goals: 2, topLevel: 1 });
    expect((await c.patch(`/api/goals/${top.id}`, { parentId: child.id })).status).toBe(422);
    expect((await c.patch(`/api/goals/${top.id}`, { health: "at_risk" })).body.goal.health).toBe("at_risk");
    expect((await c.del(`/api/goals/${top.id}`)).status).toBe(200);
    expect((await c.get("/api/goals")).body.goals.map((g: { name: string }) => g.name)).toEqual(["Launch the new site"]);
  });
});

describe("agents: REST, MCP and webhooks for round 10", () => {
  beforeEach(setup);

  it("covers chat, templates, goals and notifications through the API and MCP", async () => {
    const key = (await c.post("/api/developer/keys", { name: "Ops bot" })).body.secret;
    const g = (await api(key, "GET", "/chat/channels")).body.channels[0];
    const posted = await api(key, "POST", `/chat/channels/${g.id}/messages`, { body: "Daily summary: 3 tasks due" });
    expect(posted.status).toBe(201);
    const read = await api(key, "GET", `/chat/channels/${g.id}/messages`);
    expect(read.body.messages.map((m: { body: string }) => m.body)).toContain("Daily summary: 3 tasks due");
    const task = await api(key, "POST", `/chat/messages/${posted.body.message.id}/task`, { title: "Look at due tasks" });
    expect(task.status).toBe(201);
    expect((await api(key, "GET", "/templates")).body.templates.length).toBeGreaterThanOrEqual(4);
    expect((await api(key, "POST", "/templates/starter-bug-tracker/use", {})).body.project.name).toBe("Bug tracker");
    const goal = await api(key, "POST", "/goals", { name: "Ship v2", keyResults: [{ name: "Bugs closed", kind: "number", target: 10 }] });
    expect(goal.status).toBe(201);
    expect((await api(key, "PATCH", `/key-results/${goal.body.goal.keyResults[0].id}`, { current: 5 })).body.keyResult.progress).toBe(50);
    expect((await api(key, "GET", "/goals")).body.summary.progress).toBe(50);
    const spec = (await ctx.app.request("/api/v1/openapi.json", { headers: { host: "localhost" } }));
    const paths = Object.keys(((await spec.json()) as { paths: Record<string, unknown> }).paths);
    for (const p of ["/chat/channels", "/chat/channels/{id}/messages", "/templates/{id}/use", "/goals", "/key-results/{id}"]) expect(paths).toContain(p);

    const mcp = await mcpFor(key);
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    for (const t of ["list_channels", "read_channel", "post_message", "message_to_task", "list_templates", "use_template", "set_task_repeat", "list_goals", "create_goal", "update_key_result", "list_notifications"]) expect(tools).toContain(t);
    const channels = data(await mcp.callTool({ name: "list_channels", arguments: {} }));
    const msg = data(await mcp.callTool({ name: "post_message", arguments: { channelId: channels.channels[0].id, body: "Posted over MCP" } }));
    expect(msg.message.body).toBe("Posted over MCP");
    const rep = data(await mcp.callTool({ name: "set_task_repeat", arguments: { taskId: task.body.task.id, freq: "weekly", weekdays: [1] } }));
    expect(rep.repeat.text).toBe("Every week on Mon");
    const goals = data(await mcp.callTool({ name: "list_goals", arguments: {} }));
    expect(goals.goals[0].name).toBe("Ship v2");
    await mcp.close();
  });

  it("sends chat and goal webhooks", async () => {
    const hook = (await c.post("/api/developer/webhooks", { url: "https://hooks.example.com/mm", events: ["chat.message.created", "goal.created"] })).body;
    expect(hook.events ?? hook.endpoint?.events).toBeTruthy();
    const g = await general();
    await c.post(`/api/chat/channels/${g.id}/messages`, { body: "hello hooks" });
    await c.post("/api/goals", { name: "Hook goal" });
    const { webhookDeliveries } = await import("@/server/db/schema");
    const types = (await ctx.deps.db.select({ t: webhookDeliveries.eventType }).from(webhookDeliveries)).map((r) => r.t);
    expect(types).toEqual(expect.arrayContaining(["chat.message.created", "goal.created"]));
  });
});
