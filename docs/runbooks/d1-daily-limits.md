# D1 daily limits

## What caused 24 October (summary)
Cloudflare's Free plan allows 100,000 D1 rows written per day for the whole account, and production (mymail-au) and staging (mymail-staging) share it. On 24 October 2026 staging's test runs and demo seeds wrote 69,035 rows and production 31,724, all between 00:00 and 03:00 UTC, so the account passed 100,000 at about 03:00 UTC and every database went read only until 00:00 UTC. The biggest single production writer was an old demo seed follow-up (`UPDATE deliveries SET created_at`, 10,440 rows), removed since. Details in "Second pass" below.

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
- Write budget guard (`src/server/services/write-budget.ts`). Each cron pass reads the account's rows written today from Cloudflare analytics with `CF_ANALYTICS_TOKEN` (read only, no database writes), logs `d1.write_budget` (searchable in Workers Logs) and reports to Sentry once per level per day from 60% (`warn`). From 80% (`shed`; 85% since R32, see "D1 limit reached") production stops opening new demo workspaces. Staging runs with `WRITE_BUDGET_GUARD=strict` and answers every API write with the read only message from 60%, so tests on staging can never take production read only. Sign in and normal writes on production are never refused by the guard. `/api/health` shows `writes` (today, budget, level). Without the token the guard is off and refuses nothing.
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

## D1 limit reached (R32)

### How to tell
- The API answers `503` with `{"error":{"code":"read_only"}}` ("Multies is read only for a short while") on writes, and the web app shows the read only banner. Sign in callbacks land on `/login?error=read_only`.
- `GET https://multies.si/api/health` shows `writes`: `today`, `budget`, `pct`, `level` (`ok`, `warn` from 60%, `shed` from 85%), `resetAt` (next 00:00 UTC), `byEnvironment` (production, staging) and `deferred` (what this isolate wrote, coalesced or skipped). The operator console (`/app/admin`) shows the same as a meter.
- The alert mail to `OPS_ALERT_EMAIL` (default security@multies.si): "Multies D1 writes at 60% today (60,123 of 100,000)" and again at 85%. Once per level per UTC day for the whole deployment (one `app_settings` row per alert, key `d1_alert:<date>:<level>`). Also a Sentry error and a `d1.write_budget` line in Workers Logs on every cron pass.
- The analytics query (account token in the Cloudflare section of CREDENTIALS, read through creds.mjs, never printed):

```
POST https://api.cloudflare.com/client/v4/graphql
query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){
  d1AnalyticsAdaptiveGroups(limit:50,filter:{date:$d}){sum{rowsWritten rowsRead} dimensions{databaseId date}}}}}
variables: {"a":"84058c44c33b60521d2bb03c36dc0881","d":"<today, UTC, YYYY-MM-DD>"}
```

Database ids: production `e467919b-f7d8-4961-86b9-9cd861708efc`, staging `72494627-4880-4fb9-9586-e2175f16e8d3`.

### What still works at each level
| Level | From | Production | Staging (strict) |
| --- | --- | --- | --- |
| ok | 0% | everything | everything |
| warn | 60% | everything; visits and last used or last seen times coalesced to one per item per 15 minutes (read state a person sees still writes); alert mail | API writes refused (read only), reads work |
| shed | 85% | mail in and out, sign in, tasks, chat, docs, forms all write; deferrable writes skipped (answer success, write nothing); new demos paused; second alert mail | read only |
| cap | 100% | D1 refuses every write: read only until 00:00 UTC. Reads, the web app and cached views work; inbound mail is retried by the sender for days | read only |

Deferrable writes (src/server/services/write-priority.ts): catch up visits (`item_visits`, except "Mark as caught up"), chat read markers set by opening a channel, mail marked read because it was opened (the Mark read action is essential), notification read marks, last used times on API keys, inbound keys, OAuth grants and auth email hooks, last seen on project guests. Plan and usage counters stay essential because they enforce sending limits. When D1 itself refuses a write for the limit, that isolate sheds for the rest of the UTC day even without the analytics token.

