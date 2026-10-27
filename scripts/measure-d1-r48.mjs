// R48 measurement: replays what tests/measure-counts-r48.test.ts recorded on a local D1 (the same engine as
// production) and prints D1's own rows read and rows written per call. Usage: node scripts/measure-d1-r48.mjs <file.json>
import { readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { getPlatformProxy } from "wrangler";

const { dump, log } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const persist = `/tmp/r48-d1-${process.pid}`;
const proxy = await getPlatformProxy({ persist: { path: persist } });
const db = proxy.env.DB;
const val = (v) => (v && typeof v === "object" && v.type === "Buffer" ? new Uint8Array(v.data) : typeof v === "boolean" ? (v ? 1 : 0) : v);
// Foreign keys change nothing about what a read or write scans here, and they would force a table order on the load.
const noFk = (q) => q
  .replace(/,\s*(CONSTRAINT\s+\S+\s+)?FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s*[`"]?\w+[`"]?\s*\([^)]*\)(\s+ON\s+(DELETE|UPDATE)\s+(CASCADE|SET NULL|SET DEFAULT|NO ACTION|RESTRICT))*/gi, "")
  .replace(/\s+REFERENCES\s*[`"]?\w+[`"]?\s*\([^)]*\)(\s+ON\s+(DELETE|UPDATE)\s+(CASCADE|SET NULL|SET DEFAULT|NO ACTION|RESTRICT))*/gi, "");
for (const t of dump.tables) await db.prepare(noFk(t.sql)).run();
for (const t of dump.tables) {
  const rows = dump.rows[t.name];
  for (let i = 0; i < rows.length; i += 50) {
    await db.batch(rows.slice(i, i + 50).map((r) => {
      const cols = Object.keys(r);
      return db.prepare(`insert into "${t.name}" (${cols.map((c) => `"${c}"`).join(", ")}) values (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => val(r[c])));
    }));
  }
}
for (const s of dump.after) await db.prepare(s).run();
const out = {};
for (const e of log) {
  if (e.phase === "setup") continue;
  let meta = { rows_read: 0, rows_written: 0 };
  try { meta = (await db.prepare(e.sql).bind(...e.params.map(val)).all()).meta; } catch { out[e.phase + ":errors"] = (out[e.phase + ":errors"] ?? 0) + 1; }
  const o = (out[e.phase] ??= { statements: 0, rowsRead: 0, rowsWritten: 0 });
  o.statements++; o.rowsRead += meta.rows_read ?? 0; o.rowsWritten += meta.rows_written ?? 0;
}
console.log(JSON.stringify(out));
await proxy.dispose();
rmSync(persist, { recursive: true, force: true });
