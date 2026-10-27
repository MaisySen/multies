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
- Measured on 27 Oct 2026 (wrangler tail, 60 signed GETs per reading, 0 empty 503s in every reading):
  production before (release a8bcd4b1f6b3, warm): median 10 ms, p95 33 ms, max 53 ms;
  production after (509b801dfa1c, 15 minutes after the deploy, warm): median 7 ms, p95 28 ms, max 35 ms;
  first request of a new isolate after the change: 48 to 54 ms on production (includes the 10 request warm up),
  14 to 16 ms on staging, `reportingClientBefore` false every time. Readings taken in the first minutes after a
  deploy show a few 100 to 200 ms requests from brand new isolates; judge p95 on a warm reading.
- Proof: a thrown test error reached the error tracker from staging and once from production (environment and
  release on the event), and the `REPORT_TEST_TOKEN` secret was deleted again on both.

## Measuring a new isolate's first request on production, on demand (R44)

Before R44 the only production first request numbers came from `wrangler tail` happening to catch a new isolate right
after a deploy (R43 got none for its "before"). `scripts/cold-baseline.mjs` makes the new isolates itself, with no
traffic moved:

1. `wrangler versions upload` of the built checkout: a new version, no traffic.
2. `wrangler versions deploy <current>@100% <new>@0%`: every real request still goes to the current version.
3. GETs with `Cloudflare-Workers-Version-Overrides: mymail="<new>"` run on the new version (Cloudflare documents that
   overrides reach versions at 0%). Nobody else can reach it, so the first GET is a new isolate's first request every
   time; the `[isolate] first request` log line in the tail confirms it.
4. Back to `<current>@100%` in a `finally`. Check with `wrangler deployments status`.

```bash
cd <checkout built at the release you want to measure>   # npm run build:web && npm run build:worker
COLD_KEY_FILE=<json with workspaceKey> node scripts/creds.mjs run CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID -- \
  node scripts/cold-baseline.mjs --samples 4 --warm 5 --label <name> --out /tmp/cold.json   # add --env staging for staging
```

It refuses unless the deployment is one version at 100%, so never run it during a deploy. Each sample costs one
version upload and 6 small signed GETs. Without `COLD_KEY_FILE` it uses `GET /api/config` (public).
A request's `cpuTime` does not include script startup (Cloudflare counts that apart, with its own larger allowance).

First numbers, 27 Oct 2026 08:20 UTC, production, release 4909516bb5a3 code, 4 samples, workspace key on `/api/v1`:

| | values (ms CPU) |
|---|---|
| first request (`/api/v1/projects`) | 106, 46, 42, 46 (median 46) |
| requests 2 to 6 in the same new isolate (tasks, views, projects, tasks, views) | median 11, p95 109 |
| staging, `/api/config` first request (2 samples) | 2, 2 |

What it shows: the startup warm up covers the signed in session routes (`account/me`, dashboard, tasks and so on),
not the `/api/v1` key routes, so a new isolate still pays about 40 ms on its first `/api/v1` request and more on the
next few different `/api/v1` routes. A public route that does no auth costs 2 ms. Warming the key path (a fixture
for the key lookup) is the next lever.

