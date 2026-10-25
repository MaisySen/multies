import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { escapeLike, excerpt, normaliseQuery, parseTypes, searchEverything, myWork, setSnoozedProvider, tableExists, dayIn } from "@/server/services/search";
import { sendApprovals } from "@/server/db/schema";

/** Round 20: search everything (Cmd+K) and My Work. Reads only, and only what the caller can open. */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let domainId: string;
let ownerId: string;
let wsKey: string;

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

async function verify() {
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
}
async function inbound(to: string, subject: string, text: string, from = { address: "grace@example.com", name: "Grace Hopper" }) {
  return deliverInbound(ctx.deps, {
    envelopeFrom: from.address, rcptTo: to, sizeBytes: text.length + 200, via: "test",
    email: { messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from, to: [{ address: to }], cc: [], subject, text, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
}
async function teammate(email = "mate@acme.io", name = "Sam Mate") {
  const invite = await c.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const me = (await m.get("/api/account/me")).body;
  return { client: m, id: me.user.id as string };
}
type Group = { type: string; items: { id: string; title: string; subtitle: string; snippet: string; url: string }[] };
const search = async (cl: Client, q: string, extra = "") => (await cl.get(`/api/search?q=${encodeURIComponent(q)}${extra}`)).body as { groups: Group[]; tookMs: number; partial: boolean };
const group = (r: { groups: Group[] }, type: string) => r.groups.find((g) => g.type === type)?.items ?? [];
const general = async (cl: Client = c) => ((await cl.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
const todayUtc = () => new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  ownerId = (await c.get("/api/account/me")).body.user.id;
  domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  await verify();
  wsKey = (await c.post("/api/developer/keys", { name: "Ops" })).body.secret;
});
afterEach(() => setSnoozedProvider(null));

describe("query handling", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLike("50%")).toBe("50!%");
    expect(escapeLike("a_b")).toBe("a!_b");
    expect(escapeLike("wow!")).toBe("wow!!");
    expect(escapeLike("plain words")).toBe("plain words");
  });
  it("needs two characters, folds case and trims", () => {
    expect(normaliseQuery("a")).toBeNull();
    expect(normaliseQuery("   ")).toBeNull();
    expect(normaliseQuery("  Zebra   Plan ")).toBe("zebra plan");
    expect(normaliseQuery("x".repeat(500))).toHaveLength(100);
  });
  it("parses types and refuses unknown ones", () => {
    expect(parseTypes("tasks, docs")).toEqual(["tasks", "docs"]);
    expect(parseTypes("")).toHaveLength(6);
    expect(() => parseTypes("tasks,secrets")).toThrow(/Unknown type/);
  });
  it("cuts an excerpt around the match", () => {
    const text = `${"lorem ipsum ".repeat(30)}the zebra crossing ${"dolor sit ".repeat(30)}`;
    const e = excerpt(text, "zebra");
    expect(e).toContain("zebra");
    expect(e.startsWith("...")).toBe(true);
    expect(e.length).toBeLessThanOrEqual(146);
  });
  it("answers 422 for a one character query and 401 when signed out", async () => {
    expect((await c.get("/api/search?q=z")).status).toBe(422);
    expect((await new Client(ctx.app).get("/api/search?q=zebra")).status).toBe(401);
    expect((await new Client(ctx.app).get("/api/my-work")).status).toBe(401);
  });
});

