# Work suite: tasks, projects, docs, contacts and automations

MyMail keeps the work that comes out of email next to the email. Everything here is free in
every plan. The same functions serve the web app, the mobile app, the REST API and MCP, so a
person, a workspace key and an agent key see the same data under the same rules.

## Model

- **Projects** have a key (`TSK`, `BHM`) and their own statuses. Each status belongs to a group:
  `todo`, `doing` or `done`. Filters, automations and the mobile app use the group, so custom
  status names never break them. A new workspace gets a "Tasks" project the first time anyone
  lists projects.
- **Tasks** have a reference (`TSK-12`), title, notes, status, assignee (`member:<id>` or
  `agent:<id>`), priority (`none`, `low`, `medium`, `high`, `urgent`), labels, start and due
  dates, a position for board order, subtasks (`parentId`) and comments. A task made from an email
  keeps the thread id and message id; new mail on that thread is recorded in the task's history.
- **Docs** are Tiptap (ProseMirror) JSON with a plain text copy for search. Saves are versioned:
  send the version you read, and a stale save gets `409 version_conflict`.
- **Contacts and companies** are built from mail as it is delivered or sent. Robot senders
  (`noreply@`, `notifications@`, `receipts@` and similar) and your own domains are skipped; free
  mail domains such as Gmail get no company. Existing mail is backfilled once per workspace.
- **Deals** have a stage (`lead`, `qualified`, `proposal`, `won`, `lost`) and a value in AUD.
- **Links** join any two of these (a doc to a task, a task to a contact) and drive the timelines.
- Every write records an activity entry, a change entry for sync (`GET /api/changes?since=`) and,
  where there is one, a webhook event.

## REST

Cookie session routes for the apps live under `/api`; key authenticated routes under `/api/v1`
are in the OpenAPI document at `/api/v1/openapi.json`. The main ones:

| Route | What it does |
| --- | --- |
| `GET /api/v1/tasks` | Filter by `projectId`, `status`, `assignee`, `priority`, `label`, `q`, `threadId` |
| `POST /api/v1/tasks` | Create a task |
| `POST /api/v1/tasks/from-email` | `{ messageId }` or `{ threadId }`: title from the subject, notes from the newest text |
| `GET /api/v1/tasks/next` | Agent keys: the most urgent open task assigned to this agent |
| `GET` `PATCH` `DELETE /api/v1/tasks/{id}` | One task by id or reference |
| `POST /api/v1/tasks/{id}/comments` | Comment |
| `GET` `POST /api/v1/projects` | Projects with statuses |
| `GET` `POST /api/v1/docs`, `POST /api/v1/docs/{id}/append` | Docs |
| `GET` `POST /api/v1/contacts`, `GET /api/v1/contacts/{id}` | Contacts and a contact's timeline |
| `GET /api/v1/companies`, `GET` `POST` `PATCH /api/v1/deals` | Companies and deals |
| `GET /api/v1/changes?since=` | Change feed cursor for sync |

## Webhooks

Delivered with Standard Webhooks signatures, like the mail events: `task.created`,
`task.updated` (status changes included), `task.deleted`, `task.commented`, `project.created`,
`doc.created`, `doc.updated`, `contact.created`, `contact.updated`, `deal.created`, `deal.updated`.

## Automations

Rules run inside MyMail and never call an AI model.

| Trigger | Conditions | Actions |
| --- | --- | --- |
| `email_received` | `from` (an address or `@domain`), `subjectContains`, `mailboxId` | `create_task` (project, assignee, priority, due in N days) or `notify` |
| `status_changed` | `toCategory` (`todo`, `doing`, `done`) | `notify` the assignee, the creator, the admins or a person |
| `due_soon` | `hoursBefore` | `notify` |

Runs are counted per calendar month (Free 1,000, Pro 10,000, Business 50,000). A rule never sends
email outside the business; notifications are in the app and, when push is on, on the phone.

## Co-editing

Several people can edit one doc at the same time, with live carets and names.

- The browser opens a WebSocket at `GET /api/docs/{id}/collab` (same session cookie and the
  same workspace check as `GET /api/docs/{id}`; other sites are refused by Origin). Anyone who
  can read the doc but not edit it joins read-only: the room ignores their changes.
