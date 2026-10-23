import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let wsKey: string;
let mailboxId: string;

async function connect(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
  mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Acme" })).body.mailbox.id;
  wsKey = (await c.post("/api/developer/keys", { name: "Suite" })).body.secret;
});

describe("suite over the REST API", () => {
  it("makes a task from an email, updates it, and lists the change feed", async () => {
    await deliverInbound(ctx.deps, {
      envelopeFrom: "ravi@bondisurf.com.au", rcptTo: "hello@acme.io", sizeBytes: 300, via: "test",
      email: { messageId: "<q1@bondisurf.com.au>", from: { address: "ravi@bondisurf.com.au", name: "Ravi" }, to: [{ address: "hello@acme.io" }], cc: [], subject: "Wetsuit order", text: "Need 20 by Friday.", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const msg = (await api(wsKey, "GET", `/messages?mailboxId=${mailboxId}`)).body.data?.[0] ?? (await api(wsKey, "GET", `/messages?mailboxId=${mailboxId}`)).body.messages?.[0];
    const t = await api(wsKey, "POST", "/tasks/from-email", { messageId: msg.id, priority: "urgent" });
    expect(t.status).toBe(201);
    expect(t.body.task).toMatchObject({ title: "Wetsuit order", priority: "urgent", createdBy: { type: "member" } });
    const moved = await api(wsKey, "PATCH", `/tasks/${t.body.task.ref}`, { status: "doing" });
    expect(moved.body.task.status).toBe("doing");
    expect((await api(wsKey, "GET", "/tasks?status=doing")).body.tasks).toHaveLength(1);
    expect((await api(wsKey, "GET", "/contacts?q=ravi")).body.contacts[0].company.domain).toBe("bondisurf.com.au");
    const feed = (await api(wsKey, "GET", "/changes?since=0")).body;
    expect(feed.changes.map((x: { entity: string }) => x.entity)).toEqual(expect.arrayContaining(["contact", "project", "task"]));
    const spec = (await ctx.app.request("/api/v1/openapi.json", { headers: { host: "localhost" } }).then((r) => r.json())) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/tasks", "/tasks/from-email", "/tasks/{id}", "/projects", "/docs", "/contacts", "/deals", "/changes"]));
    const readKey = (await c.post("/api/developer/keys", { name: "Read", scope: "read" })).body.secret;
    expect((await api(readKey, "POST", "/tasks", { title: "x" })).status).toBe(403);
    expect((await api(readKey, "GET", "/tasks")).status).toBe(200);
  });
});

describe("suite over MCP", () => {
  it("lets an agent pick up its next task, comment and finish it, with its name on the history", async () => {
    const { agent, apiKey } = (await c.post("/api/agents", { name: "Ops bot", localPart: "ops" })).body;
    const created = (await c.post("/api/tasks", { title: "Chase the Bondi invoice", assignee: `agent:${agent.id}`, priority: "high" })).body.task;
    await c.post("/api/tasks", { title: "Low priority thing", assignee: `agent:${agent.id}`, priority: "low" });
    const mcp = await connect(apiKey.secret);
    const next = data(await mcp.callTool({ name: "next_task", arguments: {} }));
    expect(next.next.task.id).toBe(created.id);
    data(await mcp.callTool({ name: "comment_on_task", arguments: { id: created.ref, body: "Sent a reminder for approval." } }));
    const done = data(await mcp.callTool({ name: "update_task", arguments: { id: created.id, status: "done" } }));
    expect(done.task.status).toBe("done");
    const made = data(await mcp.callTool({ name: "create_task", arguments: { title: "Agent made this", labels: ["agent"] } }));
    expect(made.task.createdBy).toEqual({ type: "agent", id: agent.id });
    const listed = data(await mcp.callTool({ name: "list_tasks", arguments: { assignee: "me", status: "done" } }));
    expect(listed.tasks.map((t: { id: string }) => t.id)).toEqual([created.id]);
    const doc = data(await mcp.callTool({ name: "create_doc", arguments: { title: "Notes", text: "Called Ravi.", taskId: created.id } }));
    data(await mcp.callTool({ name: "append_to_doc", arguments: { id: doc.id, text: "He paid." } }));
    expect(data(await mcp.callTool({ name: "read_doc", arguments: { id: doc.id } })).text).toBe("Called Ravi.\nHe paid.");
    const detail = (await c.get(`/api/tasks/${created.id}`)).body;
    expect(detail.comments[0].author.type).toBe("agent");
    expect(detail.activity.some((x: { actor: { type: string }; verb: string }) => x.actor.type === "agent" && x.verb === "moved")).toBe(true);
    expect(detail.docs[0].title).toBe("Notes");
    const bad = await mcp.callTool({ name: "create_task", arguments: {} });
    expect(bad.isError).toBe(true);
    await mcp.close();
  });
});
