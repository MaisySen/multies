import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { isNoReply, replyAddress } from "@/server/services/suite/triage";

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
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const me = async () => (await c.get("/api/account/me")).body.user.id as string;

/** A project with Triage on and a public form for it; submits one answer set and returns the new item id. */
async function triageForm(opts: { formTriage?: boolean; projectTriage?: boolean } = {}) {
  const project = (await c.post("/api/projects", { name: "Support" })).body.project;
  if (opts.projectTriage ?? true) expect((await c.patch(`/api/projects/${project.id}`, { triage: true })).body.project.triage).toBe(true);
  const form = (await c.post("/api/forms", { name: "Contact us", projectId: project.id, ...(opts.formTriage ? { triage: true } : {}) })).body.form;
  return { project, form };
}
async function submit(slug: string, subject: string, email = "grace@harbourcoffee.com.au") {
  const pub = new Client(ctx.app);
  const r = await pub.post(`/api/public/forms/${slug}`, { answers: { name: "Grace Lee", email, subject, details: `About ${subject}` }, elapsedMs: 8000 });
  expect(r.status).toBe(200);
  return r.body.created.id as string;
}

describe("triage intake", () => {
  it("lands a form submission in Triage, hidden from lists, My Work, board and counts", async () => {
    const { project, form } = await triageForm();
    const id = await submit(form.slug, "Quote for 6 mailboxes");
    const q = (await c.get("/api/triage")).body;
    expect(q.count).toBe(1);
    expect(q.items[0]).toMatchObject({ id, title: "Quote for 6 mailboxes", triage: { state: "pending", source: "form", from: "grace@harbourcoffee.com.au" } });
    expect((await c.get("/api/triage/count")).body.count).toBe(1);
    expect((await c.get("/api/tasks")).body.tasks).toHaveLength(0);
    expect((await c.get(`/api/tasks?projectId=${project.id}`)).body.tasks).toHaveLength(0);
    expect((await c.get("/api/tasks?triage=pending")).body.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
    const proj = (await c.get("/api/projects")).body.projects.find((p: { id: string }) => p.id === project.id);
    expect(proj.counts).toEqual({ todo: 0, doing: 0, done: 0 });
    expect(JSON.stringify((await c.get("/api/my-work")).body)).not.toContain("Quote for 6 mailboxes");
    expect(JSON.stringify((await c.get("/api/search?q=mailboxes")).body)).not.toContain(id);
    expect((await c.get(`/api/triage/${id}`)).body.item.id).toBe(id);
  });

  it("keeps today's behaviour for projects without Triage, and the form switch alone sends to Triage", async () => {
    const plain = await triageForm({ projectTriage: false });
    const direct = await submit(plain.form.slug, "Direct");
    expect((await c.get("/api/tasks")).body.tasks.map((t: { id: string }) => t.id)).toEqual([direct]);
    expect(plain.project.triage).toBe(false);
    const switched = await triageForm({ projectTriage: false, formTriage: true });
    expect(switched.form.triage).toBe(true);
    const held = await submit(switched.form.slug, "Held");
    expect((await c.get("/api/triage")).body.items.map((t: { id: string }) => t.id)).toEqual([held]);
  });

  it("sends mail made into tasks by a rule to Triage when the project has it on", async () => {
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const { body } = await c.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await c.post(`/api/domains/${domainId}/verify`);
    const mailbox = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Acme" })).body.mailbox;
    const project = (await c.post("/api/projects", { name: "Inbox work" })).body.project;
    await c.patch(`/api/projects/${project.id}`, { triage: true });
    await c.post("/api/automations", { name: "Requests", trigger: "email_received", conditions: { subjectContains: "request" }, action: "create_task", actionConfig: { projectId: project.id } });
    await deliverInbound(ctx.deps, {
      envelopeFrom: "maria@blueharbor.example", rcptTo: mailbox.address, sizeBytes: 300, via: "test",
      email: { messageId: "<m1@example.com>", from: { address: "maria@blueharbor.example", name: "Maria" }, to: [{ address: mailbox.address }], cc: [], subject: "Request: new mailbox", text: "Please add one.", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const items = (await c.get("/api/triage")).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Request: new mailbox", triage: { source: "mail", from: "Maria <maria@blueharbor.example>" } });
    expect(items[0].source.threadId).toBeTruthy();
    expect((await c.get("/api/tasks")).body.tasks).toHaveLength(0);
    // A person making a task from the thread by hand still gets a normal task.
    const made = await c.post("/api/tasks/from-email", { threadId: items[0].source.threadId, projectId: project.id });
    expect(made.status).toBe(201);
    expect(made.body.task.triage).toBeNull();
  });
});

describe("triage actions", () => {
  it("accepts with an assignee and keeps the number; the task shows in the project list", async () => {
    const { project, form } = await triageForm();
    const id = await submit(form.slug, "Set up DKIM");
    const before = (await c.get(`/api/triage/${id}`)).body.item;
    const uid = await me();
    const r = await c.post(`/api/triage/${id}/accept`, { assignee: `member:${uid}`, priority: "high", due: "2026-11-02" });
    expect(r.status).toBe(200);
    expect(r.body.task).toMatchObject({ id, ref: before.ref, number: before.number, triage: null, priority: "high", assignee: { type: "member", id: uid } });
    expect((await c.get(`/api/tasks?projectId=${project.id}`)).body.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
    expect((await c.get("/api/triage")).body.count).toBe(0);
    expect((await c.post(`/api/triage/${id}/accept`, {})).status).toBe(404);
    const detail = (await c.get(`/api/tasks/${id}`)).body;
    expect(detail.activity.map((a: { verb: string }) => a.verb)).toContain("triage_accepted");
  });

  it("declines with and without a reply, and never replies to no-reply senders", async () => {
    const { form } = await triageForm();
    const quiet = await submit(form.slug, "Spammy offer");
    const polite = await submit(form.slug, "Partnership idea", "jordan@studio.example");
    const robot = await submit(form.slug, "Automated note", "no-reply@service.example");
    const sentBefore = ctx.outbound.sent.length;
    const a = await c.post(`/api/triage/${quiet}/decline`, { reason: "Spam" });
    expect(a.body).toMatchObject({ ok: true, reply: { sent: false } });
    expect(ctx.outbound.sent.length).toBe(sentBefore);
    const b = await c.post(`/api/triage/${polite}/decline`, { reason: "Not a fit", reply: true });
    expect(b.body.reply).toMatchObject({ attempted: true, to: "jordan@studio.example" });
    const mail = ctx.outbound.sent.find((m) => m.to.includes("jordan@studio.example"))!;
    expect(mail.subject).toBe("Re: Partnership idea");
    expect(mail.text).toContain("Acme");
    const r = await c.post(`/api/triage/${robot}/decline`, { reply: true });
    expect(r.body.reply).toMatchObject({ sent: false, skipped: "no_reply_address" });
    expect(ctx.outbound.sent.some((m) => m.to.includes("no-reply@service.example"))).toBe(false);
    expect((await c.get("/api/triage")).body.count).toBe(0);
    expect((await c.get("/api/tasks")).body.tasks).toHaveLength(0);
    expect((await c.get(`/api/tasks/${quiet}`)).status).toBe(404);
  });

  it("merges into an existing task: notes become a comment, the thread moves, the item goes", async () => {
    const { project, form } = await triageForm();
    const target = (await c.post("/api/tasks", { title: "Onboard Harbour Coffee", projectId: project.id })).body.task;
    const item = await c.post("/api/triage", { title: "Mail from Maria", notes: "They want 6 more seats.", from: "Maria <maria@blueharbor.example>", source: "mail" });
    expect(item.status).toBe(201);
    // Put a thread on the item to check it moves.
    const { tasks } = await import("@/server/db/schema");
    const { eq } = await import("drizzle-orm");
    await ctx.db.update(tasks).set({ threadId: "thr_test", messageId: "msg_test", sourceSubject: "Seats" }).where(eq(tasks.id, item.body.item.id));
    const formItem = await submit(form.slug, "Duplicate of onboarding");
    const r = await c.post(`/api/triage/${item.body.item.id}/merge`, { targetId: target.id });
    expect(r.status).toBe(200);
    expect(r.body.task.source).toMatchObject({ threadId: "thr_test", subject: "Seats" });
    const detail = (await c.get(`/api/tasks/${target.id}`)).body;
    expect(detail.comments[0].body).toContain("They want 6 more seats.");
    expect(detail.comments[0].body).toContain("Mail from Maria");
    expect((await c.get(`/api/tasks/${item.body.item.id}`)).status).toBe(404);
    expect((await c.post(`/api/triage/${formItem}/merge`, { targetId: formItem })).status).toBe(422);
    expect((await c.post(`/api/triage/${formItem}/merge`, { targetId: "tsk_nope" })).status).toBe(404);
    expect((await c.get("/api/triage")).body.items.map((t: { id: string }) => t.id)).toEqual([formItem]);
  });

  it("bulk accepts and declines, capped at 100", async () => {
    const { form } = await triageForm();
    const ids = [await submit(form.slug, "One"), await submit(form.slug, "Two"), await submit(form.slug, "Three")];
    const r = await c.post("/api/triage/bulk", { ids: [ids[0], ids[1], "tsk_missing"], action: "accept", accept: { status: "doing" } });
    expect(r.body).toMatchObject({ done: 2, failed: 1 });
    expect((await c.get("/api/tasks")).body.tasks.map((t: { status: string }) => t.status)).toEqual(["doing", "doing"]);
    expect((await c.post("/api/triage/bulk", { ids: [ids[2]], action: "decline" })).body.done).toBe(1);
    expect((await c.post("/api/triage/bulk", { ids: Array.from({ length: 101 }, (_, i) => `tsk_${i}`), action: "decline" })).status).toBe(422);
    expect((await c.get("/api/triage")).body.count).toBe(0);
  });
});

describe("triage permissions and API", () => {
  it("refuses guests, other workspaces and read only keys", async () => {
    const { form } = await triageForm();
    const id = await submit(form.slug, "Private");
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/triage")).status).toBe(401);
    expect((await anon.post(`/api/triage/${id}/accept`, {})).status).toBe(401);
    const other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve", "Other");
    expect((await other.get("/api/triage")).body.items).toHaveLength(0);
    expect((await other.get(`/api/triage/${id}`)).status).toBe(404);
    expect((await other.post(`/api/triage/${id}/accept`, {})).status).toBe(404);
    expect((await other.post(`/api/triage/${id}/decline`, {})).status).toBe(404);
    const otherTask = (await other.post("/api/tasks", { title: "Theirs" })).body.task;
    expect((await c.post(`/api/triage/${id}/merge`, { targetId: otherTask.id })).status).toBe(404);
    const ro = (await c.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    expect((await api(ro, "GET", "/triage")).body.count).toBe(1);
    expect((await api(ro, "POST", `/triage/${id}/accept`, {})).status).toBe(403);
    expect((await api(ro, "POST", "/triage", { title: "x" })).status).toBe(403);
    expect((await c.get("/api/triage")).body.count).toBe(1);
  });

  it("creates, lists and accepts over the public API", async () => {
    const key = (await c.post("/api/developer/keys", { name: "Agent" })).body.secret;
    const made = await api(key, "POST", "/triage", { title: "Call back Priya", notes: "About retention", from: "priya@example.com" });
    expect(made.status).toBe(201);
    expect(made.body.item.triage).toMatchObject({ state: "pending", source: "api", from: "priya@example.com" });
    expect((await api(key, "GET", "/triage")).body.items).toHaveLength(1);
    expect((await api(key, "GET", "/triage/count")).body.count).toBe(1);
    expect((await api(key, "GET", "/tasks")).body.tasks).toHaveLength(0);
    // AIS1 (row 66): a key adds and lists; a person signed in decides.
    const refused = await api(key, "POST", `/triage/${made.body.item.id}/accept`, { status: "doing" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("person_only");
    const ok = await c.post(`/api/triage/${made.body.item.id}/accept`, { status: "doing" });
    expect(ok.body.task).toMatchObject({ status: "doing", triage: null });
    expect((await api(key, "GET", "/tasks")).body.tasks).toHaveLength(1);
    const other = await api(key, "POST", "/triage", { title: "Junk" });
    expect((await api(key, "POST", `/triage/${other.body.item.id}/decline`, { reason: "junk" })).status).toBe(403);
    expect((await c.post(`/api/triage/${other.body.item.id}/decline`, { reason: "junk" })).body.ok).toBe(true);
  });

  it("works over MCP, and read only keys can list but not write", async () => {
    const key = (await c.post("/api/developer/keys", { name: "MCP" })).body.secret;
    const mcp = await mcpFor(key);
    const made = data(await mcp.callTool({ name: "create_triage_item", arguments: { title: "From the agent", from: "sam@example.com" } }));
    const listed = data(await mcp.callTool({ name: "list_triage", arguments: {} }));
    expect(listed.count).toBe(1);
    expect(listed.items[0]).toMatchObject({ id: made.item.id, source: "api", from: "sam@example.com" });
    const target = (await c.post("/api/tasks", { title: "Existing" })).body.task;
    const second = data(await mcp.callTool({ name: "create_triage_item", arguments: { title: "Dup" } }));
    const third = data(await mcp.callTool({ name: "create_triage_item", arguments: { title: "Junk" } }));
    // AIS1 (row 66): the decision tools stay listed, but only a person signed in to Multies decides.
    for (const [name, args] of [["triage_accept", { id: made.item.id, priority: "low" }], ["triage_merge", { id: second.item.id, targetId: target.id }], ["triage_decline", { id: third.item.id, reason: "junk" }]] as const) {
      const out = await mcp.callTool({ name, arguments: args });
      expect(out.isError).toBe(true);
      expect((out as { content: { text: string }[] }).content[0].text).toMatch(/^person_only: /);
    }
    expect(data(await mcp.callTool({ name: "list_triage", arguments: {} })).count).toBe(3);
    expect((await c.post(`/api/triage/${made.item.id}/accept`, { priority: "low" })).body.task).toMatchObject({ priority: "low", triage: null });
    expect((await c.post(`/api/triage/${second.item.id}/merge`, { targetId: target.id })).body.merged).toBe(second.item.id);
    expect((await c.post(`/api/triage/${third.item.id}/decline`, { reason: "junk" })).body.ok).toBe(true);
    expect(data(await mcp.callTool({ name: "list_triage", arguments: {} })).count).toBe(0);
    const ro = (await c.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    const rmcp = await mcpFor(ro);
    expect(data(await rmcp.callTool({ name: "list_triage", arguments: {} })).count).toBe(0);
    const denied = await rmcp.callTool({ name: "create_triage_item", arguments: { title: "Nope" } });
    expect(denied.isError).toBe(true);
  });

  it("reads reply addresses and spots no-reply senders", () => {
    expect(replyAddress("Grace Lee <Grace@Harbour.coffee>")).toBe("grace@harbour.coffee");
    expect(replyAddress("sam@example.com")).toBe("sam@example.com");
    expect(replyAddress("nobody")).toBeNull();
    for (const a of ["no-reply@x.io", "noreply@x.io", "do-not-reply@x.io", "donotreply@x.io", "mailer-daemon@x.io", "bounces+123@x.io"]) expect(isNoReply(a)).toBe(true);
    expect(isNoReply("grace@harbour.coffee")).toBe(false);
  });
});
