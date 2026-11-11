import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { webhookDeliveries } from "@/server/db/schema";
import { EMIT_MANY_MAX, emitEventMany, WEBHOOK_EVENTS } from "@/server/services/developer/webhooks";

/**
 * R52 (MB-239): meeting.deleted, and a project delete that sends task.deleted for each of its tasks as one batched
 * insert. With nobody subscribed to task.deleted the delete runs the same statements as before (no task id read,
 * no extra write), whatever the number of tasks.
 */
async function setup(events: string[] | null) {
  const t = await makeTestApp();
  const c = new Client(t.app);
  await c.signup("owner.hooks52@acme.io", "Olive Owner");
  const secret = (await c.post("/api/developer/keys", { name: "rw" })).body.secret as string;
  const v1 = async (method: string, path: string, body?: unknown) => {
    const r = await t.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, { id: string }> & { id?: string; deleted?: boolean } };
  };
  if (events) expect((await v1("POST", "/webhooks", { url: "https://example.com/hooks/r52", events })).status).toBeLessThan(300);
  // Statement counter: every prepared statement the app runs (reads and writes), with its SQL.
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
  const measure = async <T>(fn: () => Promise<T>) => { log = []; const r = await fn(); const out = log; log = null; return { r, statements: out }; };
  const sent = async () => (await t.db.select().from(webhookDeliveries)).map((d) => ({ type: d.eventType, status: d.status, data: JSON.parse(d.payload).data as Record<string, unknown> }));
  const project = async (n: number) => {
    const p = (await v1("POST", "/projects", { name: `P${n}` })).body.project!.id;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await v1("POST", "/tasks", { title: `T${i}`, projectId: p })).body.task!.id);
    return { p, ids };
  };
  return { ...t, c, v1, measure, sent, project };
}
const writes = (s: string[]) => s.filter((q) => /^\s*(insert|update|delete)/i.test(q));

