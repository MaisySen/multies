# Phone app 1.10: read every task on /api/tasks (R48, 27 Oct 2026)

Why: the phone app lists tasks with one GET of `/api/tasks` and no paging, so it stops at the first page (500 tasks, the
server's list cap). Workspaces with more open tasks than that show an incomplete Tasks tab and wrong counts. The server
already pages (R46, MB-234); only the app has to walk the pages. No server change is needed, and nothing here ships by
OTA from the R48 round: it goes in the 1.10 native batch (or a later JS update once 1.10 is the runtime).

## Where the app reads tasks today
- `mobile/src/api/endpoints.ts` line 56: `tasks: (p: TaskQuery = {}) => t.request<{ tasks: Task[] }>("GET", "/tasks" + q(...))`.
- `mobile/src/lib/queries.ts` line 159: the work list query calls `api.tasks(filter)` once and caches it under
  `worklist:<mode>:<filter>`.

## Request shape (session cookie or bearer, same as today)
1. First page: `GET /api/tasks?paged=1&<filters>` where filters are the ones the app already sends (projectId, status,
   assignee, threadId, q, includeSubtasks). Optional `limit` (1 to 1000, default 500) sets the page size.
   Answer: `{ "tasks": Task[], "next": string | null, "changeCursor": number }`.
2. Next pages: `GET /api/tasks?paged=1&cursor=<next>&<the same filters>`. Answer: `{ "tasks": Task[], "next": string | null }`.
   Repeat until `next` is null.
3. `paged=1` must be sent with every page. Without it the server ignores `cursor` and answers the old capped list.
4. Keep the filters identical across pages; the cursor is the last row's sort keys (position, created, id) in the
   default order, or an offset when `sort` is set. A bad or stale cursor answers 400 `invalid_cursor`: start again
   from the first page.
5. Optional refresh without rereading: keep `changeCursor` from the first page and follow `GET /api/changes?since=<n>`
   (the same feed the web board uses), then reread only the changed tasks with
   `GET /api/tasks?ids=a,b,c&<the same filters>` (at most 100 ids).

## Suggested change (about 20 lines)
- `endpoints.ts`: add `tasksPage: (p: TaskQuery & { cursor?: string; limit?: number }) =>
  t.request<{ tasks: Task[]; next: string | null; changeCursor?: number }>("GET", "/tasks" + q({ ...p, paged: "1" }))`.
- `queries.ts`: replace the single call with a loop: `let all = [], cursor; do { const r = await api.tasksPage({ ...filter, cursor });
  all.push(...r.tasks); cursor = r.next ?? undefined; } while (cursor && all.length < 5000);` (a hard stop keeps a
  runaway loop off the network), then cache `all` exactly as today.
- Older servers answer `{ tasks }` without `next`: the loop ends after one page, so the change is safe against them.
- Test: a sample workspace with 1,200 tasks (the "Multies QA (test)" 1,000 task project is enough) shows every task and
  the right count on the Tasks tab.
