# API: REST, MCP and webhooks

Multies has three ways in, all served by the same Worker:

| Surface | Base path | Who uses it | Auth |
| --- | --- | --- | --- |
| App API | `/api/...` | the web app and the mobile app | Better Auth session cookie. State changing calls must be JSON and, when the browser sends an Origin, it must match the host (CSRF guard). |
| Public REST API | `/api/v1/...` | integrations, scripts, agents | `Authorization: Bearer mm_live_...` (workspace key or a scoped agent key, created in Settings, Developers). |
| MCP | `/api/v1/mcp` | AI agents and MCP clients | the same API keys. Streamable HTTP, stateless. |

The v1 OpenAPI 3.1 document is generated from the request schemas at `/api/v1/openapi.json`, with an
interactive reference at `/api/v1/reference`. That document is the source of truth for request and
response shapes; this page is the map. Mutating calls accept an `Idempotency-Key` header (8 to 255
characters); a retry with the same key returns the first answer. Errors are JSON:
`{ "error": { "code", "message" } }` with 400, 401, 403, 404, 409, 422 or 429.

More detail: [MCP.md](MCP.md) (connecting agents) and [suite.md](suite.md) (tasks, projects, docs,
contacts, deals, automations).

## Team chat

App API (`/api/chat`):

- `GET /channels`, `POST /channels` (`name`, `topic?`, `private?`, `memberIds?`, `projectId?`, `guestAccess?`)
- `POST /dms` (`userIds`): finds or makes the direct message with exactly those people
- `GET`, `PATCH /channels/:id`; `POST /channels/:id/join`, `/leave`, `/members`, `/read`
- `GET /channels/:id/messages?limit=&before=&since=` (top level, oldest first; `since` is for polling)
- `POST /channels/:id/messages` (`body`, `parentId?`, `attachments?: [{ filename, contentType?, contentBase64 }]`)
- `GET /messages/:id`, `GET /messages/:id/thread`, `PATCH` and `DELETE /messages/:id`
- `POST /messages/:id/task`: turn a message into a task that links back to it
- `POST` and `DELETE /messages/:id/pin`: pin a top level message to its channel or unpin it (up to 50 per channel; a reply answers 422); `GET /channels/:id/pins` lists them, newest pin first. Messages carry `pinnedAt` and `pinnedBy` (a name).
- `GET /unread`, `GET /people` (for mentions and new DMs)
- `GET /files/:id`, and `GET /files/:id/download?exp=&sig=`: a signed link valid for at least 15 minutes that needs no session (used by the phone app)
- Guests use `/api/guest/chat` and see only channels shared with their project.

Body markup, the same in every client: `<@member:USER_ID>`, `<@agent:AGENT_ID>`, `<!channel>`,
`<#task:ID>`, `<#thread:ID>`, `<#doc:ID>`. Responses carry `mentions` and `links` resolved with names.
Clients poll `GET /unread` every 15 s and the open channel with `?since=` every 4 s while visible.

Public API: `GET` and `POST /api/v1/chat/channels`, `PATCH /api/v1/chat/channels/{id}` (`name?`, `topic?`, `archived?`,
`projectId?`, `guestAccess?`), `GET` and `POST /api/v1/chat/channels/{id}/messages`, `GET /api/v1/chat/messages/{id}/thread`,
`POST /api/v1/chat/messages/{id}/task`, `POST` and `DELETE /api/v1/chat/messages/{id}/pin`, `GET /api/v1/chat/channels/{id}/pins`.
Round 21: `POST /api/v1/chat/messages/{id}/reactions` (`{ emoji }`, toggles the key's reaction; read only keys get 403) and
`GET /api/v1/chat/search?q=&channelId=&limit=` (public channels only, newest first, limit 1 to 50).

Calls: pressing Call in a channel (`POST /api/chat/channels/{id}/call`) makes one meeting and posts a join card. A second
press in the same channel within 60 seconds joins that call instead (200 with `joined: true`), so two people pressing at
once get one meeting.
An agent key posts as its agent. MCP: `pin_message` (`messageId`, `pinned`).

## Search everything and My Work

`GET /api/v1/search/everything?q=&types=&limit=` searches mail, tasks (title, notes or a key like `OPS-12`), docs, chat,
contacts and deals in one call, grouped by type, newest first. `q` needs 2 to 100 characters; `types` is a comma list
(`mail,tasks,docs,chat,contacts,deals`); `limit` is per group, 1 to 20. `GET /api/v1/my-work?tz=` answers what is waiting
today: overdue and due tasks, mentions, mail on my tasks, approvals, meetings and snoozed mail coming back. Both read
only, write nothing, and show only what the key can open (an agent key: its own inboxes and public channels).
`GET /api/v1/search` stays the agent mail search.

## Notifications

App API (`/api/notifications`):

- `GET /?unread=1&category=&limit=&before=`: notifications plus unread counts per category
- `POST /read` (`ids?`, `category?`; neither marks everything read), `POST /:id/unread`
- `GET` and `PUT /settings`: per category `inApp` and `push`

Categories: mention, assignment, comment, approval, due_soon, chat, email, status. Push payloads carry
data only (`{ type, id }`), for example `chat.mention`, `chat.dm`, `chat.reply`, `goal.updated`,
`task.assigned`. MCP: `list_notifications`.

## Repeating tasks

A task's `repeat` field takes a rule: `{ freq: daily | weekly | monthly | yearly, interval?, weekdays?
(0 Sunday to 6 Saturday), monthDay?, until? (YYYY-MM-DD) }`, or `null` to stop. Set it on create or
update: `POST /api/tasks`, `PATCH /api/tasks/:id`, `POST /api/v1/tasks`, `PATCH /api/v1/tasks/{id}`.
Finishing a repeating task makes the next one with the dates moved on and fires `task.recurred`.
MCP: `set_task_repeat`.

## Bulk task changes (round 21)

Change or delete many tasks in one call, the same rules as one at a time: `POST /api/v1/tasks/bulk`
with `{ ids, patch }` and `POST /api/v1/tasks/bulk-delete` with `{ ids }` (the app uses
`POST /api/tasks/bulk` and `POST /api/tasks/bulk-delete`). `ids` are task ids or references like
`OPS-12`, at most 500 a call (413 above that). `patch` takes any of `status` (todo, doing, done) or
`statusId`, `assignee` (`member:<id>`, `agent:<id>` or null), `priority`, `dueAt` and `startAt` (null
clears), `addLabels`, `removeLabels`, `type` (task, story or bug; epics change one at a time) and `projectId` (moves the tasks; numbers come from the new
project and each status maps to the same group there). If any id is not in the workspace nothing is
changed (404). Read only keys get 403. The writes go out in one batch: each changed task writes its
row and one sync feed change, and the action writes one summary activity entry. Webhooks still get
one `task.updated` (or `task.deleted`) per task. When the daily database write budget is nearly
used, bulk changes answer 503 and single edits still work. MCP: `bulk_update_tasks`.

## Templates

Kinds: `project`, `task` and `doc`. A template is saved from an item (`fromProjectId`, `fromTaskId`, `fromDocId`) or
written from scratch with `data`:

- project: `{ project: { name, description?, color? }, tasks: [{ title, notes?, priority?, dueInDays?, status?, labels?, subtasks? }] }` (up to 200 tasks)
- task: `{ title, notes?, priority?, dueInDays?, labels?, subtasks? }`
- doc: `{ title, text }`, one paragraph per line, `#` for a heading and `-` for a bullet