describe("meeting.deleted and task.deleted per task on project delete (R52 MB-239)", () => {
  it("names meeting.deleted", () => { expect(WEBHOOK_EVENTS).toContain("meeting.deleted"); });

  it("DELETE /meetings/:id deletes it and sends meeting.deleted shaped like meeting.created", async () => {
    const s = await setup(["meeting.created", "meeting.deleted"]);
    const m = await s.v1("POST", "/meetings", { title: "Gone soon", startsAt: "2026-11-03T01:00:00.000Z" });
    expect(m.status).toBe(201);
    const id = m.body.meeting!.id;
    const del = await s.v1("DELETE", `/meetings/${id}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body).toMatchObject({ id, deleted: true });
    expect((await s.v1("GET", `/meetings/${id}`)).status).toBe(404);
    expect((await s.v1("DELETE", `/meetings/${id}`)).status).toBe(404);
    const ev = await s.sent();
    const created = ev.find((e) => e.type === "meeting.created")!.data;
    const deleted = ev.find((e) => e.type === "meeting.deleted")!.data;
    expect(deleted).toMatchObject({ id, object: "meeting", title: "Gone soon", startsAt: "2026-11-03T01:00:00.000Z", durationMin: 30 });
    for (const k of ["id", "title", "startsAt", "durationMin", "actor"]) { expect(created).toHaveProperty(k); expect(deleted).toHaveProperty(k); }
  });

  it("a read only key cannot delete a meeting, and the meeting stays", async () => {
    const s = await setup(null);
    const id = (await s.v1("POST", "/meetings", { title: "Keep" })).body.meeting!.id;
    const k = await s.c.post("/api/developer/keys", { name: "ro", scope: "read" });
    expect(k.status, JSON.stringify(k.body)).toBeLessThan(300);
    const r = await s.app.request(`/api/v1/meetings/${id}`, { method: "DELETE", headers: { host: "localhost", authorization: `Bearer ${k.body.secret as string}` } });
    expect(r.status).toBe(403);
    const db = s.db as unknown as { all: (q: unknown) => unknown[] };
    expect(db.all(sql`select id from meetings where id = ${id}`)).toHaveLength(1);
  });

  it("with a task.deleted subscriber, a project of 3 tasks sends 3 task.deleted plus project.deleted, in one insert", async () => {
    const s = await setup(["task.deleted", "project.deleted"]);
    const { p, ids } = await s.project(3);
    const { statements } = await s.measure(() => s.v1("DELETE", `/projects/${p}`));
    const ev = await s.sent();
    expect(ev.filter((e) => e.type === "project.deleted")).toHaveLength(1);
    expect(ev.find((e) => e.type === "project.deleted")!.data).toMatchObject({ id: p, object: "project", name: "P3" });
    const td = ev.filter((e) => e.type === "task.deleted");
    expect(td.map((e) => e.data.id).sort()).toEqual([...ids].sort());
    for (const e of td) expect(e.data).toMatchObject({ object: "task", projectId: p, viaProject: true });
    // The three task.deleted rows went in as one statement.
    expect(writes(statements).filter((q) => /insert into webhook_deliveries/i.test(q) && /json_each/i.test(q))).toHaveLength(1);
    expect(writes(statements).filter((q) => /insert into "?webhook_deliveries/i.test(q))).toHaveLength(2); // project.deleted + the one batched insert
  });

  it("with nobody subscribed to task.deleted, a project delete runs the same statements for 0 and 3 tasks: no task read, no extra write", async () => {
    for (const events of [null, ["project.deleted"], ["message.received"]]) {
      const s = await setup(events);
      const a = await s.project(0);
      const b = await s.project(3);
      const zero = (await s.measure(() => s.v1("DELETE", `/projects/${a.p}`))).statements;
      const three = (await s.measure(() => s.v1("DELETE", `/projects/${b.p}`))).statements;
      expect(three.length, JSON.stringify(events)).toBe(zero.length);
      expect(writes(three).length).toBe(writes(zero).length);
      expect(three.some((q) => /json_each/i.test(q))).toBe(false);
      expect((await s.sent()).filter((e) => e.type === "task.deleted")).toEqual([]);
      // Measured on main 4bbb370 (before R52) with this same counter: 10 statements, 4 writes with no endpoint or one
      // for other events; 16 and 6 with a project.deleted endpoint (its delivery row and attempt). Unchanged by R52.
      // AIS1 (row 66): one more read for a key, on the Triage index (are items waiting?), and no more writes. This
      // counter logs every select twice (see the pairs in the list), so the read shows as 2.
      const base = events?.includes("project.deleted") ? { all: 18, w: 6 } : { all: 12, w: 4 };
      expect(three.length).toBe(base.all);
      expect(writes(three).length).toBe(base.w);
    }
  });

  it("emitEventMany caps at 1,000 events in one statement, and writes nothing with no endpoint", async () => {
    const quiet = await setup(null);
    const org = (quiet.db as unknown as { all: (q: unknown) => { org: string }[] }).all(sql`select organization_id as org from members limit 1`)[0]!.org;
    expect(await emitEventMany(quiet.deps, org, "task.deleted", [{ id: "tsk_a" }])).toEqual([]);
    expect(await quiet.sent()).toEqual([]);
    const s = await setup(["task.deleted"]);
    const org2 = (s.db as unknown as { all: (q: unknown) => { org: string }[] }).all(sql`select organization_id as org from members limit 1`)[0]!.org;
    const items = Array.from({ length: EMIT_MANY_MAX + 5 }, (_, i) => ({ id: `tsk_${i}` }));
    const { r, statements } = await s.measure(() => emitEventMany(s.deps, org2, "task.deleted", items));
    expect(r).toHaveLength(EMIT_MANY_MAX);
    expect(statements.filter((q) => /insert into webhook_deliveries/i.test(q))).toHaveLength(1);
    const rows = await s.sent();
    expect(rows).toHaveLength(EMIT_MANY_MAX);
    expect(rows.filter((x) => x.status === "pending").length).toBeGreaterThanOrEqual(EMIT_MANY_MAX - 10); // the rest wait for the retry pass
  }, 60_000);
});
