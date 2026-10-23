# What the API is missing for mobile

Found while building the app. None of these block the app; each is handled behind a flag or a
fallback.

## 1. Tasks (needed for the Tasks tab to sync)

There are no tasks endpoints. The app saves tasks on the phone (`src/lib/tasks.ts`) behind
`EXPO_PUBLIC_FEATURE_TASKS` and the screen says so. To sync them, the API needs:

```
GET    /api/tasks?status=&threadId=      -> { tasks: Task[] }
POST   /api/tasks                        { title, notes?, status?, due?, source?: { messageId, threadId } }
PATCH  /api/tasks/:id                    { title?, notes?, status?, due?, assigneeId? }
DELETE /api/tasks/:id
```

`Task` matches `src/lib/tasks.ts`, plus `assignee` (a person or an agent) and `orgId`. Agents need
the same tools on MCP (list_tasks, create_task, update_task). Swapping the local store for these
calls is a change to `useTasks` and `useTaskMutations` only.

## 2. Push device registration

`POST /api/push/devices { token, platform }` and `DELETE /api/push/devices/:token`, plus sending
when mail arrives or an approval is created. Design and code in docs/push.md.

## 3. The live demo on production hangs

`POST /api/account/demo` on https://mymail.mymail-app.workers.dev did not answer within 100
seconds (checked 2026-10-23 14:03 UTC; `/api/health` answered in 3 s). The app doesn't depend on
it: "Explore with sample data" runs on the phone. Worth a look on the server side.

## 4. Nice to have

- A `GET /api/mail/changes?since=` endpoint would let the app sync only what changed instead of
  refetching the first page of each folder.
- Better Auth's `bearer` plugin would let the app use an `Authorization` header instead of a
  cookie. The cookie approach works today and needs no change.
