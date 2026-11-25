# API: REST, MCP and webhooks

Multies has three ways in, all served by the same Worker:

| Surface | Base path | Who uses it | Auth |
| --- | --- | --- | --- |
| App API | `/api/...` | the web app and the mobile app | Better Auth session cookie. State changing calls must be JSON and, when the browser sends an Origin, it must match the host (CSRF guard). |
| Public REST API | `/api/v1/...` | integrations, scripts, agents | `Authorization: Bearer mm_live_...` (workspace key or a scoped agent key, created in Settings, Developers). |
| MCP | `/api/v1/mcp` | AI agents and MCP clients | the same API keys. Streamable HTTP, stateless. |

## API key scopes (R36)

A workspace key has **Full access**, **Read only**, or scopes per area that you pick when you create it (Settings, Developers; edit them any time with "Edit scopes"):

| Area | Read | Write |
| --- | --- | --- |
| Mail | `mail:read` | `mail:send` |
| Tasks and projects | `tasks:read` | `tasks:write` |
| Chat | `chat:read` | `chat:write` |
| Docs and forms | `docs:read` | `docs:write` |
| Calendar and meetings | `calendar:read` | `calendar:write` |
| Contacts and deals | `contacts:read` | `contacts:write` |
| Workspace admin | `admin:read` | `admin:write` |
| Document tools | `tools:read` | `tools:run` |

A write scope includes its read scope. Every `/api/v1` route and every MCP tool needs one scope (GET needs the read scope, other methods the write scope); the MCP tools page at https://multies.si/developers/mcp shows each tool's. A call without it answers 403 `{"error":{"code":"insufficient_scope","message":"...","required":"tasks:write"}}` (on MCP, a tool error starting `insufficient_scope:`). Full access and Read only keys behave exactly as before. Session endpoints: `GET /api/developer/scopes` (areas and presets), `POST /api/developer/keys` with `scope` as `"full"`, `"read"` or a list, `PATCH /api/developer/keys/{id}` with `{ scope }`.


