# Multies round 9 QA report

Date: 24 October 2026 (UTC). Production and staging both run release 5b7a742829ba.
Tested with demo workspaces and the App Review demo account only. No real customer data was touched.

## What was covered

The full list is in docs/qa/inventory.md, generated from the code by scripts/qa/inventory.ts:
316 API endpoints, 53 web routes, 40 MCP tools, 34 webhook events, the cron jobs in wrangler.toml, 16 mobile screens and 8 settings pages.

| Check | How | Result |
| --- | --- | --- |
| Unit and API tests | `npx vitest run` | 260 passed, 2 skipped |
| Authorisation sweep | tests/authz-matrix.test.ts: every endpoint without a session, plus cross-workspace reads, edits and deletes | Passes after 2 fixes (below) |
| Roles (guest, member, admin, agent key) | existing tests/team, guest, agent and suite tests, plus the sweep | Pass |
| End to end, local | Playwright, 9 specs, 28 tests (2 new specs: store-pages, a11y) | All pass |
| End to end, staging | same suite against staging | 17 pass, 1 flaky then pass; 8 stopped by the per-IP sign-up and demo rate limits, which is the limits working (they pass locally) |
| End to end, production | smoke, store-pages, suite-r8 | Pass, apart from one run stopped by the demo rate limit |
| Accessibility | axe on 42 pages at 1280 px and 390 px (scripts/a11y-audit.mjs) | 0 serious or critical after fixes; a few moderate findings left (heading order on boards, no h1 on the doc editor, duplicate landmark names on 2 pages) |
| Broken links | crawl of every public page, 61 links | 0 broken |
| Copy | `npm run lint:copy` (en-AU, no em or en dash) and a search for Australian hosting claims | Clean. The FAQ and README say plainly that mail is not hosted in Australia yet |
| Static analysis | semgrep p/default and p/typescript | 1 warning, a false positive (a regular expression built from a constant) |
| Secrets | gitleaks over all 212 commits and the working tree | 0 in git; 3 hits in gitignored build output, all placeholders |
| Error states | unknown endpoint, bad JSON, no session, invalid body, missing record, cross-site POST, unknown page | 404, 400, 401, 422, 404, 403, and a friendly page-not-found screen |
| Speed | server `ms` from the live log, 600 requests at 8 at a time | p95 under 180 ms on every main endpoint (tasks 164, contacts 160, portfolio 178, projects 135, approvals 106, account 112). From Seattle, add about 150 to 250 ms of network |

## The intermittent 503s and 500s

There were two separate causes.

1. **503 with an empty body.** The live log showed `exceededCpu`. On the Workers Free plan a request gets 10 ms of CPU. The first request on a new isolate also built the whole app, and the public v1 API alone (about 150 OpenAPI routes) took around 10 ms to build. In a serial test 10 of 60 calls failed. The v1 API is now built on its first /api/v1 request (src/server/app.ts). Afterwards: 0 of 120 serial calls and 0 of 600 concurrent calls failed, and CPU p90 went from 68 ms to 14 ms.
2. **500 `failed_to_get_session` under concurrent load.** Better Auth 1.7 keeps request state in AsyncLocalStorage, and Workers lost it between concurrent requests in one isolate (63 of 300 failed on production). Every entry now opens that state per request (src/server/lib/request-state.ts). A rare remaining loss, about 1 in 300, is retried once in a fresh state (src/server/middleware.ts). The last load test had 600 of 600 succeed, with one retry logged.

## Bugs fixed (each with a regression test)

| Bug | Fix | Test |
| --- | --- | --- |
| 503 from the CPU limit on a new isolate | lazy v1 API | tests/v1-lazy.test.ts |
| 500 failed_to_get_session under concurrency | request state per request, plus a retry | tests/request-state.test.ts |
| Sentry MYMAIL-API-C: the maintenance cron hit the Workers subrequest limit | reminder and rule budgets, demo workspaces skipped, oldest run first | tests/due-reminders-budget.test.ts |
| Sentry MYMAIL-API-K: a demo seed failed on a foreign key when the visitor deleted the sandbox first | the seed checks the workspace still exists | tests/account-delete.test.ts |
| v1 fields, guests and portfolio answered 500 without an API key | added to the API key guard | tests/authz-matrix.test.ts |
| Deleting another workspace's automation answered 200 (nothing changed) | now 404 | tests/authz-matrix.test.ts |
| Board and deal cards were a button wrapping other buttons; icon-only view tabs on phones had no name; scrolling tables could not be focused | drag handle with a label, tab labels, focusable table regions | e2e/a11y.spec.ts |
| The status page showed sending as not set up on a self-hosted install using SMTP | SMTP counts as set up | tests/status.test.ts |
| A demo visitor could not delete their sandbox once the session was over 5 minutes old | the confirm word is enough for a demo-only account | tests/account-delete.test.ts |

## Housekeeping

- The leftover "Ben Carter" test account from round 8 (user usr_n3hqybcymhw0d9b6 and workspace org_jxqu8sgn24ylkuv5) was deleted from production. Staging never had it.
- Sentry: C, J and K are resolved. H, M and N are low-priority "N+1 query" performance notes on the demo seed. The seed is a one-off background job, so they were left open.

## Known limits, not fixed this round

- Unknown web pages return HTTP 200 with a page-not-found screen, because the single-page app handles routing.
- Opening a demo takes about 5 seconds from the US.
- The rate limits are kept in memory per isolate, so they are loose on Workers. They held during testing.
- GitHub Actions cannot run: the account's minutes or spending limit is used up. Deploys this round were run by hand with the same steps (build, migrate, deploy, smoke test, staging first).