Using a doc template makes a doc (`{ kind: "doc", doc }`), in `projectId` when given.

- App API: `GET /api/templates?kind=`, `POST /api/templates` (`kind`, `name?`, `description?`, `category?`, then `data` or a `from...` id), `GET /api/templates/:id`, `POST /api/templates/:id/use`, `DELETE /api/templates/:id`
- Public API: `GET /api/v1/templates`, `POST /api/v1/templates` (same body), `GET /api/v1/templates/{id}`, `POST /api/v1/templates/{id}/use` (`name?`, `projectId?` for a task or doc template, `startDate?`; due dates count from it)
- The starter gallery: client onboarding, content calendar, sales pipeline, bug tracker, and the doc starters meeting notes and project brief. Event: `template.used`. MCP: `list_templates`, `use_template`, `create_template`.

Docs: the public API also has `DELETE /api/v1/docs/{id}` (a soft delete; the doc then answers 404).

## Goals and key results

- App API: `GET` and `POST /api/goals`, `GET`, `PATCH` and `DELETE /api/goals/:id`, `POST /api/goals/:id/key-results`, `PATCH` and `DELETE /api/key-results/:id`
- Public API: `GET` and `POST /api/v1/goals`, `GET` and `PATCH /api/v1/goals/{id}`, `POST /api/v1/goals/{id}/key-results`, `PATCH /api/v1/key-results/{id}`
- Key result kinds: number, currency (AUD), percent, tasks (linked tasks or every top level task in a project). Progress is 0 to 100, rolled up from key results and child goals; health is on_track, at_risk, off_track or empty.
- Events: `goal.created`, `goal.updated`, `goal.deleted`. MCP: `list_goals`, `create_goal`, `update_key_result`.

## Integrations

- `/api/integrations`: Xero connection (behind config), connect, callback, unpaid invoices, disconnect.
- Page: `/app/integrations` (sidebar, next to Automations). Workspace admins connect and remove; members can look.

### Outgoing connectors

A catalogue of no-cost targets built on the outgoing webhooks below: Slack (incoming webhook), Discord
(channel webhook), Microsoft Teams (incoming webhook or Workflows webhook), Zapier (Catch Hook), Make
(custom webhook), n8n (Webhook node), Google Sheets (an Apps Script web app) and any HTTPS URL.
Connecting means pasting the URL and choosing events. Slack, Discord and Teams get a one line chat
message (`{ "text": ... }`, or `{ "content": ... }` for Discord). A Teams Workflows URL (a Power Automate
flow on `*.logic.azure.com` or `*.powerplatform.com`, or any `/workflows/` path) gets an Adaptive Card
message instead (`{ "type": "message", "attachments": [{ "contentType": "application/vnd.microsoft.card.adaptive", "content": { "type": "AdaptiveCard", "version": "1.4", ... } }] }`),
which the "Post to a channel when a webhook request is received" flow posts as is; the others get the standard signed
JSON event and a `whsec_` secret, shown once. Each connection is an outgoing webhook endpoint with a
`format` (json, slack, discord, teams) and a `connector`, so retries, dead letters and replay work the same.

- App API: `GET /api/connectors` (catalogue and connections), `GET /api/connectors/catalogue`, `POST /api/connectors` `{ connector, url, events?, name? }`, `PATCH /api/connectors/:id` `{ enabled?, events?, url?, name? }`, `POST /api/connectors/:id/test`, `DELETE /api/connectors/:id`
- Public API: `GET /api/v1/integrations/catalogue`, `GET /api/v1/integrations`, `POST /api/v1/integrations`

### Incoming webhooks (from Zapier, Make, n8n, forms and scripts)

Create one to get a secret URL, `POST /api/hooks/in/<token>`, that accepts JSON, a form post or plain
text (at most 64 KB) and does one action:

