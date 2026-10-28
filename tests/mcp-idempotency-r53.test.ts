import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { idempotencyKeys } from "@/server/db/schema";

/**
 * R53 (MB-239): the same id on a retry inside MCP write tools. POST /mcp replays a stored answer for a repeated
 * Idempotency-Key (R52). The case left was a first attempt that committed and then answered 5xx (or was cut off):
 * the retry runs the tool again. Each create tool now takes the stable id the v1 routes use, so the retry returns
 * the first attempt's row and the table keeps exactly one. The 5xx is simulated as R40 and R52 did: the first call
 * succeeds, then its key row is set back to running with a 503. A JSON-RPC batch gives each message its own id.
 */
type Seed = { project: string; task: string; channel: string; message: string };
type Case = { tool: string; table: string; args: (s: Seed) => Record<string, unknown>; pick: (j: Record<string, unknown>) => string[]; domain?: boolean };
const startsAt = new Date(Date.now() + 86_400_000).toISOString();
const at = (k: string) => (j: Record<string, unknown>) => [(j[k] as { id: string }).id];
const ics = readFileSync(join(__dirname, "fixtures/import", "calendar.ics"), "utf8");
const cases: Case[] = [
  { tool: "create_task", table: "tasks", args: (s) => ({ title: "Retry task", projectId: s.project }), pick: at("task") },
  { tool: "comment_on_task", table: "task_comments", args: (s) => ({ id: s.task, body: "Retry comment" }), pick: at("comment") },
  { tool: "create_doc", table: "docs", args: () => ({ title: "Retry doc", text: "Hello" }), pick: (j) => [j.id as string] },
  { tool: "schedule_meeting", table: "meetings", args: () => ({ title: "Retry meeting", startsAt }), pick: at("meeting") },
  { tool: "create_form", table: "forms", args: () => ({ name: "Retry form" }), pick: at("form") },
  { tool: "create_goal", table: "goals", args: () => ({ name: "Retry goal" }), pick: at("goal") },
  { tool: "log_time", table: "time_entries", args: (s) => ({ minutes: 30, taskId: s.task }), pick: at("entry") },
  { tool: "start_timer", table: "time_entries", args: (s) => ({ taskId: s.task }), pick: at("entry") },
  { tool: "create_agent_inbox", table: "agents", args: () => ({ name: "Retry bot", localPart: "retrybot53", approvalMode: "always" }), pick: (j) => [((j.agent ?? j) as { id: string }).id], domain: true },
  { tool: "create_snippet", table: "mail_snippets", args: () => ({ name: "Retry reply", body: "Hello", shortcut: "retry53" }), pick: at("snippet") },
  { tool: "create_custom_field", table: "custom_fields", args: (s) => ({ projectId: s.project, name: "Retry field", type: "text" }), pick: at("field") },
  { tool: "add_checklist_items", table: "task_checklist_items", args: (s) => ({ taskId: s.task, items: [{ title: "One" }, { title: "Two" }] }),
    pick: (j) => (j.items as { id: string }[]).map((x) => x.id) },
  { tool: "create_sprint", table: "sprints", args: (s) => ({ projectId: s.project, name: "Retry sprint" }), pick: at("sprint") },
  { tool: "post_message", table: "chat_messages", args: (s) => ({ channelId: s.channel, body: "Retry message" }), pick: at("message") },
  { tool: "create_triage_item", table: "tasks", args: () => ({ title: "Retry triage" }), pick: at("item") },
  { tool: "message_to_task", table: "tasks", args: (s) => ({ messageId: s.message }), pick: at("task") },
  { tool: "duplicate_task", table: "tasks", args: (s) => ({ taskId: s.task }), pick: at("task") },
  { tool: "create_dashboard", table: "dashboards", args: () => ({ name: "Retry board" }), pick: at("dashboard") },
  { tool: "create_saved_view", table: "saved_views", args: () => ({ name: "Retry view", view: "list" }), pick: at("view") },
  { tool: "mail_split_create", table: "mail_splits", args: () => ({ name: "Pitches", rules: [{ field: "subjectContains", value: "pitch" }] }), pick: at("split") },
  { tool: "import_file", table: "meetings", args: () => ({ kind: "calendar", fileName: "calendar.ics", content: ics }), pick: (j) => [(j.move as { id: string }).id] },
];

