# D1 daily limits

## What happened (24 October 2026)
The Cloudflare account hit the Free plan D1 cap of 100,000 rows written per day (reads were fine at 1.3 million of 5 million). Production (mymail-au) and staging (mymail-staging) share one account, so staging's E2E runs and demo seeds (about 70,000 rows) used most of production's budget. The cap resets at 00:00 UTC.

Top writers that day, from `d1QueriesAdaptiveGroups` in the GraphQL API:
- demo workspace seeds: messages, change log, activity, mailboxes, tasks and contacts inserts
- a redundant `UPDATE deliveries SET created_at` after each demo seed (about 58 rows each)
- the domain re-check cron writing every demo domain row every few minutes (Sentry MYMAIL-API-5)

## What we changed
- Demo: at most `DEMO_DAILY_LIMIT` new demo workspaces per rolling 24 hours (40 on production, 10 on staging); after that the demo answers "demo is resting for today". The seed sets folders and delivery dates on insert instead of two follow-up updates.
- Domain re-checks skip sample workspaces; pending domains are checked hourly and verified ones daily.
- The cron runs every 15 minutes instead of every 5.
- Chat marks a channel read once per new message, not on every channel list refresh.
- A D1 limit error answers 503 with code `read_only` ("Multies is read only for a short while") and is not sent to Sentry. Maintenance steps skip quietly.

## Rules from now on
- Run E2E and the launch checklist locally (node entry, local SQLite). Against staging or production, confirm a deploy with one GET of `/api/config`.
- Skip D1 migrations on deploys that do not need them; migrations write.
- Keep demo seeds small and lazy.

## How to read usage
GraphQL `d1AnalyticsAdaptiveGroups` (sum of rowsRead, rowsWritten by databaseId, today) and `d1QueriesAdaptiveGroups` ordered by `sum_rowsWritten_DESC` for the top queries. The account token in "CREDENTIALS (owner email v7)", Cloudflare section, can read both.

## Second pass (24 October 2026, evening)
Measured from `d1QueriesAdaptiveGroups` for 24 October (UTC). The cap was reached at about 03:00 UTC: staging wrote 69,035 rows and production 31,724, all between 00:00 and 03:00. Before and after that burst both databases wrote almost nothing (production 0 to 200 rows an hour, staging 12 to 60).

| Source | Rows written | Where |
| --- | --- | --- |
| Test and demo workspaces: mail, change log, activity, mailboxes, tasks, contacts, links inserts | about 50,000 | staging (test runs against staging) |
| `UPDATE deliveries SET created_at` in the old demo seed (180 runs, 58 rows each) | 10,440 | production (removed in 2340b1f, deployed since) |
| Demo and test workspace inserts | about 20,000 | production |
| Domain re-checks (one update per check) | 878 and 713 | production, staging (demo domains skipped since 2340b1f) |
| Uptime rows, usage counters, sessions | under 1,000 each | both |

Write costs measured locally in D1 terms (one row per table write plus one per index; `tests/write-cost.test.ts`):

| Action | D1 rows |
| --- | --- |
| Sign in | 10 (session row with 3 indexes; the rate limit counter is a binding in production) |
| Signed in GET requests | 0 |
| Idle cron pass | 3 (one uptime row) |
| New demo, both seed parts | about 970, and about as many again when the purge deletes it |

Sign in, normal use and the cron are cheap. The cap is reached only by bursts of workspace creation: test suites and demos.

What changed:
- Write budget guard (`src/server/services/write-budget.ts`). Each cron pass reads the account's rows written today from Cloudflare analytics with `CF_ANALYTICS_TOKEN` (read only, no database writes), logs `d1.write_budget` (searchable in Workers Logs) and reports to Sentry once per level per day from 60% (`warn`). From 80% (`shed`) production stops opening new demo workspaces. Staging runs with `WRITE_BUDGET_GUARD=strict` and answers every API write with the read only message from 60%, so tests on staging can never take production read only. Sign in and normal writes on production are never refused by the guard. `/api/health` shows `writes` (today, budget, level). Without the token the guard is off and refuses nothing.
- `DEMO_DAILY_LIMIT` 10 on production (at most about 20,000 rows a day) and 2 on staging.
- Staging cron runs hourly.
- Last used times for API keys, inbound keys and auth email hooks are written at most every 15 minutes (an agent polling once a minute was up to 1,440 writes a day per key).
- Migration 0025 drops `companies_org_idx`; `companies_org_domain_uq` starts with `org_id` and serves the same lookups.
- The web app shows a read only banner when any request gets `read_only`, the sign in form shows the read only message, and a sign in callback that hits the limit lands on `/login?error=read_only` instead of raw JSON.
- Playwright refuses a remote `E2E_BASE_URL` unless `E2E_ALLOW_REMOTE=1` and `--grep` are set.

Expected daily writes after this: production about 2,000 to 5,000 rows on a normal day (cron, sign ins, mail, real work) plus up to about 20,000 if all 10 demos are used; staging about 500 without test runs. Well under 100,000, with the guard as the backstop.

Setup (once, at deploy): create a Cloudflare API token with only Account Analytics: Read on account 84058c44c33b60521d2bb03c36dc0881, then `npx wrangler secret put CF_ANALYTICS_TOKEN` and the same with `--env staging`. Check with one GET of `/api/health`: `writes.level` is `ok` and `writes.today` matches the dashboard (analytics lag a few minutes).

## Plan: staging on its own free account (not done yet)
1. Create a second free Cloudflare account for staging (owner signs up, or Tab with a new mailbox).
2. Create the D1 database `mymail-staging`, the Durable Object namespace and the rate limit bindings there; apply migrations.
3. Make a token on that account with Workers Scripts, D1 and Workers Routes edit; keep it in CREDENTIALS under a new section.
4. Move `[env.staging]` in wrangler.toml to that account (`account_id` per environment) and deploy with the staging token.
5. Remove the `PEER` service binding and `PEER_HOST` (cross account), and let production watch staging over HTTPS instead.
6. Delete the old `mymail-staging` worker and database from the production account.
Result: staging and its tests can never spend production's daily budget.