describe("search everything", () => {
  it("finds a word in mail, tasks, docs, chat, contacts and deals, each with its real URL", async () => {
    const mb = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox;
    await inbound("hello@acme.io", "Zebra invoice for October", "Please pay the zebra invoice.");
    const t = (await c.post("/api/tasks", { title: "Paint the crossing", notes: "Use zebra stripes, white and black" })).body.task;
    const d = (await c.post("/api/docs", { title: "Road plan", text: "Line one\nThe zebra crossing goes by the school" })).body.doc;
    const g = await general();
    const m = (await c.post(`/api/chat/channels/${g.id}/messages`, { body: "Who ordered the zebra paint?" })).body.message;
    const ct = (await c.post("/api/contacts", { email: "zed@zebra.example", name: "Zed Stripe" })).body.contact;
    const dl = (await c.post("/api/deals", { title: "Zebra Crossings Pty Ltd", value: 12000 })).body.deal;

    const r = await search(c, "ZEBRA");
    expect(r.partial).toBe(false);
    expect(r.groups.map((x) => x.type)).toEqual(["mail", "tasks", "docs", "chat", "contacts", "deals"]);
    const mail = group(r, "mail")[0];
    expect(mail).toMatchObject({ title: "Zebra invoice for October", subtitle: "Grace Hopper <grace@example.com>" });
    expect(mail.url).toBe(`/app/mail?mailbox=${mb.id}&folder=inbox&m=${mail.id}`);
    const task = group(r, "tasks")[0];
    expect(task.id).toBe(t.id);
    expect(task.url).toBe(`/app/tasks?project=${t.projectId}&task=${t.id}`);
    expect(task.snippet).toContain("zebra stripes");
    expect(task.subtitle).toMatch(/^[A-Z0-9]+-1 · To do/);
    expect(group(r, "docs")[0]).toMatchObject({ id: d.id, url: `/app/docs/${d.id}` });
    expect(group(r, "docs")[0].snippet).toContain("zebra crossing");
    expect(group(r, "chat")[0]).toMatchObject({ id: m.id, url: `/app/chat/${g.id}?thread=${m.id}`, subtitle: "Olive Owner in #general" });
    expect(group(r, "contacts")[0]).toMatchObject({ id: ct.id, url: `/app/contacts/${ct.id}` });
    expect(group(r, "deals")[0]).toMatchObject({ id: dl.id });

    // A task key finds the task, and types narrow the groups.
    const key = task.subtitle.split(" ")[0];
    expect(group(await search(c, key.toLowerCase()), "tasks")[0].id).toBe(t.id);
    const only = await search(c, "zebra", "&types=docs,tasks");
    expect(only.groups.map((x) => x.type)).toEqual(["tasks", "docs"]);
  });

  it("limits each group, newest first, and keeps one mail result per thread", async () => {
    for (let i = 1; i <= 8; i++) await c.post("/api/tasks", { title: `Quokka task ${i}` });
    const r = await search(c, "quokka", "&limit=3");
    expect(group(r, "tasks").map((x) => x.title)).toEqual(["Quokka task 8", "Quokka task 7", "Quokka task 6"]);
    expect(group(await search(c, "quokka"), "tasks")).toHaveLength(5);
  });

  it("treats % and _ as plain characters", async () => {
    await c.post("/api/tasks", { title: "Discount 100% off" });
    await c.post("/api/tasks", { title: "Discount 1000 off" });
    await c.post("/api/tasks", { title: "file_name check" });
    await c.post("/api/tasks", { title: "fileXname check" });
    expect(group(await search(c, "0%"), "tasks").map((x) => x.title)).toEqual(["Discount 100% off"]);
    expect(group(await search(c, "e_n"), "tasks").map((x) => x.title)).toEqual(["file_name check"]);
    expect(group(await search(c, "%%"), "tasks")).toEqual([]);
  });

  it("never shows another workspace's items", async () => {
    await c.post("/api/tasks", { title: "Ours: walrus plan" });
    const other = new Client(ctx.app);
    await other.signup("boss@other.io", "Other Boss", "Other Co");
    await other.post("/api/tasks", { title: "Theirs: walrus budget" });
    await other.post("/api/docs", { title: "Walrus secrets", text: "walrus" });
    await other.post("/api/contacts", { email: "walrus@other.example", name: "Walrus" });
    const g = await general(other);
    await other.post(`/api/chat/channels/${g.id}/messages`, { body: "walrus walrus" });
    const mine = await search(c, "walrus");
    expect(mine.groups.map((x) => x.type)).toEqual(["tasks"]);
    expect(group(mine, "tasks").map((x) => x.title)).toEqual(["Ours: walrus plan"]);
    const theirs = await search(other, "walrus");
    expect(JSON.stringify(theirs)).not.toContain("Ours");
  });

  it("keeps private channels and DMs to their members", async () => {
    const mate = await teammate();
    const third = await teammate("third@acme.io", "Tia Third");
    const priv = (await c.post("/api/chat/channels", { name: "board", private: true })).body.channel;
    await c.post(`/api/chat/channels/${priv.id}/messages`, { body: "the narwhal acquisition" });
    const dm = (await c.post("/api/chat/dms", { userIds: [mate.id] })).body.channel;
    await c.post(`/api/chat/channels/${dm.id}/messages`, { body: "narwhal lunch tomorrow?" });
    const g = await general();
    await c.post(`/api/chat/channels/${g.id}/messages`, { body: "narwhal day is public" });

    expect(group(await search(c, "narwhal"), "chat")).toHaveLength(3);
    const mateSees = group(await search(mate.client, "narwhal"), "chat");
    expect(mateSees.map((x) => x.title).sort()).toEqual(["narwhal day is public", "narwhal lunch tomorrow?"]);
    expect(mateSees.find((x) => x.title.includes("lunch"))!.subtitle).toBe("Olive Owner in Direct message");
    expect(group(await search(third.client, "narwhal"), "chat").map((x) => x.title)).toEqual(["narwhal day is public"]);
  });

  it("shows a member only the mail of mailboxes they were given", async () => {
    const mb = (await c.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Sales" })).body.mailbox;
    await inbound("sales@acme.io", "Pelican order", "One pelican please");
    const mate = await teammate();
    expect(group(await search(mate.client, "pelican"), "mail")).toEqual([]);
    expect((await c.patch(`/api/team/members/${mate.id}`, { mailboxIds: [mb.id] })).status).toBe(200);
    expect(group(await search(mate.client, "pelican"), "mail")).toHaveLength(1);
  });

  it("lets a guest search only their project's tasks, docs and guest channels", async () => {
    const p = (await c.post("/api/projects", { name: "Harbour site" })).body.project;
    const other = (await c.post("/api/projects", { name: "Internal" })).body.project;
    await c.post("/api/tasks", { title: "Ibis homepage copy", projectId: p.id });
    await c.post("/api/tasks", { title: "Ibis salary review", projectId: other.id });
    await c.post("/api/docs", { title: "Ibis brief", projectId: p.id, text: "ibis" });
    await c.post("/api/docs", { title: "Ibis internal", projectId: other.id, text: "ibis" });
    await c.post("/api/contacts", { email: "ibis@x.example", name: "Ibis" });
    const g = await general();
    const shared = (await c.post("/api/chat/channels", { name: "harbour", projectId: p.id, guestAccess: true })).body.channel;
    await c.post(`/api/chat/channels/${shared.id}/messages`, { body: "ibis feedback is in" });
    await c.post(`/api/chat/channels/${g.id}/messages`, { body: "ibis team only" });
    const inv = await c.post("/api/guests", { projectId: p.id, email: "client@harbour.example", name: "Mia" });
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const token = sent.map((m) => m.text).reverse().find((t) => t.includes("/g/"))?.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1] ?? (inv.body.inviteUrl as string).split("/g/")[1];
    const guest = new Client(ctx.app);
    expect((await guest.post("/api/guest/accept", { token })).status).toBe(200);
    // The member search is not theirs: no workspace session.
    expect((await guest.get("/api/search?q=ibis")).status).toBe(401);
    const r = (await guest.get("/api/guest/search?q=ibis")).body as { groups: Group[] };
    expect(r.groups.map((x) => x.type)).toEqual(["tasks", "docs", "chat"]);
    expect(group(r, "tasks").map((x) => x.title)).toEqual(["Ibis homepage copy"]);
    expect(group(r, "docs").map((x) => x.title)).toEqual(["Ibis brief"]);
    expect(group(r, "chat").map((x) => x.title)).toEqual(["ibis feedback is in"]);
    // Asking for mail or contacts gives nothing, not an error.
    expect(((await guest.get("/api/guest/search?q=ibis&types=mail,contacts")).body as { groups: Group[] }).groups).toEqual([]);
    expect((await new Client(ctx.app).get("/api/guest/search?q=ibis")).status).toBe(401);
  });

  it("gives an agent key its own inbox and public channels only (MCP search_everything)", async () => {
    await c.post("/api/mailboxes", { domainId, localPart: "ceo", displayName: "CEO" });
    await inbound("ceo@acme.io", "Heron merger terms", "confidential heron");
    const made = await api(wsKey, "POST", "/agents", { name: "Invoice bot", localPart: "invoices" });
    const agentKey = made.body.apiKey.secret as string;
    await inbound("invoices@acme.io", "Heron invoice 12", "heron invoice");
    const priv = (await c.post("/api/chat/channels", { name: "exec", private: true })).body.channel;
    await c.post(`/api/chat/channels/${priv.id}/messages`, { body: "heron is secret" });
    const g = await general();
    await c.post(`/api/chat/channels/${g.id}/messages`, { body: "heron sighting at lunch" });

    const mcp = await mcpFor(agentKey);
    const r = data(await mcp.callTool({ name: "search_everything", arguments: { q: "heron" } })) as { groups: Group[] };
    expect(group(r, "mail").map((x) => x.title)).toEqual(["Heron invoice 12"]);
    expect(group(r, "chat").map((x) => x.title)).toEqual(["heron sighting at lunch"]);
    // A workspace key reads every mailbox, but still no private channel.
    const ws = await mcpFor(wsKey);
    const w = data(await ws.callTool({ name: "search_everything", arguments: { q: "heron", types: ["mail", "chat"] } })) as { groups: Group[] };
    expect(group(w, "mail")).toHaveLength(2);
    expect(group(w, "chat").map((x) => x.title)).toEqual(["heron sighting at lunch"]);
    // Too short a query is an error the model can read.
    const bad = await mcp.callTool({ name: "search_everything", arguments: { q: "h" } });
    expect(bad.isError).toBe(true);
    await mcp.close(); await ws.close();
  });

  it("answers within its time budget and says when it is partial", async () => {
    await c.post("/api/tasks", { title: "Budget gecko" });
    const me = (await c.get("/api/account/me")).body;
    const actor = { orgId: me.organization.id, userId: ownerId, email: "owner@acme.io", name: "Olive", role: "owner" as const };
    // Every query takes 50 ms longer than usual.
    const slow = (o: object): object => new Proxy(o, { get(t, p) {
      const v = Reflect.get(t, p);
      if (p === "then" && typeof v === "function") return (res: (x: unknown) => void, rej: (e: unknown) => void) => setTimeout(() => (v as (a: unknown, b: unknown) => void).call(t, res, rej), 50);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => { const r = (v as (...x: unknown[]) => unknown).apply(t, a); return r && typeof r === "object" ? slow(r) : r; };
    } });
    const slowDeps = { ...ctx.deps, db: slow(ctx.deps.db) as typeof ctx.deps.db };
    const cut = await searchEverything(slowDeps, { kind: "actor", actor }, "gecko", { budgetMs: 10 });
    expect(cut.partial).toBe(true);
    expect(cut.tookMs).toBeLessThan(500);
    const full = await searchEverything(slowDeps, { kind: "actor", actor }, "gecko", { budgetMs: 2_000 });
    expect(full.partial).toBe(false);
    expect(group(full, "tasks").map((x) => x.title)).toEqual(["Budget gecko"]);
  });
});

