# R25 API speed: before and after

Internal note (not for any website). Branch r25-perf, measured 25 October 2026 on a local Node server.

## How it was measured

- `node scripts/perf-r25.mjs` starts the Node server (`src/entry/node.ts`) on a fresh SQLite file and seeds a realistic workspace through the API plus direct inserts: 10 members, 3 projects x 2,000 tasks (statuses, assignees, due dates, sprints, subtasks), 50 docs, 5 channels x 2,000 chat messages, one mailbox with 2,000 threads (3,000 messages), 500 notifications, a team dashboard.
- Each endpoint is called once to warm up, then 30 times in a row as the owner; p50 and p95 are in milliseconds, wall clock from the client.
- `scripts/perf-r25-count.cjs` (loaded with `--require`, local only) records every SQL statement the server prepares and its run time, so the table also shows statements per request (each one is a network round trip on D1) and time spent inside SQLite.
- Before = main 93dc6c7 (a separate worktree), After = this branch, same script and seed. They ran alternately, twice each, and the numbers below are the mean of the two runs.
- The machine was shared with other builds (Android, web bundles, other test suites) while this ran, so small endpoints move about 15 percent either way from noise alone (config, a static object, shows +16 percent). Treat changes under about 20 percent on the small endpoints as noise; the large ones are repeatable.

## Results

| Endpoint | Before p50 | Before p95 | After p50 | After p95 | p50 change | SQL statements before / after | SQL ms before / after |
|---|---:|---:|---:|---:|---:|---:|---:|
| account me | 6.2 | 17.2 | 5.5 | 10.8 | -10% | 6 / 6 | 0.1 / 0.1 |
| config | 2.2 | 3.1 | 2.5 | 4.2 | +16% | 0 / 0 | 0.0 / 0.0 |
| my work | 36.7 | 50.4 | 11.2 | 18.4 | -70% | 10 / 10 | 1.4 / 1.4 |
| tasks list | 24.9 | 31.2 | 25.9 | 36.7 | +4% | 16 / 14 | 5.7 / 5.5 |
| tasks board | 25.6 | 31.2 | 24.5 | 29.1 | -4% | 16 / 14 | 5.5 / 5.8 |
| sprints | 5.2 | 12.6 | 5.4 | 9.1 | +5% | 6 / 6 | 0.4 / 0.3 |
| sprint detail | 24.4 | 28.5 | 23.0 | 29.4 | -5% | 21 / 19 | 9.9 / 9.1 |
| sprint backlog | 23.2 | 34.0 | 21.9 | 26.0 | -6% | 17 / 15 | 5.6 / 5.3 |
| projects | 8.0 | 20.1 | 6.7 | 8.8 | -16% | 6 / 6 | 3.1 / 2.0 |
| assignees | 4.3 | 7.7 | 4.2 | 5.8 | -5% | 5 / 5 | 0.2 / 0.1 |
| team people | 5.8 | 15.2 | 4.8 | 6.2 | -17% | 5 / 5 | 0.1 / 0.1 |
| dashboard overview | 6.0 | 16.1 | 5.5 | 11.1 | -8% | 22 / 22 | 0.2 / 0.4 |
| dashboard widgets | 21.1 | 29.8 | 15.9 | 20.9 | -24% | 13 / 13 | 10.3 / 14.8 |
| search | 16.2 | 22.2 | 13.8 | 22.7 | -15% | 11 / 11 | 9.2 / 8.6 |
| chat channels | 7.8 | 14.2 | 6.8 | 8.9 | -12% | 9 / 9 | 2.2 / 1.9 |
| chat messages | 8.3 | 16.5 | 7.0 | 8.1 | -15% | 8 / 8 | 2.2 / 2.2 |
| inbox threads | 11.2 | 22.0 | 4.9 | 6.8 | -56% | 4 / 4 | 5.4 / 0.3 |
| notifications | 6.5 | 15.3 | 4.7 | 6.0 | -28% | 5 / 5 | 0.4 / 0.4 |
| workload | 19.9 | 29.3 | 16.2 | 22.6 | -18% | 10 / 10 | 2.5 / 2.2 |

