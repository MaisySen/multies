import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { webhookDeliveries } from "@/server/db/schema";
import { emitEvent, WEBHOOK_EVENTS } from "@/server/services/developer/webhooks";

/** R51 (MB-239): delete and comment events for the main objects, sent after the write, and free when nobody listens. */
async function setup(events: string[] | null) {
  const t = await makeTestApp();
  const c = new Client(t.app);
  await c.signup("owner.hooks@acme.io", "Olive Owner");
  const secret = (await c.post("/api/developer/keys", { name: "rw" })).body.secret as string;
  const v1 = async (method: string, path: string, body?: unknown) => {
    const r = await t.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, { id: string }> & { id?: string } };
  };
  if (events) {
    const w = await v1("POST", "/webhooks", { url: "https://example.com/hooks/r51", events });
    expect(w.status, JSON.stringify(w.body)).toBeLessThan(300);
  }
  const db = t.db as unknown as { all: (q: unknown) => { name?: string; n?: number }[] };
  const tables = db.all(sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%_fts%'`).map((r) => r.name!);
  const total = () => tables.reduce((s, n) => s + Number(db.all(sql.raw(`select count(*) as n from "${n}"`))[0]!.n), 0);
  const sent = async () => (await t.db.select().from(webhookDeliveries)).map((d) => ({ type: d.eventType, data: JSON.parse(d.payload).data as Record<string, unknown> }));
  return { ...t, v1, total, sent };
}

describe("webhook events for projects, docs and comments (R51 MB-239)", () => {
  it("names the new events", () => {
    for (const e of ["project.deleted", "doc.deleted", "comment.created", "comment.updated", "comment.deleted", "task.deleted"]) expect(WEBHOOK_EVENTS).toContain(e);
  });

  it("fires project.deleted, doc.deleted and the three comment events with id and object", async () => {
    const s = await setup(["project.deleted", "doc.deleted", "comment.created", "comment.updated", "comment.deleted", "task.deleted", "task.commented"]);
    const p = (await s.v1("POST", "/projects", { name: "Hook project" })).body.project!.id;
    const task = (await s.v1("POST", "/tasks", { title: "Hook task", projectId: p })).body.task!.id;
    const cm = await s.v1("POST", `/tasks/${task}/comments`, { body: "First" });
    expect(cm.status).toBe(201);
    const cid = cm.body.comment!.id;
    expect((await s.v1("PATCH", `/comments/${cid}`, { body: "Edited" })).status).toBe(200);
    expect((await s.v1("DELETE", `/comments/${cid}`)).status).toBe(200);
    const d = (await s.v1("POST", "/docs", { title: "Hook doc" })).body.doc!.id;
    expect((await s.v1("DELETE", `/docs/${d}`)).status).toBe(200);
    expect((await s.v1("DELETE", `/tasks/${task}`)).status).toBe(200);
    expect((await s.v1("DELETE", `/projects/${p}`)).status).toBe(200);
    const ev = await s.sent();
    const of = (type: string) => ev.filter((e) => e.type === type);
    expect(of("comment.created")).toHaveLength(1);
    expect(of("comment.created")[0]!.data).toMatchObject({ id: cid, object: "comment", taskId: task });
    expect(of("task.commented")[0]!.data).toMatchObject({ taskId: task, comment: { id: cid } }); // old shape kept
    expect(of("comment.updated")[0]!.data).toMatchObject({ id: cid, object: "comment", taskId: task, comment: { body: "Edited" } });
    expect(of("comment.deleted")[0]!.data).toMatchObject({ id: cid, object: "comment", taskId: task });
    expect(of("doc.deleted")[0]!.data).toMatchObject({ id: d, object: "doc", title: "Hook doc" });
    expect(of("task.deleted")[0]!.data).toMatchObject({ id: task });
    expect(of("project.deleted")[0]!.data).toMatchObject({ id: p, object: "project", name: "Hook project" });
    for (const e of ev) expect(e.data.actor).toBeTruthy();
  });

  it("an endpoint only gets the names it subscribed to: task.commented alone does not get comment.created", async () => {
    const s = await setup(["task.commented"]);
    const task = (await s.v1("POST", "/tasks", { title: "Only old" })).body.task!.id;
    await s.v1("POST", `/tasks/${task}/comments`, { body: "Hi" });
    expect((await s.sent()).map((e) => e.type)).toEqual(["task.commented"]);
  });

  it("costs no D1 write when nobody subscribes (no endpoint, or an endpoint for other events)", async () => {
    for (const events of [null, ["message.received"]]) {
      const s = await setup(events);
      const db = s.db as unknown as { all: (q: unknown) => { org?: string }[] };
      const orgId = db.all(sql`select organization_id as org from members limit 1`)[0]!.org!;
      const before = s.total();
      const out = await emitEvent(s.deps, orgId, ["comment.created", "task.commented", "project.deleted"], { id: "cmt_x" });
      expect(out).toEqual([]);
      expect(s.total()).toBe(before); // one read, no write
      // and through the real routes: a comment and a delete leave no delivery rows
      const task = (await s.v1("POST", "/tasks", { title: "Quiet" })).body.task!.id;
      const mid = s.total();
      await s.v1("DELETE", `/tasks/${task}`);
      expect(await s.sent()).toEqual([]);
      expect(before).toBeGreaterThan(0);
      expect(mid).toBeGreaterThan(before);
    }
  });
});
