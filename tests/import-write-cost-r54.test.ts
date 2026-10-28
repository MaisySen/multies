import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { runImport } from "@/server/services/work-import/service";
// @ts-expect-error plain JS fixture generator
import { makeCsv } from "./fixtures/work-import/generate-1000.mjs";

/**
 * R54: what an import costs in D1 writes per imported row, and how many statements it sends (meter copied from
 * write-cost.test.ts, plus a statement counter). This meter counts trigger rows (the parent's subtask count, the
 * project status counter) as if they were task rows, so it reads high: 16.2 per row here. The real D1 figure, measured
 * on staging on 28 Oct 2026 with the exact insert statements of a 1 parent plus 4 subtask import: 53 rows written for
 * 5 tasks (10.6 per task), 45 for 5 top level tasks (9 per task, the floor: the row, its indexes and the status counter).
 * The ceilings below keep the measured cost from creeping up.
 */
function meter(db: unknown) {
  const c = (db as { $client: { prepare: (q: string) => Record<string, (...a: unknown[]) => unknown> } }).$client;
  const idx = new Map<string, number>();
  // R21: a partial index (CREATE INDEX ... WHERE) only holds the rows its WHERE matches, so a row outside it costs
  // nothing there. Full indexes count once per written row; a partial index counts the entries that came or went.
  for (const r of c.prepare("select tbl_name t, count(*) n from sqlite_master where type='index' and (sql is null or sql not like '% WHERE %') group by tbl_name").all() as { t: string; n: number }[]) idx.set(r.t, r.n);
  const partial = new Map<string, string[]>();
  for (const r of c.prepare("select tbl_name t, sql from sqlite_master where type='index' and sql like '% WHERE %'").all() as { t: string; sql: string }[]) partial.set(r.t, [...(partial.get(r.t) ?? []), r.sql.slice(r.sql.search(/ WHERE /i) + 7)]);
  const prepare = c.prepare.bind(c);
  const changes = () => (prepare("select total_changes() n").get() as { n: number }).n;
  const members = (table: string) => (partial.get(table) ?? []).map((w) => (prepare(`select count(*) n from "${table}" where ${w}`).get() as { n: number }).n);
  let total = 0;
  c.prepare = (q: string) => {
    const st = prepare(q);
    const table = /^\s*(?:insert(?: or \w+)? into|update|delete from)\s+["`]?(\w+)/i.exec(q)?.[1];
    if (!table) return st;
    for (const fn of ["run", "all", "get"]) {
      const orig = st[fn].bind(st);
      st[fn] = (...a: unknown[]) => {
        const before = changes(); const inBefore = members(table);
        const r = orig(...a);
        const inAfter = members(table);
        total += (changes() - before) * (1 + (idx.get(table) ?? 0)) + inAfter.reduce((n, v, i) => n + Math.abs(v - inBefore[i]), 0);
        return r;
      };
    }
    return st;
  };
  return () => { const n = total; total = 0; return n; };
}


function statements(db: unknown) {
  const c = (db as { $client: { prepare: (q: string) => unknown } }).$client;
  const prepare = c.prepare.bind(c);
  const n = { all: 0, writes: 0 };
  c.prepare = (q: string) => { n.all++; if (/^\s*(insert|update|delete)/i.test(q)) n.writes++; return prepare(q); };
  return () => { const r = { ...n }; n.all = 0; n.writes = 0; return r; };
}

async function owner() {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Owner Person");
  const me = (await c.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id as string, userId: me.user.id as string, email: "owner@acme.io", name: "Owner Person", role: "owner" as const };
  return { ...ctx, c, actor };
}

describe("R54 import write cost", () => {
  it.each([100, 500])("measures a %i row work import", async (n) => {
    const o = await owner();
    const take = meter(o.db);
    const st = statements(o.db);
    const content = makeCsv(n) as string;
    let body = await runImport(o.deps, o.actor, { content, projectName: "Big" });
    let runs = 1;
    while (body.stopped && runs < 5) { body = await runImport(o.deps, o.actor, { content, projectName: "Big" }); runs++; }
    const units = take(); const s = st();
    console.log(`R54 import ${n} rows: ${units} write units (${(units / n).toFixed(2)} per row), ${s.all} prepared statements (${s.writes} writes) in ${runs} run(s)`);
    expect(body.stopped).toBeNull();
    // Measured 16.24 (100 rows) and 16.10 (500 rows) units per row; about 1.05 write statements per row.
    expect(units / n).toBeLessThanOrEqual(17);
    expect(s.writes / n).toBeLessThanOrEqual(1.2);
  }, 120_000);
});