There is no local fallback counter: a count of one isolate's own writes sees a sliver of one database and never staging, so it would read "ok" on exactly the day that matters. Without `CF_ANALYTICS_TOKEN` the meter is off and only the real limit error sheds.

### First 10 minutes
1. Stop the bleeding: cancel any test run, Playwright suite or load script pointed at staging or production, and any demo seeding. Check CI for running jobs.
2. Read the top writers today, ordered by rows written:

```
query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){
  d1QueriesAdaptiveGroups(limit:20,filter:{date:$d},orderBy:[sum_rowsWritten_DESC]){
    sum{rowsWritten rowsRead} count dimensions{query databaseId}}}}}
```

3. If staging is the writer and the cap is not reached yet, make staging read only now: `npx wrangler secret put WRITE_BUDGET_GUARD --env staging` with the value `strict` piped on stdin (already set; check it is), or lower the thresholds for staging: `WRITE_BUDGET_WARN_PCT=30`.
4. If production is the writer, find the route or cron step in the top queries and turn it off (demo: `DEMO_DAILY_LIMIT=0`; cron: comment the step and deploy only if the cap is not reached, since a deploy with migrations writes).
5. Post in #engineering what you saw and did. Do not run `wrangler d1 export` or migrations until the reset.

### Recovery
The cap resets at 00:00 UTC (11:00 Sydney in summer). Nothing needs restoring: refused writes were never applied, and the API told each client it was read only. After the reset check `/api/health` (`writes.level` is `ok`), send a test mail to security@ and confirm it lands, and check that the cron's next pass ran (uptime row). Mail that bounced during the window was retried by the sending servers.