- `task`: title from `title`, `text`, `subject`, `name` or `summary`; notes from `notes`, `description`, `body`, `message` or `details` (otherwise the other simple fields as `key: value` lines); due from `due`, `due_date`, `dueDate` or `deadline`; assignee from `assignee` or `assignee_email` (a member's email). Optional `projectId`.
- `chat`: posts `text`, `message`, `body`, `content`, `title` or `subject` to the chosen public channel.
- `contact`: `email` (required), `name` (or `first_name` and `last_name`), `phone`, `notes`.

`config.mapping` overrides a field, for example `{ "title": "data.subject" }` (dotted paths work).
The token is random, shown once and stored only as a SHA-256 hash; revoke it by switching the hook off
or deleting it. Answers: 201 `{ ok, result: { type, id } }`, 404 for an unknown or switched off token,
413 over 64 KB, 422 when the required field is missing, 429 over 60 calls a minute per hook. Each call
is kept with its status (the last 20, shown on the page). A call costs the action's own writes plus one
update of the hook row, and emits `incoming_hook.received`.

- App API: `GET` and `POST /api/incoming-hooks`, `GET`, `PATCH` and `DELETE /api/incoming-hooks/:id`
- Public API: `GET` and `POST /api/v1/incoming-hooks`, `GET`, `PATCH` and `DELETE /api/v1/incoming-hooks/{id}`
- MCP: `list_integrations`, `create_incoming_hook`

## Scheduling (booking pages)

Off unless the server sets `SCHEDULING_ENABLED=true`; when off, the page and every endpoint below answer
404. A member sets weekly hours (per day, in their time zone), a slot length of 15, 30, 45 or 60
minutes, a buffer, how far ahead people can book and the minimum notice, and shares `/book/<slug>`.
Free slots leave out the host's own scheduled meetings, every occurrence of the host's weekly series
(worked out on read) and other bookings, widened by the buffer.
A booking creates a meeting (with its video guest link when video is on), emails the guest a
confirmation through system mail with an `.ics` link and a cancel link, and notifies the host in the app.
No paid calendar APIs and no phone spend. A booking costs two inserts; a slot can only be booked once.

- Page: `/app/scheduling` (Booking page, under Meetings when on); public pages `/book/<slug>` and `/book/<slug>/cancel/<id>?t=<token>`.
- App API: `GET` and `PUT /api/scheduling/page`, `GET /api/scheduling/bookings` (`upcoming=1`, `status`), `POST /api/scheduling/bookings/:id/cancel`
- Public booking API (no sign in, limited per IP): `GET /api/book/<slug>?from=&days=` (page and free slots, up to 31 days), `POST /api/book/<slug>` `{ startsAt, name, email, note?, timezone? }` (409 when the slot is gone), `GET /api/book/bookings/:id?t=`, `GET /api/book/bookings/:id/ics?t=`, `POST /api/book/bookings/:id/cancel` `{ token }`
- Public API: `GET` and `PUT /api/v1/scheduling/availability`, `GET /api/v1/scheduling/bookings`, `POST /api/v1/scheduling/bookings/{id}/cancel`
- Events: `booking.created`, `booking.cancelled`. MCP: `list_bookings` (registered only when scheduling is on).

## Triage (Round 21)

New work can wait in Triage before it becomes a task. A project's `triage` setting (off for existing
projects) sends tasks made by mail rules, public forms and incoming hooks there; a form's own "Send to
triage" switch (`triage: true`, on by default for new forms in the app) does the same for that form.
A triage item is a task row with `triage_state = 'pending'`: it keeps its number, and lists, boards,
My Work, search, reports, the portfolio and counts leave it out (`GET /api/tasks?triage=pending` asks
for them). Accept clears the flag in the same task write as any other change; decline soft deletes the
item and can send the sender a short polite reply (opt in, never to no-reply addresses); merge adds the
item's notes as a comment on another task, moves its mail thread there when the target has none, and
deletes the item.

- Page: `/app/triage` (Triage in the nav, with a count). Keys: j and k move, a accepts, d declines, m merges.
- App API: `GET /api/triage` (`projectId`, `limit`), `GET /api/triage/count`, `POST /api/triage`, `GET /api/triage/:id`, `POST /api/triage/:id/accept` `{ projectId?, assignee?, statusId?, status?, priority?, due? }`, `POST /api/triage/:id/decline` `{ reason?, reply?, message? }`, `POST /api/triage/:id/merge` `{ targetId }`, `POST /api/triage/bulk` `{ ids (up to 100), action: accept | decline, accept?, decline? }`
- Public API: the same under `/api/v1/triage` (`GET /triage`, `GET /triage/count`, `POST /triage`, `GET /triage/{id}`, `POST /triage/{id}/accept`, `POST /triage/{id}/decline`, `POST /triage/{id}/merge`, `POST /triage/bulk`). Read only keys can list but not change anything.
- MCP: `list_triage`, `triage_accept`, `triage_decline`, `triage_merge`, `create_triage_item`.

## People and AI agent members

Every member has an optional `title` (up to 80 characters) and `bio` (up to 500), shown in People (Settings, Team) and read by REST and MCP. An AI agent member is a workspace member with `kind: "agent"`: it has no mailbox, takes no seat and no inbox, and works only through its own API keys. Those keys act as the agent member with the member role, so its chat posts, task comments and activity carry its name, and it can't do admin work (domains, mailboxes, webhooks, agent inboxes, integrations). The Free plan includes 10 agent members (Pro 25, Business 100); one more answers 403 `plan_limit`. Mail agents with their own inbox (`/agents`) are listed in People too, as `type: "mail_agent"`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/people` | People (`kind: "human"`), agent members (`kind: "agent"`, `email` null) and mail agents, each with `title` and `bio`. |
| GET | `/api/v1/people/{id}` | One member by user id. |
| PATCH | `/api/v1/people/{id}` | `{ title?, bio?, name? }`. A workspace key edits anyone but the owner; an agent member's key edits itself; `name` is for agent members only. |
| POST | `/api/v1/agent-members` | `{ name, title?, bio?, scope? }` (`full` or `read`). Returns `{ member, apiKey, secret }`; the secret is shown once. |
| DELETE | `/api/v1/agent-members/{id}` | Removes the member and revokes its keys. What it posted stays under its name. |
| GET, POST | `/api/v1/agent-members/{id}/keys` | List keys, or make another (`{ name?, scope? }`). |
| DELETE | `/api/v1/agent-members/{id}/keys/{keyId}` | Revokes one key. |

In the app the same actions live under `/api/team/people` and `/api/team/agents`. MCP: `list_people` (optional `kind`).

## Agent track record (earned autonomy)

Round 14. `GET /api/agents/{id}/track-record` (app API, any member) returns `{ mode, record, suggestion }`.
`record` counts the agent's latest 50 send approvals: `approvedAsIs`, `approvedEdited` (from the
`approval.approved` audit rows that say a person changed the text or subject), `rejected`, `expired`,
`failed`, `pending`, and `cleanStreak`, the approvals in a row without a change, newest first. A
failed delivery neither builds nor breaks the streak.

`suggestion` is `null` or `{ mode, direction, reason }`:

| Current mode | Suggests | When |
|---|---|---|
| `always` | `external` | 20 clean approvals in a row |
| `external` | `never` | 50 clean approvals in a row |
| `external` or `never` | `always` | 3 or more rejections, at least 20 percent of the decisions in the window |

Nothing changes on its own: an admin applies a suggestion with the usual `PATCH /api/agents/{id}`.
The agent page shows the record, a bar of outcomes and the suggestion with a one tap switch. The
read writes nothing.

## Weekly meeting series

A meeting can repeat weekly: every 1 or 2 weeks on chosen days, with an optional last day or number of meetings. A series is one meeting row; the upcoming list (`GET /api/v1/meetings?upcoming=true`) works out the next occurrences on read (up to 12 per series over the next 60 days), each with the series' `id` and `seriesStartsAt`. Nothing is written per occurrence. Times keep their wall clock time in the series' time zone across daylight saving changes.