The v1 OpenAPI 3.1 document is generated from the request schemas at `/api/v1/openapi.json`, with an
interactive reference at `/api/v1/reference`. That document is the source of truth for request and
response shapes; this page is the map. Mutating calls accept an `Idempotency-Key` header (8 to 255
characters); a retry with the same key returns the first answer, marked `idempotent-replayed: true`, and
writes nothing. Every v1 POST, PUT, PATCH and DELETE takes the key, and a test sends each of them twice to
check this. The same key with a different body is 422 `idempotency_key_reused`, and a retry while the first
call is still running is 409 `idempotency_in_progress`. Keys last 24 hours and belong to the API key that sent
them. A first call that answered 5xx or 429, or was cut off, can be retried with the same key: creating a task,
project, doc, deal, task comment, meeting, form, goal, time entry, chat channel, agent, saved reply (snippet),
custom field, checklist items or sprint then returns the item the first call made, with the same id, instead
of a copy. A retried agent create answers `apiKey: null` when the first call already made the agent (its key was
shown once, in the lost answer): make a new one with `POST /api/v1/agents/{id}/keys`. Invites (`POST /invites`,
`POST /projects/{id}/guests`) and contacts (`POST /contacts`) are matched by email, so a retry renews the same
one. `POST /api/v1/mcp` takes the key too: a tool call sent twice with one key runs once (see MCP.md).
R53: `POST /webhooks` retried after a 5xx returns the endpoint the first call made, with the same id and the
same signing secret (no second secret is made). Imports retried with the same key leave one copy of every row:
`POST /work-imports/run` fills the project its first call made instead of a second one, and
`POST /data-moves/imports/run` answers the same run (`move.id`) and skips meetings, docs and projects the first
call already wrote, even when it was cut off before saving its progress.
R54: the same holds for `POST /templates` and `POST /templates/{id}/use` (the project, doc or task it makes;
a project template's fields and tasks are not made again), `POST /docs/{id}/versions`, `POST /tasks/{id}/runs`,
`POST /runs/{id}/steps` (a step has no id: a retry whose step already landed answers with that step and logs no
second one), `POST /meetings/{id}/action-items` (one id per item, and the notes get each new line once),
`POST /dashboards` and `POST /dashboards/{id}/widgets`, `POST /reports` (one report and one mail to the team),
`POST /incoming-hooks` (the same hook and the same URL; no second URL is made) and `POST /agent-triggers` (the
same trigger and, for a webhook trigger, the same secret). Two creates are exceptions: a retry of
`POST /agent-members` after a server error can make a second agent member with its own key, and a share link made
over MCP (`create_share_link`) can be made twice, because a key or link is shown only once and kept only as a hash.
List them (`GET /agent-members`, `list_share_links`) and delete the extra one (`DELETE /agent-members/{id}`,
`revoke_share_link`).
R55: the same holds for `POST /threads/{id}/comments`, `POST /tasks/from-email`, `POST /tasks/{id}/duplicate` (one
copy), `POST /mail/splits`, `POST /chat/messages/{id}/task`, `POST /chat/channels/{id}/messages` (sent without a
clientMsgId; with one, the clientMsgId decides), `POST /time/start`, `POST /triage`, `POST /views`,
`POST /goals/{id}/key-results`, `POST /checklist-items/{id}/to-subtask` (one subtask, and the item is removed once),
`POST /integrations` (the same connection and the same signing secret), `POST /agent-triggers/{id}/run` (the same
queued run and, for a project trigger, the same task) and `POST /auth-email-hooks` (the same hook and URL). Still not
covered: sends (`POST /messages`, `/agents/{id}/send`, `/agents/{id}/threads/{threadId}/reply`, `/approvals/{id}/approve`,
`/meetings/{id}/invite`), because mail may already have left; `POST /data-moves/exports`, whose retry inside the export
interval answers 429 and makes no second export; and doc edits (`POST /docs/{id}/append`, version restore), where
`ifVersion` makes a retry answer `version_conflict` instead of applying twice. Keys and links shown once
(`POST /agent-members`, `/agent-members/{id}/keys`, `/agents/{id}/keys`, `/inbound-keys`, `/share-links`) stay
exceptions. Names, addresses and emails that must be unique (domains, mailboxes, aliases, contacts, invites,
guests) never make a second row.
Errors are JSON:
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
Round 33: a post may carry `clientMsgId` (9 base 36 characters of the send time in ms, then 8 to 40 more). The answer then carries
`ack { type: "ack", reply_to, ok, message: { id, ts }, deduped }`, and a repeat with the same id answers 200 with the first message
(no second row, notification or live event). The live socket's first frame is `{ t: "hello", serverTime, seq }`; the app holds sends until it.
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

Triage (R31): `GET /?view=inbox|later|done` (default `inbox`: not done, and not snoozed or the snooze has passed). Each
item has `doneAt` and `snoozedUntil` (ISO or null); the answer adds `viewCounts { inbox, later, done }`, and `unread`
counts the Inbox only. `POST /:id/done`, `POST /:id/undone` (clears done and snooze), `POST /:id/snooze` with
`{ until }` (ISO, in the future, at most 90 days) or `{ preset: later_today | tomorrow | next_week }` in the person's time
zone (UTC+10 when none is set), and `POST /done` with `{ ids }` (up to 500). A snoozed item comes back to the top of the
Inbox, unread. The same on `/api/v1/notifications` (workspace keys). MCP: `notification_list`, `notification_done`,
`notification_undone`, `notification_snooze`.

## Catch-up

`GET /api/catchup?type=channel|task|doc&id=&visit=1` (and `GET /api/v1/catchup`) answers what changed since the person's
last visit: `counts` (messages, replies, comments, edits, statusChanges, assigneeChanges, mentions), `actors`,
`decisions` (messages and comments that say decided, agreed, approved or we will, plus status and assignee changes),
`latest` and `hasNew`. It is a deterministic digest (`mode: "digest"`). `visit=1` also records the visit, at most once a
minute per item. `POST /api/catchup/visit` (`{ type, id }`) marks the item caught up now. With the workspace's own AI key,
`POST /api/catchup/summary` writes a short summary on that key (409 `ai_key_required` without one). MCP: `catchup_get`.

## The workspace's own AI key: refusals and built-in AI (QUAL1)

When the provider refuses the workspace's own key (401, or a 403 that names the key or a permission), says its account
has no credit (402 or its own quota or balance code), or no longer offers the saved model, Multies notes it on the key
with the time, on any AI call (the mail assistant, Tools, Team AI, meeting notes and recordings, catch-up, forms, the
connection test and the model list). A call on the key that works, a passed `POST /api/ai/test`, a new key, or (for the
model) a new model clears it. A provider turning down the request's own text (its moderation or a guardrail flags it,
or it is too long) is never noted on the key and never goes to built-in AI: the answer is `502 ai_provider_error`
saying the provider would not answer this request, on the mail assistant and on mail Translate and the document
tools alike. Rate limits are not noted either: a 429 counts as no credit only when it names the credit itself (an
`insufficient_quota` code), so a per minute limit (a 429 `RESOURCE_EXHAUSTED`) passes. A 402 is always no credit,
also when its text mentions `max_tokens`. A saved key that can't be read (the app secret changed)
answers 409 `ai_key_refused` asking an admin to paste it again, and goes to built-in AI only when the stand-in is on.

