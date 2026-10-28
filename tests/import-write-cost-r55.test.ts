import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { runImport } from "@/server/services/work-import/service";
// @ts-expect-error plain JS fixture generator
import { makeCsv } from "./fixtures/work-import/generate-1000.mjs";

/**
 * R55: an import writes fewer D1 rows. Families (a top row and its subtasks) go in one batch, children first, and the
 * parent's insert carries its subtask counts; on D1 (one transaction per batch) comments and checklist items go in
 * before their task with the foreign key check deferred, and the task row carries their counts. The count triggers
 * then find no row to update. Staging D1, 28 Oct 2026, exact statements: a parent with 4 subtasks 53 rows parent
 * first, 49 children first; a task with 2 comments and 2 checklist items 25 rows task first, 21 children first.
 *
 * The D1 path is tested here with a stand in batch that runs the statements in one SQLite transaction, as D1 does.
 */
const file = (n: string) => readFileSync(new URL(`./fixtures/work-import/${n}`, import.meta.url), "utf8");

async function owner(atomic: boolean) {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Owner Person");
  const me = (await c.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id as string, userId: me.user.id as string, email: "owner@acme.io", name: "Owner Person", role: "owner" as const };
  const client = (ctx.db as unknown as { $client: { exec: (q: string) => void; prepare: (q: string) => { get: () => unknown; all: () => unknown[] } } }).$client;
  // Counts the UPDATEs the count triggers make (each is a row D1 bills): the triggers write tasks rows that nobody inserted.
  let batches = 0;
  if (atomic) {
    Object.assign(ctx.db as object, {
      batch: async (stmts: PromiseLike<unknown>[]) => {
        batches++;
        client.exec("BEGIN");
        try {
          // better-sqlite3 runs db.run() at once, outside the transaction; D1 runs it in the batch. Repeat it here.
          client.exec("PRAGMA defer_foreign_keys = on");
          for (const s of stmts) await s;
          client.exec("COMMIT");
        } catch (e) { client.exec("ROLLBACK"); throw e; }
      },
    });
  }
  return { ...ctx, c, actor, client, batches: () => batches };
}

/** Every task's stored counts against a fresh recount from the source rows. */
function countsMismatch(client: { prepare: (q: string) => { all: () => unknown[] } }) {
  return client.prepare(`select t.id, t.title,
      t.subtask_total, (select count(*) from tasks s where s.parent_id = t.id and s.deleted_at is null) st,
      t.subtask_done, (select count(*) from tasks s where s.parent_id = t.id and s.deleted_at is null and s.status = 'done') sd,
      t.comment_count, (select count(*) from task_comments c where c.task_id = t.id and c.deleted_at is null) cc,
      t.checklist_total, (select count(*) from task_checklist_items k where k.task_id = t.id) kt,
      t.checklist_done, (select count(*) from task_checklist_items k where k.task_id = t.id and k.done = 1) kd
    from tasks t`).all().filter((r) => {
    const x = r as Record<string, number>;
    return x.subtask_total !== x.st || x.subtask_done !== x.sd || x.comment_count !== x.cc || x.checklist_total !== x.kt || x.checklist_done !== x.kd;
  });
}

/** Rows the count triggers updated: total_changes over an import minus the rows the import inserted itself. */
function triggerUpdates(client: { prepare: (q: string) => { get: () => unknown } }, run: () => Promise<unknown>) {
  const n = () => (client.prepare("select total_changes() n").get() as { n: number }).n;
  const rows = () => (client.prepare("select (select count(*) from tasks) + (select count(*) from task_comments) + (select count(*) from task_checklist_items) n").get() as { n: number }).n;
  return async () => {
    const c0 = n(), r0 = rows();
    await run();
    return { changes: n() - c0, inserted: rows() - r0 };
  };
}