- Create or edit with `recurrence`, either `{ interval: 1 | 2, days: ["mo", "we"], until: "YYYY-MM-DD" | null, count: n | null, timezone }` (the zone defaults to the workspace's) or an RRULE string such as `FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=10`. The first meeting's weekday is always part of the series. `null` makes it a one off.
- `PATCH /api/v1/meetings/{id}` edits the whole series (title, start, length, guests, recurrence).
- `GET /api/v1/meetings/{id}/ics` (and `/api/meetings/{id}/ics` in the app) gives the .ics; a series carries its `RRULE` with `DTSTART;TZID=...` and a `VTIMEZONE` for that zone (yearly STANDARD and DAYLIGHT rules from the runtime's zone data, or one STANDARD part for a zone without daylight saving), which older Outlook versions need. Calendar invites carry the same.
- Meetings come back with `recurrence: { interval, days, until, count, rrule, timezone, summary }` or null. MCP: `schedule_meeting` takes `repeats` (an RRULE), `list_meetings` returns `repeats`.

## Sprints (round 21)

Sprints (cycles) per project: plan them ahead, run one at a time, complete them with the unfinished
tasks carried to the next sprint or back to the backlog. Tasks in no sprint are the project's backlog.
Each task has an optional estimate (`points`), counted in points or hours per project.
The burndown has one entry per day in the person's (or workspace's, or `timeZone`) zone: what was left at
the end of that day, in points, or in tasks when nothing is estimated, and the ideal line. It is worked out
on read, so a task change costs no extra write; a completed sprint keeps its final chart.

- Page: Tasks, Sprints view (pick a project).
- App API: `GET /api/sprints?projectId=`, `GET /api/sprints/backlog?projectId=`, `POST /api/sprints` `{ projectId, name?, goal?, startAt?, endAt? }`, `GET`, `PATCH` and `DELETE /api/sprints/:id` (delete: planned only), `POST /api/sprints/:id/start`, `POST /api/sprints/:id/complete` `{ carryOver: "next" | "backlog" }`, `POST /api/sprints/:id/tasks` and `POST /api/sprints/:id/tasks/remove` `{ taskIds }` (up to 500), `PUT /api/sprints/estimate-unit` `{ projectId, unit: "points" | "hours" }`
- Public API: `GET` and `POST /api/v1/projects/{id}/sprints`, `GET /api/v1/projects/{id}/backlog`, `GET`, `PATCH` and `DELETE /api/v1/sprints/{id}` (`timeZone` on GET), `POST /api/v1/sprints/{id}/start`, `POST /api/v1/sprints/{id}/complete` `{ carry_over: "next" | "backlog" }`, `POST /api/v1/sprints/{id}/tasks` and `/tasks/remove` `{ taskIds }`, `PUT /api/v1/tasks/{id}/points` `{ points }`. Task create and update also take `sprintId` and `points`.
- Errors: 409 `sprint_already_active` (complete the running one first), 409 `sprint_completed`, 422 when a sprint ends before it starts or a task is in another project.
- MCP: `list_sprints`, `get_sprint`, `create_sprint`, `start_sprint`, `complete_sprint`, `add_to_sprint`, `remove_from_sprint`.

## MCP tools

The tools at the time of writing (the generated list is in [qa/inventory.md](qa/inventory.md)):
`append_to_doc`, `bulk_update_tasks`, `comment_on_task`, `contact_timeline`, `create_agent_inbox`, `create_custom_field`, `create_doc`, `create_form`, `create_goal`, `create_incoming_hook`, `create_task`, `create_template`, `find_tasks_by_field`, `get_portfolio`, `get_report`, `get_task`, `get_timesheet`, `invite_guest`, `list_channels`, `list_custom_fields`, `list_forms`, `list_goals`, `list_bookings` (when scheduling is on), `list_guests`, `list_inboxes`, `list_integrations`, `list_meetings`, `list_notifications`, `list_projects`, `list_tasks`, `list_templates`, `list_threads`, `log_time`, `message_to_task`, `next_task`, `pin_message`, `post_message`, `read_channel`, `read_chat_thread`, `read_doc`, `read_thread`, `reply`, `schedule_meeting`, `search`, `search_contacts`, `search_docs`, `send_email`, `set_project_health`, `set_task_blocked_by`, `set_task_fields`, `set_task_repeat`, `start_timer`, `stop_timer`, `update_key_result`, `update_task`, `upsert_contact`, `use_template`, `wait_for_email`.

The tool list is in `src/server/routes/mcp-server.ts`. Agents act within their key's scope, and sends
by agents can require a person's approval.

## Transactional email (no SMTP)

Multies has no SMTP server. Apps send over HTTPS: `POST /api/v1/messages` takes `from` (a mailbox address) as
well as `mailboxId`. A Supabase project sends its auth emails through `POST /api/v1/auth-email-hooks`
(`from`, `secret` from Supabase's Send Email Hook, `supabaseUrl`, `appName?`): the answer's `url`
(`/api/auth-hooks/supabase/{id}`) goes into Supabase. `GET` lists hooks, `DELETE /{id}` removes one. Workspace keys only.
Full setup, including the DNS records for a customer domain: [transactional-email.md](transactional-email.md).

Domains (`/api/domains`, `/api/v1/domains`) carry `sending: { status: verified | pending | error, detail }` when the
domain is registered with the outbound provider, and their `records` then list the provider's DKIM, return path
(`return_mx`, `return_spf`) and receiving MX.

## Outgoing webhooks

Endpoints are added in Settings, Developers (or `/api/developer`). Deliveries follow
[Standard Webhooks](https://www.standardwebhooks.com): headers `webhook-id`, `webhook-timestamp` and
`webhook-signature`, signed with the endpoint's `whsec_` secret, so any Standard Webhooks library can
verify them and reject old timestamps. Failed deliveries retry with backoff for about nine hours, then
wait as dead letters you can replay. An endpoint that fails five deliveries in a row is switched off
and its owners are emailed.

Events (51): `message.received`, `message.sent`, `message.bounced`, `message.complained`, `domain.verified`, `domain.failed`, `approval.requested`, `approval.decided`, `agent.created`, `agent.deleted`, `task.created`, `task.updated`, `task.deleted`, `task.commented`, `task.file_added`, `task.recurred`, `project.created`, `project.updated`, `doc.created`, `doc.updated`, `contact.created`, `contact.updated`, `deal.created`, `deal.updated`, `time_entry.created`, `time_entry.updated`, `form.submitted`, `meeting.created`, `meeting.updated`, `custom_field.created`, `custom_field.updated`, `custom_field.deleted`, `guest.invited`, `guest.joined`, `guest.revoked`, `chat.channel.created`, `chat.message.created`, `chat.message.updated`, `chat.message.deleted`, `chat.mention`, `template.used`, `goal.created`, `goal.updated`, `goal.deleted`, `incoming_hook.received`, `booking.created`, `booking.cancelled`, `triage.created`, `triage.accepted`, `triage.declined`, `triage.merged`.

Triage events (round 22): `triage.created` carries `{ task, source }` when new work lands in Triage (from mail rules, forms with triage on, incoming hooks, chat or the API); `triage.accepted` carries the accepted `task`; `triage.declined` carries `{ id, title, number, source, reason?, replied }`; `triage.merged` carries `{ id, title, source, into }` (the target task). The matching `task.*` events still fire as before.

The list lives in `src/server/services/developer/webhooks.ts`.

## Incoming webhooks

- `POST /api/inbound/cloudflare`: mail from the inbound Email Worker, signed with an inbound key (Settings, Inbound; `/api/inbound-keys`).
- `POST /api/webhooks/resend`: delivery, bounce and complaint events, verified with the Resend signing secret.
- `POST /api/webhooks/stripe`: billing events, verified with the Stripe signature.

## Task types and epics (round 21)

Every task has a `type`: `task` (the default), `story`, `bug` or `epic`. Set it on create or update
(`POST /api/tasks`, `PATCH /api/tasks/:id`, `POST /api/v1/tasks`, `PATCH /api/v1/tasks/{id}`) and
filter by it: `GET /api/v1/tasks?type=bug`. A repeating task repeats with its type.

An epic groups work through the parent link: an item whose `parentId` is an epic is in that epic.
The list and board show an epic's items (they are top level work); subtasks of a story, task or bug
stay subtasks. Rules:

- An epic has no parent: it can't be a subtask or sit inside another epic (`epic_in_epic`).
- A story, task or bug is in at most one epic. Adding it to another epic moves it.
- An item with a parent can't become an epic until it is taken out (`epic_has_parent`).
- An epic that still has items keeps its type until they are moved out (`epic_has_items`).

Endpoints (the app uses the same shapes under `/api/epics` with the session cookie):

- `GET /api/v1/epics?project=<projectId>`: epics with `progress`.
- `GET /api/v1/epics/{id}`: one epic (id or reference) with `progress` and its `items`.
- `POST /api/v1/epics/{id}/items` with `{ "ids": [...] }` (up to 100 ids or references): puts them in the epic. Answers `{ epic, items, moved }`.
- `DELETE /api/v1/epics/{id}/items` with `{ "ids": [...] }`: takes them out (only items in this epic).

`progress` is worked out when read (no writes): `done`, `total` and `percent` over the epic's items
and their subtasks, `items` and `subtasks` counted apart, `points` (`{ done, total, percent }`) when
tasks carry points and otherwise `null`, and `start` and `end`: the earliest start and latest due
date of its items. Read only keys can read epics but not add or remove items. Adding N items is one
batch: each task row with its indexes plus one change entry, and one activity entry on the epic.
MCP: `list_epics`, `get_epic`, `add_to_epic`.

## Internal notes on threads (round 22)

People and agents can leave notes on a shared inbox thread. Notes are team only: they are never part
of an outgoing message, a reply quote, `GET /threads/{id}`, `read_thread` or anything the sender can
see. You read them only by asking for them. Access follows the shared inbox: the caller must be able
to open at least one message of the thread (same workspace, a mailbox in their scope), else 404.

A note is plain text up to 4,000 characters. `@Full Name` or `@email` in the text mentions a
teammate who can open the thread's mailbox; they get a `thread_mention` notification (category
mention) that opens `/app/inbox?thread=<id>`. Unknown names and people without access are ignored,
and the author is never notified. Only the author can edit, for 24 hours (only newly mentioned people
are notified); the author, an owner or admin, or a workspace key can delete. Agent keys write as their
agent. Each note costs 1 row and 1 index entry, plus 1 notification row per mentioned person.

- Page: the "Team notes" card under the messages in `/app/inbox?thread=<id>`. Type @ to mention, Cmd or Ctrl+Enter posts.
- App API: `GET /api/threads/:id/comments` (notes and `mentionable` people), `POST /api/threads/:id/comments` `{ body, mentions? }`, `PATCH /api/threads/:id/comments/:commentId` `{ body, mentions? }`, `DELETE /api/threads/:id/comments/:commentId`, `GET /api/threads/comment-counts?ids=a,b` (up to 100 threads, one grouped read).
- Public API: `GET /threads/{id}/comments`, `POST /threads/{id}/comments`, `PATCH /threads/{id}/comments/{commentId}`, `DELETE /threads/{id}/comments/{commentId}`. `mentions` takes user ids or emails. Read only keys can list but not write.
- MCP: `list_thread_comments`, `add_thread_comment`, `delete_thread_comment`.
## Shared inbox: owners, done and reply times (round 22)

A shared inbox thread (`messages.thread_id` within a workspace) can have an owner and be marked done.
Only threads someone touched get a `mail_thread_state` row; every other thread is open and unassigned.
Every call checks the caller can open the thread (one of its messages is in a mailbox they can open),
otherwise 404. The assignee must be a workspace member who can open the thread's mailbox (owners and
admins open every mailbox), otherwise 400. The assignee gets a notification (`thread_assigned`, in the
Assignments category) unless they assigned themselves.

- Page: the shared inbox (`/app/inbox`) has All, Mine, Unassigned, Assigned to (a person) and Done above
  the list, the assignee's initials on each row, an Assign menu and Mark done or Reopen in the thread
  header, and a Reply times card. My Work shows "Mail assigned to you" (open threads, newest first, up to 20).
- App API: `GET /api/agents/threads?view=open|mine|unassigned|assigned|waiting|done|all` (`assignee=<userId>` with
  assigned or done; open by default; each thread carries `assignee { id, name }` or null and `status`),
  `GET /api/threads/:id/state` (the state and the people who can open the thread), `POST /api/threads/:id/assign`
  `{ userId }` or `{ userId: null }`, `POST /api/threads/:id/status` `{ status: open | waiting | done }`,
  `GET /api/threads/stats/replies` (`mailboxId`, `from`, `to`, `groupBy`).
- Public API: `GET /api/v1/threads?view=...` (open by default), `GET /api/v1/threads/{id}/state`,
  `POST /api/v1/threads/{id}/assign`, `POST /api/v1/threads/{id}/status`,
  `GET /api/v1/stats/replies?mailboxId=&from=&to=&groupBy=mailbox|person`. Read only keys can list and read
  stats but not assign or change status. Agent keys see only their agent's mailboxes.
- MCP: `assign_thread`, `unassign_thread`, `set_thread_status`, `list_threads_by_view`, `get_reply_stats`.

Reply times are worked out when read (no writes, no table). A thread counts when its first inbound
message falls in the range (the last 30 days by default, at most 90). First response is the first
message we sent in the thread after that, credited to the person who sent it (`sent_by_user_id`, so an
agent reply a person approved counts for that person) or else the agent; resolution runs from the first
inbound message to `done_at`. Calendar hours, not business hours. Each row has `threads`, `replied`,
`medianFirstResponseMs`, `averageFirstResponseMs`, `resolved`, `medianResolutionMs`, `averageResolutionMs`;
`total` covers every thread. At most 2,000 threads are scanned, newest first, and `sampled: true` says
the answer was cut.

### Mail rules that assign threads, and Waiting (R22.5)

An automation with trigger `email_received` can use the action `assign_thread`. Its `actionConfig` is
`{ mode: "person", userId }` or `{ mode: "round_robin", userIds: [...] }` (2 to 20 people, each once).
It acts only on the first message of a new thread, never on replies, and assigns as a system actor, so
the assignee gets the usual `thread_assigned` notification. Round robin picks the next person in order
and skips anyone who left the workspace or can no longer open the thread's mailbox; the rule keeps its
place in `actionConfig.last`, saved with the run count (no extra write). At save time every person must
be in the workspace and, when the rule names a mailbox (`conditions.mailboxId`), able to open it, else
422 with a plain message. Runs count against the plan's automation runs like any other rule.

- App API: `POST /api/automations` and `PATCH /api/automations/:id` accept `action: "assign_thread"`
  (admins only, as before). Automations are not exposed in the public API or MCP.

Thread status can also be `waiting`: we replied and the customer has the ball. `POST /api/threads/:id/status`
and `POST /api/v1/threads/{id}/status` take `{ status: open | waiting | done }`; MCP `set_thread_status`
takes `waiting` too. `view=waiting` (app API, public API and MCP `list_threads_by_view`) lists waiting
threads (`assignee=` narrows it); the open, mine, unassigned and assigned views leave waiting threads out.
New inbound mail on a waiting or done thread puts it back to open: one primary key read of the state row
when the thread has one, and a write only when the status changes. Thread lists carry `lastInboundAt`
(the newest message not in Sent); the shared inbox shows its age on open rows ("2h", "3d"), amber after
24 hours, worked out when read. Resolution in reply times still uses `done_at`.

D1 writes: an assign or unassign is 2 rows (the WITHOUT ROWID row and its partial assignee index entry),
plus 3 for the assignee's notification; a status change is 1; an unchanged assign or status writes nothing;
views, My Work and reply times write nothing.
## Thread presence and shared drafts (round 22)

Live collision warning in the shared inbox: while a thread is open the app beats every 15 seconds
with `viewing` or `replying` (Compose with a reply open), and everyone else in the thread sees
"Maya is viewing" or, in amber, "Maya is replying"; Compose shows "Maya is also replying. Send
anyway?" above Send. Presence lives in memory only (the `ThreadPresence` Durable Object, binding
`THREAD_PRESENCE`, one per org and thread; an in process map on Node and self host), so a heartbeat
writes no D1 rows. An entry expires 40 seconds after its last beat; hiding the tab or closing the
thread leaves at once.

