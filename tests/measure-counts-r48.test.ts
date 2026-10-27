import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { makeTestApp, Client } from "./helpers";

/**
 * R48 measurement only (MEASURE_R48=<out.json>): seeds a 1,000 task project, dumps the database, then records every
 * SQL statement each API call runs, so scripts/measure-d1-r48.mjs can replay them on local D1 and read D1's own
 * rows read and rows written per call. Skipped in the normal suite.
 */
const OUT = process.env.MEASURE_R48;
type St = Record<string, (...a: unknown[]) => unknown>;
type Raw = { prepare: (q: string) => St };

describe.skipIf(!OUT)("measure D1 rows per task list call (R48)", () => {
  it("records", async () => {
    const { app, db } = await makeTestApp();
    const c = new Client(app);
    await c.signup("owner@acme.io", "Olive Owner");
    const p = (await c.post("/api/projects", { name: "Big", key: "BIG" })).body.project;
    const field = (await c.post("/api/fields", { projectId: p.id, name: "Hours", type: "number" })).body.field;
    const key = (await c.post("/api/developer/keys", { name: "API" })).body.secret as string;
    const raw = (db as unknown as { $client: Raw }).$client;
    const org = (raw.prepare("select org_id from projects where id = ?").get(p.id) as { org_id: string }).org_id;
    const todo = p.statuses.find((s: { category: string }) => s.category === "todo").id;
    const doneS = p.statuses.find((s: { category: string }) => s.category === "done").id;
    const ins = raw.prepare("insert into tasks (id, org_id, project_id, number, status_id, status, title, position, parent_id, created_by_type, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'member', ?, ?)");
    const now = Date.now();
    const id = (i: number) => `tsk_${String(i).padStart(5, "0")}`;
    for (let i = 0; i < 1000; i++) ins.run(id(i), org, p.id, i + 1, i % 3 === 2 ? doneS : todo, i % 3 === 2 ? "done" : "todo", `Task ${i}`, i, null, now - i * 1000, now);
    for (let i = 0; i < 200; i++) ins.run(id(1000 + i), org, p.id, 1001 + i, i % 2 ? doneS : todo, i % 2 ? "done" : "todo", `Sub ${i}`, i, id(i), now, now);
    const cm = raw.prepare("insert into task_comments (id, org_id, task_id, author_name, body, created_by_type, created_at, updated_at) values (?, ?, ?, 'Olive', 'Looks good', 'member', ?, ?)");
    for (let i = 0; i < 400; i++) for (let k = 0; k < 2; k++) cm.run(`cmt_${i}_${k}`, org, id(i), now, now);
    const ck = raw.prepare("insert into task_checklist_items (id, org_id, task_id, title, done, position, created_at, updated_at) values (?, ?, ?, 'Step', ?, ?, ?, ?)");
    for (let i = 0; i < 300; i++) for (let k = 0; k < 3; k++) ck.run(`chk_${i}_${k}`, org, id(i), k === 0 ? 1 : 0, k, now, now);
    const fv = raw.prepare("insert into task_field_values (task_id, field_id, org_id, value_num, updated_at) values (?, ?, ?, ?, ?)");
    for (let i = 0; i < 200; i++) fv.run(id(i), field.id, org, i, now);
    raw.prepare("insert or replace into project_counters (project_id, next_number) values (?, 1201)").run(p.id);

    // dump: schema (tables first, then indexes and triggers after the data) and every row
    const master = raw.prepare("select type, name, sql from sqlite_master where sql is not null and name not like 'sqlite_%'").all() as { type: string; name: string; sql: string }[];
    const tables = master.filter((m) => m.type === "table" && !/^_cf_|^d1_/.test(m.name));
    const rows: Record<string, unknown> = {};
    for (const t of tables) rows[t.name] = raw.prepare(`select * from "${t.name}"`).all();
    const dump = { tables: tables.map((t) => ({ name: t.name, sql: t.sql })), after: master.filter((m) => m.type === "index" || m.type === "trigger").map((m) => m.sql), rows };

    // capture
    const log: { phase: string; sql: string; params: unknown[] }[] = [];
    let phase = "setup";
    const prepare = raw.prepare.bind(raw);
    raw.prepare = (q: string) => {
      const st = prepare(q);
      const wrap: St = {};
      const proxy: St = new Proxy(st, { get(target, prop: string) {
        const v = target[prop];
        if (typeof v !== "function") return v;
        if (["all", "get", "run", "iterate"].includes(prop)) return (...a: unknown[]) => { log.push({ phase, sql: q, params: a.flat() }); return v.apply(target, a); };
        if (["raw", "pluck", "expand", "safeIntegers"].includes(prop)) return (...a: unknown[]) => { v.apply(target, a); return proxy; };
        return v.bind(target);
      } }) as St;
      void wrap;
      return proxy;
    };
    const v1 = async (path: string) => (await app.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${key}`, host: "localhost" } })).json();
    const forget = async () => { try { (await import("@/server/services/suite/tasks")).forgetProjectCounts(); } catch { /* older builds */ } };

    phase = "list50"; await c.get(`/api/tasks?projectId=${p.id}&limit=50`);
    phase = "board1000";
    let page = (await c.get(`/api/tasks?projectId=${p.id}&paged=1`)).body;
    for (let n = 0; page.next && n < 20; n++) page = (await c.get(`/api/tasks?projectId=${p.id}&paged=1&cursor=${encodeURIComponent(page.next)}`)).body;
    await forget();
    phase = "projects"; await c.get("/api/projects");
    phase = "v1page"; await v1(`/tasks?projectId=${p.id}&limit=100`);
    phase = "comment"; await c.post(`/api/tasks/${id(5)}/comments`, { body: "Another" });
    phase = "checklistAdd"; await c.post(`/api/tasks/${id(5)}/checklist`, { title: "New step" });
    phase = "checklistTick"; await c.patch(`/api/checklist-items/chk_5_1`, { done: true });
    phase = "subtask"; await c.post("/api/tasks", { projectId: p.id, title: "New sub", parentId: id(5) });
    phase = "fieldSet"; await c.patch(`/api/tasks/${id(6)}`, { fields: { [field.id]: 7 } });
    phase = "status"; await c.patch(`/api/tasks/${id(7)}`, { statusId: doneS });
    phase = "end";
    writeFileSync(OUT!, JSON.stringify({ dump, log }));
  }, 120_000);
});