### Permanent fixes
- Staging on its own free Cloudflare account (steps in "Plan: staging on its own free account" above). This removes the main cause: staging can never spend production's budget. Needs the owner, or a new mailbox, to sign up.
- Workers Paid (the owner's choice): D1 then allows 50 million rows written a month, billed past that. Not done; the guard stays useful either way.

## Write amplification (R32)
Measured with the D1 meter in tests (`tests/d1-meter.ts`: a row counts once for the table and once per full index, a partial index only for entries that came or went). This is an upper bound: D1 counts an index on an UPDATE only when its columns change.

Migration 0072 makes seven indexes partial (`WHERE col IS NOT NULL`): `tasks_parent_idx`, `tasks_org_thread_idx`, `tasks_org_due_idx`, `chat_messages_parent_idx`, `deliveries_provider_msg_idx`, `messages_mailbox_provider_msgid_idx`, `contacts_company_idx`. Those columns are empty for most rows, so every insert paid for an index entry no query reads. EXPLAIN QUERY PLAN checks that the lookups still use them.

| Action | Before (53b8cdb) | After (0072) | Where the rows go now |
| --- | --- | --- | --- |
| Task create (no due date) | 17 | 14 | task 4, project number claim 3, activity 4, change log 2, creator watch 1 |
| Task update (status) | 7 | 5 | task 5 (the meter counts every full index on an update) |
| Task update (title) | 13 | 11 | task 5, activity 4, change log 2 |
| Chat message | 12 | 11 | message 4, channel last message time 4, sender read marker 3 |
| Doc save | 9 | 9 | doc 3, activity 4, change log 2 |
| Mail received | 20 | 17 | message 6, mailbox counters 4, delivery log 3, contact 4 |
| Mail sent (API, with limiter) | 33 | 32 | message 6, mailbox 4, contact 5, activity 4, change log 2, delivery 4, audit 4, limiter 3 |
| Sign in | 10 | 10 | session 4, user 3, limiter 3 (a binding in production) |
| Cron pass, idle | 3 | 3 | one uptime row |

`tests/write-budget-r32.test.ts` locks the After column: it fails if any action grows.

Not cut in R32, and why: task create at 8 rows (the goal) was not reached; it needed the activity row and the change log row to become one, and the project number claim to move off the projects row. Both landed in R33 (below).

### R33: one row per change, number claim off the projects row (migration 0073)

- One row per change. A tracked write (task, doc, project, contact and the rest through `recordWrite`) used to add an `activity` row (row, primary key, two indexes: 4) and a `changes` row (row and one index: 2). The `changes` row now carries the activity fields (`actor_type`, `actor_id`, `actor_name`, `verb`, `data`) and is the only row: 3 (row, `changes_org_seq_idx`, and one entry in the partial `changes_entity_idx`, which holds only rows with a verb). The sync feed (`changesSince`) reads the same rows as before. Every timeline reader (task and contact history, catch-up digests, sprint burndown) reads the SQL view `activity_feed`: the old `activity` rows plus change rows with a verb, so rows from before 0073 still show. Bulk summaries and sprint scope rows still go to `activity` (one row per bulk action, not per task). Nothing is dropped.
- Task number claim. `UPDATE projects SET next_number = next_number + n` rewrote the wide projects row (3). The counter is now `project_counters` (WITHOUT ROWID, no other index: 1), claimed with one UPSERT ... RETURNING in `src/server/services/suite/project-counter.ts`, seeded on first claim from `projects.next_number` (and by 0073 for projects past 1). `projects.next_number` is kept and no longer written.
- Rollback: the code before 0073 still reads `projects.next_number`, so copy the live counters back first: `UPDATE projects SET next_number = (SELECT next_number FROM project_counters WHERE project_id = projects.id) WHERE id IN (SELECT project_id FROM project_counters);`. Change rows written since 0073 have no `activity` twin; the old timeline would not show them (they stay in `changes`).

| Action | Before R33 | After R33 | Where the rows go now |
| --- | --- | --- | --- |
| Task create (no due date) | 14 | 9 | task 4, change 3, number claim 1, creator watch 1 |
| Task update (title) | 10 | 7 | task 4, change 3 |
| Task update (status) | 4 | 4 | task 4 (no timeline row, as before) |
| Task move to another project | 13 | 8 | task 4, change 3, number claim 1 |
| Comment (http, with limiter) | 16 | 13 | comment 3, task 4, change 3, limiter 3 |
| Bulk move of 2 tasks (http) | 22 | 20 | tasks 8, change rows 4 (feed only), one summary activity 4, number claim 1, limiter 3 |
| Doc save | 9 | 6 | doc 3, change 3 |
| Doc create | 9 | 6 | doc 3, change 3 |
| Chat message | 11 | 11 | unchanged |

Measured with `tests/d1-meter.ts` (`tests/r33-measure.test.ts` prints the table by table split); `tests/write-budget-r32.test.ts` locks the new numbers and `tests/d1-rows-r33.test.ts` checks the query plan (`changes_entity_idx`) and the behaviour.

The cron writes one uptime row per pass: 96 a day on production (every 15 minutes) and 24 on staging (hourly), about 360 D1 rows a day with the row's index. No cut needed.

## Imports (R54, 28 Oct 2026)

What one imported task costs, measured on staging D1 (`wrangler d1 execute --remote`, whose answer carries D1's own rows written) with the exact insert statements the work import sends:

| File shape | Tasks | D1 rows written | Per task |
| --- | --- | --- | --- |
| 1 parent with 4 subtasks, parent first (today's order) | 5 | 53 | 10.6 |
| the same, subtasks before their parent | 5 | 49 | 9.8 |
| 5 top level tasks | 5 | 45 | 9.0 |

So 9 rows per task is the floor (the task row, its indexes, the project status counter row the trigger keeps), and a subtask adds about 2 (its entry in the parent index, and the trigger's update of the parent's subtask count). A 1,000 row file with 800 subtasks costs about 10,600 rows, about a tenth of the shared 100,000 a day; the import already stops at the write budget warning and the daily task cap. Statements: about 1.05 write statements per row (one insert per task, 50 tasks per batch, one counter row per batch).

The only avoidable part is the parent count update (about 0.8 rows per row on a subtask heavy file). Two ways to cut it, neither done yet: insert a family's subtasks before their parent inside one batch (the batch is one transaction, so the trigger finds no parent and the parent's insert carries its counts), or a migration that skips the trigger for imported rows and recounts once per batch. `tests/import-write-cost-r54.test.ts` locks the local meter at 17 units per row (it counts trigger rows as task rows, so it reads 16.2 where D1 reads 10.6).
