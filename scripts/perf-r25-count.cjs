// R25 perf helper (local only): counts the SQL statements the server prepares so scripts/perf-r25.mjs
// can report queries per request (each one is a network round trip on D1). Loaded with
// NODE_OPTIONS=--require ./scripts/perf-r25-count.cjs and PERF_COUNT_PORT set; never used in production.
/* eslint-disable @typescript-eslint/no-require-imports */
const http = require("node:http");
const port = Number(process.env.PERF_COUNT_PORT || 0);
if (port) {
  let Database;
  try { Database = require("better-sqlite3"); } catch { Database = undefined; }
  if (Database) {
    let log = [];
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      const srv = http.createServer((req, res) => {
        if (req.url === "/reset") log = [];
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(req.url === "/dump" ? log : { n: log.length }));
      });
      srv.on("error", () => { /* another process has it */ });
      srv.listen(port, "127.0.0.1").unref();
    };
    const prepare = Database.prototype.prepare;
    let patched = false;
    const patch = (proto) => {
      patched = true;
      for (const m of ["all", "get", "run"]) {
        const orig = proto[m];
        proto[m] = function (...a) {
          const t = process.hrtime.bigint();
          try { return orig.apply(this, a); } finally { log.push({ sql: this.source, ms: Number(process.hrtime.bigint() - t) / 1e6 }); }
        };
      }
    };
    Database.prototype.prepare = function (sql) {
      start();
      const st = prepare.call(this, sql);
      if (!patched) patch(Object.getPrototypeOf(st));
      return st;
    };
  }
}
