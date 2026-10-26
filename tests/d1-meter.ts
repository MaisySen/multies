/**
 * R32: the D1 write meter shared by the write cost tests. D1 bills a written row once for the table and
 * once for every index on it (a partial index only for the entries that came or went). `meter` returns a
 * `take()` that answers the rows since the last take; `take.byTable()` names where they went.
 */
export function meter(db: unknown) {
  const c = (db as { $client: { prepare: (q: string) => Record<string, (...a: unknown[]) => unknown> } }).$client;
  const idx = new Map<string, number>();
  for (const r of c.prepare("select tbl_name t, count(*) n from sqlite_master where type='index' and (sql is null or sql not like '% WHERE %') group by tbl_name").all() as { t: string; n: number }[]) idx.set(r.t, r.n);
  const partial = new Map<string, string[]>();
  for (const r of c.prepare("select tbl_name t, sql from sqlite_master where type='index' and sql like '% WHERE %'").all() as { t: string; sql: string }[]) partial.set(r.t, [...(partial.get(r.t) ?? []), r.sql.slice(r.sql.search(/ WHERE /i) + 7)]);
  const prepare = c.prepare.bind(c);
  const changes = () => (prepare("select total_changes() n").get() as { n: number }).n;
  const members = (table: string) => (partial.get(table) ?? []).map((w) => (prepare(`select count(*) n from "${table}" where ${w}`).get() as { n: number }).n);
  let total = 0;
  let tables: Record<string, number> = {};
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
        const n = (changes() - before) * (1 + (idx.get(table) ?? 0)) + inAfter.reduce((s, v, i) => s + Math.abs(v - inBefore[i]), 0);
        total += n;
        if (n) tables[table] = (tables[table] ?? 0) + n;
        return r;
      };
    }
    return st;
  };
  const take = () => { const n = total; total = 0; tables = {}; return n; };
  /** Rows per table since the last take (does not reset). */
  take.byTable = () => ({ ...tables });
  return take;
}
