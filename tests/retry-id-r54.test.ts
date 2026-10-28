import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { idempotencyKeys } from "@/server/db/schema";
import { deliverInbound } from "@/server/services/mail/delivery";

/**
 * R54 (MB-239): the same id on a 5xx retry for the creates R53 left: templates (create and use), doc versions, agent
 * runs and their steps, meeting action items (one id per item), dashboard widgets, content reports, incoming hooks
 * (the same URL, no second token) and agent triggers (the committed secret), over MCP and over REST. The 5xx is
 * simulated as R52 and R53 did: the first call succeeds, then its key row is set back to running with a 503, and the
 * retry runs the handler again. Each case checks the retry answers with the first attempt's ids and adds nothing.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function setup() {
  const t = await makeTestApp();
  const c = new Client(t.app);
  await c.signup("owner.retry54@acme.io", "Olive Owner");
  const owner = (await c.post("/api/developer/keys", { name: "r54" })).body.secret as string;
  const headers = (secret: string, extra: Record<string, string>) => ({ host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });
  const keyed = (key?: string): Record<string, string> => (key ? { "idempotency-key": key } : {});
  const post = async (body: unknown, extra: Record<string, string> = {}, secret = owner) => {
    const r = await t.app.request("/api/v1/mcp", { method: "POST", headers: headers(secret, extra), body: JSON.stringify(body) });
    const text = await r.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return { status: r.status, json: JSON.parse(line ? line.slice(6) : text) as unknown };
  };
  const msg = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  type Rpc = { result?: { content?: { text: string }[]; isError?: boolean } };
  const out = (r: Rpc) => {
    expect(r.result?.isError ?? false, r.result?.content?.[0]?.text).toBe(false);
    return JSON.parse(r.result!.content![0]!.text) as J;
  };
  const call = async (name: string, args: unknown, key?: string, secret = owner, id = 7) => {
    const r = await post(msg(id, name, args), keyed(key), secret);
    expect(r.status).toBe(200);
    return out(r.json as Rpc);
  };
  const v1 = async (method: string, path: string, body?: unknown, key?: string, secret = owner) => {
    const r = await t.app.request(`/api/v1${path}`, { method, headers: headers(secret, keyed(key)), body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json()) as J;
    expect(r.status, JSON.stringify(j)).toBeLessThan(300);
    return j;
  };
  await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "r54", version: "1" } } });
  const db = t.db as unknown as { all: (q: unknown) => { n: number }[] };
  const scalar = (q: string) => Number(db.all(sql.raw(q))[0]!.n);
  const count = (table: string) => scalar(`select count(*) as n from "${table}"`);
  const fail = (key: string) => t.db.update(idempotencyKeys).set({ state: "running", responseStatus: 503, responseBody: null }).where(eq(idempotencyKeys.key, key));
  // Statement counter (as tests/webhooks-r52.test.ts and tests/mcp-idempotency-r53.test.ts).
  const client = (t.db as unknown as { $client: { prepare: (q: string) => Record<string, (...a: unknown[]) => unknown> } }).$client;
  const prepare = client.prepare.bind(client);
  let log: string[] | null = null;
  client.prepare = (q: string) => {
    const st = prepare(q);
    for (const fn of ["run", "all", "get", "raw", "values"]) {
      if (typeof st[fn] !== "function") continue;
      const orig = st[fn].bind(st);
      st[fn] = (...a: unknown[]) => { log?.push(q); return orig(...a); };
    }
    return st;
  };
  const measure = async <T>(fn: () => Promise<T>) => { log = []; const r = await fn(); const statements = log; log = null; return { r, statements }; };

  // Seeds every case can use.
  const project = (await v1("POST", "/projects", { name: "Seed" })).project.id as string;
  const task = async (title = "Seed") => (await v1("POST", "/tasks", { title, projectId: project })).task.id as string;
  const made = await call("create_agent_member", { name: "Robo Helper" }, undefined, owner, 2);
  const agentUserId = made.member.userId as string;
  const agent = made.secret as string;
  await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "r54a", version: "1" } } }, {}, agent);
  const meeting = async () => (await call("schedule_meeting", { title: "Seed meeting", startsAt: new Date(Date.now() + 86_400_000).toISOString() }, undefined, owner, 3)).meeting.id as string;
  const doc = async () => (await call("create_doc", { title: "Seed doc", text: "Hello" }, undefined, owner, 4)).id as string;
  const dashboard = async () => (await call("create_dashboard", { name: "Seed board" }, undefined, owner, 5)).dashboard.id as string;
  const template = async (kind: "task" | "doc") => (await call("create_template", kind === "task" ? { kind, data: { title: "Seed task tpl" } } : { kind, data: { title: "Seed doc tpl", text: "Body" } }, undefined, owner, 6)).template.id as string;
  const queuedRun = async () => (await call("start_task_run", { taskId: await task("Run seed"), agentUserId }, undefined, owner, 8)).run.id as string;
  return { t, owner, agent, post, msg, out, call, v1, scalar, count, fail, measure, project, task, agentUserId, meeting, doc, dashboard, template, queuedRun };
}
type S = Awaited<ReturnType<typeof setup>>;

/** What a case does: prepare once (no key), then run the keyed create; `ids` reads the answer, `rows` what must not grow. */
type Case = { name: string; prep: (s: S) => Promise<J>; run: (s: S, p: J, key: string) => Promise<J>; ids: (j: J) => unknown[]; rows: (s: S) => number[] };
const widgets = "select coalesce(sum(json_array_length(layout, '$.widgets')), 0) as n from dashboards";
const steps = "select coalesce(sum(step_count), 0) as n from agent_runs";
const docText = "select coalesce(sum(length(content)), 0) as n from docs";
const cases: Case[] = [
  // MCP tools
  { name: "MCP create_template", prep: async () => ({}), run: (s, _p, k) => s.call("create_template", { kind: "task", data: { title: "Retry tpl" } }, k), ids: (j) => [j.template.id], rows: (s) => [s.count("templates")] },
  { name: "MCP use_template (task)", prep: async (s) => ({ tpl: await s.template("task") }), run: (s, p, k) => s.call("use_template", { templateId: p.tpl, projectId: s.project }, k), ids: (j) => [j.task.id], rows: (s) => [s.count("tasks")] },
  { name: "MCP use_template (doc)", prep: async (s) => ({ tpl: await s.template("doc") }), run: (s, p, k) => s.call("use_template", { templateId: p.tpl }, k), ids: (j) => [j.doc.id], rows: (s) => [s.count("docs")] },
  { name: "MCP save_doc_version", prep: async (s) => ({ doc: await s.doc() }), run: (s, p, k) => s.call("save_doc_version", { docId: p.doc, name: "Retry version" }, k), ids: (j) => [j.version.id], rows: (s) => [s.count("doc_versions")] },
  { name: "MCP start_task_run", prep: async (s) => ({ task: await s.task("Run me") }), run: (s, p, k) => s.call("start_task_run", { taskId: p.task, agentUserId: s.agentUserId }, k), ids: (j) => [j.run.id], rows: (s) => [s.count("agent_runs")] },
  { name: "MCP add_run_step", prep: async (s) => ({ run: await s.queuedRun() }), run: (s, p, k) => s.call("add_run_step", { runId: p.run, kind: "note", text: "Read the brief" }, k, s.agent), ids: (j) => [j.runId, j.stepCount, j.step.text], rows: (s) => [s.scalar(steps)] },
  { name: "MCP create_action_items", prep: async (s) => ({ meeting: await s.meeting() }), run: (s, p, k) => s.call("create_action_items", { meetingId: p.meeting, items: [{ title: "Send the deck" }, { title: "Book the room" }] }, k),
    ids: (j) => (j.created as J[]).map((x) => x.id).sort(), rows: (s) => [s.count("tasks"), s.count("meeting_action_items"), s.scalar(docText)] },
  { name: "MCP add_dashboard_widget", prep: async (s) => ({ dash: await s.dashboard() }), run: (s, p, k) => s.call("add_dashboard_widget", { dashboardId: p.dash, type: "count" }, k), ids: (j) => (j.dashboard.widgets as J[]).map((w) => w.id), rows: (s) => [s.scalar(widgets)] },
  { name: "MCP create_report", prep: async () => ({}), run: (s, _p, k) => s.call("create_report", { targetType: "user", userId: s.agentUserId, reason: "spam" }, k), ids: (j) => [j.id], rows: (s) => [s.count("content_reports")] },
  { name: "MCP create_incoming_hook", prep: async () => ({}), run: (s, _p, k) => s.call("create_incoming_hook", { name: "Retry hook", action: "task", projectId: s.project }, k), ids: (j) => [j.hook.id, j.token, j.url], rows: (s) => [s.count("incoming_hooks")] },
  { name: "MCP create_agent_trigger (webhook)", prep: async (s) => ({ task: await s.task("Trigger me") }), run: (s, p, k) => s.call("create_agent_trigger", { agentUserId: s.agentUserId, kind: "webhook", name: "Retry trigger", taskId: p.task }, k), ids: (j) => [j.trigger.id, j.secret], rows: (s) => [s.count("agent_triggers")] },
  // REST routes over the same services
  { name: "REST POST /templates", prep: async () => ({}), run: (s, _p, k) => s.v1("POST", "/templates", { kind: "task", data: { title: "Retry tpl" } }, k), ids: (j) => [j.template.id], rows: (s) => [s.count("templates")] },
  { name: "REST POST /templates/{id}/use", prep: async (s) => ({ tpl: await s.template("task") }), run: (s, p, k) => s.v1("POST", `/templates/${p.tpl}/use`, { projectId: s.project }, k), ids: (j) => [j.task.id], rows: (s) => [s.count("tasks")] },
  { name: "REST POST /docs/{id}/versions", prep: async (s) => ({ doc: await s.doc() }), run: (s, p, k) => s.v1("POST", `/docs/${p.doc}/versions`, { name: "Retry version" }, k), ids: (j) => [j.version.id], rows: (s) => [s.count("doc_versions")] },
  { name: "REST POST /tasks/{id}/runs", prep: async (s) => ({ task: await s.task("Run me") }), run: (s, p, k) => s.v1("POST", `/tasks/${p.task}/runs`, { agentUserId: s.agentUserId }, k), ids: (j) => [j.run.id], rows: (s) => [s.count("agent_runs")] },
  { name: "REST POST /runs/{id}/steps", prep: async (s) => ({ run: await s.queuedRun() }), run: (s, p, k) => s.v1("POST", `/runs/${p.run}/steps`, { kind: "note", text: "Read the brief" }, k, s.agent), ids: (j) => [j.runId, j.stepCount, j.step.text], rows: (s) => [s.scalar(steps)] },
  { name: "REST POST /meetings/{id}/action-items", prep: async (s) => ({ meeting: await s.meeting() }), run: (s, p, k) => s.v1("POST", `/meetings/${p.meeting}/action-items`, { items: [{ title: "Send the deck" }, { title: "Book the room" }] }, k),
    ids: (j) => (j.created as J[]).map((x) => x.id).sort(), rows: (s) => [s.count("tasks"), s.count("meeting_action_items"), s.scalar(docText)] },
  { name: "REST POST /dashboards/{id}/widgets", prep: async (s) => ({ dash: await s.dashboard() }), run: (s, p, k) => s.v1("POST", `/dashboards/${p.dash}/widgets`, { type: "count" }, k), ids: (j) => (j.dashboard.widgets as J[]).map((w) => w.id), rows: (s) => [s.scalar(widgets)] },
  { name: "REST POST /dashboards", prep: async () => ({}), run: (s, _p, k) => s.v1("POST", "/dashboards", { name: "Retry board" }, k), ids: (j) => [j.dashboard.id], rows: (s) => [s.count("dashboards")] },
  { name: "REST POST /reports", prep: async () => ({}), run: (s, _p, k) => s.v1("POST", "/reports", { targetType: "user", userId: s.agentUserId, reason: "spam" }, k), ids: (j) => [j.id], rows: (s) => [s.count("content_reports")] },
  { name: "REST POST /incoming-hooks", prep: async () => ({}), run: (s, _p, k) => s.v1("POST", "/incoming-hooks", { name: "Retry hook", action: "task", config: { projectId: s.project } }, k), ids: (j) => [j.hook.id, j.token, j.url], rows: (s) => [s.count("incoming_hooks")] },
  { name: "REST POST /agent-triggers (webhook)", prep: async (s) => ({ task: await s.task("Trigger me") }), run: (s, p, k) => s.v1("POST", "/agent-triggers", { agentUserId: s.agentUserId, kind: "webhook", name: "Retry trigger", taskId: p.task }, k), ids: (j) => [j.trigger.id, j.secret], rows: (s) => [s.count("agent_triggers")] },
];

