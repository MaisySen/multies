import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { idempotencyKeys } from "@/server/db/schema";
import { deliverInbound } from "@/server/services/mail/delivery";

/**
 * R55 (MB-239): the same id on a 5xx retry for the creates R54 left. Most were REST routes whose MCP twin already kept
 * its id (thread notes, task duplicate, mail splits, message to task, chat posts, timers, triage items, saved views, task
 * from an email); the rest needed the service to take the id (key results, checklist item to subtask over REST and MCP,
 * integrations, MCP schedule_send). The 5xx is simulated as R52 to R54 did: the first call succeeds, then its key row is
 * set back to running with a 503, and the retry runs the handler again. Each case checks the retry answers with the
 * first attempt's ids and adds nothing, and that a first attempt with a key runs the same app statements as one without.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function setup() {
  const t = await makeTestApp();
  const c = new Client(t.app);
  await c.signup("owner.retry55@acme.io", "Olive Owner");
  await c.post("/api/org/plan", { plan: "pro" });
  const owner = (await c.post("/api/developer/keys", { name: "r55" })).body.secret as string;
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
  const call = async (name: string, args: unknown, key?: string, secret = owner, id = 7) => {
    const r = await post(msg(id, name, args), keyed(key), secret);
    expect(r.status).toBe(200);
    const res = (r.json as Rpc).result;
    expect(res?.isError ?? false, res?.content?.[0]?.text).toBe(false);
    return JSON.parse(res!.content![0]!.text) as J;
  };
  const v1raw = async (method: string, path: string, body?: unknown, key?: string, secret = owner) => {
    const r = await t.app.request(`/api/v1${path}`, { method, headers: headers(secret, keyed(key)), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as J };
  };
  const v1 = async (method: string, path: string, body?: unknown, key?: string, secret = owner) => {
    const r = await v1raw(method, path, body, key, secret);
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
    return r.json;
  };
  await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "r55", version: "1" } } });
  const db = t.db as unknown as { all: (q: unknown) => { n: number }[] };
  const scalar = (q: string) => Number(db.all(sql.raw(q))[0]!.n);
  const count = (table: string) => scalar(`select count(*) as n from "${table}"`);
  const fail = (key: string) => t.db.update(idempotencyKeys).set({ state: "running", responseStatus: 503, responseBody: null }).where(eq(idempotencyKeys.key, key));
  // Statement counter (as tests/retry-id-r54.test.ts).
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
  const channel = (await v1("POST", "/chat/channels", { name: "seed-room" })).channel.id as string;
  const chat = async (body = "Please check the invoice") => (await v1("POST", `/chat/channels/${channel}/messages`, { body })).message.id as string;
  const goal = async () => (await v1("POST", "/goals", { name: "Quality" })).goal.id as string;
  const item = async () => {
    const id = await task("Checklist seed");
    const r = await v1("POST", `/tasks/${id}/checklist`, { title: "Write the release note" });
    return ((r.items ?? r.checklist ?? [r.item]) as J[]).at(-1)!.id as string;
  };
  // A project trigger on its own agent member (the queue limit is per agent), for "run now".
  let agents = 0;
  const trigger = async () => {
    const m = await call("create_agent_member", { name: `Robo ${++agents}` }, undefined, owner, 10);
    return (await v1("POST", "/agent-triggers", { agentUserId: m.member.userId, kind: "schedule", name: "Daily sweep", projectId: project, everyHours: 24 })).trigger.id as string;
  };
  // Mail: a verified domain, one inbound thread and an agent inbox, made once when a case needs them.
  let mail: { threadId: string; messageId: string; agentId: string } | undefined;
  const mailSeed = async () => {
    if (mail) return mail;
    const domainId = (await c.post("/api/domains", { name: "acme55.io" })).body.domain.id;
    const { body } = await c.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") t.dns.records.mx = { ...t.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else t.dns.records.txt = { ...t.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await c.post(`/api/domains/${domainId}/verify`);
    await c.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" });
    await deliverInbound(t.deps, {
      envelopeFrom: "grace@example.com", rcptTo: "support@acme55.io", sizeBytes: 300, via: "test",
      email: { messageId: "<r55-seed@example.com>", from: { address: "grace@example.com", name: "Grace" }, to: [{ address: "support@acme55.io" }], cc: [], subject: "Refund", text: "Hi, a refund please.", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const thread = (await c.get("/api/agents/threads")).body.data[0];
    const agent = await call("create_agent_inbox", { name: "Outreach", localPart: "outreach" }, undefined, owner, 9);
    mail = { threadId: thread.id as string, messageId: (thread.lastMessageId ?? thread.latestMessageId ?? thread.messageId) as string, agentId: agent.agent.id as string };
    return mail;
  };
  return { t, c, owner, post, msg, call, v1, v1raw, scalar, count, fail, measure, project, task, channel, chat, goal, item, trigger, mailSeed };
}
type S = Awaited<ReturnType<typeof setup>>;

/** What a case does: prepare once (no key), then run the keyed create; `ids` reads the answer, `rows` what must not grow. */
type Case = { name: string; prep: (s: S) => Promise<J>; run: (s: S, p: J, key: string) => Promise<J>; ids: (j: J) => unknown[]; rows: (s: S) => number[] };
const HOOK_SECRET = `v1,whsec_${Buffer.from("supabase-hook-secret-r55-0123456789").toString("base64")}`;
const LATER = new Date(Date.now() + 3 * 86_400_000).toISOString(); // fixed: a retry must send the same body
const later = () => LATER;
const cases: Case[] = [
  // REST routes whose services already took the id
  { name: "REST POST /threads/{id}/comments", prep: async (s) => s.mailSeed(), run: (s, p, k) => s.v1("POST", `/threads/${p.threadId}/comments`, { body: "Refund approved" }, k), ids: (j) => [j.comment.id], rows: (s) => [s.count("thread_comments")] },
  { name: "REST POST /tasks/from-email", prep: async (s) => s.mailSeed(), run: (s, p, k) => s.v1("POST", "/tasks/from-email", { threadId: p.threadId, projectId: s.project }, k), ids: (j) => [j.task.id], rows: (s) => [s.count("tasks")] },
  { name: "REST POST /tasks/{id}/duplicate", prep: async (s) => ({ task: await s.task("Copy me") }), run: (s, p, k) => s.v1("POST", `/tasks/${p.task}/duplicate`, {}, k), ids: (j) => [(j.task ?? j).id], rows: (s) => [s.count("tasks")] },
  { name: "REST POST /mail/splits", prep: async () => ({}), run: (s, _p, k) => s.v1("POST", "/mail/splits", { name: "Vendors", rules: [{ field: "fromDomain", value: "vendor.io" }] }, k), ids: (j) => [j.split.id], rows: (s) => [s.count("mail_splits")] },
  { name: "REST POST /chat/messages/{id}/task", prep: async (s) => ({ m: await s.chat() }), run: (s, p, k) => s.v1("POST", `/chat/messages/${p.m}/task`, { projectId: s.project }, k), ids: (j) => [j.task.id], rows: (s) => [s.count("tasks")] },
  { name: "REST POST /chat/channels/{id}/messages", prep: async () => ({}), run: (s, _p, k) => s.v1("POST", `/chat/channels/${s.channel}/messages`, { body: "Posted once" }, k), ids: (j) => [j.message.id], rows: (s) => [s.count("chat_messages")] },
  { name: "REST POST /goals/{id}/key-results", prep: async (s) => ({ goal: await s.goal() }), run: (s, p, k) => s.v1("POST", `/goals/${p.goal}/key-results`, { name: "Open bugs", kind: "number", target: 0, current: 10 }, k), ids: (j) => [j.keyResult.id], rows: (s) => [s.count("key_results")] },
  { name: "REST POST /time/start", prep: async (s) => ({ task: await s.task("Time me") }), run: (s, p, k) => s.v1("POST", "/time/start", { taskId: p.task }, k), ids: (j) => [j.entry.id], rows: (s) => [s.count("time_entries")] },
  { name: "REST POST /triage", prep: async () => ({}), run: (s, _p, k) => s.v1("POST", "/triage", { title: "Call back Priya", from: "priya@example.com" }, k), ids: (j) => [j.item.id], rows: (s) => [s.count("tasks")] },
  { name: "REST POST /views", prep: async () => ({}), run: (s, _p, k) => s.v1("POST", "/views", { name: "My board", view: "list" }, k), ids: (j) => [j.view.id], rows: (s) => [s.count("saved_views")] },
  { name: "REST POST /checklist-items/{id}/to-subtask", prep: async (s) => ({ item: await s.item() }), run: (s, p, k) => s.v1("POST", `/checklist-items/${p.item}/to-subtask`, undefined, k), ids: (j) => [j.task.id, j.removedItemId], rows: (s) => [s.count("tasks"), s.count("task_checklist_items")] },
  { name: "REST POST /integrations", prep: async () => ({}), run: (s, _p, k) => s.v1("POST", "/integrations", { connector: "n8n", url: "https://n8n.example.com/webhook/1" }, k), ids: (j) => [j.connection.id, j.secret], rows: (s) => [s.count("webhook_endpoints")] },
  { name: "REST POST /agent-triggers/{id}/run (project trigger)", prep: async (s) => ({ trg: await s.trigger() }), run: (s, p, k) => s.v1("POST", `/agent-triggers/${p.trg}/run`, undefined, k), ids: (j) => [j.fired.runId, j.fired.taskId, j.fired.taskRef], rows: (s) => [s.count("agent_runs"), s.count("tasks"), s.scalar("select coalesce(sum(fire_count), 0) as n from agent_triggers")] },
  { name: "REST POST /auth-email-hooks", prep: async (s) => s.mailSeed(), run: (s, _p, k) => s.v1("POST", "/auth-email-hooks", { from: "support@acme55.io", secret: HOOK_SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Acme" }, k), ids: (j) => [j.hook.id, j.hook.url], rows: (s) => [s.count("auth_email_hooks")] },
  // MCP tools
  { name: "MCP checklist_item_to_subtask", prep: async (s) => ({ item: await s.item() }), run: (s, p, k) => s.call("checklist_item_to_subtask", { itemId: p.item }, k), ids: (j) => [j.task.id, j.removedItemId], rows: (s) => [s.count("tasks"), s.count("task_checklist_items")] },
  { name: "MCP schedule_send", prep: async (s) => s.mailSeed(), run: (s, p, k) => s.call("schedule_send", { agentId: p.agentId, to: ["lead@example.com"], subject: "Intro", text: "Hello", at: later() }, k), ids: (j) => [j.id], rows: (s) => [s.count("mail_schedules")] },
];

describe("creates keep the same id on a 5xx retry (R55 MB-239)", () => {
  it.each(cases)("$name: the retry answers with the first attempt's ids and adds nothing", async (k) => {
    const s = await setup();
    const p = await k.prep(s);
    const key = `r55-${k.name.replace(/[^a-z0-9]+/gi, "-")}-0001`;
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

  it("a different body under the same key answers the existing conflict (422 idempotency_key_reused)", async () => {
    const s = await setup();
    const key = "r55-conflict-views-0001";
    await s.v1("POST", "/views", { name: "First", view: "list" }, key);
    const other = await s.v1raw("POST", "/views", { name: "Second", view: "list" }, key);
    expect(other.status).toBe(422);
    expect(other.json.error.code).toBe("idempotency_key_reused");
    await s.fail(key);
    const again = await s.v1raw("POST", "/views", { name: "Second", view: "list" }, key);
    expect(again.status).toBe(422);
    expect(s.count("saved_views")).toBe(1);
  }, 60_000);

  it("a subtask retried after the first attempt was cut off between its two writes still removes the item once", async () => {
    const s = await setup();
    const itemId = await s.item();
    const key = "r55-subtask-cut-0001";
    const first = await s.v1("POST", `/checklist-items/${itemId}/to-subtask`, undefined, key);
    // Put the item back as if the first attempt stopped after making the subtask.
    const parent = (await s.v1("GET", `/tasks/${first.task.id}`)).task.parentId as string;
    await s.v1("POST", `/tasks/${parent}/checklist`, { title: "Write the release note" });
    const n = s.count("task_checklist_items");
    const stray = ((await s.v1("GET", `/tasks/${parent}/checklist`)).items as J[]).at(-1)!.id as string;
    await s.fail(key);
    // The retry carries the original item id; the stray copy above has its own id and is left alone.
    const retry = await s.v1("POST", `/checklist-items/${itemId}/to-subtask`, undefined, key);
    expect(retry.task.id).toBe(first.task.id);
    expect(s.count("task_checklist_items")).toBe(n);
    expect(stray).not.toBe(itemId);
  }, 60_000);

  it("without a key nothing changes: random ids, and the same call twice makes two", async () => {
    const s = await setup();
    const a = await s.v1("POST", "/views", { name: "Twice", view: "list" });
    const b = await s.v1("POST", "/views", { name: "Twice", view: "list" });
    expect(a.view.id).not.toBe(b.view.id);
    const g = await s.goal();
    const k1 = await s.v1("POST", `/goals/${g}/key-results`, { name: "Same", kind: "number", target: 1 });
    const k2 = await s.v1("POST", `/goals/${g}/key-results`, { name: "Same", kind: "number", target: 1 });
    expect(k1.keyResult.id).not.toBe(k2.keyResult.id);
  }, 60_000);

  it("a first attempt with a key runs the same app statements as a call without one (no extra read)", async () => {
    const s = await setup();
    const m = await s.mailSeed();
    const tasks = [await s.task("A"), await s.task("B"), await s.task("C")];
    const goals = [await s.goal(), await s.goal(), await s.goal()];
    const chats = [await s.chat("one"), await s.chat("two"), await s.chat("three")];
    const triggers = [await s.trigger(), await s.trigger(), await s.trigger()];
    const items = [await s.item(), await s.item(), await s.item(), await s.item(), await s.item(), await s.item()];
    type Op = [string, (n: number, key?: string) => Promise<unknown>];
    const ops: Op[] = [
      ["POST /threads/{id}/comments", (n, k) => s.v1("POST", `/threads/${m.threadId}/comments`, { body: `Note ${n}` }, k)],
      ["POST /tasks/from-email", (_n, k) => s.v1("POST", "/tasks/from-email", { threadId: m.threadId, projectId: s.project }, k)],
      ["POST /tasks/{id}/duplicate", (n, k) => s.v1("POST", `/tasks/${tasks[n]}/duplicate`, {}, k)],
      ["POST /mail/splits", (n, k) => s.v1("POST", "/mail/splits", { name: `Split ${n}`, rules: [{ field: "fromDomain", value: `v${n}.io` }] }, k)],
      ["POST /chat/messages/{id}/task", (n, k) => s.v1("POST", `/chat/messages/${chats[n]}/task`, { projectId: s.project }, k)],
      ["POST /chat/channels/{id}/messages", (n, k) => s.v1("POST", `/chat/channels/${s.channel}/messages`, { body: `Hello ${n}` }, k)],
      ["POST /goals/{id}/key-results", (n, k) => s.v1("POST", `/goals/${goals[n]}/key-results`, { name: `KR ${n}`, kind: "number", target: 3 }, k)],
      ["POST /triage", (n, k) => s.v1("POST", "/triage", { title: `Item ${n}` }, k)],
      ["POST /views", (n, k) => s.v1("POST", "/views", { name: `View ${n}`, view: "list" }, k)],
      ["POST /checklist-items/{id}/to-subtask", (n, k) => s.v1("POST", `/checklist-items/${items[n]}/to-subtask`, undefined, k)],
      ["POST /integrations", (n, k) => s.v1("POST", "/integrations", { connector: "n8n", url: `https://n8n.example.com/webhook/${n}` }, k)],
      ["POST /agent-triggers/{id}/run", (n, k) => s.v1("POST", `/agent-triggers/${triggers[n]}/run`, undefined, k)],
      ["POST /auth-email-hooks", (n, k) => s.v1("POST", "/auth-email-hooks", { from: "support@acme55.io", secret: HOOK_SECRET, supabaseUrl: `https://abcd123${n}.supabase.co` }, k)],
      ["checklist_item_to_subtask", (n, k) => s.call("checklist_item_to_subtask", { itemId: items[n + 3] }, k)],
      ["schedule_send", (n, k) => s.call("schedule_send", { agentId: m.agentId, to: ["lead@example.com"], subject: `Intro ${n}`, text: "Hello", at: later() }, k)],
    ];
    const counts: Record<string, [number, number]> = {};
    for (const [name, op] of ops) {
      await op(0); // warm the read caches, so both measured calls start alike
      const plain = await s.measure(() => op(1));
      const keyed = await s.measure(() => op(2, `r55-count-${name.replace(/[^a-z0-9]+/gi, "-")}-0001`));
      const app = (x: string[]) => x.filter((q) => !/idempotency_keys/i.test(q));
      counts[name] = [app(plain.statements).length, app(keyed.statements).length];
      expect(app(keyed.statements).length, name).toBe(app(plain.statements).length);
    }
    console.log("R55 first attempt app statements (no key, keyed):", JSON.stringify(counts));
  }, 180_000);
});