async function setup() {
  const t = await makeTestApp();
  const c = new Client(t.app);
  await c.signup("owner.mcp53@acme.io", "Olive Owner");
  const secret = (await c.post("/api/developer/keys", { name: "mcp" })).body.secret as string;
  const headers = (extra: Record<string, string>) => ({ host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });
  const post = async (body: unknown, extra: Record<string, string> = {}) => {
    const r = await t.app.request("/api/v1/mcp", { method: "POST", headers: headers(extra), body: JSON.stringify(body) });
    const text = await r.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return { status: r.status, json: JSON.parse(line ? line.slice(6) : text) as unknown };
  };
  const v1 = async (method: string, path: string, body?: unknown) => {
    const r = await t.app.request(`/api/v1${path}`, { method, headers: headers({}), body: body === undefined ? undefined : JSON.stringify(body) });
    return (await r.json()) as Record<string, { id: string }>;
  };
  await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "r53", version: "1" } } });
  const msg = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  type Rpc = { result?: { content?: { text: string }[]; isError?: boolean } };
  const out = (r: Rpc) => {
    expect(r.result?.isError ?? false, r.result?.content?.[0]?.text).toBe(false);
    return JSON.parse(r.result!.content![0]!.text) as Record<string, unknown>;
  };
  const call = async (name: string, args: unknown, key?: string, id = 7) => {
    const r = await post(msg(id, name, args), key ? { "idempotency-key": key } : {});
    expect(r.status).toBe(200);
    return out(r.json as Rpc);
  };
  const db = t.db as unknown as { all: (q: unknown) => { n: number }[] };
  const count = (table: string) => db.all(sql.raw(`select count(*) as n from "${table}"`))[0]!.n;
  const fail = (key: string) => t.db.update(idempotencyKeys).set({ state: "running", responseStatus: 503, responseBody: null }).where(eq(idempotencyKeys.key, key));
  // Statement counter (as tests/webhooks-r52.test.ts): every prepared statement the app runs, with its SQL.
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
  return { t, post, v1, msg, out, call, count, fail, measure };
}

const appStatements = (s: string[]) => s.filter((q) => !/idempotency_keys/i.test(q));

describe("MCP create tools keep the same id on a 5xx retry (R53 MB-239)", () => {
  it.each(cases)("$tool: the retry returns the same id and makes no second row", async (k) => {
    const s0 = await setup();
    const project = (await s0.v1("POST", "/projects", { name: "Seed" })).project!.id;
    const task = (await s0.v1("POST", "/tasks", { title: "Seed", projectId: project })).task!.id;
    const channel = (await s0.v1("POST", "/chat/channels", { name: "seed-53" })).channel!.id;
    if (k.domain) await s0.v1("POST", "/domains", { name: "retry-r53.io" });
    const message = ((await s0.call("post_message", { channelId: channel, body: "Seed message" }, undefined, 3)).message as { id: string }).id;
    const seed = { project, task, channel, message };
    const key = `r53-mcp-${k.tool}-0001`;
    const first = await s0.call(k.tool, k.args(seed), key);
    const ids = k.pick(first);
    const rows = s0.count(k.table);
    await s0.fail(key);
    const retry = await s0.call(k.tool, k.args(seed), key);
    expect(k.pick(retry)).toEqual(ids);
    expect(s0.count(k.table)).toBe(rows);
    // The retry's answer is stored now: a third call replays it.
    const third = await s0.call(k.tool, k.args(seed), key);
    expect(k.pick(third)).toEqual(ids);
    expect(s0.count(k.table)).toBe(rows);
  }, 60_000);

  it("a JSON-RPC batch with two creates gets two ids, and both stay the same across a retry", async () => {
    const s = await setup();
    const key = "r53-mcp-batch-0001";
    const body = [s.msg(21, "create_task", { title: "Batch one" }), s.msg(22, "create_task", { title: "Batch two" })];
    const first = await s.post(body, { "idempotency-key": key });
    expect(first.status).toBe(200);
    const ids = (r: unknown) => (r as { id: number; result: { content: { text: string }[] } }[]).sort((a, b) => a.id - b.id).map((m) => (JSON.parse(m.result.content[0]!.text) as { task: { id: string } }).task.id);
    const a = ids(first.json);
    expect(a).toHaveLength(2);
    expect(a[0]).not.toBe(a[1]);
    const n = s.count("tasks");
    await s.fail(key);
    const retry = await s.post(body, { "idempotency-key": key });
    expect(ids(retry.json)).toEqual(a);
    expect(s.count("tasks")).toBe(n);
  }, 60_000);

  it("without a key nothing changes: random ids, and the same call twice makes two rows", async () => {
    const s = await setup();
    const n = s.count("tasks");
    const a = (await s.call("create_task", { title: "No key" })).task as { id: string };
    const b = (await s.call("create_task", { title: "No key" })).task as { id: string };
    expect(a.id).not.toBe(b.id);
    expect(s.count("tasks")).toBe(n + 2);
  }, 60_000);

  it("a first attempt with a key runs the same app statements as a call without one (no extra read)", async () => {
    const s = await setup();
    const project = (await s.v1("POST", "/projects", { name: "Count" })).project!.id;
    for (const [tool, args] of [["create_task", { title: "Count", projectId: project }], ["create_doc", { title: "Count", text: "x" }], ["create_goal", { name: "Count" }]] as const) {
      await s.call(tool, args, undefined, 30); // warm the read caches, so both measured calls start alike
      const plain = await s.measure(() => s.call(tool, args, undefined, 31));
      const keyed = await s.measure(() => s.call(tool, args, `r53-count-${tool}-0001`, 32));
      expect(appStatements(keyed.statements).length, tool).toBe(appStatements(plain.statements).length);
      // The only extra statements are the key row's own (the middleware's read, insert and stored answer).
      expect(keyed.statements.length, tool).toBeGreaterThan(plain.statements.length);
      if (process.env.R53_COUNTS) console.log(`R53_COUNTS ${tool} plain=${plain.statements.length} keyed=${keyed.statements.length} keyed_app=${appStatements(keyed.statements).length}`);
    }
  }, 60_000);
});
