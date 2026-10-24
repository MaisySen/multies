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

## Plan: staging on its own free account (not done yet)
1. Create a second free Cloudflare account for staging (owner signs up, or Tab with a new mailbox).
2. Create the D1 database `mymail-staging`, the Durable Object namespace and the rate limit bindings there; apply migrations.
3. Make a token on that account with Workers Scripts, D1 and Workers Routes edit; keep it in CREDENTIALS under a new section.
4. Move `[env.staging]` in wrangler.toml to that account (`account_id` per environment) and deploy with the staging token.
5. Remove the `PEER` service binding and `PEER_HOST` (cross account), and let production watch staging over HTTPS instead.
6. Delete the old `mymail-staging` worker and database from the production account.
Result: staging and its tests can never spend production's daily budget.
