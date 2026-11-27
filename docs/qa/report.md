# Multies QA report

## Round 10 (0.10.0), 24 October 2026

Production runs release bf51880eb8e2 with the Multies name, the light and dark design and the analytics
beacon. The inventory ([inventory.md](inventory.md)) was regenerated from the code: 334 API endpoints,
60 web routes, 52 MCP tools, 44 webhook events and 23 mobile screens.

| Check | How | Result |
| --- | --- | --- |
| Unit and API tests | `npx vitest run` | 283 passed, 2 skipped |
| End to end, local | `npx playwright test` | 39 passed |
| Launch checklist | `e2e/launch-checklist.spec.ts` against production | 9 of 9 specs pass, covering all 20 points |
| Copy | `npm run lint:copy` | Clean, including the old product name rule |
| Unknown pages | launch checklist | HTTP 404 with the page not found screen (was 200 in round 9) |

Changes to the round 9 known limits: unknown pages now answer 404, and the moderate axe findings on
board headings and the doc editor were fixed in round 10. Still open: rate limits are per isolate, a
remote E2E run hits the sign up and demo limits, and GitHub Actions has no minutes until 1 November, so
deploys are manual ([../runbooks/deploy.md](../runbooks/deploy.md)). Round 11 work (integrations,
demo speed, the remaining axe items, meetings scheduling) is tracked in the CHANGELOG.

## Round 9 (0.9.0)

Date: 24 October 2026 (UTC). Production and staging both run release 5b7a742829ba.
Tested with demo workspaces and the App Review demo account only. No real customer data was touched.

### What was covered

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

### The intermittent 503s and 500s

There were two separate causes.

1. **503 with an empty body.** The live log showed `exceededCpu`. On the Workers Free plan a request gets 10 ms of CPU. The first request on a new isolate also built the whole app, and the public v1 API alone (about 150 OpenAPI routes) took around 10 ms to build. In a serial test 10 of 60 calls failed. The v1 API is now built on its first /api/v1 request (src/server/app.ts). Afterwards: 0 of 120 serial calls and 0 of 600 concurrent calls failed, and CPU p90 went from 68 ms to 14 ms.
2. **500 `failed_to_get_session` under concurrent load.** Better Auth 1.7 keeps request state in AsyncLocalStorage, and Workers lost it between concurrent requests in one isolate (63 of 300 failed on production). Every entry now opens that state per request (src/server/lib/request-state.ts). A rare remaining loss, about 1 in 300, is retried once in a fresh state (src/server/middleware.ts). The last load test had 600 of 600 succeed, with one retry logged.

### Bugs fixed (each with a regression test)

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

### Housekeeping

- The leftover "Ben Carter" test account from round 8 (user usr_n3hqybcymhw0d9b6 and workspace org_jxqu8sgn24ylkuv5) was deleted from production. Staging never had it.
- Sentry: C, J and K are resolved. H, M and N are low-priority "N+1 query" performance notes on the demo seed. The seed is a one-off background job, so they were left open.

### Known limits, not fixed this round

- Unknown web pages return HTTP 200 with a page-not-found screen, because the single-page app handles routing.
- Opening a demo takes about 5 seconds from the US.
- The rate limits are kept in memory per isolate, so they are loose on Workers. They held during testing.
- GitHub Actions cannot run: the account's minutes or spending limit is used up. Deploys this round were run by hand with the same steps (build, migrate, deploy, smoke test, staging first).

## Release Handover Verification (2026-11-28)

Date: 28 November 2026 (AEDT). Production runs release `console-ui-fix-paired-20261123`. `main` is at
`519cb2c2b623` and is behind production. The full status, the migration registry and the landing
order are in [../handover-2026-11-28.md](../handover-2026-11-28.md). Tests used synthetic accounts and
synthetic data only. No one signed in as the live Owner, and no real customer data was touched.

| Check | How | Result |
| --- | --- | --- |
| Console rollout, 23 November | Fresh signed-out browser journeys on production after the paired Worker and asset release | 8 of 8 pass. 59 boot asset hashes present. Old `/admin` and `/app/admin` links redirect to `/console` |
| Console, signed in | Synthetic Owner in an isolated environment with the exact live JavaScript and CSS, 15 sections and 2 detail pages, desktop and mobile | 34 of 34 pass. An ordinary account is refused with 403 |
| Console suites on the live source | 21 suites that use `tests/console-kit.ts`, no-network shell | 132 of 132 pass with a one-line fixture fix. As it is, the wider 58-file run passes 394 of 411; the Console failures come from a stale proof key in the fixture |
| Database migrations | Production | 162 applied, ending `0178_console_indexes_ops1`. `0171_operator_access_audit` preserved |
| Hosted D1 rehearsal, Mail PR #32 as `0179_first_sender_d1load` | Disposable hosted Cloudflare D1 database, 162-migration baseline, 10,000 synthetic messages | Mailbox Important rows read 38,094 to 1,797 (95.3% fewer, 6.26 times faster). Org-wide 34,491 to 12,336 (64.2% fewer, 2.76 times faster). Exact ID parity. 6 of 6 write parity checks |
| Hosted D1 rehearsal, scheduler lease `0180_cron_tick_lease` | Same disposable database | 10 concurrent claims: 1 winner, 9 blocked, 0 errors. Expired lease reclaimed by 1 of 5. Database deleted afterwards and confirmed gone (404) |
| PR #33 Meetings | Applied alone to the live Console source, no-network shell | 34 of 34 pass |
| PR #28 Boards | Same | 28 of 28 pass |
| PR #27 Mail permissions | Same | 5 of 5 pass |
| PR #26 Gmail connect | Same, reconciled to keep MPLAT-110 and the Console feature gate | 50 of 50 pass. Privacy-hardened variant 51 of 51, recommended |
| PR #38 TikTok credentials | Same | 36 of 36 pass |
| PR #44 DMARC test clock | Same | 11 of 11 pass. Equivalent fix already in the live source, still needed on `main` |
| PR #31 Tools flags | Same | 41 of 41 pass. Exactly six approved tools, no `index` or `folders`. Held until the Mail database load fix is live |
| Worker release guard | 8 verifier tests and 7 browser journeys against the compiled package | Pass. A stale Worker with new assets and a missing style are both rejected. Applies to `main` forward and reverse |
| Auth0 native MFA and operator access | 116 checks across 14 suites, plus a private staging rehearsal with real Auth0 sign-ins | Pass. Owner recovery and revocation proven on staging. Stage closed afterwards |
| Stripe | Six check groups in Stripe test mode, billing route suite locally | Six of six groups pass. 12 of 12 route checks pass. Sandbox cleaned up. No live charges |
| iPhone Mail QA, run `45118482982` | Simulator build, install, launch and Inbox tap test | Build succeeded. Install and launch exit 0, no crash record, app stayed running. Tap test blocked: assertion driver timeout (`exit=-9`), then `BLOCKED: terminate fixture timed out after 10s` |

Still open after this round:

- Gate: clear the `main` CI and security gates before merging the dependency and CI pull requests.
- Gate: verify a fresh encrypted off-peak backup and an isolated restore before the next production
  migration.
- One test fails the same way on `main` and on the live source: `tests/tools-index-p2.test.ts`,
  "stops before the D1 read guard".
- Native Inbox and Search checks on iPhone are incomplete, and the Build 20 startup crash has no
  matching device crash report.
- The hosted D1 rehearsal used synthetic data. Nothing from PR #32 or the scheduler lease has been
  applied to production.