Draft replies are messages in folder `drafts` that carry the thread id and their author
(`sent_by_user_id`). The thread shows "Draft by Maya, edited 3 min ago" with a preview; Take over
makes you the owner (one row update), notifies the previous author once and shows them a note if
they are in the thread. Saving over a draft somebody else took over answers 409 `draft_taken_over`;
saving over a draft that changed in another window answers 409 `draft_changed`.

- App API: `GET /api/threads/:id/presence`, `POST /api/threads/:id/presence` `{ clientId, state: viewing | replying }` (answers the same view), `POST /api/threads/:id/presence/leave` `{ clientId }`, `GET /api/threads/:id/drafts`, `POST /api/threads/drafts/:draftId/take-over`. `POST /api/mail/drafts` takes `inReplyToId` to file the draft in that thread.
- Public API: `GET /api/v1/threads/{id}/presence`, `GET /api/v1/threads/{id}/drafts`, `POST /api/v1/drafts/{id}/take-over`. Read only keys can read; agent keys can't take over a draft.
- MCP: `get_thread_presence`, `list_thread_drafts`, `take_over_draft`.
- Every route answers 404 unless the caller can open at least one message of the thread (same workspace, a mailbox in their scope).

## Saved replies (round 22)

Reusable replies with variables, shared with the workspace or kept private (`shared: false`, only the
author sees it). Variables, case and space tolerant (`{{ First_Name }}` works): `{{first_name}}`,
`{{name}}`, `{{email}}` (the recipient: the thread's newest inbound sender, or the To address when it
names someone else), `{{my_name}}`, `{{my_first_name}}`, `{{company}}` (the workspace name),
`{{mailbox}}` (the sending address), `{{date}}` (today in your time zone, else the workspace's, e.g.
26 October 2026). A variable with no value becomes empty; an unknown one stays as typed. Name up to 80
characters, plain text body up to 10,000, optional subject and one word `shortcut` (unique in the
workspace; typing `/shortcut` then Tab in Compose inserts it).

