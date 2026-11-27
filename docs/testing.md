# Testing

## The pyramid

| Layer | Tool | Where | Count (24 Oct 2026, round 10) |
| --- | --- | --- | --- |
| Unit and API integration | Vitest | `tests/` | 283 pass, 2 skipped |
| End to end, local | Playwright (Chromium) | `e2e/` | 39 pass |
| Launch checklist | Playwright | `e2e/launch-checklist.spec.ts` | 9 specs covering the 20 points, pass against production |
| Accessibility | axe-core | `e2e/a11y.spec.ts`, `scripts/a11y-audit.mjs` | 0 serious or critical |
| Copy | `scripts/check-copy.ts` | every tracked text file | clean |
| Load | k6 | `load/` | see `load/README.md` |
| Lighthouse budgets | Lighthouse CI | `lighthouserc.cjs` | |
| Mobile | Jest | the Expo project | 106 pass, 6 skipped (1.5.0) |

API tests run the real Hono app against an in memory SQLite database with fakes for DNS, mail, clock
and fetch (all injected through `Deps`). The authorisation sweep (`tests/authz-matrix.test.ts`) calls
every endpoint without a session and with another workspace's ids.

## Run them

```bash
npm run typecheck
npm run lint
npm run lint:copy
npx vitest run                      # or npm run test:coverage for thresholds
npm run build:web                   # Playwright serves the built app
npx playwright install chromium     # once
npx playwright test                 # starts a local Node server on :8788 with DEMO_MODE
npm run a11y:audit -- <base-url> <out-file>   # add --cookies for signed in pages
```

`npm run typecheck` checks about 7,000 files and needs about 5.3 GB of memory (measured on Linux, Node 22,
11 November 2026), more than Node's default heap, so `scripts/typecheck.mjs` runs tsc with a 6 GB heap. That
fits the 7 GB CI runner. A heap size in `NODE_OPTIONS` (for example `--max-old-space-size=8192`) takes its place
on a machine that needs more. If it runs out of memory again, measure first (`/usr/bin/time -v`) before raising
the cap.

`npx playwright test` starts its own server (`src/entry/node.ts` on port 8788 with a fresh database
in `.data/e2e.db` and an outbox in `.data/e2e-outbox`), so nothing else needs to run.

## Against a deployed host

Set `E2E_BASE_URL` and Playwright uses that host instead of starting a server:

```bash
E2E_BASE_URL=https://mymail-staging.mymail-app.workers.dev npx playwright test e2e/smoke.spec.ts e2e/launch-checklist.spec.ts
E2E_BASE_URL=https://mymail.mymail-app.workers.dev npx playwright test e2e/launch-checklist.spec.ts
scripts/smoke.sh https://mymail-staging.mymail-app.workers.dev <release>
```

Known limitation: a full remote run signs up and opens demo workspaces many times from one IP, so it
hits the per IP sign up and demo rate limits and some specs stop with 429. That is the limits working.
Run the whole suite locally, and only the smoke, store pages, launch checklist and round 10 specs
(`e2e/suite-r10.spec.ts` shares one demo workspace) against staging and production.

## When to add a test

- Every bug fix gets a regression test that fails before the fix.
- If the app counts data only in a time window (for example the last 30 days), do not use fixed dates in
  the test data. Calculate the dates from the test clock (`Date.now()`). Add a test that moves the clock
  forward with `vi.useFakeTimers({ toFake: ["Date"] })` before the test app setup and the test data, and runs
  the same assertions (MB-7).
- Every new route gets an API test, including a cross workspace call that must answer 404 or 403.
- Every new page gets an entry in the known pages list and is covered by the a11y spec.
