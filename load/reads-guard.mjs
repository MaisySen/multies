#!/usr/bin/env node
// R39: run before any load or QA script that reads a lot. D1's free plan blocks every read for the whole
// account, production included, past 5 million rows a day (26 Oct 2026, 23:18 UTC). Exits 1 when today's
// reads are at 50% or more of that, or when the count can't be read.
//   node load/reads-guard.mjs [base url]   (default: staging)
const base = process.argv[2] || "https://mymail-staging.mymail-app.workers.dev";
const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
const reads = res?.ok ? (await res.json()).reads : null;
if (!reads) { console.error("reads guard: the rows read count is not available; not running load."); process.exit(1); }
if (reads.pct >= 50) { console.error(`reads guard: D1 rows read today are at ${reads.pct}% (${reads.today} of ${reads.budget}). Load waits until 00:00 UTC.`); process.exit(1); }
console.log(`reads guard: ${reads.pct}% of today's D1 reads used, ok to run.`);
