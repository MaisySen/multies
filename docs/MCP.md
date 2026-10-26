# Multies MCP server

Multies runs a Model Context Protocol server, so any MCP client (a desktop chat app, a code editor,
a terminal agent or your own agent) can work in a Multies workspace: mail and agent inboxes, tasks,
projects, docs, contacts, chat, meetings and more.

Bring your own AI: connect any agent through MCP, free. Multies never pays for or resells AI model
calls. People who want the assistant inside webmail add their own model provider key in Settings,
General, AI; it is encrypted at rest.

- URL: `https://multies.si/api/v1/mcp` (your own deployment: `<origin>/api/v1/mcp`)
- Transport: Streamable HTTP, stateless. Built on the official MCP TypeScript SDK.
- Tools: 189 (listed below). An agent key sees the agent tools; `create_agent_inbox` and `set_mailbox_reply_to` are for workspace keys and people.

## Signing in

There are two ways in. Both keep every guardrail: agent approval rules, daily send caps and read only access.

### OAuth: add Multies by its URL (round 20)

Paste `https://multies.si/api/v1/mcp` into the app's "add connector" or "add MCP server" screen.
The app finds the sign in page on its own, you sign in to Multies, pick a workspace and choose
"Read and write" or "Read only", and you are done. No key to copy.

- The app works as you, with your role in that workspace. A member's connection can't run the
  workspace's mail, agents or integrations, the same as in the app.
- Sends still go out as an agent inbox (pass `agentId`), so approval rules and caps apply.
- See and disconnect connected apps in Settings, Developers, Connected AI apps. A disconnect takes
  effect on the app's next request. Admins see every connection in the workspace; members see their own.
- Standards: OAuth 2.1 authorisation code with PKCE (S256 only), dynamic client registration
  (RFC 7591), protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource`,
  authorisation server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`, token
  revocation (RFC 7009). Scopes: `mcp:read`, `mcp:write`.
- Tokens: access tokens last an hour and are signed, not stored. Refresh tokens last 90 days and
  rotate on every use. A code used twice ends the connection.
- An unauthenticated call to the MCP URL answers 401 with a `WWW-Authenticate` header that points
  at the metadata, which is how clients discover the sign in.
- OAuth tokens work on the MCP endpoint only. The REST API keeps using API keys.

### API keys

`Authorization: Bearer mm_live_...` from Settings, Developers. API keys keep working exactly as before.

- An **agent key** (made with an agent inbox) acts only as that agent: its inbox, the shared
  mailboxes it was given, and sends within its daily cap and approval rule.
- A **workspace key** sees every agent and mailbox and can create agent inboxes. Sends still go
  out as an agent (pass `agentId`), so guardrails always apply.
- A **read only** key (or a read only OAuth connection) can call the read tools only.

## Scopes and the full tool list

Every tool needs one API key scope (for example `tasks:read` for list_tasks, `mail:send` for reply). A key with per area scopes gets a tool error starting `insufficient_scope:` for a tool outside them; Full access and Read only keys work as before. The page https://multies.si/developers/mcp (Markdown: https://multies.si/developers/mcp.md) lists every tool with its scope, parameters and an example call, generated from the server.

## Show only the tools a key can use

A key with limited scopes can hide the tools it can't use, so an agent's tool list stays short and every tool it sees will work.

- Per key: turn on "Show only the tools this key can use" when you create or edit a key in Settings, Developers. It is on by default for new keys with picked areas, and off for Read only keys and for keys made before it existed. Full access keys always see every tool. Over the API: `showOnlyUsableTools: true` on `POST` or `PATCH /api/developer/keys`.
- Per connection: add `?tools=scoped` to the MCP URL (`https://multies.si/api/v1/mcp?tools=scoped`), or send the header `X-Multies-Tools: scoped`. `?tools=all` shows every tool even when the key hides them. This works for API keys and for OAuth sign-ins: a read only sign-in then sees only read tools.
- A hidden tool is only hidden from `tools/list`. Calling it by name still gets the same `insufficient_scope` (or `read_only_key`) answer as before.
- To see a key's list without an MCP client: `GET https://multies.si/api/mcp-tools?view=key` with `Authorization: Bearer <key>`, or preview any scopes with `GET https://multies.si/api/mcp-tools?scope=mail:read+tasks:write`.

## Tools

### Mail and agent inboxes

| Tool | What it does |
| --- | --- |
| `list_inboxes` | List inboxes |
| `list_threads` | List threads (R31: `split` narrows to an Inbox tab) |
| `read_thread` | Read a thread |
| `search` | Search mail |
| `search_everything` | One search across mail, tasks (or a key like OPS-12), docs, chat, contacts and deals, grouped by type. Only what the key can open (read only) |
| `my_work` | What is waiting today: tasks due today and overdue, mentions, threads on my tasks, approvals waiting, today's meetings (read only) |
| `send_email` | Send an email |
| `reply` | Reply in a thread |
| `wait_for_email` | Wait for new email |
| `create_agent_inbox` | Create an agent inbox |
| `create_agent_member` | Add an AI agent member (no seat, mailbox optional); returns its first key, shown once. Full workspace key (R26) |
| `set_mailbox_reply_to` | Set a mailbox's default Reply-To, used when a send names none (R25, MB-61) |
| `snooze_thread` | Snooze a thread until a time (round 20, registered in src/server/routes/mcp-mail-schedule.ts) |
| `schedule_send` | Send an email later, as an agent; its approval rules apply when it goes |
| `list_scheduled` | List snoozed threads, scheduled sends and reminders |
| `cancel_scheduled` | Cancel a scheduled send or reminder, or unsnooze |