- `GET /api/ai/status` adds `problem` (`key_refused`, `no_credit` or `model_unavailable`), `problemAt` (ISO time) and
  `problemMessage` (the plain sentence the app shows) while the key is refused. They are absent while it works; `connected`
  stays `true` because the key is still saved.
- `POST /api/ai/summary`, `/api/ai/draft` and `/api/ai/triage` (and the meeting suggestions, the forms AI draft, the
  live meeting summary, `POST /api/catchup/summary`, the mail Translate `POST /api/translate`, and the document tools'
  `POST /api/tools/ai/ask` and `/api/tools/ai/translate`) answer **409** with the code `ai_key_refused`, `ai_no_credit`
  or `ai_model_unavailable`, the same sentence, and `details.fix: "/app/settings#ai"`. A provider that is down or rate
  limited is still `502 ai_provider_error`. A recording chunk the provider refuses stays `502 ai_provider_error` with the
  same sentence (the web recorder tries it again, then names the reason at Stop; the phone app does not record). While
  the key is noted refused or out of credit, `GET /api/meetings/:id/recordings` keeps `setup.ready: true` (a chunk that
  works clears the note) with `setup.keyProblem` and the sentence in `setup.message`, which the meeting room shows.
- Built-in AI answers in the key's place only where the deployment sets `AI_KEY_FALLBACK=on` (with AI2 on). It is off
  by default: the workspace chose its own provider, so its text never goes to another processor unless the operator
  turns this on (after the privacy policy says so). When it is on, `GET /api/ai-trust` lists built-in AI "In their
  place if your provider refuses your key" before any refusal, and each answer it writes inside the free daily meter
  carries `fallback: { reason, message }` (`message` starts "Built-in AI wrote this because ..."). `POST /api/translate`
  (also when served from its cache), the forms AI draft and the document tools' Ask and Translate answers carry the
  same `fallback`, their invoice and contract readers put the sentence in `note`, and a Team AI run ends with that line.
- `POST /api/ai/models` with a refused key answers the short list of common models with `live: false`,
  `problem: "key_refused"` and a note saying so, and keeps no cached copy.
- `GET /api/team-ai/state` shows `ai.keyProblem` and `ai.keyProblemMessage`; `ai.source` is `built_in` (or `none`)
  while the key is refused, never `own_key`. An `@assistant` mention whose key is refused posts that sentence in the
  thread (a fixed line, no AI call) and the run ends `failed` with the reason `key_refused`, `no_credit` or
  `model_unavailable`.

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
changed (404). Read only keys get 403. Deleting a task that waits in Triage, or one with a subtask that waits,
needs a person signed in: a key gets 403 `person_only` and nothing is deleted (AIS1). The writes go out in one batch: each changed task writes its
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

### Form logic and results (R31)

