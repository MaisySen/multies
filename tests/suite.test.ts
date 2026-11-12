import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { runDueReminders } from "@/server/services/suite/automations";
import { docFromText, plainTextOf } from "@/server/services/suite/docs";
import { companyNameFromDomain } from "@/server/services/suite/contacts";
import { sortableId } from "@/server/services/suite/common";
import { pushPayload } from "@/server/services/suite/push";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let domainId: string;
let mailbox: { id: string; address: string };

async function verify() {
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
}

async function inbound(subject: string, text: string, from = { address: "grace@harbourcoffee.com.au", name: "Grace Lee" }, extra: Record<string, unknown> = {}) {
  const messageId = `<${Math.random().toString(36).slice(2)}@example.com>`;
  await deliverInbound(ctx.deps, {
    envelopeFrom: from.address, rcptTo: mailbox.address, sizeBytes: text.length + 200, via: "test",
    email: { messageId, from, to: [{ address: mailbox.address }], cc: [], subject, text, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {}, ...extra },
  });
  return messageId;
}

async function latestInbox() {
  const r = await c.get(`/api/mail/messages?mailboxId=${mailbox.id}&folder=inbox`);
  return r.body.messages[0] as { id: string; threadId: string; subject: string };
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  await verify();
  mailbox = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Acme" })).body.mailbox;
});

describe("helpers", () => {
  it("makes sortable ids and plain text from docs", () => {
    const a = sortableId("tsk", 1_000), b = sortableId("tsk", 2_000);
    expect(a < b).toBe(true);
    expect(a).toMatch(/^tsk_[0-9a-z]{19}$/);
    const doc = docFromText("# Plan\nFirst line\n- one\n- two");
    expect(doc.content?.[0].type).toBe("heading");
    expect(doc.content?.[2].type).toBe("bulletList");
    expect(plainTextOf(doc)).toBe("Plan\nFirst line\none\ntwo");
    expect(companyNameFromDomain("harbour-coffee.com.au")).toBe("Harbour Coffee");
    expect(pushPayload({ type: "message.received", id: "msg_1" })).toEqual({ type: "message.received", id: "msg_1" });
  });
});

