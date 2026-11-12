import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";

/**
 * AIS1 (audit row 35): Triage is on for every new project (the server, not only the web dialog), a key or a
 * connected AI app can't turn it off, and work an AI app or a key makes waits there whichever way it is made:
 * from an email, as a subtask, as a copy, from a template, or by a person's mail rule. Tasks a person makes in
 * the app still go straight to the board, and existing projects keep their setting.
 */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function mcpWith(token: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const key = async (name = "Bot") => (await c.post("/api/developer/keys", { name })).body.secret as string;

/** A verified acme.io with a shared mailbox, so inbound mail lands (the pattern from tests/triage-r21.test.ts). */
async function mailbox() {
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
  return (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Acme" })).body.mailbox as { id: string; address: string };
}
async function inbound(to: string, subject: string, from = "grace@client.com") {
  const messageId = `<${Math.random().toString(36).slice(2)}@example.com>`;
  await deliverInbound(ctx.deps, {
    envelopeFrom: from, rcptTo: to, sizeBytes: 300, via: "test",
    email: { messageId, from: { address: from, name: "Grace" }, to: [{ address: to }], cc: [], subject, text: "Please have a look.", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
}

describe("AIS1 row 35: new projects start with Triage on, and only a person turns it off", () => {
  it("the server turns Triage on for a new project made by a person or a key; a person may choose off, a key may not", async () => {
    const k = await key();
    expect((await c.post("/api/projects", { name: "By hand" })).body.project.triage).toBe(true);
    expect((await c.post("/api/projects", { name: "Hand, off", triage: false })).body.project.triage).toBe(false);
    const viaKey = await api(k, "POST", "/projects", { name: "By key" });
    expect(viaKey.status).toBe(201);
    expect(viaKey.body.project.triage).toBe(true);
    const off = await api(k, "POST", "/projects", { name: "Key, off", triage: false });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe("person_only");
    // Turning it off later: a key gets 403, a key may turn it on, a person may do either.
    const p = viaKey.body.project.id as string;
    const patch = await api(k, "PATCH", `/projects/${p}`, { triage: false });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe("person_only");
    expect((await c.patch(`/api/projects/${p}`, { triage: false })).body.project.triage).toBe(false);
    expect((await api(k, "PATCH", `/projects/${p}`, { triage: true })).body.project.triage).toBe(true);
    // Other changes by a key still work.
    expect((await api(k, "PATCH", `/projects/${p}`, { name: "Renamed" })).status).toBe(200);
  });

  it("a key's first task in an empty workspace waits in the Tasks project it makes", async () => {
    const k = await key();
    const made = await api(k, "POST", "/tasks", { title: "From the API" });
    expect(made.status).toBe(201);
    expect(made.body.task.triage).toMatchObject({ state: "pending", source: "api" });
  });
});

describe("AIS1 row 35: key and AI app tasks wait in Triage whichever way they are made", () => {
  it("subtasks, copies and template tasks from a key or MCP wait; a person's go straight to the board", async () => {
    const k = await key();
    const p = (await c.post("/api/projects", { name: "Support" })).body.project.id as string;
    const parent = (await c.post("/api/tasks", { title: "Quote for Grace", projectId: p })).body.task;
    expect(parent.triage).toBeNull();

    const sub = await api(k, "POST", "/tasks", { title: "Check the price list", projectId: p, parentId: parent.id });
    expect(sub.status).toBe(201);
    expect(sub.body.task.triage).toMatchObject({ state: "pending", source: "api" });
    const m = await mcpWith(k);
    const mcpSub = data(await m.callTool({ name: "create_task", arguments: { title: "Ring the supplier", projectId: p, parentId: parent.id } }));
    expect(mcpSub.task.triage).toMatchObject({ state: "pending", source: "agent" });

    const copy = data(await m.callTool({ name: "duplicate_task", arguments: { taskId: parent.id, subtasks: false } }));
    expect((copy.task ?? copy).triage).toMatchObject({ state: "pending" });

    const tpl = data(await m.callTool({ name: "create_template", arguments: { kind: "task", name: "Callback", data: { title: "Call the customer back" } } }));
    const used = data(await m.callTool({ name: "use_template", arguments: { templateId: tpl.template.id, projectId: p } }));
    expect(used.task.triage).toMatchObject({ state: "pending" });
    await m.close();

    // The same things done by a person in the app land on the board.
    expect((await c.post("/api/tasks", { title: "By hand", projectId: p, parentId: parent.id })).body.task.triage).toBeNull();
    expect((await c.get(`/api/tasks?projectId=${p}`)).body.tasks.map((t: { title: string }) => t.title)).toEqual(["Quote for Grace"]);
  });

  it("a chat message, a checklist item and meeting action items turned into tasks by MCP wait too", async () => {
    const k = await key();
    const p = (await c.post("/api/projects", { name: "Ops" })).body.project.id as string;
    const parent = (await c.post("/api/tasks", { title: "Open the new shop", projectId: p })).body.task;
    const general = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const said = (await c.post(`/api/chat/channels/${general.id}/messages`, { body: "Order more coffee cups" })).body.message as { id: string };
    const meeting = (await c.post("/api/meetings", { title: "Weekly sync", startsAt: "2026-11-09T00:00:00Z" })).body.meeting as { id: string };

    const m = await mcpWith(k);
    const fromChat = data(await m.callTool({ name: "message_to_task", arguments: { messageId: said.id, projectId: p } }));
    const added = data(await m.callTool({ name: "add_checklist_items", arguments: { taskId: parent.id, items: [{ title: "Get the keys" }] } }));
    const sub = data(await m.callTool({ name: "checklist_item_to_subtask", arguments: { itemId: added.items[0].id } }));
    const actions = data(await m.callTool({ name: "create_action_items", arguments: { meetingId: meeting.id, projectId: p, items: [{ title: "Book the plumber" }] } }));
    await m.close();
    expect(actions.created.map((t: { title: string }) => t.title)).toEqual(["Book the plumber"]);

    const waiting = ((await c.get("/api/triage")).body.items as { id: string; title: string; triage: { source: string } }[]);
    expect(waiting.map((i) => [i.title, i.triage.source]).sort()).toEqual([["Book the plumber", "agent"], ["Get the keys", "agent"], ["Order more coffee cups", "agent"]]);
    expect(waiting.map((i) => i.id)).toEqual(expect.arrayContaining([fromChat.task.id, sub.task.id]));
    expect((await c.get(`/api/tasks?projectId=${p}`)).body.tasks.map((t: { title: string }) => t.title)).toEqual(["Open the new shop"]);
  });

  it("a task made from an email by a key or MCP waits; by a person it doesn't", async () => {
    const box = await mailbox();
    const p = (await c.post("/api/projects", { name: "Inbox work" })).body.project.id as string;
    await inbound(box.address, "Need a quote");
    const thread = (await c.get(`/api/mail/messages?mailboxId=${box.id}&folder=inbox`)).body.messages[0].threadId as string;
    const k = await key();
    const viaKey = await api(k, "POST", "/tasks/from-email", { threadId: thread, projectId: p });
    expect(viaKey.status).toBe(201);
    expect(viaKey.body.task.triage).toMatchObject({ state: "pending", source: "api" });
    const m = await mcpWith(k);
    const viaMcp = data(await m.callTool({ name: "create_task", arguments: { title: "From the thread", threadId: thread, projectId: p } }));
    expect(viaMcp.task.triage).toMatchObject({ state: "pending", source: "agent" });
    await m.close();
    expect((await c.post("/api/tasks/from-email", { threadId: thread, projectId: p })).body.task.triage).toBeNull();
  });

  it("a person's mail rule that makes a task sends it to Triage when the project has it on", async () => {
    await c.post("/api/org/plan", { plan: "pro" }); // as in tests/mail-r85.test.ts
    const box = await mailbox();
    const p = (await c.post("/api/projects", { name: "Client mail" })).body.project.id as string;
    const rule = await c.post("/api/mail/rules", { name: "Client mail", mailboxId: box.id, conditions: [{ field: "domain", value: "client.com" }], actions: [{ kind: "create_task", projectId: p }] });
    expect(rule.status).toBe(201);
    await inbound(box.address, "Can you send the quote?");
    const items = (await c.get("/api/triage")).body.items as { title: string; projectId: string; triage: { source: string } }[];
    expect(items.map((i) => [i.title, i.projectId, i.triage.source])).toEqual([["Can you send the quote?", p, "mail"]]);
    // With Triage off, the rule's task goes straight to the board as before.
    const plain = (await c.post("/api/projects", { name: "Plain", triage: false })).body.project.id as string;
    await c.patch(`/api/mail/rules/${rule.body.rule.id}`, { name: "Client mail", mailboxId: box.id, conditions: [{ field: "domain", value: "client.com" }], actions: [{ kind: "create_task", projectId: plain }] });
    await inbound(box.address, "Second request");
    expect((await c.get(`/api/tasks?projectId=${plain}`)).body.tasks.map((t: { title: string }) => t.title)).toEqual(["Second request"]);
  });

  it("forms made by a key or MCP send answers to Triage by default; the app still sends its own choice", async () => {
    const k = await key();
    const p = (await c.post("/api/projects", { name: "Leads", triage: false })).body.project.id as string;
    const viaKey = await api(k, "POST", "/forms", { name: "Contact us", projectId: p });
    expect(viaKey.status).toBe(201);
    expect(viaKey.body.form.triage).toBe(true);
    const m = await mcpWith(k);
    expect(data(await m.callTool({ name: "create_form", arguments: { name: "Quote request", projectId: p } })).form.triage).toBe(true);
    await m.close();
    expect((await c.post("/api/forms", { name: "Hand made", projectId: p, triage: false })).body.form.triage).toBe(false);
  });

  it("finishing a repeating task with a key makes the next one on the board, not in Triage", async () => {
    const k = await key();
    const p = (await c.post("/api/projects", { name: "Bills" })).body.project.id as string;
    const t = (await c.post("/api/tasks", { title: "Pay super", projectId: p, due: "2026-11-28", repeat: { freq: "monthly", monthDay: 28 } })).body.task;
    expect((await api(k, "PATCH", `/tasks/${t.id}`, { status: "done" })).status).toBe(200);
    const open = (await c.get(`/api/tasks?projectId=${p}`)).body.tasks.filter((x: { status: string }) => x.status !== "done");
    expect(open.map((x: { title: string; triage: unknown }) => [x.title, x.triage])).toEqual([["Pay super", null]]);
    expect((await c.get("/api/triage/count")).body.count).toBe(0);
  });
});