### Tasks and projects

| Tool | What it does |
| --- | --- |
| `list_tasks` | List tasks |
| `get_task` | Get a task |
| `next_task` | Next task for this agent |
| `create_task` | Create a task (with `type`, `points` and `sprintId` when wanted) |
| `update_task` | Update a task, including its type, estimate (`points`) and sprint (`sprintId`, null for the backlog) |
| `bulk_update_tasks` | Change up to 500 tasks at once: status, assignee, priority, dates, labels, type (task, story, bug) or project (round 21, registered in src/server/routes/mcp-r21-table.ts) |
| `comment_on_task` | Comment on a task |
| `list_projects` | List projects |
| `set_task_blocked_by` | Set a task as blocked by another; `lagDays` sets a wait after the blocker ends, negative for a lead (R38) |
| `check_task_schedule` | Date clashes along dependencies: tasks that start before a task they wait on ends, each with `lagDays`, `overlapDays` and `fix { taskId, start, due }`; with `projectId` also the project's schedule rules (R37, R38, `tasks:read`) |
| `reschedule_task` | Move a task (`start`, `due`) and shift the tasks that wait on it by just enough, keeping their length; `strict: true` moves them all by the same days (R38); `moveDependents: false` moves only this one, `preview: true` changes nothing (R37, `tasks:write`) |
| `set_project_schedule` | A project's rules for dependency dates: `workingDaysOnly` (with `daysOff`) and `strict` moves (R38, `tasks:write`) |
| `set_task_repeat` | Make a task repeat |
| `list_custom_fields` | List a project's custom fields |
| `create_custom_field` | Add a custom field to a project (any type; formula and rollup take a config) |
| `set_task_fields` | Set custom field values on a task |
| `find_tasks_by_field` | Find tasks by a custom field |
| `get_portfolio` | Portfolio of all projects |
| `set_project_health` | Set a project's health |
| `update_project` | Rename a project or change its key (a key used by another project, any case, is refused with key_taken; R33) |
| `list_guests` | List a project's guests |
| `invite_guest` | Invite a guest to a project |
| `list_epics` | List epics with progress: done of total, percent, points when tasks carry points (round 21, registered in src/server/routes/mcp-r21-types.ts) |
| `get_epic` | One epic with its items and progress (round 21) |
| `add_to_epic` | Put tasks, stories or bugs in an epic, or take them out with `remove: true` (round 21) |

Task types (round 21): `create_task`, `update_task` and `list_tasks` take `type`: `task` (the default),
`story`, `bug` or `epic`. An item whose parent is an epic is in that epic. An epic can't have a parent,
an item with a parent can't become an epic, and an epic that still has items keeps its type.

### Docs, contacts, forms and templates

| Tool | What it does |
| --- | --- |
| `search_docs` | Search docs |
| `read_doc` | Read a doc |
| `create_doc` | Create a doc |
| `append_to_doc` | Add to a doc |
| `docs_append` | Append markdown to a doc (R28): keeps what is there; `ifVersion` fails with `version_conflict` if the doc changed |
| `docs_add_block` | Add a table (`rows`, `header`), an image (`url` https, `alt`) or a callout (`text`, `variant` info, success, warning, danger) to the end of a doc (R32); `ifVersion` as for `docs_append` |
| `search_contacts` | Search contacts |
| `contact_timeline` | Contact timeline |
| `upsert_contact` | Save a contact |
| `list_forms` | List forms |
| `create_form` | Create a public form |
| `form_logic_set` | Set a question's "show if" logic, answer rules and required switch (R31); conditions use earlier questions only |
| `form_results` | A form's results (R31): total, a summary per question and the newest responses |
| `list_templates` | List project, task and doc templates |
| `use_template` | Make a project, task or doc from a template |
| `create_template` | Create a template from scratch |

### Time, reports, goals and people

| Tool | What it does |
| --- | --- |
| `start_timer` | Start a timer on a task |
| `stop_timer` | Stop the running timer |
| `log_time` | Log time by hand |
| `get_timesheet` | Timesheet |
| `get_report` | Workspace report |
| `list_goals` | Goals and key results |
| `create_goal` | Create a goal |
| `update_key_result` | Record progress on a key result |
| `list_people` | List people and agents |
| `list_agent_members` | AI agent members with avatar, paused state, linked inbox and key count (R26) |
| `update_agent_member` | Edit an agent member or pause it (its keys are refused until resumed). Full workspace key (R26) |
| `list_notifications` | Your notifications |
| `notification_list` | Your notifications by view: inbox, later (snoozed) or done, with viewCounts (R31) |
| `get_counts` | Every unread count in one read: mail { inbox, important, other }, chat { unread, mentions }, notifications { unread }, triage, tasks { dueToday, overdue }; tz for due today (R34) |
| `create_report` | Report a chat message (messageId) or a person (userId) to the Multies team: reason spam, harassment, hate, sexual, violence, self_harm or other; note up to 500. 20 a day (R35) |
| `list_blocks` | The people you blocked (R35) |
| `add_block` | Block a person: their chat messages are hidden from you and they can't message you; they aren't told (R35) |
| `remove_block` | Unblock a person (R35) |
| `notification_done` | Mark one notification (id) or up to 500 (ids) done (R31) |
| `notification_undone` | Move a notification back to the Inbox (R31) |
| `notification_snooze` | Snooze a notification until a time or later_today, tomorrow, next_week (R31) |
| `catchup_get` | What did I miss: a digest of a channel, task or doc since your last visit (R31) |