describe("tasks from email", () => {
  it("makes a task from a thread in one call and shows later replies on it", async () => {
    const first = await inbound("Re: Quote for the café fit-out", "Can you send the revised quote by Friday?\n\nOn Mon, Bob wrote:\n> old stuff");
    const m = await latestInbox();
    const made = await c.post("/api/tasks/from-email", { messageId: m.id });
    expect(made.status).toBe(201);
    const task = made.body.task;
    expect(task.title).toBe("Quote for the café fit-out");
    expect(task.ref).toBe("TSK-1");
    expect(task.notes).toBe("Can you send the revised quote by Friday?");
    expect(task.source).toMatchObject({ threadId: m.threadId, messageId: m.id });
    expect(task.status).toBe("todo");

    // A reply on the same thread shows on the task.
    await inbound("Re: Quote for the café fit-out", "Also add the coffee machine please.", undefined, { inReplyTo: first, references: first });
    const detail = (await c.get(`/api/tasks/${task.id}`)).body;
    expect(detail.thread).toHaveLength(2);
    expect(detail.thread[1].latestText).toBe("Also add the coffee machine please.");
    expect(detail.activity.map((a: { verb: string }) => a.verb)).toContain("email_received");
    expect(detail.contacts[0].email).toBe("grace@harbourcoffee.com.au");

    // The webmail can ask which tasks a thread has.
    const byThread = (await c.get(`/api/tasks?threadId=${m.threadId}`)).body.tasks;
    expect(byThread.map((t: { id: string }) => t.id)).toEqual([task.id]);
    // And the task can be found by its reference.
    expect((await c.get("/api/tasks/TSK-1")).body.task.id).toBe(task.id);
  });

  it("covers assignees, priority, labels, subtasks, comments and optimistic versions", async () => {
    const agent = (await c.post("/api/agents", { name: "Ops bot", localPart: "ops" })).body;
    const agentId = agent.agent?.id ?? agent.id;
    const t = (await c.post("/api/tasks", { title: "Book the van", priority: "high", labels: ["ops", "ops", " urgent "], assignee: `agent:${agentId}`, due: "2026-11-02" })).body.task;
    expect(t.assignee).toMatchObject({ type: "agent", id: agentId, name: "Ops bot" });
    expect(t.labels).toEqual(["ops", "urgent"]);
    expect(t.due).toBe("2026-11-02T00:00:00.000Z");
    const sub = (await c.post("/api/tasks", { title: "Get two quotes", parentId: t.id })).body.task;
    expect(sub.projectId).toBe(t.projectId);
    await c.patch(`/api/tasks/${sub.id}`, { status: "done" });
    const me = (await c.get("/api/account/me")).body;
    expect((await c.post(`/api/tasks/${t.id}/comments`, { body: "Called them, waiting on a price." })).status).toBe(201);
    const d = (await c.get(`/api/tasks/${t.id}`)).body;
    expect(d.task.subtasks).toEqual({ total: 1, done: 1 });
    expect(d.subtasks[0].completedAt).toBeTruthy();
    expect(d.comments[0].body).toBe("Called them, waiting on a price.");
    expect(d.comments[0].author.name).toBe(me.user.name);
    expect((await c.patch(`/api/tasks/${t.id}`, { title: "Book the van for Saturday", version: 1 })).body.task.version).toBe(2);
    const stale = await c.patch(`/api/tasks/${t.id}`, { title: "x", version: 1 });
    expect(stale.status).toBe(409);
    expect((await c.patch(`/api/tasks/${t.id}`, { assignee: "member:nobody" })).status).toBe(422);
    expect((await c.patch(`/api/tasks/${t.id}`, { assigneeId: `member:${me.user.id}` })).body.task.assignee.type).toBe("member");
    const list = (await c.get("/api/tasks?assignee=me")).body.tasks;
    expect(list.map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect((await c.get("/api/tasks?label=ops")).body.tasks).toHaveLength(1);
    expect((await c.del(`/api/tasks/${t.id}`)).status).toBe(200);
    expect((await c.get(`/api/tasks/${t.id}`)).status).toBe(404);
  });
});

describe("projects and boards", () => {
  it("has custom statuses, moves cards between columns and keeps a change feed", async () => {
    const p = (await c.post("/api/projects", { name: "Client onboarding", statuses: [
      { name: "New", category: "todo" }, { name: "Kickoff booked", category: "doing" }, { name: "Live", category: "done" },
    ] })).body.project;
    expect(p.key).toBe("CO");
    expect(p.statuses.map((s: { name: string }) => s.name)).toEqual(["New", "Kickoff booked", "Live"]);
    const a = (await c.post("/api/tasks", { title: "Harbour Coffee", projectId: p.id })).body.task;
    const b = (await c.post("/api/tasks", { title: "Bondi Surf Co", projectId: p.id })).body.task;
    expect(a.statusId).toBe(p.statuses[0].id);
    expect(b.position).toBeGreaterThan(a.position);
    const before = (await c.get("/api/changes?since=0")).body.cursor;
    // Drag b to the second column, above nothing.
    const moved = (await c.patch(`/api/tasks/${b.id}`, { statusId: p.statuses[1].id, position: 512 })).body.task;
    expect(moved).toMatchObject({ statusId: p.statuses[1].id, status: "doing", position: 512, statusName: "Kickoff booked" });
    const feed = (await c.get(`/api/changes?since=${before}`)).body;
    expect(feed.changes).toEqual([expect.objectContaining({ entity: "task", id: b.id, op: "update" })]);
    // Removing a status moves its tasks to the first status in the same group.
    const renamed = (await c.patch(`/api/projects/${p.id}`, { statuses: [p.statuses[0], { name: "Live", category: "done", id: p.statuses[2].id }] })).body.project;
    expect(renamed.statuses).toHaveLength(2);
    expect((await c.get(`/api/tasks/${b.id}`)).body.task.statusId).toBe(p.statuses[0].id);
    expect((await c.post("/api/projects", { name: "Bad", statuses: [{ name: "Only", category: "todo" }] })).status).toBe(422);
    const projects = (await c.get("/api/projects")).body.projects;
    expect(projects.find((x: { id: string }) => x.id === p.id).counts).toEqual({ todo: 2, doing: 0, done: 0 });
  });

  it("saves filters as views", async () => {
    const v = (await c.post("/api/tasks/views", { name: "My urgent", view: "list", filters: { assignee: "me", priority: "urgent" } })).body.view;
    expect(v).toMatchObject({ name: "My urgent", view: "list", shared: false });
    expect((await c.get("/api/tasks/views")).body.views).toHaveLength(1);
    await c.del(`/api/tasks/views/${v.id}`);
    expect((await c.get("/api/tasks/views")).body.views).toHaveLength(0);
  });
});

describe("docs", () => {
  it("creates a doc from text, links it to a task and saves edits with versions", async () => {
    const t = (await c.post("/api/tasks", { title: "Launch plan" })).body.task;
    const doc = (await c.post("/api/docs", { title: "Launch brief", text: "# Goals\nShip it\n- landing page", links: [{ type: "task", id: t.id }] })).body.doc;
    expect(doc.text).toBe("Goals\nShip it\nlanding page");
    expect(doc.links).toEqual([{ type: "task", id: t.id }]);
    expect((await c.get(`/api/tasks/${t.id}`)).body.docs[0].title).toBe("Launch brief");
    const edited = (await c.patch(`/api/docs/${doc.id}`, { version: doc.version, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Rewritten" }] }] } })).body.doc;
    expect(edited.text).toBe("Rewritten");
    expect((await c.patch(`/api/docs/${doc.id}`, { version: doc.version, title: "Old" })).status).toBe(409);
    expect((await c.patch(`/api/docs/${doc.id}`, { content: { type: "nope" } })).status).toBe(422);
    expect((await c.get("/api/docs?q=Rewritten")).body.docs).toHaveLength(1);
  });
});

describe("contacts from mail", () => {
  it("creates a contact and a company for an outside sender, and skips teammates and robots", async () => {
    await inbound("Hello", "Hi there", { address: "Grace@HarbourCoffee.com.au", name: "Grace Lee" });
    await inbound("Again", "Hi again", { address: "grace@harbourcoffee.com.au", name: "Grace" });
    await inbound("Gmail", "Hey", { address: "sam.k@gmail.com", name: "Sam K" });
    await inbound("Robot", "Receipt", { address: "no-reply@shop.example", name: "Shop" });
    const list = (await c.get("/api/contacts")).body;
    const emails = list.contacts.map((x: { email: string }) => x.email).sort();
    expect(emails).toEqual(["grace@harbourcoffee.com.au", "sam.k@gmail.com"]);
    const grace = list.contacts.find((x: { email: string }) => x.email === "grace@harbourcoffee.com.au");
    expect(grace).toMatchObject({ name: "Grace Lee", messageCount: 2, source: "mail", company: { name: "Harbourcoffee", domain: "harbourcoffee.com.au" } });
    expect(list.contacts.find((x: { email: string }) => x.email === "sam.k@gmail.com").company).toBeNull();
    // Mail sent out makes contacts too.
    await c.post("/api/mail/send", { mailboxId: mailbox.id, to: ["ravi@bondisurf.com.au"], subject: "Proposal", text: "Attached." });
    expect((await c.get("/api/contacts?q=ravi")).body.contacts).toHaveLength(1);
    // The timeline has the threads and the tasks.
    const inbox = (await c.get(`/api/mail/messages?mailboxId=${mailbox.id}&folder=inbox`)).body.messages as { id: string; subject: string }[];
    await c.post("/api/tasks/from-email", { messageId: inbox.find((x) => x.subject === "Again")!.id });
    const detail = (await c.get(`/api/contacts/${grace.id}`)).body;
    expect(detail.threads.length).toBe(2);
    expect(detail.tasks.length).toBe(1);
    expect(detail.timeline.map((i: { kind: string }) => i.kind).sort()).toEqual(["task", "thread", "thread"]);
    expect((await c.get("/api/companies")).body.companies.map((x: { domain: string }) => x.domain).sort()).toEqual(["bondisurf.com.au", "harbourcoffee.com.au"]);
  });

  it("builds contacts from mail that arrived before the suite existed", async () => {
    await inbound("Hello", "Hi", { address: "old@client.com.au", name: "Old Client" });
    // Pretend the contact was never made (mail from before this release).
    const { contacts } = await import("@/server/db/schema");
    await ctx.db.delete(contacts);
    const list = (await c.get("/api/contacts")).body.contacts;
    expect(list.map((x: { email: string }) => x.email)).toEqual(["old@client.com.au"]);
  });

  it("runs a deals pipeline in AUD", async () => {
    await inbound("Hi", "Hi", { address: "grace@harbourcoffee.com.au", name: "Grace" });
    const contact = (await c.get("/api/contacts")).body.contacts[0];
    const d = (await c.post("/api/deals", { title: "Fit-out", value: 12500, contactId: contact.id })).body.deal;
    expect(d).toMatchObject({ stage: "lead", value: 12500, currency: "AUD", companyId: contact.companyId });
    await c.patch(`/api/deals/${d.id}`, { stage: "proposal" });
    const board = (await c.get("/api/deals")).body;
    expect(board.stages.find((s: { id: string }) => s.id === "proposal").total).toBe(12500);
    expect(board.deals[0].contact.email).toBe("grace@harbourcoffee.com.au");
  });
});

describe("automations", () => {
  it("makes a task when matching mail arrives, and counts the run", async () => {
    // AIS1: the first project would start with Triage on, where mail tasks wait; this one has it off.
    await c.post("/api/projects", { name: "Tasks", triage: false });
    const r = await c.post("/api/automations", { name: "Invoices", trigger: "email_received", conditions: { subjectContains: "invoice" }, action: "create_task", actionConfig: { priority: "high", dueInDays: 2 } });
    expect(r.status).toBe(201);
    await inbound("Invoice INV-204 overdue", "Please pay.");
    await inbound("Lunch?", "Free Friday?");
    const tasks = (await c.get("/api/tasks")).body.tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Invoice INV-204 overdue", priority: "high", createdBy: { type: "system" } });
    const list = (await c.get("/api/automations")).body;
    expect(list.automations[0].runCount).toBe(1);
    expect(list.usage).toEqual({ used: 1, limit: 1000 });
    expect(list.recipes.length).toBeGreaterThan(2);
    expect((await c.post("/api/automations", { name: "Bad", trigger: "email_received", conditions: {}, action: "create_task" })).status).toBe(422);
  });

  it("notifies on status change and reminds before the due date", async () => {
    const me = (await c.get("/api/account/me")).body.user;
    await c.post("/api/automations", { name: "Done", trigger: "status_changed", conditions: { toCategory: "done" }, action: "notify", actionConfig: { to: "creator" } });
    await c.post("/api/automations", { name: "Due", trigger: "due_soon", conditions: { hoursBefore: 24 }, action: "notify", actionConfig: { to: "assignee" } });
    const t = (await c.post("/api/tasks", { title: "Pay BAS", assignee: `member:${me.id}`, due: new Date(Date.now() + 3 * 3600_000).toISOString() })).body.task;
    await c.patch(`/api/tasks/${t.id}`, { status: "done" });
    let n = (await c.get("/api/notifications")).body.notifications;
    expect(n.map((x: { type: string }) => x.type)).toContain("automation.status");
    await c.patch(`/api/tasks/${t.id}`, { status: "todo" });
    expect((await runDueReminders(ctx.deps)).sent).toBe(1);
    expect((await runDueReminders(ctx.deps)).sent).toBe(0);
    n = (await c.get("/api/notifications?unread=1")).body.notifications;
    expect(n.map((x: { type: string }) => x.type)).toContain("task.due_soon");
    expect((await c.post("/api/notifications/read", {})).body.marked).toBeGreaterThan(0);
  });
});

describe("push devices", () => {
  it("registers a phone and sends only an event type and an id", async () => {
    const sent: unknown[] = [];
    ctx = await makeTestApp({ PUSH_ENABLED: "1" }, { fetch: (async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ data: [{ status: "ok" }] })); }) as unknown as typeof fetch });
    c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    await verify();
    mailbox = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Acme" })).body.mailbox;
    expect((await c.post("/api/push/devices", { token: "nope", platform: "ios" })).status).toBe(422);
    const r = await c.post("/api/push/devices", { token: "ExponentPushToken[abcdefghijklmnop]", platform: "ios" });
    expect(r.body).toEqual({ ok: true, enabled: true });
    await inbound("Secret subject", "Secret body");
    const push = sent.find((s) => (s as { url: string }).url.includes("exp.host")) as { body: { to: string; data: Record<string, string>; title?: string; body?: string }[] };
    expect(push.body[0].to).toBe("ExponentPushToken[abcdefghijklmnop]");
    expect(Object.keys(push.body[0].data).sort()).toEqual(["id", "type"]);
    expect(push.body[0].data.type).toBe("message.received");
    expect(JSON.stringify(push.body)).not.toContain("Secret");
    expect((await c.get("/api/push/devices")).body.devices).toHaveLength(1);
    await c.del(`/api/push/devices/${encodeURIComponent("ExponentPushToken[abcdefghijklmnop]")}`);
    expect((await c.get("/api/push/devices")).body.devices).toHaveLength(0);
  });
});