Members create; the author, or an owner, admin or workspace key, edits and deletes. Another person's
private reply, and another workspace's ids, answer 404. Rendering for a thread needs a thread the caller
can open (same workspace, a mailbox in their scope), else 404.

- App API: `GET /api/mail/snippets?q=`, `POST /api/mail/snippets`, `GET|PATCH|DELETE /api/mail/snippets/:id`, `POST /api/mail/snippets/:id/render` `{ threadId?, to?, mailboxId? }` answers `{ subject, body, variables }`.
- Public API: `GET /api/v1/snippets?q=`, `POST /api/v1/snippets`, `GET|PATCH|DELETE /api/v1/snippets/{id}`, `POST /api/v1/snippets/{id}/render`. Read only keys can list and render (render is a POST that writes nothing) but not create, edit or delete.
- MCP: `list_snippets`, `render_snippet`, `create_snippet`.

D1 writes: create, edit and delete are 2 rows each (the WITHOUT ROWID row and its one index entry); list
and render write nothing.

## Meeting notes and action items (round 23)

Each meeting can have one agenda and notes doc, made the first time someone opens Notes (or calls
`POST .../notes`). It starts with the headings Agenda, Notes and Action items, the last holding an
empty checklist. Two people opening at once get the same doc. A weekly series shares one doc. The doc
is a normal doc (any member can open and edit it) and shows "Notes for <meeting>" with a link back.