describe("R55 import write cost", () => {
  for (const atomic of [false, true]) {
    const where = atomic ? "D1 (one transaction per batch)" : "SQLite in Node";
    it(`${where}: a subtask heavy file lands with right counts and no parent count updates`, async () => {
      const o = await owner(atomic);
      const content = makeCsv(100) as string; // 20 parents with 4 subtasks each
      const measure = triggerUpdates(o.client, () => runImport(o.deps, o.actor, { content, projectName: "Big" }));
      const m = await measure();
      expect(countsMismatch(o.client)).toEqual([]);
      const parents = o.client.prepare("select count(*) n from tasks where subtask_total = 4").get() as { n: number };
      expect(parents.n).toBe(20);
      // Changes = inserted rows + the status counter upserts (1 per task) + the usage counter + project counter rows;
      // before R55 each subtask also updated its parent (80 more).
      expect(m.inserted).toBe(100);
      // Measured 110 here (100 status counter rows, 10 counter rows); parents first it was 190.
      console.log(`R55 ${where}: ${m.changes - m.inserted} trigger and counter rows for 100 tasks`);
      expect(m.changes - m.inserted).toBeLessThanOrEqual(112);
    });

    it(`${where}: comments and checklist items land with right counts`, async () => {
      const o = await owner(atomic);
      const measure = triggerUpdates(o.client, () => runImport(o.deps, o.actor, { fileName: "clickup.csv", content: file("clickup.csv") }));
      const m = await measure();
      expect(countsMismatch(o.client)).toEqual([]);
      const launch = o.client.prepare("select comment_count, checklist_total, checklist_done, subtask_total, subtask_done from tasks where title = 'Launch site'").get();
      expect(launch).toEqual({ comment_count: 0, checklist_total: 2, checklist_done: 1, subtask_total: 2, subtask_done: 1 });
      const press = o.client.prepare("select comment_count from tasks where title = 'Write the press note'").get();
      expect(press).toEqual({ comment_count: 1 });
      // 3 tasks + 2 checklist items + 1 comment inserted; the count triggers write nothing on D1 (3 more in Node).
      expect(m.inserted).toBe(6);
      if (atomic) expect(o.batches()).toBeGreaterThan(0);
      // A re-run writes no task, item or comment.
      const again = await runImport(o.deps, o.actor, { fileName: "clickup.csv", content: file("clickup.csv") });
      expect(again).toMatchObject({ created: 0, checklistItems: 0, comments: 0 });
      expect(countsMismatch(o.client)).toEqual([]);
    });

    it(`${where}: a family bigger than a batch keeps parents first and still counts right`, async () => {
      const o = await owner(atomic);
      const lines = ["Task ID,Name,Section/Column,Parent task"];
      lines.push("1,Big parent,Done,");
      for (let i = 0; i < 12; i++) lines.push(`${100 + i},Child ${i},${i % 2 ? "Done" : "To do"},Big parent`);
      for (let i = 0; i < 6; i++) lines.push(`${200 + i},Flat ${i},To do,`);
      const r = await runImport(o.deps, o.actor, { content: lines.join("\n"), projectName: "Fam" }, { batchSize: 5 });
      expect(r).toMatchObject({ created: 19, stopped: null });
      expect(countsMismatch(o.client)).toEqual([]);
      expect(o.client.prepare("select subtask_total, subtask_done from tasks where title = 'Big parent'").get()).toEqual({ subtask_total: 12, subtask_done: 6 });
    });

    it(`${where}: small families never straddle a batch, and a run that stops leaves no child without its parent`, async () => {
      const o = await owner(atomic);
      const lines = ["Task ID,Name,Section/Column,Parent task"];
      for (let f = 0; f < 6; f++) {
        lines.push(`${f}0,Parent ${f},To do,`);
        for (let k = 1; k <= 3; k++) lines.push(`${f}${k},Kid ${f}.${k},Done,Parent ${f}`);
      }
      // A time limit of 0 stops after the first batch (batch of 6 holds one whole family of 4, not one and a half).
      const r = await runImport(o.deps, o.actor, { content: lines.join("\n"), projectName: "Stop" }, { batchSize: 6, maxMs: 0 });
      expect(r.created).toBe(4);
      const orphans = o.client.prepare("select count(*) n from tasks k where k.parent_id is not null and not exists (select 1 from tasks p where p.id = k.parent_id)").get() as { n: number };
      expect(orphans.n).toBe(0);
      let next = r; let runs = 0;
      while (next.stopped && runs < 10) { next = await runImport(o.deps, o.actor, { content: lines.join("\n"), projectName: "Stop" }, { batchSize: 6, maxMs: 0 }); runs++; }
      expect(o.client.prepare("select count(*) n from tasks").get()).toEqual({ n: 24 });
      expect(countsMismatch(o.client)).toEqual([]);
      expect((o.client.prepare("select count(*) n from tasks where subtask_total = 3 and subtask_done = 3").get() as { n: number }).n).toBe(6);
    });
  }
});
void sql;