- Production and staging host each doc's room in a Durable Object (`DOC_ROOMS` binding, class
  `DocRoom`, SQLite storage, migration tag `v1-doc-rooms`), on the Workers Free plan. Rooms use
  WebSocket hibernation, so a quiet room costs nothing. The Yjs state is stored as a short log
  of updates folded into one merged update every 100 writes, and is cleared after 30 days
  with nobody connected. The Node entry keeps rooms in memory (`src/server/collab/node.ts`).
  Both use the one room module, `src/server/collab/room.ts` (y-websocket protocol from
  y-protocols).
- The doc row stays the record. One open window (the one with the lowest Yjs client id) saves
  Tiptap JSON and plain text to the row, about a second after the last change, so search,
  agents, the REST API and MCP keep reading the latest text.
- API and MCP writes win. The room remembers which row version its content matches. When the
  row moves on with different text (an agent appended, someone used the API), the saving
  window loads the row into the room on its next save or within 15 seconds, and everyone sees
  it. A title change only moves the version. Typing in the second before an API write can be
  replaced by that write.
- An empty room is filled once from the saved JSON. When the socket cannot connect (for
  example a host without the binding answers 503), the editor works as before, for one person,
  with versioned saves.

## Push

The mobile app registers its Expo push token with `POST /api/push/devices` and removes it on sign
out. With `PUSH_ENABLED=1` the server sends a push for new mail, approvals waiting, a task assigned
or commented on, a reply on a task's thread and a task nearly due. The payload is only
`{ type, id }`; the app fetches the item through the API, so no mail content passes through the
push provider.

## Time tracking

A timer belongs to one person or agent; starting a new one stops the old, and a timer left running
counts at most 12 hours. Manual entries take minutes and a date. `GET /api/time/timesheet` (and
`/api/v1/time/timesheet`) returns one row per person and project with seconds per day in the
workspace's time zone. Agent keys log time under the agent's own name (`start_timer`, `stop_timer`,
`log_time`, `get_timesheet` over MCP). Webhooks: `time_entry.created`, `time_entry.updated`.

## Dependencies

"Blocked by" is a link between two tasks (`entity_links`, relation `blocks`, from the blocker to the
blocked task). `POST /api/v1/tasks/{id}/dependencies { blockedBy }` adds one and refuses loops; the
task detail lists `blockedBy` and `blocking`; the timeline draws them as finish to start arrows, and
dragging from one bar to another adds one. MCP: `set_task_blocked_by`.

## Forms

A form has a random public address (`/f/<slug>`) and makes a task (answers in the notes, label
`form`, linked to the sender's contact) or a contact. Spam checks: Cloudflare Turnstile when
`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set; always a hidden trap field, a minimum fill
time (1.5 s) and five submissions per sender per form in ten minutes (by a salted hash of the IP).
A bot that trips the trap gets the normal thank-you and creates nothing. Only the form page loads
the Turnstile script; the rest of the app keeps `script-src 'self'`. Webhook: `form.submitted`.

## Reports

`GET /api/reports/dashboard?days=30&projectId=` (and `/api/v1/reports/dashboard`, MCP `get_report`)
counts in the database: tasks by status and assignee, overdue tasks, tasks done per day, time per
project and the deals pipeline in AUD, ex GST. The page draws it with Recharts (MIT).

## Meetings

Video runs on LiveKit (Apache 2.0) and is off until `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET` are set. A meeting can be started from a thread, task or contact (title and
guests are filled in from it), and has a guest link (`/m/<token>`) that needs no account. Calendar
invites are an `.ics` file sent through MyMail's own sending: a person sends from a mailbox they can
use; an agent's invite (REST or MCP `schedule_meeting`) always goes out as an agent and follows its
approval rules, so outside guests wait for a person to approve. Tokens last six hours; members are
room admins, guests are not. No recording, notes or transcripts.

Self-hosting instead of LiveKit Cloud: run the open source `livekit-server` (Docker image
`livekit/livekit-server`, one binary) on a small VM with ports 7880 (WebSocket), 7881 (TCP) and
50000 to 60000 UDP open, put TLS in front of 7880 (Caddy works), create a key pair in its config and
set `LIVEKIT_URL=wss://your-host`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` on the Worker. The app
and the browser code don't change. The page's content security policy allows any `wss:` host.