A form field can carry `logic` and `rules`. `logic` is `{ "join": "all" | "any", "conditions": [{ "field": "<id of a question above>", "op": "is" | "is_not" | "contains" | "answered" | "not_answered" | "gt" | "lt", "value": "Yes" }] }`: the question shows only when the conditions hold. A hidden question is skipped, never required, and its answer is dropped. A condition can only use a question above it: a loop, a question that depends on itself or on a later one answers 422 (`details.code` is `cycle`, `self` or `later`), and a condition on a deleted question is removed when the form is saved. `rules` by type: `minLength`, `maxLength` (text, long text, email, phone), `min`, `max` (number), `minSelected`, `maxSelected` (the new `multiselect` type, answers stored as "A, B"), `pattern` and `patternMessage` (text, phone). A public submission that breaks a rule answers 400 `validation_failed` with every field's message in `details.fields` and the first in `details.field`.

- `PUT /api/v1/forms/{id}/fields/{fieldId}/logic` with `{ logic?, rules?, required? }` (null clears logic or rules): `{ form, field }`. Read only keys get 403.
- `GET /api/v1/forms/{id}/responses?q=&from=YYYY-MM-DD&to=YYYY-MM-DD&sort=createdAt|<question id>&dir=asc|desc&limit=50&offset=0`: `{ fields, responses: [{ id, answers, entityType, entityId, createdAt }], total, limit, offset }` (limit up to 200).
- `GET /api/v1/forms/{id}/summary` (same q, from, to): `{ total, firstAt, lastAt, capped, questions }`, each question `kind: "choice"` with `counts`, `"number"` with `average`, `min`, `max`, or `"text"` with the 5 latest answers. Reads the newest 10,000 matching responses at most, a page of 500 at a time.
- Routing (forms that make tasks): `routing: [{ "when": { "field", "op", "value" }, "projectId", "assigneeId": "member:..." | "agent:..." }]` on create and update (up to 10). After a submission the first rule that matches puts the task in that project and assigns it; otherwise the form's own project and assignee apply. A rule needs a project or a person (422), another workspace's project is a 404, and a rule on a removed question is dropped.
- In the app the same routes live under `/api/forms/:id/...`, plus `GET /api/forms/:id/responses.csv` (a spreadsheet safe CSV of the matching responses).

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

New work can wait in Triage before it becomes a task. A project's `triage` setting sends tasks from mail
rules (workspace automations and a person's own rules), public forms, incoming hooks, API keys and AI apps
(MCP, agents) there, subtasks, copies and imports included (`POST /work-imports/run`,
`POST /data-moves/imports/run` and MCP `import_file` from a key, also into a new project the import makes; the
work import answers `triage: true` then); tasks a person makes or imports in the app go straight to the board.
A decision on a task takes its subtasks with it: accept brings in the ones that wait (into the accept's
`projectId` too), decline and merge remove the ones that came through Triage, and undo puts them back. A subtask
that never came through Triage only leaves the declined item. A key or an AI app can't put a task that isn't
waiting under a waiting item (`PATCH /tasks/{id}` with `parentId`: 403 `person_only`), and when it finishes its
own waiting repeating task the next one waits too. A key or an AI app can't move a task from a project with Triage off into one
with Triage on (`PATCH /tasks/{id}` or `POST /tasks/bulk` with `projectId`: 403 `person_only`, nothing changes)
unless it waits in Triage or a person accepted it there; it can make the task in that project, where it waits.
It is on for every new project, made in the app, by a key (`POST /projects`), from a template, by an import
or as the first "Tasks" project (AIS1); projects made before keep what they had. Only a person signed in
turns it off: `triage: false` from a key, on create or on `PATCH /projects/{id}`, answers 403 `person_only`.
A form's own "Send to triage" switch (`triage: true`, on by default for new forms, also from the API and
MCP) sends its answers there whatever the project's setting.
A triage item is a task row with `triage_state = 'pending'`: it keeps its number, and lists, boards,
My Work, search, reports, the portfolio and counts leave it out (`GET /api/tasks?triage=pending` asks
for them). Accept clears the flag in the same task write as any other change; decline soft deletes the
item and can send the sender a short polite reply (opt in, never to no-reply addresses); merge adds the
item's notes as a comment on another task, moves its mail thread there when the target has none, and
deletes the item.

- Page: `/app/triage` (Triage in the nav, with a count). Keys: j and k move, a accepts, d declines, m merges.
- App API: `GET /api/triage` (`projectId`, `limit`), `GET /api/triage/count` (`projectId`: the count for that project only; without it, the whole workspace), `POST /api/triage`, `GET /api/