### Chat

| Tool | What it does |
| --- | --- |
| `list_channels` | List chat channels |
| `read_channel` | Read a chat channel |
| `read_chat_thread` | Read a chat thread |
| `post_message` | Post in a chat channel |
| `pin_message` | Pin or unpin a chat message |
| `message_to_task` | Turn a chat message into a task |
| `react_to_chat_message` | Add or take off an emoji reaction on a chat message (write keys) |

### Triage

New work from mail rules, public forms, incoming hooks or the API can wait in Triage before it becomes a task. Read only keys can list; the rest need a write key.

| Tool | What it does |
| --- | --- |
| `list_triage` | List items waiting in Triage, newest first, with the count |
| `triage_accept` | Accept an item as a normal task, optionally setting project, assignee, status, priority and due |
| `triage_decline` | Decline and delete an item, with an optional reason and an opt in polite reply to the sender |
| `triage_merge` | Merge an item into an existing task (notes as a comment, mail thread moves over) |
| `create_triage_item` | Put new work in Triage instead of making a task straight away |

### Shared inbox: owners, done and reply times (round 22)

Give a mail thread an owner, mark it done, list threads by view and read reply times. Read only keys can list and read stats; assigning and status need a write key.

| Tool | What it does |
| --- | --- |
| `assign_thread` | Assign a thread to a member who can open its mailbox (they get a notification), or pass userId null to unassign |
| `unassign_thread` | Take the owner off a thread |
| `set_thread_status` | Mark a thread done, waiting (we replied, the customer has the ball) or reopen it; new inbound mail reopens a waiting or done thread |
| `list_threads_by_view` | Threads by view: open, mine, unassigned, assigned (to a person or anyone), waiting, done or all, each with its assignee, status and lastInboundAt |
| `get_reply_stats` | Median and average first response and resolution times per mailbox or per person, calendar hours, at most 90 days and 2,000 threads |

### Meetings and scheduling

| Tool | What it does |
| --- | --- |
| `list_meetings` | List meetings |
| `schedule_meeting` | Schedule a video meeting |
| `list_bookings` | List meeting bookings |

### Integrations

| Tool | What it does |
| --- | --- |
| `list_integrations` | List integrations |
| `create_incoming_hook` | Create an incoming webhook |