describe("creates keep the same id on a 5xx retry (R54 MB-239)", () => {
  it.each(cases)("$name: the retry answers with the first attempt's ids and adds nothing", async (k) => {
    const s = await setup();
    const p = await k.prep(s);
    const key = `r54-${k.name.replace(/[^a-z0-9]+/gi, "-")}-0001`;
    const first = await k.run(s, p, key);
    const ids = k.ids(first);
    expect(ids.every((x) => x !== undefined && x !== null)).toBe(true);
    const rows = k.rows(s);
    await s.fail(key);
    const retry = await k.run(s, p, key);
    expect(k.ids(retry)).toEqual(ids);
    expect(k.rows(s)).toEqual(rows);
    // The retry's answer is stored now: a third call replays it.
    expect(k.ids(await k.run(s, p, key))).toEqual(ids);
    expect(k.rows(s)).toEqual(rows);
  }, 60_000);

  it("an incoming hook made on a retry still works: its one URL takes a call", async () => {
    const s = await setup();
    const first = await s.call("create_incoming_hook", { name: "Live hook", action: "task", projectId: s.project }, "r54-hook-live-0001");
    await s.fail("r54-hook-live-0001");
    const retry = await s.call("create_incoming_hook", { name: "Live hook", action: "task", projectId: s.project }, "r54-hook-live-0001");
    expect(retry.url).toBe(first.url);
    const before = s.count("tasks");
    const r = await s.t.app.request(new URL(retry.url as string).pathname, { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ title: "From the hook" }) });
    expect(r.status).toBeLessThan(300);
    expect(s.count("tasks")).toBe(before + 1);
  }, 60_000);

  it("a JSON-RPC batch with two create_action_items gets distinct ids that stay the same across a retry", async () => {
    const s = await setup();
    const [m1, m2] = [await s.meeting(), await s.meeting()];
    const key = "r54-batch-actions-0001";
    const body = [s.msg(21, "create_action_items", { meetingId: m1, items: [{ title: "One" }] }), s.msg(22, "create_action_items", { meetingId: m2, items: [{ title: "Two" }] })];
    const ids = (r: unknown) => (r as { id: number; result: { content: { text: string }[] } }[]).sort((a, b) => a.id - b.id).map((m) => (JSON.parse(m.result.content[0]!.text) as { created: { id: string }[] }).created.map((x) => x.id)).flat();
    const first = await s.post(body, { "idempotency-key": key });
    const a = ids(first.json);
    expect(a).toHaveLength(2);
    expect(a[0]).not.toBe(a[1]);
    const n = s.count("tasks");
    await s.fail(key);
    expect(ids((await s.post(body, { "idempotency-key": key })).json)).toEqual(a);
    expect(s.count("tasks")).toBe(n);
  }, 60_000);

  it("without a key nothing changes: random ids, and the same call twice makes two", async () => {
    const s = await setup();
    const dash = await s.dashboard();
    const one = await s.call("add_dashboard_widget", { dashboardId: dash, type: "count" });
    const two = await s.call("add_dashboard_widget", { dashboardId: dash, type: "count" });
    expect((two.dashboard.widgets as J[]).length).toBe((one.dashboard.widgets as J[]).length + 1);
    const m = await s.meeting();
    const n = s.count("tasks");
    const a = await s.call("create_action_items", { meetingId: m, items: [{ title: "Same" }] });
    const b = await s.call("create_action_items", { meetingId: m, items: [{ title: "Same" }] });
    expect(a.created[0].id).not.toBe(b.created[0].id);
    expect(s.count("tasks")).toBe(n + 2);
    const t1 = await s.call("create_template", { kind: "task", data: { title: "Twice" } });
    const t2 = await s.call("create_template", { kind: "task", data: { title: "Twice" } });
    expect(t1.template.id).not.toBe(t2.template.id);
  }, 60_000);

  it("a first attempt with a key runs the same app statements as a call without one (no extra read)", async () => {
    const s = await setup();
    const dash = await s.dashboard();
    const docId = await s.doc();
    const tpl = await s.template("task");
    const m = [await s.meeting(), await s.meeting(), await s.meeting()];
    const tasks = [await s.task("A"), await s.task("B"), await s.task("C")];
    const runs = [await s.queuedRun(), await s.queuedRun(), await s.queuedRun()];
    const tools: [string, (n: number) => unknown, string?][] = [
      ["create_template", () => ({ kind: "task", data: { title: "Count" } })],
      ["use_template", () => ({ templateId: tpl, projectId: s.project })],
      ["save_doc_version", () => ({ docId, name: "Count" })],
      ["start_task_run", (n) => ({ taskId: tasks[n], agentUserId: s.agentUserId })],
      ["add_run_step", (n) => ({ runId: runs[n], kind: "note", text: "Count" }), s.agent],
      ["create_action_items", (n) => ({ meetingId: m[n], items: [{ title: "Count one" }, { title: "Count two" }] })],
      ["add_dashboard_widget", () => ({ dashboardId: dash, type: "count" })],
      ["create_report", () => ({ targetType: "user", userId: s.agentUserId, reason: "spam" })],
      ["create_incoming_hook", () => ({ name: "Count", action: "task", projectId: s.project })],
      ["create_agent_trigger", (n) => ({ agentUserId: s.agentUserId, kind: "webhook", name: `Count ${n}`, taskId: tasks[n] })],
    ];
    const counts: Record<string, [number, number]> = {};
    for (const [tool, args, secret] of tools) {
      await s.call(tool, args(0), undefined, secret ?? s.owner, 30); // warm the read caches, so both measured calls start alike
      const plain = await s.measure(() => s.call(tool, args(1), undefined, secret ?? s.owner, 31));
      const keyed = await s.measure(() => s.call(tool, args(2), `r54-count-${tool}-0001`, secret ?? s.owner, 32));
      const app = (x: string[]) => x.filter((q) => !/idempotency_keys/i.test(q));
      counts[tool] = [app(plain.statements).length, app(keyed.statements).length];
      expect(app(keyed.statements).length, tool).toBe(app(plain.statements).length);
    }
    console.log("R54 first attempt app statements (no key, keyed):", JSON.stringify(counts));
  }, 120_000);
});