Action items are the doc's checklist items, anywhere in it. Each unchecked item gives a title, an
assignee from "@Full Name", "@First" (when only one person has that first name), "@email" or a mention,
and a due date from "due Fri", "by Friday", "next Tue", "by 30 Oct", "due Oct 30th", "by 2026-10-30",
"today" or "tomorrow" (in the series' time zone, else the person's, else the workspace's). Turning them
into tasks is one request; an item that already became a task is skipped, so pressing twice makes
nothing new. Each task links back to the meeting. Assignees must be members or agents of the workspace.
The project is the one given, else the meeting's source task's project, else the workspace's first.

- App API: `GET /api/meeting-notes/:meetingId` (reads only; `doc` is null until made), `POST /api/meeting-notes/:meetingId` (makes the doc if missing, answers the same), `POST /api/meeting-notes/:meetingId/action-items` `{ projectId?, items?: [{ key?, title?, assignee?, due? }] }`, `GET /api/meeting-notes/by-doc/:docId` (the meeting a doc is the notes of, or null).
- Public API: `GET /api/v1/meetings/{id}/notes`, `POST /api/v1/meetings/{id}/notes`, `POST /api/v1/meetings/{id}/action-items`. Read only keys can read the notes but not make the doc or tasks.
- MCP: `get_meeting_notes`, `create_action_items`.
- Another workspace's meeting answers 404; project guests and meeting guests have no workspace session (401).

D1 writes: the doc costs 8 rows once (the doc row and the meeting's doc_id, with their indexes); each
action item costs its task plus 4 (the meeting_action_items row and the link back); reading the notes
and a second press write nothing.

## Meeting recordings and transcripts (round 23)

A member presses Record in a meeting's room; the browser mixes the call's audio and uploads a chunk
about every 5 minutes and at Stop. Each chunk goes straight on to the workspace's own OpenAI
(`gpt-4o-mini-transcribe`) or Groq (`whisper-large-v3-turbo`) key; Multies keeps only the text (capped
at 200 KB), never the audio. At Stop the workspace's AI key writes a short summary with decisions and
action items, posted once as a chat message from the recorder in the channel the call started from, or
sent to the attendees who are members as a notification. Without an OpenAI or Groq key, starting answers
409 `recording_needs_ai_key` (no key) or `recording_needs_transcribe_key` (an Anthropic or OpenRouter
key). Everyone in the call sees a Recording banner.

- App API (cookie session): `GET /api/meetings/:id/recordings` answers `{ recordings, setup }`;
  `POST /api/meetings/:id/recordings` starts (or joins the live one); `PUT /api/meetings/:id/recordings/:rid/chunks/:seq`
  `{ audioBase64, mime?, offsetSec?, durationSec? }` (chunks from 0 in order; a chunk already taken answers
  `duplicate: true`, one that skips ahead is 409 `out_of_order` with `details.expected`; over 24 MB is 413);
  `POST /api/meetings/:id/recordings/:rid/stop` `{ durationSec? }` (idempotent: the summary is posted once);
  `DELETE /api/meetings/:id/recordings/:rid`. Only the person who started a recording uploads to it.
- Public API: `GET /api/v1/meetings/{id}/recordings`. Read only keys can call it.
- MCP: `get_meeting_transcript`.

D1 writes: starting is 1 row (WITHOUT ROWID, no secondary index), each chunk is 1 row, Stop is 2 rows
plus the one chat message (or one notification per attendee); reads and a retried chunk write nothing.

## Calls in chat (round 23)

A call from a DM rings every other member ("Maya is calling you", in the inbox and on phones through the
chat category). A call from a channel with up to 8 members rings them too; bigger channels get only the
join card, so a busy channel doesn't buzz everyone. A second press of Call within 60 seconds joins the
first call and rings nobody. Room tokens allow camera, microphone, screen share and screen share audio for
members and guests.

Who is in a call is read from the video service (LiveKit RoomService ListParticipants) and cached in memory
for about 10 seconds per server instance; open chat views poll every 15 seconds only while a call card from
the last few hours is on screen. A call is marked ended (meeting status `ended`, `endedAt`) the first time a
read finds the room empty after people were in it, or when the last person's app leaves: one row update per
call, never one per poll. Without video keys the routes answer `enabled: false`.

- App API: `GET /api/chat/channels/:id/call` answers `{ enabled, channelId, live: call | null, calls: [{ meetingId, title, channelId, state: live | waiting | ended, participants: [{ name }], count, startedAt, endedAt, durationMin }] }`; `GET /api/chat/calls/:meetingId` (one meeting); `POST /api/chat/calls/:meetingId/left` (the app's leave signal; people only); guests of a shared channel: `GET /api/guest/chat/channels/:id/call`.
- Public API: `GET /api/v1/chat/channels/{id}/call`, `GET /api/v1/meetings/{id}/call`. Read only keys can read.
- MCP: `get_call_status`.
- 404 when the caller can't open the channel: DMs and private channels for non-members and keys, another workspace's ids, a guest outside their shared channel. A meeting started from such a chat follows the chat's rule.
- Local E2E only: `POST /api/chat/calls/:meetingId/test-room` `{ participants: [{ name }] }` fakes who is in the room when the server runs with `CALLS_TEST_HOOK=true`; `loadConfig` refuses that variable in production and the route answers 404 without it.

D1 writes: presence reads write nothing; a call adds one `call.started` notification per person rung (in place
of the card's plain DM notification); ending a call is one meeting row update, once.

## Calendar sync (round 23)

A person's calendar feed: a secret address, `https://<app>/cal/<token>.ics`, for Google Calendar,
Apple Calendar or Outlook (Settings > Calendar). It holds their meetings (they made them, are invited
by email, or the call came from one of their channels or DMs; a weekly series is one event with its
RRULE and VTIMEZONE) and the due dates of open tasks assigned to them as all day events ("Due: ..."),
30 days back to 180 days ahead, at most 1,000 items. The token is the only key: only its SHA-256 hash
and its last four characters are stored. Reset makes a new address and the old one answers 404 at once.
The feed answers GET and HEAD with `ETag` and `Cache-Control: private, max-age=300`, `If-None-Match`
gives 304, and it is limited to 30 fetches a minute per token. Serving it writes nothing to the database.

Other calendars (read only, per person, never shared with the workspace): a connected mailbox's
CalDAV calendar (Fastmail, iCloud, Zoho, Yahoo, GMX or the mail server's own; same user name and app
password) or a secret ICS link (Google "Secret address in iCal format", Outlook "Publish calendar").
The ICS link is stored encrypted and never sent back (only its host). Events are fetched when the
calendar opens and kept in memory for 5 minutes; none are stored. Private network addresses are refused.
Gmail and Outlook calendars need their own sign in (coming later); add their ICS link meanwhile.

- App API: `GET|POST|PATCH|DELETE /api/calendar/feed` (POST turns on or resets and answers the address
  once; PATCH `{ includeTasks }`), `GET /api/calendar/events?from&to` (at most 100 days; meetings, due
  dates and the person's other calendars, with `errors` per calendar that could not be read),
  `GET /api/calendar/sources`, `GET /api/calendar/sources/options` (the person's connected mailboxes
  and whether each offers CalDAV), `POST /api/calendar/sources` `{ kind: "ics", url, name? }` or
  `{ kind: "caldav", connectionId, url? }`, `PATCH|DELETE /api/calendar/sources/:id` `{ enabled?, name?, color? }`.
- Public API: `GET /api/v1/calendar/events?from&to` (keys see the workspace's meetings and due dates,
  no other calendars), `GET /api/v1/calendar/feed` (status of the key's person's feed: `enabled`,
  `hint`, `includeTasks`; never the address), `POST /api/v1/calendar/feed/reset` (full keys; answers the
  new address once).
- MCP: `list_calendar_events`.

D1 writes: turning the feed on is 2 rows (the row and its unique token index), a reset 3 at most, off 2;
adding, changing or removing another calendar is 1. Fetching the feed and viewing events write nothing.

## Workload (R24.2)

Open tasks and their estimates per person per week, for planning and for moving work off someone
who is over capacity. Rows are workspace members and agents with open tasks in the range, plus an
Unassigned row; columns are whole weeks, Monday first, in the viewer's time zone (the `tz` query, else
the person's own zone, else the workspace zone). A task sits in the week of its due date, or of its
start date when it has a start and no due date. Open means not in a done category (so cancelled
statuses are out too), not waiting in Triage, not deleted, and not an epic; subtasks are counted the
way list views count them. Open tasks due before the range are in `overdue`.

Each cell carries `count`, `points` and `hours` (each project's estimate unit), `noEstimate` (tasks with
no estimate), `load` (the sum in the chosen `unit`), `over` and `near` (80% of capacity or more) and
`tasks` (id, ref, title, project, due, start, status, points, unit). Capacity is a plain default per
person per week, 20 points or 40 hours, that a request can change with `capacity`; nothing is stored.
At most 2,000 tasks are read, soonest first; `truncated: true` says the answer was cut.

- App API: `GET /api/workload?from&weeks&projectId[]&sprintId&person[]&unit&capacity&tz`. `weeks` is 1
  to 12 (default 4: this week and the next 3). `projectId` and `person` (`member:<id>`, `agent:<id>` or
  `none`) repeat. A project or sprint from another workspace answers 404.
- Public API: `GET /api/v1/workload` with the same query. Read only keys can call it; it reads the
  tasks GET /api/v1/tasks reads.
- MCP: `get_workload`.
- Moving work: the Workload view reassigns with `PATCH /api/tasks/:id { assignee }` and moves a task by
  whole weeks with `PATCH /api/tasks/:id { due }` (the same weekday), the normal task update.

D1 writes: reading the workload writes nothing. A move is one task update.

## Dashboards (R24.3)

A dashboard is a named grid of widgets, private to the person who made it or shared with the
workspace. The widgets are kept in the dashboard row (so saving any number of widget changes is one
row write) and their numbers are computed when you read them: nothing is stored or cached.

Widget: `{ id, type, title, source, groupBy, chart, size, position }`.

- `type`: `count` (a number), `breakdown` (tasks grouped by `groupBy`: `status`, `assignee`, `priority`,
  `project`, `sprint`, `type` or `label`; by person counts open tasks unless the widget filters a
  status), `due` (open tasks overdue and due this week, with up to 10 of them), `completed` (tasks done
  per week over the last 8 weeks), `burndown` (the active sprint of the widget's project), `goals`
  (progress of the top level goals), `reply_times` (median first response and resolution per mailbox or
  person over 30 days, `groupBy` `mailbox` or `person`), `mail_volume` (received and sent per day over 14
  days) and `workload` (open tasks and estimates per person over 4 weeks).
- `source`: `{ savedViewId }` applies a saved view's project and filters; `{ projectId, filters }` sets
  them inline (`assignee` as `member:<id>`, `agent:<id>`, `me` or `none`; `status` `todo`, `doing` or
  `done`; `priority`; `label`; `type`; `q`; `due` as `overdue`, `week` or `none`). Inline filters go on
  top of a saved view's. `{ mailboxId }` narrows the mail widgets.
- `chart`: `number`, `bar`, `donut`, `line` or `table`. `size`: 1 or 2 columns.

Up to 24 widgets a dashboard and 50 dashboards a workspace. Breakdowns return at most 20 groups (the
rest add up in Other). Tasks are read the way the task list reads them (this workspace, top level,
not in Triage, not deleted); mail widgets read only the mailboxes you may read. Another workspace's
saved views, projects and mailboxes are refused when a dashboard is saved (404).

- App API (session): `GET /api/dashboards`, `POST /api/dashboards { name, shared, widgets }` or
  `{ starter: "team" }` (Team overview: by status, by person, due this week, completed per week),
  `GET /api/dashboards/:id`, `PATCH /api/dashboards/:id { name, shared, widgets, version }` (the whole
  widget list in its new order; a stale `version` answers 409), `POST /api/dashboards/:id/widgets`,
  `DELETE /api/dashboards/:id`, and `GET /api/dashboards/:id/data?tz` for every widget's data in one
  request: `{ dashboard, timeZone, weekStart, widgets: [{ id, type, data, error }] }`.
- Public API: the same under `/api/v1/dashboards` (`GET /api/v1/dashboards/{id}/data`). Read only keys
  can list and read; creating, saving, adding and removing need a full key. A key sees its maker's
  private dashboards; a dashboard made by an agent key is shared.
- MCP: `list_dashboards`, `get_dashboard_data`, `create_dashboard`, `add_dashboard_widget`.
- Who can change what: the owner changes everything; anyone in the workspace can change a shared
  dashboard's name and widgets; sharing and removing a shared one is for its owner or an admin.

D1 writes: reading a dashboard's data writes nothing. Creating, saving (any number of widget changes, a
rename and the share flag together) and removing a dashboard are each one row and its index: 2.