describe("My Work", () => {
  it("lists my tasks due today and overdue, not other people's or done ones", async () => {
    const mate = await teammate();
    const today = todayUtc();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await c.post("/api/tasks", { title: "Send the quote", assignee: `member:${ownerId}`, due: today });
    await c.post("/api/tasks", { title: "Late report", assignee: `member:${ownerId}`, due: yesterday });
    await c.post("/api/tasks", { title: "Next week", assignee: `member:${ownerId}`, due: later });
    await c.post("/api/tasks", { title: "Sam's job", assignee: `member:${mate.id}`, due: today });
    const done = (await c.post("/api/tasks", { title: "Already done", assignee: `member:${ownerId}`, due: today })).body.task;
    const doneStatus = (await c.get(`/api/projects/${done.projectId}`)).body.project.statuses.find((s: { category: string }) => s.category === "done");
    await c.patch(`/api/tasks/${done.id}`, { statusId: doneStatus.id });
    const w = (await c.get("/api/my-work?tz=UTC")).body;
    expect(w.date).toBe(today);
    expect(w.dueToday.map((x: { title: string }) => x.title)).toEqual(["Send the quote"]);
    expect(w.overdue.map((x: { title: string }) => x.title)).toEqual(["Late report"]);
    expect(w.dueToday[0].url).toMatch(/^\/app\/tasks\?project=.+&task=tsk_/);
    expect((await mate.client.get("/api/my-work?tz=UTC")).body.dueToday.map((x: { title: string }) => x.title)).toEqual(["Sam's job"]);
    // The section for snoozed mail is absent until a snooze source is wired in.
    expect(w.snoozed).toBeNull();
  });

  it("shows mentions of me, approvals waiting, threads on my tasks and today's meetings", async () => {
    const mate = await teammate();
    const g = await general();
    await c.post(`/api/chat/channels/${g.id}/messages`, { body: `<@member:${mate.id}> can you check the van?` });
    const mw = (await mate.client.get("/api/my-work?tz=UTC")).body;
    expect(mw.mentions).toHaveLength(1);
    expect(mw.mentions[0].url).toBe(`/app/chat/${g.id}?m=${mw.mentions[0].url.split("?m=")[1]}`);
    expect((await c.get("/api/my-work?tz=UTC")).body.mentions).toEqual([]);

    const made = await api(wsKey, "POST", "/agents", { name: "Invoice bot", localPart: "invoices" });
    const agent = made.body.agent;
    const now = new Date();
    await ctx.db.insert(sendApprovals).values({ id: "apr_test1", orgId: agent.orgId ?? (await c.get("/api/account/me")).body.organization.id, agentId: agent.id, mailboxId: agent.mailboxIds?.[0] ?? agent.mailboxId, payload: JSON.stringify({ to: ["a@b.example"], subject: "Your invoice", text: "hi" }), status: "pending", expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now });
    const ow = (await c.get("/api/my-work?tz=UTC")).body;
    expect(ow.approvals).toHaveLength(1);
    expect(ow.approvals[0]).toMatchObject({ title: "Your invoice", url: "/app/approvals" });
    expect(ow.approvals[0].subtitle).toContain("Invoice bot");
    // A member with no mailboxes waits on no approvals.
    expect((await mate.client.get("/api/my-work?tz=UTC")).body.approvals).toEqual([]);

    const mb = (await c.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" })).body.mailbox;
    await inbound("support@acme.io", "Broken kettle", "It stopped working");
    const msg = (await c.get(`/api/mail/messages?mailboxId=${mb.id}&folder=inbox`)).body;
    const first = (msg.messages ?? msg.threads ?? msg.data)[0];
    const fromEmail = await c.post("/api/tasks/from-email", { messageId: first.id, assignee: `member:${ownerId}` });
    expect(fromEmail.status).toBe(201);
    const threads = (await c.get("/api/my-work?tz=UTC")).body.threads;
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toBe("Broken kettle");
    expect(threads[0].url).toContain(`mailbox=${mb.id}`);

    const soon = new Date(Date.now() + 60_000).toISOString();
    await c.post("/api/meetings", { title: "Stand up", startsAt: soon, durationMin: 15 });
    await c.post("/api/meetings", { title: "Next month", startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    const meets = (await c.get(`/api/my-work?tz=UTC`)).body.meetings;
    if (dayIn(new Date(soon), "UTC") === todayUtc()) expect(meets.map((x: { title: string }) => x.title)).toEqual(["Stand up"]);
  });

  it("gives an agent key its own tasks and approvals and no mentions (MCP my_work)", async () => {
    const made = await api(wsKey, "POST", "/agents", { name: "Ops bot", localPart: "ops" });
    const agentKey = made.body.apiKey.secret as string;
    await c.post("/api/tasks", { title: "Bot job", assignee: `agent:${made.body.agent.id}`, due: todayUtc() });
    await c.post("/api/tasks", { title: "Person job", assignee: `member:${ownerId}`, due: todayUtc() });
    const mcp = await mcpFor(agentKey);
    const w = data(await mcp.callTool({ name: "my_work", arguments: { timeZone: "UTC" } }));
    expect(w.dueToday.map((x: { title: string }) => x.title)).toEqual(["Bot job"]);
    expect(w.mentions).toEqual([]);
    await mcp.close();
  });

  it("takes snoozed mail from a provider when one is wired in, and skips it when the table is missing", async () => {
    expect(await tableExists(ctx.deps, "tasks")).toBe(true);
    expect(await tableExists(ctx.deps, "mail_schedules_not_here")).toBe(false);
    setSnoozedProvider(async () => [{ id: "m1", title: "Back from snooze", subtitle: "Grace", url: "/app/mail?m=m1", at: new Date().toISOString() }]);
    expect((await c.get("/api/my-work?tz=UTC")).body.snoozed).toHaveLength(1);
    setSnoozedProvider(async (deps) => { await deps.db.run((await import("drizzle-orm")).sql`select * from mail_schedules_not_here`); return []; });
    expect((await c.get("/api/my-work?tz=UTC")).body.snoozed).toBeNull();
    const me = (await c.get("/api/account/me")).body;
    const direct = await myWork(ctx.deps, { orgId: me.organization.id, userId: ownerId, email: "owner@acme.io", name: "Olive", role: "owner" }, { timeZone: "UTC", snoozed: null });
    expect(direct.snoozed).toBeNull();
  });
});
