import { describe, it, expect, beforeAll } from "vitest";
import { makeTestApp, Client, d1Violations } from "./helpers";

/**
 * Round 25 (Sentry MYMAIL-API-V and MYMAIL-API-W): D1 refuses a statement with more than 100 bound variables, and two
 * list reads did that once a workspace passed 100 tasks. This builds a workspace past that size (260 tasks with
 * comments and subtasks, 150 chat messages, 120 docs, 150 mail threads) and calls every GET in the REST API and the
 * app's list reads under the same limit (tests/helpers.ts). Any statement over the limit is named in the failure.
 */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
let key: string;
const ids: Record<string, string> = {};

type Raw = { prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => Record<string, unknown> | undefined; all: (...a: unknown[]) => Record<string, unknown>[] }; transaction: (f: () => void) => () => void };

beforeAll(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@big.test", "Olive Owner");
  key = (await owner.post("/api/developer/keys", { name: "rw" })).body.secret;
  const project = (await owner.post("/api/projects", { name: "Big", key: "BIG" })).body.project;
  ids.project = project.id;
  const first = (await owner.post("/api/tasks", { projectId: project.id, title: "Template task" })).body.task;
  await owner.post(`/api/tasks/${first.id}/comments`, { body: "template comment" });
  ids.sprint = (await owner.post("/api/sprints", { projectId: project.id, name: "Sprint 1" })).body.sprint?.id ?? "";
  const channel = (await owner.post("/api/chat/channels", { name: "big" })).body.channel;
  ids.channel = channel.id;
  await owner.post(`/api/chat/channels/${channel.id}/messages`, { body: "template message" });
  ids.doc = (await owner.post("/api/docs", { title: "Template doc", text: "hello" })).body.doc?.id ?? "";

  const db = (ctx.db as unknown as { $client: Raw }).$client;
  const now = Date.now();
  const cols = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => String(c.name));
  const clone = (table: string, where: string, arg: string, rows: Record<string, unknown>[]) => {
    const names = cols(table);
    const tpl = db.prepare(`SELECT * FROM ${table} WHERE ${where} = @a LIMIT 1`).get({ a: arg })!;
    const ins = db.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map((n) => "@" + n).join(",")})`);
    db.transaction(() => { for (const r of rows) ins.run({ ...tpl, ...r }); })();
  };
  const taskIds = Array.from({ length: 260 }, (_, i) => `tsk_big${i}`);
  clone("tasks", "id", first.id, taskIds.map((id, i) => ({ id, number: 100 + i, title: `Big task ${i}`, position: i, parent_id: i >= 140 ? taskIds[i - 140] : null, sprint_id: i % 2 && ids.sprint ? ids.sprint : null, created_at: now - i * 1000, updated_at: now - i * 1000 })));
  clone("task_comments", "task_id", first.id, taskIds.map((t, i) => ({ id: `tcm_big${i}`, task_id: t })));
  ids.task = taskIds[0];
  clone("chat_messages", "channel_id", channel.id, Array.from({ length: 150 }, (_, i) => ({ id: `chm_big${i}`, body: `Message ${i}`, created_at: now - (150 - i) * 1000, updated_at: now - (150 - i) * 1000 })));
  if (ids.doc) clone("docs", "id", ids.doc, Array.from({ length: 120 }, (_, i) => ({ id: `doc_big${i}`, title: `Doc ${i}`, created_at: now - i * 1000, updated_at: now - i * 1000 })));
  const org = String(db.prepare("SELECT org_id FROM projects WHERE id = @p").get({ p: project.id })!.org_id);
  db.prepare("INSERT INTO domains (id, org_id, name, status, verification_token, dkim_selector, dkim_public_key, dkim_private_key_enc, created_at) VALUES ('dom_big', @o, 'big.test', 'verified', 'x', 'mm', 'x', 'x', @n)").run({ o: org, n: now });
  db.prepare("INSERT INTO mailboxes (id, org_id, domain_id, local_part, address, display_name, quota_mb, created_at) VALUES ('mbx_big', @o, 'dom_big', 'olive', 'olive@big.test', 'Olive', 5000, @n)").run({ o: org, n: now });
  const mIns = db.prepare("INSERT INTO messages (id, org_id, mailbox_id, folder, message_id_header, thread_id, from_address, from_name, to_json, subject, text_body, snippet, size_bytes, is_read, date, created_at) VALUES (@id, @o, 'mbx_big', 'inbox', @h, @t, 'a@x.test', 'A', '[\"olive@big.test\"]', @s, 'body', 'body', 900, 0, @d, @d)");
  db.transaction(() => { for (let i = 0; i < 150; i++) mIns.run({ id: `msg_big${i}`, o: org, h: `<m${i}@x.test>`, t: `thr_big${i}`, s: `Subject ${i}`, d: now - i * 1000 }); })();
  ids.mailbox = "mbx_big";
  ids.thread = "thr_big0";
}, 120_000);

function fill(path: string): string | null {
  const byPrefix: [RegExp, string][] = [
    [/^\/projects\/\{[^}]+\}/, ids.project], [/^\/tasks\/\{[^}]+\}/, ids.task], [/^\/chat\/channels\/\{[^}]+\}/, ids.channel],
    [/^\/channels\/\{[^}]+\}/, ids.channel], [/^\/sprints\/\{[^}]+\}/, ids.sprint], [/^\/docs\/\{[^}]+\}/, ids.doc],
    [/^\/mailboxes\/\{[^}]+\}/, ids.mailbox], [/^\/threads\/\{[^}]+\}/, ids.thread],
  ];
  for (const [re, id] of byPrefix) if (re.test(path) && id) { const out = path.replace(/\{[^}]+\}/, id); return out.includes("{") ? null : out; }
  return path.includes("{") ? null : path;
}

describe("every list read stays under D1's 100 variable limit on a big workspace", () => {
  it("REST API (every GET in the OpenAPI document) and the app's list reads", async () => {
    const doc = await (await ctx.app.request("/api/v1/openapi.json", { headers: { host: "localhost" } })).json() as { paths: Record<string, Record<string, unknown>> };
    const q = `projectId=${ids.project}&limit=500`;
    const v1 = Object.entries(doc.paths).filter(([, ops]) => ops.get).map(([p]) => fill(p)).filter((p): p is string => !!p && !/openapi|reference|mcp|export|download|\.ics|stream|events$/.test(p));
    const app = ["/tasks", `/tasks?${q}`, `/tasks?${q}&includeSubtasks=true`, "/my-work", "/triage", "/goals", "/dashboard", "/dashboards", "/portfolio", `/sprints?projectId=${ids.project}`, `/sprints/backlog?projectId=${ids.project}`,
      `/sprints/${ids.sprint}`, `/epics?projectId=${ids.project}`, `/computed/projects/${ids.project}/rollups`, `/tasks/dependencies?projectId=${ids.project}`, `/workload?weeks=4&projectId=${ids.project}`,
      `/chat/channels/${ids.channel}/messages?limit=100`, `/chat/channels/${ids.channel}/pins`, "/chat/channels", "/chat/unread", `/docs`, "/docs/tree", `/tasks/${ids.task}`, "/notifications?limit=100",
      `/search?q=Big`, `/threads?mailboxId=${ids.mailbox}&limit=200`, "/mail/overview", "/mailboxes", "/tasks/assignees", "/team"];
    const errors: string[] = [];
    for (const p of v1) {
      const res = await ctx.app.request(`/api/v1${p}${p.includes("?") ? "&" : "?"}limit=100`, { headers: { host: "localhost", authorization: `Bearer ${key}` } });
      if (res.status >= 500) errors.push(`v1 GET ${p}: ${res.status}`);
    }
    for (const p of app) { const res = await owner.get(`/api${p}`); if (res.status >= 500) errors.push(`app GET ${p}: ${res.status}`); }
    expect(v1.length).toBeGreaterThan(40);
    expect(d1Violations, `statements over 100 variables:\n${d1Violations.join("\n")}`).toEqual([]);
    expect(errors).toEqual([]);
  }, 180_000);
});