Agents read only the threads they can open, and anything an agent sends outside Multies still goes
through its approval rule. Sends and approvals are in the audit log. Thread reads by an agent are in
the audit log too, rolled up to one entry per agent, thread and hour so a polling agent doesn't fill
the log (or the database's daily write budget).

### Sprints (round 21)

Registered in src/server/routes/mcp-r21-sprints.ts. Read only keys can list and read; the rest need a key that can write.

| Tool | What it does |
| --- | --- |
| `list_sprints` | A project's sprints with task and point counts, and its estimate unit |
| `get_sprint` | One sprint with its tasks and burndown (remaining per day and the ideal line) |
| `create_sprint` | Plan a sprint (defaults: Sprint N, the day after the last one ends, two weeks) |
| `start_sprint` | Start a planned sprint; one active sprint per project |
| `complete_sprint` | Complete the active sprint; unfinished tasks carry over to the next sprint or the backlog |
| `add_to_sprint` | Move up to 500 tasks into a sprint |
| `remove_from_sprint` | Move tasks back to the backlog |

### Thread notes (round 22)

Registered in src/server/routes/mcp-r22-comments.ts. Internal notes on a mail thread: team only, never part of `read_thread` or any mail that is sent. Read only keys can list; adding and deleting need a key that can write. Agent keys write as their agent.

| Tool | What it does |
| --- | --- |
| `list_thread_comments` | A thread's internal notes, oldest first, and the teammates who can be mentioned |
| `add_thread_comment` | Add a note; "@Full Name" in the text or mentions (user ids or emails) notifies teammates who can open the thread |
| `delete_thread_comment` | Delete a note (its author, or a workspace key) |
### Thread presence and shared drafts (round 22)

Registered in src/server/routes/mcp-r22-presence.ts. Read only keys can read; `take_over_draft` needs a key that can write and is refused for agent keys. A thread the key can't open answers not found.

| Tool | What it does |
| --- | --- |
| `get_thread_presence` | Who has a shared inbox thread open right now, and whether each is viewing or replying (entries expire 40 seconds after the last heartbeat) |
| `list_thread_drafts` | Draft replies saved in a thread: author, last saved, preview |
| `take_over_draft` | Become the owner of a teammate's draft reply; they are notified once and their next save of it is refused |

### Saved replies (round 22)

Registered in src/server/routes/mcp-r22-snippets.ts. Read only keys and tokens can list and render; `create_snippet` needs a key that can write. Agent keys see shared replies and their own and save as their agent. Variables: `{{first_name}}`, `{{name}}`, `{{email}}` (the recipient), `{{my_name}}`, `{{my_first_name}}`, `{{company}}`, `{{mailbox}}`, `{{date}}`; unknown ones stay as typed.

| Tool | What it does |
| --- | --- |
| `list_snippets` | The workspace's saved replies (shared ones plus your private ones), by name, with shortcut, subject and body; `q` filters |
| `render_snippet` | A saved reply's subject and body filled in for a thread (its newest sender; the thread must be one the key can open) or a `to` address. Sends nothing |
| `create_snippet` | Save a reply: name, body, optional subject, shortcut and `shared` (default true) |

### Bulk mail actions (R32)

Registered in src/server/routes/mcp-r32-mail.ts. Same service as the web app's selection bar and `POST /v1/mail/messages/bulk`. Read only keys get 403.

| Tool | What it does |
| --- | --- |
| `mail_bulk_action` | One action on up to 500 message ids: read, unread, star, unstar, archive, inbox, spam, trash, delete (forever), move (`to`), snooze (`until` or `preset`) or unsnooze. Inverses undo: inbox undoes archive or trash, unread undoes read, unsnooze undoes snooze |
| `mail_bulk_job` | Every message in a folder or search (up to 20,000) as one job: read, unread, star, unstar, archive, inbox, spam, trash (delete, undoable), snooze (`snooze_until` or `snooze_preset`; Undo clears it) or move (`to`, a synced folder; R35: Undo moves each message back to the folder it came from). Give your own `job_id`; call again with it to continue until `done` (900 per call). Mail that arrived after `max_received_at` is left alone. `undo: true` puts back exactly what the job changed |

### Live chat typing (R32)

Registered in src/server/routes/mcp-r32-live.ts.

| Tool | What it does |
| --- | --- |
| `chat_typing` | Shows "<name> is typing" to people who have the channel open, for about 6 seconds. Call it every 3 seconds or so while writing. Nothing is stored; `sent` is false when called faster than every 3 seconds |

### Task triage queue (R32)

Registered in src/server/routes/mcp-r32-triage.ts. Same service as the Triage page and the v1 triage routes.

| Tool | What it does |
| --- | --- |
| `task_triage_list` | Tasks waiting in Triage (from mail, forms, the API and agents), newest first, with the count. `view`: pending (default) or snoozed |
| `task_triage_action` | accept (optional status, project, assignee), decline (optional reason), snooze (`until`, at most a year out), unsnooze, duplicate (`duplicateOf`) or restore (undo an accept, decline or duplicate from the last day). `comment`: a one line note written with an accept or decline (the answer carries `comment.id`); `commentId` with restore removes it in the same undo |

### Inbox splits and read status (R31)

Registered in src/server/routes/mcp-r31-mail.ts. Splits are a person's own: personal keys and OAuth sign ins (agent keys get 403). Important is mail from people (someone the mailbox wrote to, a teammate, a saved contact, or a reply in a thread the mailbox wrote in, and since R32 a first time sender whose message passed SPF and DKIM) that is not bulk; Other is the rest. `list_threads` takes `split` (`important`, `other` or a split id).

| Tool | What it does |
| --- | --- |
| `mail_split_list` | Your Inbox tabs (Important, Other, then your splits) with unread counts, plus each split's rules |
| `mail_split_create` | Add a split: name, rules (fromContains, fromDomain, to, subjectContains, calendarInvite, fromTeammate), match all or any, leavesImportant (default true) |
| `mail_split_update` | Rename, reorder (position) or change a split's rules |
| `mail_split_delete` | Remove a split; its mail goes back to Important or Other |
| `mail_read_status` | Whether a sent message was opened: tracked, opens, firstOpenAt, lastOpenAt (tracked is false when the sender had read status off) |

### Meeting notes (round 23)

Registered in src/server/routes/mcp-r23-notes.ts. Read only keys and tokens can read the notes; `create_action_items` needs a key that can write. Agent keys create tasks as their agent.

| Tool | What it does |
| --- | --- |
| `get_meeting_notes` | A meeting's title, time and attendees with its notes doc as plain structure: agenda lines, notes lines, and action items (title, assignee, due date, and the task once made). `doc` is null before anyone took notes; `summary` is null unless a recording summary exists |
| `meeting_lobby_list` | The meeting's waiting room: guests from the guest link waiting to be let in (`id`, `name`, `askedAt`), oldest first, and `guestsWait` (R32) |
| `meeting_lobby_decide` | Admit or deny one waiting guest (`lobbyId`) or everyone waiting (`all: true`); `decision` is `admit` or `deny`. Audited (R32) |
| `meeting_summary_so_far` | For a live call or meeting: who is in it and since when, minutes elapsed, the notes doc's headings and to-dos, and decisions said in the call's chat. A deterministic digest labelled "So far" (no model call); `transcript` is always null (R31) |
| `create_action_items` | With no `items`: every unchecked action item in the notes that is not a task yet becomes a task. With `items` ({ title, assignee?, due? }): each is added to the notes, then made a task. Items already made are skipped, so a second call creates nothing |
### Call recordings and transcripts (round 23)

Registered in src/server/routes/mcp-r23-recordings.ts. Read only: read only keys and tokens can call it. Calls are recorded by a person in the meeting room and transcribed with the workspace's own speech to text key; Multies keeps the text, not the audio.

| Tool | What it does |
| --- | --- |
| `get_meeting_transcript` | A meeting's recordings, newest first: status (recording, processing, done or failed), who recorded, duration, the summary, action items `[{ text, assignee, due }]` and the transcript (capped at 200 KB; `truncated` says when it was cut) |
### Calendar (round 23)

Registered in src/server/routes/mcp-r23-calendar.ts. Read only; nothing is written.

| Tool | What it does |
| --- | --- |
| `list_calendar_events` | Meetings (weekly series expanded) and task due dates between `from` and `to` (at most 100 days). Signed in as a person (OAuth): your meetings, your tasks' due dates and your other calendars (read only, `kind: external`). With a key: every meeting and due date in the workspace |

## Desktop chat apps

In the app's connector settings, choose "add custom connector" (some apps call it "add MCP server"),
name it Multies and paste `https://multies.si/api/v1/mcp`. The app opens the Multies sign in page;
allow it and the tools appear. Apps that register themselves (dynamic client registration) need
nothing else.

## Terminal agents

Most terminal agents add a remote server with one command or one entry in their settings file. Give
it the name `multies`, the transport `http` and the URL `https://multies.si/api/v1/mcp`. The agent
signs in with OAuth the first time it uses a Multies tool. To use an API key instead, add the header
`Authorization: Bearer mm_live_YOUR_KEY`.

## Code editors

Editors that read an `mcp.json` settings file (per user or per project) take this entry. With only
the URL, the editor signs in with OAuth:

```json
{
  "mcpServers": {
    "multies": { "url": "https://multies.si/api/v1/mcp" }
  }
}
```

Or with a key: add `"headers": { "Authorization": "Bearer mm_live_YOUR_KEY" }`.

## Your own agent (model APIs with a remote MCP tool)

Model APIs that support remote MCP servers take the URL and a header. The shape is usually:

```json
{
  "type": "mcp",
  "server_label": "multies",
  "server_url": "https://multies.si/api/v1/mcp",
  "headers": { "Authorization": "Bearer mm_live_YOUR_AGENT_KEY" }
}
```

Any approval prompt there belongs to the model API. Multies' own approval queue still decides
whether a send goes out.

## Older clients

Clients without OAuth support can use an API key header, or the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "multies": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://multies.si/api/v1/mcp", "--header", "Authorization:${MULTIES_AUTH}"],
      "env": { "MULTIES_AUTH": "Bearer mm_live_YOUR_KEY" }
    }
  }
}
```

## Testing it

```sh
npx @modelcontextprotocol/inspector
```

Choose Streamable HTTP and paste the URL. The inspector can run the OAuth sign in, or you can add the
`Authorization` header with a key.

### Calls in chat (round 23)

Registered in src/server/routes/mcp-r23-calls.ts. Read only. Agents can't start calls (people press Call in chat); they can schedule meetings with `create_meeting`. Keys can't open DMs or private channels, so their calls answer not found.

| Tool | What it does |
| --- | --- |
| `get_call_status` | Live status of calls: `channelId` for the calls started in a channel in the last 6 hours (live, waiting or ended, who is in each), or `meetingId` for one meeting; `enabled` is false when video is off |
| `get_call_minutes` | The workspace's call participant-minutes this month against its cap (`cap` null means no limit; free workspaces get 1,000; new calls are refused once used up, a running call is never cut off) |

### Workload (R24.2)

Registered in src/server/routes/mcp-r24-workload.ts. `get_workload` is read only, so read only keys and tokens can call it, and it writes nothing. `set_weekly_capacity` writes one row and is refused for read only keys.

| Tool | What it does |
| --- | --- |
| `get_workload` | Open tasks and estimates per person (plus Unassigned) per week, Monday first, in points or hours, with a capacity flag (default 20 points or 40 hours a person a week, or pass `capacity`); `overloaded` lists each person and week over capacity, so "who is overloaded next week" is one call with `from` set to next Monday and `weeks` 1; `overdue` holds open tasks due before the range; `includeTasks` adds each cell's tasks. Each person carries `capacity` and `capacitySource` (stored, default or request) |
| `set_weekly_capacity` | Stores one person's weekly capacity (`person` member:<id> or agent:<id>, `points` and or `hours`; null clears back to the default, a value left out stays). Owners and admins set anyone's, a member their own; `get_workload` then flags over capacity against it |

### Automation recipes (R24.4)

Registered in src/server/routes/mcp-r24-recipes.ts. Listing is read only; turning a recipe on needs a full workspace key (read only keys and tokens and agent keys are refused, like turning on a rule in the app, which is for admins).

| Tool | What it does |
| --- | --- |
| `list_automation_recipes` | Ready made automation rules by category (Tasks, Mail, Chat, Meetings, Sprints): key, name, description, the rules each makes, the blanks to fill (channel, project, member, members or text) and whether it is on here; `category` narrows the list |
| `enable_automation_recipe` | Turns a recipe on with its `blanks` (for example `{ channelId }`, or `{ projectId, memberIds }`): makes its rules as normal automations, or switches them back on; channels must be public channels of this workspace and every id must be this workspace's |

### Docs tree and backlinks (R24.5)

Registered in src/server/routes/mcp-r24-docs.ts. `get_doc_tree` and `get_backlinks` are reads, so read only keys and tokens can call them; `move_doc` needs a write key and writes one row.

| Tool | What it does |
| --- | --- |
| `get_doc_tree` | The workspace's docs as a tree of pages and sub pages (id, title, parentId, position, depth, children), at most 6 levels deep; `flat: true` gives one line per page with its depth |
| `move_doc` | Puts a doc under another page (`parentId`, or null for the top level) and, optionally, right before or after a sibling (`beforeId` or `afterId`); with neither it goes last. A page can't go under itself or its own sub pages |
| `get_backlinks` | The docs whose body links to a doc or a task (`type` doc or task, `id` an id or a task ref like OPS-12), newest first, each with a short snippet of the text around the link |

### Page history (R39)

Registered in src/server/routes/mcp-r39-doc-versions.ts. `list_doc_versions` and `read_doc_version` are reads (`docs:read`); `save_doc_version` and `restore_doc_version` need `docs:write`. A version is kept when a new editing session starts (10 minutes after the last save, or someone else edits), when someone saves one, and before every restore; the newest 50 unnamed versions per doc are kept, named ones always.

| Tool | What it does |
| --- | --- |
| `list_doc_versions` | A doc's saved versions, newest first (id, docVersion, title, name, reason edit or restore, words, author, savedAt), and the page now (version, words, editedBy) |
| `read_doc_version` | One version's title and text, and `sinceThen { added, removed, titleChanged }` against the page now; `diff: true` adds the line diff, `content: true` the Tiptap JSON |
| `save_doc_version` | Keeps the page as it is now under a `name` (default "Version N"), for example before a big rewrite; never pruned |
| `restore_doc_version` | Puts a doc back to a version; the page as it is now is saved first, so the restore can be undone. `ifVersion` fails with version_conflict if the doc changed since |

### Dashboards (R24.3)

Registered in src/server/routes/mcp-r24-dashboards.ts. `list_dashboards` and `get_dashboard_data` read, so read only keys and tokens can call them and they write nothing; `create_dashboard` and `add_dashboard_widget` need a full key or token. A private dashboard is seen only by its owner (a key acts for the person who made it); a dashboard made by an agent key is shared.

| Tool | What it does |
| --- | --- |
| `list_dashboards` | Dashboards you can open (shared ones and your own) with their widget counts |
| `get_dashboard_data` | Every widget's numbers for one dashboard in one call, computed now: counts, tasks grouped by status, person, priority, project, sprint, type or label, due this week and overdue, completed per week (8 weeks), the active sprint's burndown, goal progress, reply times, mail per day (14 days) and workload per person, and the R38 types: calculations with a goal and the change against the previous range, battery, pivot tables, created vs completed, task lists, time tracked and notes; a widget whose saved filter was removed carries an `error` |
| `create_dashboard` | Make a dashboard with up to 24 widgets, or `starter: "team"` for Team overview (by status, by person, due this week, completed per week); private unless `shared` |
| `add_dashboard_widget` | Add one widget at the end: `type`, `groupBy`, `chart`, `size`, and a source (`savedViewId`, or `projectId` with `filters`, or `mailboxId`). R38 types take `range`, `metric`, `op`, `goal` (calculation), `columnBy` (pivot), `sort` (task_list) and `text` (note) |

### Formula and rollup fields (R24.1)

Registered in src/server/routes/mcp-r24-formulas.ts. `get_computed_fields` is a read, so read only keys and tokens can call it; the two create tools need a write key. Values are computed when read and nothing is stored per task.

| Tool | What it does |
| --- | --- |
| `get_computed_fields` | With `taskId` (an id or a reference like OPS-12): each formula and rollup field on the task's project with its settings and value; with `projectId`: the project level rollups over its tasks. A value that can't be worked out is `#ERROR` with a plain `error` message |
| `create_formula_field` | Adds a read only formula field, like `{Budget} * 1.1` or `if({points} > 5, "big", "small")`; field names go in braces, built ins are points, due, start, created, completed, status, priority, title and assignee; functions: if, round, floor, ceil, abs, min, max, sum, concat, len, upper, lower, days_between, today, now, date_add, is_empty, coalesce; up to 500 characters; loops between formulas are refused |
| `create_rollup_field` | Adds a rollup: `source` subtasks, epic_children (an epic's items and their subtasks) or project (one value over the project, shown in its header); `fn` sum, count, count_done, average, min, max or percent_done; `field` points or a number, currency or formula field (not needed for the count functions) |

### Saved views (DF-20)

Registered in src/server/routes/mcp-views.ts. `list_saved_views` is a read, so read only keys and tokens can call it; the other two need a full key or token. The same views are on REST as GET /api/v1/views, POST /api/v1/views and DELETE /api/v1/views/{id}.

| Tool | What it does |
| --- | --- |
| `list_saved_views` | Saved views you can open (shared ones and your own), optionally for one project: id, name, view type and filters |
| `create_saved_view` | Save a view of tasks: `view` board, list, calendar, timeline, sprints or workload, an optional `projectId`, and `filters` (assignee, status, priority, label, type, due, q); shared unless `shared` is false. One row written |
| `delete_saved_view` | Remove a saved view by id; tasks are not touched |

### Board swimlanes and column limits (R34, MB-186)

Registered in src/server/routes/mcp-r34-board.ts. `get_board_settings` is a read, so read only keys and tokens can call it; `set_board_settings` needs a full key or token. The same settings are on REST as GET and PUT /api/v1/projects/{id}/board.

| Tool | What it does |
| --- | --- |
| `get_board_settings` | A project board's `swimlanes` (none, assignee, epic, priority or project) and `limits` per column: `{ [statusId]: { max, min } }` |
| `set_board_settings` | Change `swimlanes`, replace the whole `limits` map, or set one column with `column: { id, max, min }` (null clears a side). Whole numbers 1 to 999, min not above max. Cards can still go into a full column; the board shows it as over the limit. One row written |

### Branded auth emails (R25, MB-60)

Registered in src/server/routes/mcp-r25-authmail.ts. Needs a full workspace key or token (read only keys and tokens get `read_only_key`; agent and agent member keys are refused); another workspace's hook id is not found. The same change is on REST as `PATCH /api/v1/auth-email-hooks/{id}`, and `POST /api/v1/auth-email-hooks/{id}/preview?type=signup` shows the result without sending.

| Tool | What it does |
| --- | --- |
| `update_auth_email_hook` | Set how a Supabase auth email hook's emails look: `branding` with `logoUrl` (https), `brandColor` (#RRGGBB), `replyTo`, `footer`, per type `templates` (signup, invite, magiclink, recovery, email_change, email, reauthentication: `subject`, `intro`, `buttonLabel`) and `secondaryLanguage` (`lang`, the same per type `templates`, `note`), shown under the main text. Plain text only, placeholders `{appName}`, `{code}`, `{email}`. Keys left out stay, null clears one, `branding: null` goes back to the default email. Also `appName` and `from`. One row written |

### Sign-up emails settings (R28)

Registered in src/server/routes/mcp-r28-auth-email-settings.ts, over the same service as Settings, Sign-up emails and `/api/v1/auth-email-settings` (R27), with the same rules: owners, admins and full workspace keys or tokens only (agent keys and agent member keys get `forbidden`), and writes need a full key (read only keys and tokens can get and preview; the rest answer `read_only_key`). The signing secret is in the one answer that made it, never in a later read, the audit log or the logs.

| Tool | What it does |
| --- | --- |
| `get_auth_email_settings` | The settings (`enabled`, `senderName`, `from`, `appName`, `supabaseUrl`, `branding`, `endpointUrl`, `secret: { set, masked }`, `testSendsLeft`) and the sender mailboxes on verified domains. `settings` is null before the first save. Writes nothing |
| `update_auth_email_settings` | Create (`from` and `supabaseUrl` needed the first time; that answer carries `secret` once) or change any of `enabled`, `senderName`, `from`, `appName`, `supabaseUrl`, `branding` (merged, null clears), with the API's validation. Audited; a change that changes nothing writes nothing |
| `regenerate_auth_email_secret` | A new signing secret, returned once as `secret`; the old one stops working at once. Audited without the value |
| `preview_auth_email` | The email one `type` would send (signup by default), with a sample link and the code 123456, and unsaved `appName` or `branding` merged in. Nothing sent or stored |
| `send_auth_email_test` | Sends one `type`, as saved, to your own address (a key's creator for a workspace key) with "Test:" before the subject. At most 5 an hour a workspace, shared with the page and REST (`rate_limited` after). Audited |

### Comments and chat messages: read back, edit, delete (R26, MB-77)

Registered in src/server/routes/mcp-r26-comments.ts. Read only keys can list; edits and deletes need a full key. Only the author edits (an agent key edits what its agent wrote); the author, an owner or an admin deletes. The same calls are on REST as `GET /api/v1/tasks/{id}/comments`, `GET|PATCH|DELETE /api/v1/comments/{id}` and `GET|PATCH|DELETE /api/v1/chat/messages/{id}`.

| Tool | What it does |
| --- | --- |
| `list_task_comments` | Every comment on a task (id or reference), oldest first, with author and `editedAt` |
| `edit_task_comment` | Replace the text of a comment you wrote; it then shows as edited. One row written |
| `delete_task_comment` | Delete a task comment (author, owner or admin). One row written |
| `edit_chat_message` | Replace the text of a chat message you posted, same markup as `post_message`; it then shows as edited. One row written |
| `delete_chat_message` | Delete a chat message (author, owner or admin); replies keep their place |
### Share links (R26, MB-87)

Registered in src/server/routes/mcp-r26-share.ts. Making or revoking a link needs a full workspace key or token (read only keys and tokens get `read_only_key`); agent keys are refused; another workspace's doc, project or link is not found. The same is on REST as `/api/v1/share-links`.

| Tool | What it does |
| --- | --- |
| `create_share_link` | Make a read only link anyone can open without signing in: `kind` `doc` (the doc, read only) or `project_board` (columns, card titles, assignee initials, due dates and labels; never notes, comments, files or custom fields). `expiresInDays` 7 or 30 (left out: never), `showWorkspaceName` (default true). Returns the url once. One row written |
| `list_share_links` | Active links (not revoked, not expired), newest first; pass `kind` and `targetId` for one doc or project |
| `revoke_share_link` | Stop a link at once by id; its page then says it is no longer active |

### Checklists inside tasks (R26, MB-85)

| Tool | What it does |
|---|---|
| `list_checklist` | A task's checklist items in order, with total and done counts (read only keys can call it) |
| `add_checklist_items` | Add one or more items to the end of a task's checklist (title, done, assignee, due); up to 200 per task. One row per item |
| `update_checklist_item` | Tick, untick, rename, or change an item's assignee or due date. One row; a patch that changes nothing writes nothing |
| `reorder_checklist` | Put a task's checklist in a new order (every item id once); only items that move are written |
| `delete_checklist_item` | Remove an item from its task's checklist |
| `checklist_item_to_subtask` | Turn an item into a subtask of its task (same title, assignee and due date) and remove the item |

### Agent runs (R27, DF-3 slice 2)

| Tool | What it does |
|---|---|
| `start_task_run` | With an agent member's key: start your run on a task you are assigned to or mentioned on, or claim a run queued for you (`taskId`, `moveToDoing?`, `note?`). With a person's or workspace key: queue a run for `agentUserId`. One queued or running run per agent and task |
| `add_run_step` | Log one step in your run: `kind` note, tool, comment or status_change, `text` up to 1,000 characters; 200 steps per run. One row write |
| `finish_task_run` | Finish with `status` succeeded, failed or cancelled and a `result`; `moveTo` done or review moves the task, `comment` posts the result as your comment. A person's or workspace key can only cancel |
| `list_task_runs` | With `taskId`: that task's runs with steps and results. Without: runs across the workspace (no steps), by `agentUserId` and `status` (read only keys can call it) |
| `agent_run_cancel` | R30: cancel a queued or running run (`runId`, `reason?` up to 500 characters, kept as the run's result). A person's key, a full workspace key, or the run's own agent key; another agent's key gets `not_this_agent`. A finished run is refused (`run_finished`); an already cancelled run comes back unchanged with no second audit entry. Writes `agent_run.cancelled`. Same rules as `POST /api/v1/runs/{id}/cancel` |

### Agent run triggers (R28, DF-3 slice 3)

Admin and full workspace keys only; an agent member's key gets 403.

| Tool | What it does |
|---|---|
| `list_agent_triggers` | The workspace's triggers (at most 20): kind, agent, task or project, next run, last fired, fire count. `agentUserId?` filters |
| `create_agent_trigger` | Queue runs for an agent member on a schedule (`everyHours` 1 or more, or `dailyAt` HH:MM with `days?` in the workspace zone) or from a signed webhook (the answer holds the URL and the secret, shown once). Target: `taskId`, or `projectId` plus `titleTemplate` ({trigger}, {date}, {datetime}) for a new task each time; `instructions` travel with each run |
| `delete_agent_trigger` | Delete a trigger (`triggerId`); its webhook stops at once and runs already queued stay |
| `agent_trigger_history` | R30: a trigger's recent fires and refusals, newest first (`triggerId`, `limit?` 1 to 50, default 20). Each entry: `at`, `outcome` (fired or refused), `source` (schedule, webhook or manual), `reason` and `message` on a refusal, `run { id, taskId, taskRef }`, `actor`, `sampled`. The same rows as `GET /api/v1/agent-triggers/{id}/history`; another workspace's trigger is not found |

### Task queries (R26, MB-86)

| Tool | What it does |
|---|---|
| `search_tasks` | Find tasks with the task query language, for example `assignee:me status:doing label:bug due:<7d sprint:current -label:wontfix "login page"`. Keys: assignee, status, label, priority, due, sprint, type, project, created, updated, points, has, is, title. A bad query returns an error with the character where it went wrong. R34: OR, AND, NOT, brackets and history (`status WAS doing`, `status CHANGED FROM todo TO doing AFTER -7d BY me`) |

### Task watchers and duplicate (R27)

| Tool | What it does |
|---|---|
| `list_task_watchers` | Who watches a task and whether you do (read only keys can call it). Watchers hear about new comments and status changes |
| `watch_task` | Start watching a task: you, or the member named by `userId` (an agent key must name one). One row; twice changes nothing |
| `unwatch_task` | Stop watching a task: you, or the member named by `userId` |
| `duplicate_task` | Copy a task (new number, first to-do status) with notes, assignee, priority, dates, labels, type, estimate, sprint, repeat rule and custom fields; by default also its subtasks (3 levels, 200 tasks) and checklist (unticked). Options: `title`, `projectId`, `subtasks`, `checklist`, `assignee`, `dependencies` |

`search_tasks` also takes `is:watching` for the tasks you watch.