describe("add_thread_comment keeps the same id on a 5xx retry (R53 listed it without a test)", () => {
  it("the retry returns the first note and adds none", async () => {
    const t = await makeTestApp();
    const owner = new Client(t.app);
    await owner.signup("owner.notes54@acme.io", "Olive Owner");
    await owner.post("/api/org/plan", { plan: "pro" });
    const domainId = (await owner.post("/api/domains", { name: "acme54.io" })).body.domain.id;
    const { body } = await owner.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") t.dns.records.mx = { ...t.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else t.dns.records.txt = { ...t.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await owner.post(`/api/domains/${domainId}/verify`);
    await owner.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" });
    await deliverInbound(t.deps, {
      envelopeFrom: "grace@example.com", rcptTo: "support@acme54.io", sizeBytes: 300, via: "test",
      email: { messageId: "<r54-note@example.com>", from: { address: "grace@example.com", name: "Grace" }, to: [{ address: "support@acme54.io" }], cc: [], subject: "Refund", text: "Hi, a refund please.", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const threadId = (await owner.get("/api/agents/threads")).body.data[0].id as string;
    const secret = (await owner.post("/api/developer/keys", { name: "notes" })).body.secret as string;
    const post = async (body: unknown, key: string) => {
      const r = await t.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json, text/event-stream", "idempotency-key": key }, body: JSON.stringify(body) });
      const text = await r.text();
      const line = text.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse(line ? line.slice(6) : text) as { result: { content: { text: string }[]; isError?: boolean } };
    };
    await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "r54n", version: "1" } } }, "r54-note-init");
    const add = async () => {
      const r = await post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "add_thread_comment", arguments: { threadId, body: "Refund approved" } } }, "r54-note-0001");
      expect(r.result.isError ?? false, r.result.content[0]!.text).toBe(false);
      return (JSON.parse(r.result.content[0]!.text) as { comment: { id: string } }).comment.id;
    };
    const db = t.db as unknown as { all: (q: unknown) => { n: number }[] };
    const notes = () => Number(db.all(sql.raw(`select count(*) as n from thread_comments`))[0]!.n);
    const id = await add();
    expect(notes()).toBe(1);
    await t.db.update(idempotencyKeys).set({ state: "running", responseStatus: 503, responseBody: null }).where(eq(idempotencyKeys.key, "r54-note-0001"));
    expect(await add()).toBe(id);
    expect(notes()).toBe(1);
  }, 60_000);
});