`my work` response bytes differ by one because the body carries its own `tookMs`. Every other response is byte for byte the same size, and every status is 200.

## What the plans showed (EXPLAIN QUERY PLAN on the seeded database)

- Inbox thread list: `SEARCH messages USING INDEX messages_org_idx (org_id=?)` then `USE TEMP B-TREE FOR ORDER BY`: it read every message in the workspace and sorted them to return 50. 5.2 ms in SQLite on 3,000 messages, growing with the mailbox.
- Projects list counts (`group by project_id, status`): read every task row through an index that only held `org_id`. 3 to 8 ms on 6,000 tasks.
- My Work: SQL was only 1.4 ms of 37 ms. The rest was building a new `Intl.DateTimeFormat` for every due task, twice (overdue and due today). Sprint burndowns (one per day) and dashboard widgets (one per time zone offset lookup) did the same.
- Task list, board, sprint and backlog: custom field definitions and statuses were read from D1 on every request.
- No hot read did a plain full table scan; the other plans use their indexes.

## What changed

1. Migration 0052 (`drizzle/0052_r25_perf_indexes.sql`) replaces two indexes, so the number of indexes on each table is unchanged:
   - `messages_org_idx (org_id)` becomes `messages_org_folder_date_idx (org_id, folder, date)`. Inbox list SQL time 5.4 ms to 0.3 ms.
   - `tasks_org_project_idx (org_id, project_id, status_id, position)` becomes `tasks_org_project_cover_idx (org_id, project_id, status_id, position, status, deleted_at, triage_state)`: same leading columns, and the project counts are now answered from the index alone (`COVERING INDEX`).
   - Write cost: a task insert is 16 rows before and after (tests/write-cost.test.ts). Updates that change `deleted_at` or `triage_state` now also touch the task index (rare); status changes already did.
2. `src/server/lib/intl-cache.ts`: one formatter per locale and options for the life of the isolate (bounded at 500). Used by My Work, sprints and dashboards. My Work p50 37 ms to 11 ms.
3. `src/server/lib/org-memo.ts` and `src/server/services/suite/read-cache.ts`: a per isolate memo with a 10 second TTL, keyed by database handle and org, for custom field definitions and project statuses. Field and status writes (fields.ts, project status edits, work imports) clear it in the isolate that wrote; other isolates catch up within 10 s. It holds the query promise, so concurrent readers share one query, and a failure is never cached. Task list, board, sprint and backlog each make 2 fewer D1 round trips.
4. `src/server/lib/http-cache.ts`: weak ETag and 304 for `/api/config` (public, no-cache) and `/api/team/people`, `/api/tasks/assignees`, `/api/projects`, `/api/chat/channels` (private, no-cache, Vary: Cookie, Authorization). Every use revalidates; nothing private can sit in a shared cache. Everything else under `/api/` keeps `no-store`.
5. Sprint burndown: the 90 id chunks (D1 takes at most 100 bound values) now run side by side instead of one after another.

## On D1

Local SQLite answers a statement in microseconds; D1 adds a network round trip per statement, so on production the statement counts above matter as much as the local milliseconds. The index changes also cut rows read, which D1 bills.

## Left for later

- Task list and board for a 2,000 task project are still about 25 ms locally; most of it is building and serialising 400 KB of JSON, not SQL. Paging or a slimmer list shape would help but changes the response, so it was left alone.
- My Work's overdue query walks every task with a due date in the workspace and filters by assignee in the table. Fixing it needs a new index on tasks (one more write per task insert), so it was left; it costs 1.4 ms at 6,000 tasks.
- Dashboard widgets still read the task table once per widget (they already run in parallel).
