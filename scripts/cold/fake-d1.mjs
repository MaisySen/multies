// A small D1 stand-in on better-sqlite3 for the cold start profiler (Node only, never shipped).
import Database from "better-sqlite3";
const norm = (v) => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v instanceof ArrayBuffer ? Buffer.from(v) : ArrayBuffer.isView(v) && !(v instanceof Buffer) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v;
class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.db, this.sql, p.map(norm)); }
  _s() { return this.db.prepare(this.sql); }
  async all() { const s = this._s(); if (!s.reader) { const r = s.run(...this.params); return { results: [], success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; } return { results: s.all(...this.params), success: true, meta: {} }; }
  async first(col) { const s = this._s(); if (!s.reader) { s.run(...this.params); return null; } const r = s.get(...this.params) ?? null; return col && r ? r[col] : r; }
  async raw(opts) { const s = this._s(); if (!s.reader) { s.run(...this.params); return []; } const rows = s.raw(true).all(...this.params); if (opts?.columnNames) return [s.columns().map((c) => c.name), ...rows]; return rows; }
  async run() { const s = this._s(); if (s.reader) { const results = s.all(...this.params); return { results, success: true, meta: { changes: 0 } }; } const r = s.run(...this.params); return { results: [], success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }
}
export function fakeD1(path) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");
  return {
    _db: db,
    prepare(sql) { return new Stmt(db, sql); },
    async batch(stmts) { const out = []; db.transaction(() => {})(); for (const s of stmts) out.push(await s.all()); return out; },
    async exec(sql) { db.exec(sql); return { count: 1, duration: 0 }; },
    withSession() { return this; },
  };
}

export function recordingD1(inner) {
  const calls = [];
  const wrap = (st) => ({
    bind: (...p) => wrap(st.bind(...p)),
    all: async () => { const r = await st.all(); calls.push({ sql: st.sql, method: "all", ret: r }); return r; },
    raw: async (o) => { const r = await st.raw(o); calls.push({ sql: st.sql, method: "raw", ret: r }); return r; },
    first: async (c) => { const r = await st.first(); calls.push({ sql: st.sql, method: "first", ret: r }); return c && r ? r[c] : r; },
    run: async () => { const r = await st.run(); calls.push({ sql: st.sql, method: "run", ret: r }); return r; },
    get sql() { return st.sql; },
  });
  return { calls, prepare: (sql) => wrap(inner.prepare(sql)), batch: async (list) => { const out = []; for (const s of list) out.push(await s.all()); return out; }, exec: (s) => inner.exec(s), withSession() { return this; } };
}
