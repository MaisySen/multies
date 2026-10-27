# Cold start CPU (R42, MB-199)

The free plan stops a request at 10 ms of CPU. A new isolate's first request used to cost 30 to 60 ms.

## What the profile showed (scripts/cold)

- `node scripts/cold/build-profile.mjs <out>/_worker.js` builds the worker bundle unminified with a metafile.
- `scripts/cold/run-profile.mjs` runs that bundle in Node (cloudflare:* stand ins, a better-sqlite3 D1 stand in) and
  times every lazily initialised module (esbuild `__esm` / `__commonJS` wrappers) per phase, plus one cold and three
  warm requests. `--cpuprof <file>` writes a CPU profile of the cold request.
- Result on 142ec75: all 1410 wrapped modules initialise during script startup (about 200 ms in Node), and **none**
  during the first request. The first request's extra 30 to 75 ms was the engine compiling the request path
  (routing, middleware, session lookup, query builder, the route, and the error reporting wrapper).

## The fix: a startup warm up (src/entry/warmup.ts)

At script startup (its own, much larger allowance) a throwaway copy of the app answers the hot signed in GETs from a
recorded fixture (`src/entry/warm-fixture.json`) through a replay only fake database. The compiled code is shared
with the real app; config, database, bindings and caches are not. Startup forbids Request, Response, timers and
random values, so stand ins are swapped in for the warm up and put back when it ends, and again first thing in every
real request, cron run and Durable Object handler. Per isolate caches are cleared after each warm route.

- Never warm the outer error reporting wrapper: it keeps one client per isolate with the address it was first
  given (R42 deploy 1 did, with a placeholder address; removed in the next deploy). The first request log line
  `[isolate] first request` carries `reportingClientBefore`, which must be false.
- Turn off: set `STARTUP_WARM=off` (a Worker var). `STARTUP_BOOT_LOG=1` logs the warm up report at startup.
- Local check in the real runtime: `wrangler dev --local` with `STARTUP_BOOT_LOG=1` in `.dev.vars` prints
  `[startup] warm up {"ran":10,"ok":10,...}`.
- Re-record the fixture after schema or hot route changes (a stale fixture only warms less, it never breaks):
  `node scripts/cold/build-profile.mjs /tmp/cold/_worker.js && cp /tmp/cold/_worker.js /tmp/cold/w.mjs &&
  node --import ./scripts/cold/register.mjs scripts/cold/record-fixture.mjs /tmp/cold/w.mjs`
  (the fixture is a fresh local demo workspace; tests/warmup-r42.test.ts checks it holds only test addresses).

## R43: no per request error reporting wrapper (src/entry/reporting.ts)

The R43 workerd profile (files/multies-r43/cpu-first-pass.md) showed the reporting SDK's request wrapper as the biggest
single block of a new isolate's first request: about 17 ms of about 45 ms (its init, isolation scope and request
span), and about 0.8 ms on every warm request, with tracing already off. R43 removed the wrapper:

- `src/entry/worker.ts` wraps fetch and scheduled in our own try/catch. `deps.reportError` (the API's error handler,
  the cron, background jobs) and anything that escapes a request or a cron run go to `reportException`.
- The reporting client is created lazily, on the first error in an isolate, always with the real address
  (`SENTRY_DSN_API`, read per request; never at startup and never by the warm up). Errors only: no tracing, no
  request spans, the same privacy scrubber. Queued events leave on `flushReporting()` inside `ctx.waitUntil`.
- `[isolate] first request` now also says `"reporting":"lazy"`; `reportingClientBefore` must still be false.
- End to end check: `POST /api/_report-test` with header `x-report-test` equal to the `REPORT_TEST_TOKEN` secret
  (at least 32 characters) throws a test error through the outer catch and answers 500 with the event id. Without the
  secret (the normal state) the path is a plain 404. Set it with `wrangler secret put REPORT_TEST_TOKEN` (value on
  stdin, never in argv), run the check once, then `wrangler secret delete REPORT_TEST_TOKEN`.
- Admins can still send a handled test event from Operations (`POST /api/admin/sentry-test`).
