#!/usr/bin/env node
// R39: run before any load or QA script that reads a lot. D1's free plan blocks every read for the whole
// account, production included, past 5 million rows a day (26 Oct 2026, 23:18 UTC). Exits 1 when today's
// reads are at 50% or more of that, or when the count can't be read.
//   MULTIES_OPERATOR_COOKIE="<name>=<value>" node load/reads-guard.mjs [base url]   (default: staging)
// QUAL1 (audit row 36): the count is on /api/admin/health, for platform operators only (the public /api/health is
// { ok, db }). Pass a platform operator's session cookie for that server; without one the guard refuses, as before.
const base = process.argv[2] || "https://mymail-staging.mymail-app.workers.dev";
const cookie = process.env.MULTIES_OPERATOR_COOKIE || "";
if (!cookie) { console.error("reads guard: set MULTIES_OPERATOR_COOKIE to a platform operator's session cookie for this server; not running load."); process.exit(1); }
const res = await fetch(`${base}/api/admin/health`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
const reads = res?.ok ? (await res.json()).reads : null;
if (!reads) { console.error(`reads guard: the rows read count is not available (${res ? `HTTP ${res.status}` : "no answer"}); not running load.`); process.exit(1); }
if (reads.pct >= 50) { console.error(`reads guard: D1 rows read today are at ${reads.pct}% (${reads.today} of ${reads.budget}). Load waits until 00:00 UTC.`); process.exit(1); }
console.log(`reads guard: ${reads.pct}% of today's D1 reads used, ok to run.`);
