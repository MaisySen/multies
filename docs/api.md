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
| GET | `/api/v1/invites` | Pending invitations, newest first, with `role`, `mailboxIds`, `title` and `bio`. Members who joined are in `/people`. |
| POST | `/api/v1/invites` | `{ email, role?, mailboxIds?, title?, bio? }` (`role` is `member` or `admin`). Sends the invitation email and returns `{ id, link, emailed }`. The title and bio become the member's own when they join. The key acts as its creator: an admin invite needs a key made by the owner, the plan's seats apply (403 `plan_limit`), an address already in the workspace answers 409, and the same address again renews its pending invitation. Agent keys, agent member keys and read only keys get 403. Nobody is invited as owner; transfer ownership once they have joined. |
| DELETE | `/api/v1/invites/{id}` | Revokes a pending invitation; another workspace's, an accepted or a revoked one answers 404. |

Creating a workspace and minting its first API key stay sign up steps in the app (a key can't make the workspace it belongs to).

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
`append_to_doc`, `bulk_update_tasks`, `comment_on_task`, `contact_timeline`, `create_agent_inbox`, `set_mailbox_reply_to`, `create_custom_field`, `create_doc`, `create_form`, `create_goal`, `create_incoming_hook`, `create_task`, `create_template`, `find_tasks_by_field`, `get_portfolio`, `get_report`, `get_task`, `get_timesheet`, `invite_guest`, `list_channels`, `list_custom_fields`, `list_forms`, `list_goals`, `list_bookings` (when scheduling is on), `list_guests`, `list_inboxes`, `list_integrations`, `list_meetings`, `list_notifications`, `list_projects`, `list_tasks`, `list_templates`, `list_threads`, `log_time`, `message_to_task`, `next_task`, `pin_message`, `post_message`, `read_channel`, `read_chat_thread`, `read_doc`, `read_thread`, `reply`, `schedule_meeting`, `search`, `search_contacts`, `search_docs`, `send_email`, `set_project_health`, `set_task_blocked_by`, `set_task_fields`, `set_task_repeat`, `start_timer`, `stop_timer`, `update_key_result`, `update_task`, `upsert_contact`, `use_template`, `wait_for_email`.

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
person per week, 20 points or 40 hours, that a request can change with `capacity`. A person's own weekly capacity can be stored (below); each
person in the answer carries `capacity` and `capacitySource` (`stored`, `default` or `request`).
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

### Weekly capacity per person (R24)

A stored weekly capacity per person, in points and in hours, used by the workload view instead of the
default (20 points, 40 hours). Owners and admins set anyone's; a member sets their own. Setting one is
1 row write; an unchanged value writes nothing.

- App API: `GET /api/workload/capacity` (defaults and every person with their stored values, null when
  unset) and `PUT /api/workload/capacity` with `{ person: "member:<id>" | "agent:<id>", points?, hours? }`.
  A number above 0 (up to 10,000) sets it, `null` clears it back to the default, a field left out stays.
  A person from another workspace answers 404; someone else's capacity without admin rights answers 403.
- Public API: `GET /api/v1/workload/capacity` and `PUT /api/v1/workload/capacity`, same shapes. Read only
  keys can read and are refused (403) on PUT.
- MCP: `set_weekly_capacity`.

## Automation recipes (R24.4)

Ready made "when this happens, do that" rules, about 28 of them in five groups (Tasks, Mail, Chat,
Meetings, Sprints), defined in src/shared/automation-recipes.ts. Turning one on makes normal automation
rows (one per rule of the recipe) with `conditions.recipe` set to the recipe's key, so they show and
edit like any rule. Each recipe lists its `blanks`: what the person picks (`channel`, `project`,
`member`, `members` or `text`), sent as `{ blanks: { channelId, projectId, memberIds, from, keyword } }`.

- App API: `GET /api/automations/recipes` answers `{ categories, canManage, recipes: [{ key, category,
  name, description, icon, rules, blanks, added, on, automationIds }] }`. `POST
  /api/automations/recipes/:key/enable` with `{ blanks }` (admins only) answers `{ recipe, automations,
  created }`; a recipe added before is switched back on (`created: false`).
- Public API: `GET /api/v1/automations/recipes` (read only keys can call it) and `POST
  /api/v1/automations/recipes/{key}/enable` (a full workspace key; read only and agent keys get 403).
- MCP: `list_automation_recipes`, `enable_automation_recipe`.
- Errors: 404 for a key that is not a recipe; 422 when a blank is missing, or names a channel, project
  or member outside this workspace, or a private or archived channel.

The engine behind them (`POST /api/automations` takes the same values):

- Triggers: `email_received`, `status_changed`, `due_soon` (as before), and `task_created`,
  `assignee_changed`, `due_passed` (an open task whose due date passed, checked by the 15 minute cron,
  once per task per due date, paused when the day's D1 write budget reads warn or shed),
  `meeting_ended` (a meeting marked ended; optional `titleContains`) and `chat_message_posted` (needs
  `keyword`, matched as a whole word; optional `channelId`; posts made by rules never trigger it).
- Conditions on task triggers: `projectId`, `priority`, `type`, `label`, `inSprint`, `unassigned`,
  `category` (the task's current category), and on `status_changed` also `toCategory`, `toStatusId` and
  `toStatusName` (for example "In review").
- Actions: `notify` (`to`: assignee, creator, lead, admins or a member id), `create_task`, and
  `post_to_channel` (`channelId` of a public channel, `message` with `{task.title}`, `{task.ref}`,
  `{task.url}`, `{assignee}`, `{project}`, `{meeting.title}`, `{message.text}`, `{author}`,
  `{channel}`, `{email.from}`, `{email.subject}`), `assign_task` (`mode` member with `memberId`, lead
  for the project's owner, or round_robin over `memberIds`), `set_status` (`statusName`, `statusId` or
  `category`), `add_label` (`label`), `set_priority` (`priority`) and `create_subtask_checklist`
  (`items`, 1 to 10 subtasks). Meeting and chat rules can notify, make a task or post.
- Loops: a rule's own change runs one level deeper and nothing runs past 3 levels; one rule acts on
  one task at most once a minute. Every run counts against the plan's monthly automation runs.

D1 writes: listing recipes writes nothing; turning a recipe on is about 9 rows per rule (the rule, its
activity and change rows). A run is the run count and the rule's run stamp (3) plus its action: a post
in a channel about 11, a task change about 15. A due_passed run adds the task's once per due date
marker. A task, chat message or meeting with no matching rules writes nothing more than before.

## Docs page tree and backlinks (R24.5)

Docs form a tree of pages and sub pages, at most 6 levels deep. Each doc has `parentId` (null at the
top) and `position` (a number that orders it among its siblings). Moving a page writes one row: it gets
a position halfway between its new neighbours, and siblings are spaced out again only when two
neighbours have no room left between them. A page can't go under itself or one of its own sub pages
(422 `cycle`), and a move or a new sub page that would go past 6 levels answers 422 `too_deep`.
Deleting a page moves its sub pages up to its parent.

Backlinks: when a doc's body is saved, the links inside it are read: links to `/app/docs/<id>`,
`/app/tasks/<id>`, `/app/tasks?task=<id>` and `/app/tasks?project=<id>` (relative, or on the app's own
host), mention nodes and page links. Outside links and ids from another workspace are ignored. Only
the difference from the stored set is written, so a save that did not change the links writes no link
rows. The co-editing room keeps its own state; the doc row (and so its links) is saved by the leader's
periodic snapshot through the normal update.

- `GET /api/v1/docs/tree` (app: `GET /api/docs/tree`): `{ tree, count, truncated, maxDepth }`; each
  node has id, title, parentId, position, projectId, updatedAt, depth and children. At most 2,000 docs.
- `PATCH /api/v1/docs/{id}/move` (app: `PATCH /api/docs/:id/move`): body `{ parentId?, beforeId? |
  afterId? | position? }`. `parentId` null is the top level; `beforeId` or `afterId` is a sibling under
  that parent; with none the page goes last. Needs a full key. Answers `{ doc, renumbered }`.
- `POST /api/v1/docs` accepts `parentId` to create a sub page (it goes last under that page).
- `GET /api/v1/docs/{id}/backlinks` and `GET /api/v1/tasks/{id}/backlinks` (a task id or a ref like
  OPS-12; app: the same paths under `/api`): `{ backlinks: [{ id, title, snippet, projectId, updatedAt }] }`,
  newest first, at most 100. The snippet is the text of the block that holds the link.
- Project guests: `GET /api/guest/r24/docs/tree`, `/api/guest/r24/docs/:id/backlinks` and
  `/api/guest/r24/tasks/:id/backlinks` show their project's docs only.
- Another workspace's ids answer 404. MCP: `get_doc_tree`, `move_doc`, `get_backlinks`.

D1 writes: a move is 1 docs row (more only when siblings must be spaced out again, once per sibling).
A new link is 2 rows (the row and its target index), a removed link 2, an unchanged save 0. Deleting a
page writes 1 row per sub page moved up. Reading the tree and backlinks writes nothing.

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
  private dashboards; an agent key acts as its agent and sees shared dashboards only, and a dashboard
  it makes is shared.
- MCP: `list_dashboards`, `get_dashboard_data`, `create_dashboard`, `add_dashboard_widget`.
- Who can change what: the owner changes everything; anyone in the workspace can change a shared
  dashboard's name and widgets; sharing and removing a shared one is for its owner or an admin.

D1 writes: reading a dashboard's data writes nothing. Creating, saving (any number of widget changes, a
rename and the share flag together) and removing a dashboard are each one row and its index: 2.

## Formula and rollup fields (R24.1)

Two more custom field types, both read only and computed when tasks are read, so a list, table,
board or task read writes nothing for them. Their settings go in `config` on the normal field create
and update (`POST /api/fields`, `POST /api/v1/projects/{id}/fields`, `PATCH .../fields/{id}`).

- `formula`: `config: { expression }`, up to 500 characters, for example `{Budget} * 1.1`,
  `{points} * 2` or `if(days_between(today(), {due}) < 0, "late", "ok")`. Field names go in braces
  (any custom field on the same project, by name, any case); built ins: points, due, start, created,
  completed, status, priority, title, assignee (also usable bare). Operators: + - * / %, = == != <>
  < > <= >=, and, or, not (&& || !), parentheses. Functions: if, round, floor, ceil, abs, min, max,
  sum, concat, len, upper, lower, days_between, today, now, date_add (days), is_empty, coalesce.
  Type rules: + joins text when either side is text; other maths needs numbers and an empty value
  makes the answer empty; dates are text like 2026-11-02; dividing by 0 is an error. Formulas can read
  other formulas; a loop is refused when saved and shows as an error if it ever appears. The parser is
  hand written: no eval, no property access, no loops, a depth limit of 32.
- `rollup`: `config: { source, fn, field }`. `source` is `subtasks` (the task's direct subtasks; on an
  epic, its items), `epic_children` (an epic's items and their subtasks) or `project` (one value over
  the project's live tasks, epics left out, shown in the project header and not as a task column).
  `fn` is sum, count, count_done, average, min, max or percent_done (0 to 100 by count). `field` is
  `points` or a number, currency or formula field id or name; count functions need none. Sum of
  nothing is 0; average, min, max and percent of nothing are empty.

Values appear in each task's `fields` like stored values. A cell that can't be worked out holds
`"#ERROR"` and the task carries `fieldErrors: { <fieldId>: "message" }`; a read never fails because of
a formula. Computed fields can't be set, filtered or sorted on (422 `computed_field`).

- App API: `GET /api/computed/tasks/:id`, `GET /api/computed/projects/:id/rollups`, and
  `GET /api/computed/preview?projectId&expression&taskId` (the field editor's live preview against the
  first task, or `taskId`; saves nothing).
- Public API: `GET /api/v1/tasks/{id}/computed` returns `computed: [{ fieldId, name, type, config,
  value, error? }]`; `GET /api/v1/projects/{id}/rollups` returns `rollups: [{ id, name, fn, field,
  fieldName, value, error? }]`, `taskCount` and `truncated` (at most 2,000 tasks are read). Both are
  reads; read only keys can call them. Another workspace's ids answer 404.
- MCP: `get_computed_fields`, `create_formula_field`, `create_rollup_field`.

Cost per read: one query for the field definitions, then only when a project has rollups one grouped
query for the listed tasks' children (plus one for epics' grandchildren and one for the children's
stored values when needed), at most 5,000 children per request. D1 writes: reading writes nothing;
defining or changing a formula or rollup field writes its one custom_fields row (plus its index) and
the activity row, like any field.

## Round 24 polish

- Renaming a custom field (`PATCH /api/v1/fields/{id}` with a new `name`) rewrites `{Old Name}` references in the
  same project's formula fields to `{New Name}`, in any case, braced or bare. One extra custom_fields write per formula
  that changed; none when no formula reads the field.
- `POST /api/v1/tasks/bulk` with an `assignee` runs the workspace's `assignee_changed` automations for the reassigned
  tasks, at most 50 rule runs per request. When any ran or were skipped the answer carries
  `automationRuns: { runs, skipped }` (skipped: over the cap, or paused while the daily write budget reads warn or shed).
- A call started from chat that ends because the last person left runs `meeting_ended` automations once.
- MCP `create_custom_field` also takes `formula` (with `config: { expression }`) and `rollup` (with `config: { source, fn, field }`).

## Saved views (DF-20)

Saved views (the filters behind a board, list, calendar, timeline, sprints or workload view) can be made with an API key, not only in the app.

- `GET /api/v1/views?projectId=` lists shared views and the key owner's own.
- `POST /api/v1/views` with `{ "name": "Build board", "view": "sprints", "projectId": "prj_...", "filters": { "status": "doing" }, "shared": true }` answers 201 with the view. Shared unless `shared` is false. One row written. Read only keys get 403, a project outside the workspace 404, bad input 422.
- `DELETE /api/v1/views/{id}` removes it; tasks are not touched.


## Round 25: fixes found by Haajir

- `GET /health` and `GET /healthz` answer the same JSON as `/api/health` (MB-53).
- `GET /api/v1/projects/{id}/tasks`: a project's tasks, the same filters as `GET /api/v1/tasks?projectId={id}` (MB-52).
- Sprints: `startDate` and `endDate` are accepted as names for `startAt` and `endAt`. A date with no time (`2026-11-01`) is that calendar day in the workspace's time zone: a start is its first moment, an end its last, on create and on `PATCH` alike. A new sprint with no dates starts today (or the day after the last sprint) in that zone (MB-54, MB-55).
- Every sprint object carries `url`, the page that opens that sprint (`/app/tasks?project=<id>&view=sprints&sprint=<id>`) (MB-62).
- `POST /api/v1/epics/{id}/items` and `DELETE` take `taskIds` as well as `ids` (MB-56).
- `PATCH /api/v1/docs/{id}` takes `text` (plain text, `#` headings and `-` bullets) to replace the body, as create does (MB-58).
- `PATCH /api/v1/threads/{id}` with `{ status?, userId? }` (`assigneeId` also accepted): owner and status in one call (MB-59).
- `POST /api/v1/messages` takes `replyTo`, the address replies should go to (MB-61).
- `PATCH /api/v1/mailboxes/{id}` with `{ displayName?, replyTo? }`: a mailbox's default Reply-To, carried by every send from it that names none (`replyTo` on the send still wins; `null` or `""` clears it). Mailbox objects carry `replyTo`. Settings, Mailboxes, Edit has the same field ("Replies go to") and MCP has `set_mailbox_reply_to` (MB-61).
- `POST /api/v1/auth-email-hooks` answers with `hook.setup`, the Supabase steps besides the URL, including the SMTP placeholder and rate limit without which Supabase stays at 2 auth emails an hour (MB-57).

## Conditional GETs (R25)

A few read only session GETs send a weak `ETag` and answer `304 Not Modified` (no body) when the request's `If-None-Match` matches: `/api/config` (`Cache-Control: public, no-cache`, it holds no account data) and `/api/team/people`, `/api/tasks/assignees`, `/api/projects`, `/api/chat/channels` (`Cache-Control: private, no-cache`, `Vary: Cookie, Authorization`). Every one of them revalidates on each use, so a change is never hidden; response shapes are unchanged. All other `/api/*` responses keep `Cache-Control: no-store`.

## Branded auth emails (R25, MB-60)

The Supabase auth email hook (`/api/v1/auth-email-hooks`, see docs/transactional-email.md section 5) can carry the app's branding. With nothing set the email is exactly the one sent before.

- `POST /api/v1/auth-email-hooks` takes an optional `branding` object; `GET /api/v1/auth-email-hooks` shows each hook's `branding` (or `null`). Secrets are never shown.
- `PATCH /api/v1/auth-email-hooks/{id}` with any of `{ appName, from, branding }`. `branding`:
  - `logoUrl`: an `https://` image URL (shown at the top, 40 px high).
  - `brandColor`: `#RRGGBB` (or `#RGB`), the button colour; the button text turns dark on light colours.
  - `replyTo`: the address replies go to (sent as the `Reply-To` header).
  - `footer`: one line under the email.
  - `templates`: per type (`signup`, `invite`, `magiclink`, `recovery`, `email_change`, `email`, `reauthentication`) any of `{ subject, intro, buttonLabel }`. A type or field you leave out keeps the default text. Code only types (`email`, `reauthentication`) never show a button.
  - `secondaryLanguage`: `{ lang, templates, note }`. For a type with text here, a second block (with `lang`, for example `ne`) goes under the main text: its intro, its own button to the same link and the note (for example "If you didn't ask for this" in that language). Its `subject`, when set, is added to the subject after ` / `.
  - Placeholders in any text: `{appName}`, `{code}` (empty when the email has none) and `{email}` (the recipient). Other braces stay as typed.
  - Everything is plain text: it is HTML escaped when sent and never taken as HTML. Subjects and one line fields refuse line breaks. A bad value answers 422 naming the field (`branding.logoUrl: ...`).
  - Merging: keys you leave out stay as they are, `null` clears one, `templates` merge per type (a type set to `null` goes back to the default), `secondaryLanguage` is replaced whole, and `branding: null` clears everything.
  - Needs a full workspace key or an admin; read only keys get 403 `read_only_key`, agent and agent member keys 403, another workspace's hook 404. One row written (an unchanged PATCH writes nothing).
- `POST /api/v1/auth-email-hooks/{id}/preview?type=signup` returns `{ preview: { type, to, subject, html, text, replyTo } }` with a sample link and the code `123456`. Nothing is sent or written. Optional body `{ email, branding }`: the address for `{email}` and unsaved branding to try (merged over the saved one). Read only keys can call it. An unknown `type` answers 422.
- MCP: `update_auth_email_hook` (see docs/MCP.md).

## Round 26: comments and chat messages can be read back and edited (MB-77), sprint filter (MB-72)

- `GET /api/v1/tasks/{id}/comments` (id or reference) returns `{ taskId, comments: [{ id, taskId, body, author: { type, id, name }, editedAt, createdAt }] }`, oldest first. Read only keys can call it.
- `GET /api/v1/comments/{id}`, `PATCH /api/v1/comments/{id}` with `{ body }` (author only; then `editedAt` is set), `DELETE /api/v1/comments/{id}` (author, owner or admin).
- `GET /api/v1/chat/messages/{id}` returns `{ message, channel }`; `PATCH /api/v1/chat/messages/{id}` with `{ body }` (author only, same markup as posting; `editedAt` is set); `DELETE /api/v1/chat/messages/{id}` (author, owner or admin; a deleted placeholder stays so replies keep their place).
- Another workspace's ids answer 404; private channels and DMs answer 404 to keys; read only keys get 403 `read_only_key` on writes.
- `GET /api/v1/tasks` and `GET /api/v1/projects/{id}/tasks` take `sprintId=<id>` (one sprint) or `sprintId=none` (the backlog). An unknown query parameter now answers 400 `unknown_parameter` naming it (`field.<id>` filters are still allowed).
- MCP: `list_task_comments`, `edit_task_comment`, `delete_task_comment`, `edit_chat_message`, `delete_chat_message`.

## AI agent members (R26, DF-3)

Agent members are workspace members of kind `agent` (see docs/adr/0008-agents-as-members.md). Creating, keys and removal are in the People section (`POST /api/v1/agent-members`, `/agent-members/{id}/keys`, `DELETE /agent-members/{id}`). R26 adds:

- `POST /api/v1/agent-members` also takes `avatarColor` (`#rrggbb`) and `inboxAgentId` (an existing agent inbox to link; mailbox stays optional). The answer's `member` carries `avatar: { color, initials }`, `disabled`, `inbox` and `keys`.
- `GET /api/v1/agent-members`: `{ agents: [{ userId, name, title, bio, avatar, disabled, disabledAt, inbox, keys, joinedAt }] }`. Any key of the workspace.
- `GET /api/v1/agent-members/{id}`: `{ agent }` for one, by user id. Another workspace's id answers 404.
- `PATCH /api/v1/agent-members/{id}` with any of `{ name, title, bio, avatarColor, disabled, inboxAgentId }`. `disabled: true` pauses the agent: every key of it answers 401 until `disabled: false`. A paused agent stays in People and in task history, and leaves the assignee and mention pickers (`/api/tasks/assignees` marks it `paused: true`). Needs a full workspace key or an admin; read only keys get 403 `read_only_key`, agent and agent member keys 403 `agent_key_scope`. One members row and one audit row (`agent_member.updated`, `agent_member.paused` or `agent_member.resumed`); an unchanged PATCH writes nothing.
- Task assignees and chat people mark agent members `isAgent: true` (assignee `member:<userId>`), and a task assigned to one shows `assignee.isAgent: true` with no email.
- Session routes for the app: `GET /api/team/agents`, `PATCH /api/team/agents/{userId}` (admins), and `POST /api/team/agents` with the same new fields.
- MCP: `list_agent_members`, `create_agent_member`, `update_agent_member`.
## Share links (R26, MB-87)

A read only link to a doc or a project board for someone who is not in the workspace (a client or a partner), without making them a guest.

- `POST /api/v1/share-links` with `{ kind: "doc" | "project_board", targetId, expiresInDays?: 7 | 30 | null, showWorkspaceName?: boolean }` answers 201 with `{ link: { id, kind, targetId, showWorkspaceName, createdBy, createdAt, expiresAt, url } }`. `url` is `https://multies.si/s/<token>` (32 random bytes, base64url) and is shown only this once: only the token's SHA-256 is stored. `showWorkspaceName` defaults to true (the page says "Shared by <workspace>"); false hides it. One row written.
- `GET /api/v1/share-links?kind=&targetId=` lists active links (not revoked, not expired), newest first, at most 200, with `allowShareLinks`. Read only keys can list.
- `DELETE /api/v1/share-links/{id}` revokes a link at once. Revoking twice is fine.
- The page `GET /s/<token>` needs no sign in. A doc shows its title and body (comments dropped, mentions as plain names, links into the app as plain text). A board shows its columns by status with each card's title, assignee initials, due date and labels; never notes, comments, files or custom fields. An unknown, revoked or expired token, a deleted target, or share links turned off answer 404 with "This link is no longer active". Headers: `Cache-Control: private, max-age=0`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, and the app's page CSP. 60 opens a minute per IP (429 after). Opening a link writes nothing (views are not counted).
- Who: workspace members and admins (a session, or a full workspace key acting as its creator). Guests, read only keys (for create and revoke), agent keys and agent member keys get 401 or 403; another workspace's doc, project or link is 404.
- Settings: `GET /api/share-links/settings` and `PUT /api/share-links/settings` `{ allowShareLinks }` (admins; on by default). Off makes create answer 403 `share_links_off` and every existing link show the inactive page; turning it back on brings unrevoked, unexpired links back.
- Session routes (the app): `POST /api/share-links`, `GET /api/share-links?kind=&targetId=`, `DELETE /api/share-links/:id`.
- MCP: `create_share_link`, `list_share_links`, `revoke_share_link` (see docs/MCP.md).

## Checklists inside tasks (R26, MB-85)

A task can hold a checklist: light to-dos with a title, done, order and an optional assignee and due date. Permissions
follow the task. Read only keys can list; writes need a full key. Another workspace's ids answer 404.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/tasks/{id}/checklist` | Items in order, with `total` and `done`. `{id}` takes a task id or a reference like `OPS-12` |
| POST | `/api/v1/tasks/{id}/checklist` | Add one item `{ title, done?, assignee?, due?, position? }` or `{ items: [...] }` (up to 200 per task) |
| POST | `/api/v1/tasks/{id}/checklist/reorder` | `{ ids }`: every item id once, in the new order. Only items that move are written |
| PATCH | `/api/v1/checklist-items/{id}` | Any of `{ title, done, assignee, due, position }`. A patch that changes nothing writes nothing |
| DELETE | `/api/v1/checklist-items/{id}` | Remove the item |
| POST | `/api/v1/checklist-items/{id}/to-subtask` | Make a subtask of the item's task (same title, assignee, due) and remove the item |

Task rows (GET /tasks and friends) carry `checklist: { total, done }`. Each item write costs 3 D1 row writes (the row,
its primary key and one index on task_id).

## Agent runs on tasks (R27, DF-3 slice 2)

An AI agent member works on a task itself and leaves a run log: a start, ordered steps and a result. Runs show on the
task (the Runs section of the task panel) and every start and finish writes an audit entry that names the agent and the
task ("Builder started a run on MB-12"). A run is `queued`, `running`, `succeeded`, `failed` or `cancelled`.

| Method | Path | Who | What it does |
|---|---|---|---|
| POST | `/api/v1/tasks/{id}/runs` | the agent member's own key | Start a run (`running`) on a task the agent is assigned to or mentioned on (`<@member:id>` or `@Name` in the notes or a comment), or claim a run queued for it. Body `{ moveToDoing?, note? }`. Otherwise 403 `agent_not_on_task` |
| POST | `/api/v1/tasks/{id}/runs` | a person or a full workspace key | Queue a run (`queued`) for an agent member: the explicit allowance. Body `{ agentUserId }` |
| POST | `/api/v1/runs/{id}/steps` | the run's own agent | Append `{ kind: note \| tool \| comment \| status_change, text }`. A queued run becomes running |
| POST | `/api/v1/runs/{id}/finish` | the run's own agent | `{ status: succeeded \| failed \| cancelled, result?, moveTo?: done \| review, comment? }`. `moveTo: review` picks the project status whose name has "review" in it; `comment: true` posts the result as the agent's comment |
| POST | `/api/v1/runs/{id}/finish` | a person or a workspace key | Only `{ status: "cancelled" }` (403 `cancel_only` otherwise). The app has `POST /api/agent-runs/{id}/cancel` |
| GET | `/api/v1/tasks/{id}/runs` | any key | The task's runs, newest first, with steps and result. `limit` 1 to 200 |
| GET | `/api/v1/runs/{id}` | any key | One run with its steps |
| GET | `/api/v1/runs` | any key | Runs across the workspace, newest first, without steps. `agentUserId`, `status`, `limit` (1 to 200) |

Limits: one queued or running run per agent and task (409 `run_in_progress`), 200 steps per run (422
`run_step_limit`), 1,000 characters per step and 4,000 per result. Mail agent keys get 403 `agent_member_only`; read
keys get 403 `read_only_key`; a paused agent's key gets 401. Another workspace's ids answer 404.

D1 cost: a step is 1 row write (the steps are a JSON array on the run row, appended in place; no index changes).
Starting is 4 (the row, its primary key, the task index and the one-active-run index) plus the audit row; finishing is
2 plus the audit row. Moving the task or posting the comment costs what those writes always cost.

## Task query language (R26, MB-86)

`GET /api/v1/tasks?q=...` (and the app's task list) takes a typed query. Terms are ANDed, commas mean any of, a leading
minus negates a term and quotes keep words together:

    assignee:me status:doing label:bug priority:>=high due:<7d sprint:current type:bug project:MB "free text"
    -label:wontfix created:>2026-10-01 points:>=3 has:subtasks is:overdue

Keys: `assignee` (me, none, a name or email, member:<id>), `status` (todo, doing, done, open or a status name),
`label`, `priority` (urgent, high, medium, low, none; `<`, `<=`, `>`, `>=` work), `due` (today, tomorrow, 2026-11-02,
7d meaning 7 days from now, -3d, none), `sprint` (current, next, none or a sprint name), `type` (task, story, bug,
epic), `project` (key or name), `created` and `updated` (a date or 7d meaning 7 days ago), `points` (a number or
none), `has` (subtasks, checklist, due, assignee, labels, points, parent, notes), `is` (overdue, open, done,
unassigned, subtask, mine, watching) and `title`. Text with no key in it searches titles and notes, as before.

A bad query answers 400 with `error.code` `bad_query`, a message and `error.details.position` (the 1 based character
where it went wrong). A query holds up to 30 values and 500 characters; names cost the most and about 10 names fit in
one query. MCP: `search_tasks` with `q`.

## Task watchers (R27)

Watchers hear about a task's new comments (notification type `task.watch_comment`, category comment) and status
changes (`task.watch_status`, category status) in their notifications inbox, under their own notification settings.
The person who creates a task, a member it is assigned to and anyone who comments start watching on their own
(`source: "auto"`); anyone can watch or stop by hand (`source: "manual"`). A person told about a comment by a mention
or as the assignee is told once. Commenting again after stopping starts watching again.

    GET    /api/v1/tasks/{id}/watchers            { taskId, watching, count, watchers: [{ userId, name, email, source, since }] }
    POST   /api/v1/tasks/{id}/watchers            { userId? }  (default: the key's member; an agent key names one)
    DELETE /api/v1/tasks/{id}/watchers/{userId}   ("me" is the key's member)

`id` takes a task id or a reference like OPS-12. Read only keys can list. Up to 200 watchers per task; a non member
answers 422 `invalid_member`. `q=is:watching` lists the tasks you watch. MCP: `list_task_watchers`, `watch_task`,
`unwatch_task`.

## Duplicate a task (R27)

`POST /api/v1/tasks/{id}/duplicate` copies a task with a new number into the project's first to-do status. The copy
keeps the notes, assignee, priority, dates, labels, type, estimate, sprint, repeat rule and custom field values, and is
linked to the original (`duplicate_of`). Body, all optional:

    { "title": "Launch, Android", "projectId": "prj_...", "subtasks": true, "checklist": true, "assignee": true, "dependencies": false }

`title` defaults to "<title> (copy)". `subtasks` copies up to 3 levels and 200 tasks in all. `checklist` copies every
item unticked. `dependencies` copies the "blocked by" links. A copy into another project keeps no sprint or custom
field values. Comments, time, files and history stay with the original. Answers 201 with
`{ task, from: { id, ref }, copied: { tasks, subtasks, checklistItems, dependencies } }`. Read only keys get 403.
MCP: `duplicate_task`.

## Inbound keys (R26, DF-18)

The Email Worker signs each delivery with a workspace's inbound key. Owner and admin workspace keys can manage them
(read only, agent and agent member keys are refused):

| Method | Path | What it does |
|---|---|---|
| GET | `/api/v1/inbound-keys` | The keys: `id`, `createdAt`, `lastUsedAt`. Secrets are never shown again |
| POST | `/api/v1/inbound-keys` | Make one. Returns `{ key: { id, secret }, webhookUrl }`; the secret is shown only this once |
| DELETE | `/api/v1/inbound-keys/{id}` | Revoke it. Deliveries signed with it are refused from then on |

## Sign-up emails settings (R27)

Settings, Sign-up emails (workspace owners and admins) and the REST API manage the workspace's auth email hook (the Supabase Send Email Hook above) without hand calls. Full workspace keys only: members, agent keys and read only keys get 403.

- `GET /api/v1/auth-email-settings`: `{ settings, senders, types, testSendsPerHour }`. `settings` is `null` before the first save, else `{ id, enabled, senderName, from, appName, supabaseUrl, branding, endpointUrl, secret: { set, masked }, testSendsLeft, lastUsedAt }`. The secret itself is never returned here; `masked` shows its last 4 characters. `senders` are the mailboxes on the workspace's verified domains.
- `PUT /api/v1/auth-email-settings` with any of `{ enabled, senderName, from, appName, supabaseUrl, branding }` (`from` and `supabaseUrl` are needed the first time; `branding` merges as in PATCH above, `null` clears it). The first save answers with `secret` once, in the form Supabase takes (`v1,whsec_...`). `enabled: false` makes the hook answer 503 and send nothing; `senderName` is the From name (null uses the mailbox's display name).
- `POST /api/v1/auth-email-settings/secret`: a new signing secret, returned once; the old one stops working at once.
- `POST /api/v1/auth-email-settings/preview` with `{ type?, appName?, branding?, email? }`: the email one type would send, with unsaved changes merged in. Nothing is sent or stored.
- `POST /api/v1/auth-email-settings/test` with `{ type? }`: sends that type, as saved, to the caller's own address with "Test:" before the subject. At most 5 an hour for a workspace (429 after).
- Audit log: `auth_email_settings.created`, `auth_email_settings.updated` (names the fields that changed), `auth_email_settings.secret_regenerated`, `auth_email_settings.test_sent`. Secrets are never written to the audit log or to logs.
- The web app uses the same routes at `/api/auth-email-settings` (cookie session). Migration 0060 adds `enabled`, `sender_name` and `test_sends` to `auth_email_hooks`.
