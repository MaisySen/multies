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

- Turn off: set `STARTUP_WARM=off` (a Worker var). `STARTUP_BOOT_LOG=1` logs the warm up report at startup.
- Local check in the real runtime: `wrangler dev --local` with `STARTUP_BOOT_LOG=1` in `.dev.vars` prints
  `[startup] warm up {"ran":10,"ok":10,...}`.
- Re-record the fixture after schema or hot route changes (a stale fixture only warms less, it never breaks):
  `node scripts/cold/build-profile.mjs /tmp/cold/_worker.js && cp /tmp/cold/_worker.js /tmp/cold/w.mjs &&
  node --import ./scripts/cold/register.mjs scripts/cold/record-fixture.mjs /tmp/cold/w.mjs`
  (the fixture is a fresh local demo workspace; tests/warmup-r42.test.ts checks it holds only test addresses).
