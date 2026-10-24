# API: REST, MCP and webhooks

Multies has three ways in, all served by the same Worker:

| Surface | Base path | Who uses it | Auth |
| --- | --- | --- | --- |
| App API | `/api/...` | the web app and the mobile app | Better Auth session cookie. State changing calls must be JSON and, when the browser sends an Origin, it must match the host (CSRF guard). |
| Public REST API | `/api/v1/...` | integrations, scripts, agents | `Authorization: Bearer mm_live_...` (workspace key or a scoped agent key, created in Settings, Developers). |
| MCP | `/api/v1/mcp` | AI agents and MCP clients | the same API keys. Streamable HTTP, stateless. |

The v1 OpenAPI 3.1 document is generated from the request schemas at `/api/v1/openapi.json`, with an
interactive reference at `/api/v1/docs`. That document is the source of truth for request and
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
- `GET /unread`, `GET /people` (for mentions and new DMs)
- `GET /files/:id`, and `GET /files/:id/download?exp=&sig=`: a signed link valid for at least 15 minutes that needs no session (used by the phone app)
- Guests use `/api/guest/chat` and see only channels shared with their project.

Body markup, the same in every client: `<@member:USER_ID>`, `<@agent:AGENT_ID>`, `<!channel>`,
`<#task:ID>`, `<#thread:ID>`, `<#doc:ID>`. Responses carry `mentions` and `links` resolved with names.
Clients poll `GET /unread` every 15 s and the open channel with `?since=` every 4 s while visible.

Public API: `GET` and `POST /api/v1/chat/channels`, `GET` and `POST /api/v1/chat/channels/{id}/messages`,
`GET /api/v1/chat/messages/{id}/thread`, `POST /api/v1/chat/messages/{id}/task`. An agent key posts as its agent.

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

## Templates

- App API: `GET /api/templates`, `POST /api/templates`, `GET /api/templates/:id`, `POST /api/templates/:id/use`, `DELETE /api/templates/:id`
- Public API: `GET /api/v1/templates`, `GET /api/v1/templates/{id}`, `POST /api/v1/templates/{id}/use` (`name?`, `projectId?` for a task template, `startDate?`; due dates count from it)
- The starter gallery: client onboarding, content calendar, sales pipeline, bug tracker. Event: `template.used`. MCP: `list_templates`, `use_template`.

## Goals and key results

- App API: `GET` and `POST /api/goals`, `GET`, `PATCH` and `DELETE /api/goals/:id`, `POST /api/goals/:id/key-results`, `PATCH` and `DELETE /api/key-results/:id`
- Public API: `GET` and `POST /api/v1/goals`, `GET` and `PATCH /api/v1/goals/{id}`, `POST /api/v1/goals/{id}/key-results`, `PATCH /api/v1/key-results/{id}`
- Key result kinds: number, currency (AUD), percent, tasks (linked tasks or every top level task in a project). Progress is 0 to 100, rolled up from key results and child goals; health is on_track, at_risk, off_track or empty.
- Events: `goal.created`, `goal.updated`, `goal.deleted`. MCP: `list_goals`, `create_goal`, `update_key_result`.

## Integrations

- `/api/integrations`: Xero connection (behind config), connect, callback, unpaid invoices, disconnect.
- Round 11 adds an integrations page with a catalogue of incoming and outgoing webhooks and Zapier style connectors. Its routes are added here in the same release.

## MCP tools

52 tools at the time of writing:
`append_to_doc`, `comment_on_task`, `contact_timeline`, `create_agent_inbox`, `create_custom_field`, `create_doc`, `create_form`, `create_goal`, `create_task`, `find_tasks_by_field`, `get_portfolio`, `get_report`, `get_task`, `get_timesheet`, `invite_guest`, `list_channels`, `list_custom_fields`, `list_forms`, `list_goals`, `list_guests`, `list_inboxes`, `list_meetings`, `list_notifications`, `list_projects`, `list_tasks`, `list_templates`, `list_threads`, `log_time`, `message_to_task`, `next_task`, `post_message`, `read_channel`, `read_chat_thread`, `read_doc`, `read_thread`, `reply`, `schedule_meeting`, `search`, `search_contacts`, `search_docs`, `send_email`, `set_project_health`, `set_task_blocked_by`, `set_task_fields`, `set_task_repeat`, `start_timer`, `stop_timer`, `update_key_result`, `update_task`, `upsert_contact`, `use_template`, `wait_for_email`.

The tool list is in `src/server/routes/mcp-server.ts`. Agents act within their key's scope, and sends
by agents can require a person's approval.

## Outgoing webhooks

Endpoints are added in Settings, Developers (or `/api/developer`). Deliveries follow
[Standard Webhooks](https://www.standardwebhooks.com): headers `webhook-id`, `webhook-timestamp` and
`webhook-signature`, signed with the endpoint's `whsec_` secret, so any Standard Webhooks library can
verify them and reject old timestamps. Failed deliveries retry with backoff for about nine hours, then
wait as dead letters you can replay. An endpoint that fails five deliveries in a row is switched off
and its owners are emailed.

Events (44): `message.received`, `message.sent`, `message.bounced`, `message.complained`, `domain.verified`, `domain.failed`, `approval.requested`, `approval.decided`, `agent.created`, `agent.deleted`, `task.created`, `task.updated`, `task.deleted`, `task.commented`, `task.file_added`, `task.recurred`, `project.created`, `project.updated`, `doc.created`, `doc.updated`, `contact.created`, `contact.updated`, `deal.created`, `deal.updated`, `time_entry.created`, `time_entry.updated`, `form.submitted`, `meeting.created`, `meeting.updated`, `custom_field.created`, `custom_field.updated`, `custom_field.deleted`, `guest.invited`, `guest.joined`, `guest.revoked`, `chat.channel.created`, `chat.message.created`, `chat.message.updated`, `chat.message.deleted`, `chat.mention`, `template.used`, `goal.created`, `goal.updated`, `goal.deleted`.

The list lives in `src/server/services/developer/webhooks.ts`.

## Incoming webhooks

- `POST /api/inbound/cloudflare`: mail from the inbound Email Worker, signed with an inbound key (Settings, Inbound; `/api/inbound-keys`).
- `POST /api/webhooks/resend`: delivery, bounce and complaint events, verified with the Resend signing secret.
- `POST /api/webhooks/stripe`: billing events, verified with the Stripe signature.
