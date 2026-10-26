# Multies MCP server

Multies runs a Model Context Protocol server, so Claude, ChatGPT, Cursor and any MCP client can work
in a Multies workspace: mail and agent inboxes, tasks, projects, docs, contacts, chat, meetings and more.

Bring your own AI: connect Claude, ChatGPT or any agent through MCP, free. Multies never pays for
or resells AI model calls. People who want the assistant inside webmail add their own OpenAI,
Anthropic, OpenRouter or Groq key in Settings, General, AI; it is encrypted at rest.

- URL: `https://multies.si/api/v1/mcp` (your own deployment: `<origin>/api/v1/mcp`)
- Transport: Streamable HTTP, stateless. Built on the official MCP TypeScript SDK.
- Tools: 137 (listed below). An agent key sees the agent tools; `create_agent_inbox` and `set_mailbox_reply_to` are for workspace keys and people.

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

## Tools

### Mail and agent inboxes

| Tool | What it does |
| --- | --- |
| `list_inboxes` | List inboxes |
| `list_threads` | List threads |
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
| `set_task_blocked_by` | Set a task as blocked by another |
| `set_task_repeat` | Make a task repeat |
| `list_custom_fields` | List a project's custom fields |
| `create_custom_field` | Add a custom field to a project (any type; formula and rollup take a config) |
| `set_task_fields` | Set custom field values on a task |
| `find_tasks_by_field` | Find tasks by a custom field |
| `get_portfolio` | Portfolio of all projects |
| `set_project_health` | Set a project's health |
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
| `search_contacts` | Search contacts |
| `contact_timeline` | Contact timeline |
| `upsert_contact` | Save a contact |
| `list_forms` | List forms |
| `create_form` | Create a public form |
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

### Meeting notes (round 23)

Registered in src/server/routes/mcp-r23-notes.ts. Read only keys and tokens can read the notes; `create_action_items` needs a key that can write. Agent keys create tasks as their agent.

| Tool | What it does |
| --- | --- |
| `get_meeting_notes` | A meeting's title, time and attendees with its notes doc as plain structure: agenda lines, notes lines, and action items (title, assignee, due date, and the task once made). `doc` is null before anyone took notes; `summary` is null unless a recording summary exists |
| `create_action_items` | With no `items`: every unchecked action item in the notes that is not a task yet becomes a task. With `items` ({ title, assignee?, due? }): each is added to the notes, then made a task. Items already made are skipped, so a second call creates nothing |
### Call recordings and transcripts (round 23)

Registered in src/server/routes/mcp-r23-recordings.ts. Read only: read only keys and tokens can call it. Calls are recorded by a person in the meeting room and transcribed with the workspace's own OpenAI or Groq key; Multies keeps the text, not the audio.

| Tool | What it does |
| --- | --- |
| `get_meeting_transcript` | A meeting's recordings, newest first: status (recording, processing, done or failed), who recorded, duration, the summary, action items `[{ text, assignee, due }]` and the transcript (capped at 200 KB; `truncated` says when it was cut) |
### Calendar (round 23)

Registered in src/server/routes/mcp-r23-calendar.ts. Read only; nothing is written.

| Tool | What it does |
| --- | --- |
| `list_calendar_events` | Meetings (weekly series expanded) and task due dates between `from` and `to` (at most 100 days). Signed in as a person (OAuth): your meetings, your tasks' due dates and your other calendars (read only, `kind: external`). With a key: every meeting and due date in the workspace |

## Claude (claude.ai and Claude Desktop)

Settings, Connectors, Add custom connector. Name it Multies and paste `https://multies.si/api/v1/mcp`.
Claude opens the Multies sign in page; allow it and the tools appear.

## Claude Code

```sh
claude mcp add --transport http multies https://multies.si/api/v1/mcp
```

Claude Code signs in with OAuth the first time you use a Multies tool (`/mcp` shows the status). To use
an API key instead, add `--header "Authorization: Bearer mm_live_YOUR_KEY"`.

## ChatGPT

In ChatGPT's connector settings (developer mode), create a connector with the URL
`https://multies.si/api/v1/mcp` and OAuth authentication. ChatGPT registers itself and sends you to
the Multies sign in page.

With the OpenAI API (Responses API or the Agents SDK), use the remote MCP tool with an API key:

```js
const response = await openai.responses.create({
  model: "gpt-5",
  tools: [{
    type: "mcp",
    server_label: "multies",
    server_url: "https://multies.si/api/v1/mcp",
    headers: { Authorization: "Bearer mm_live_YOUR_AGENT_KEY" },
    require_approval: "never",
  }],
  input: "Check my agent inbox for a verification code from Acme and tell me what it is.",
});
```

`require_approval` there is OpenAI's own prompt. Multies' approval queue still decides whether a
send goes out.

## Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project). With only the URL, Cursor signs in with OAuth:

```json
{
  "mcpServers": {
    "multies": { "url": "https://multies.si/api/v1/mcp" }
  }
}
```

Or with a key: add `"headers": { "Authorization": "Bearer mm_live_YOUR_KEY" }`.

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

### Dashboards (R24.3)

Registered in src/server/routes/mcp-r24-dashboards.ts. `list_dashboards` and `get_dashboard_data` read, so read only keys and tokens can call them and they write nothing; `create_dashboard` and `add_dashboard_widget` need a full key or token. A private dashboard is seen only by its owner (a key acts for the person who made it); a dashboard made by an agent key is shared.

| Tool | What it does |
| --- | --- |
| `list_dashboards` | Dashboards you can open (shared ones and your own) with their widget counts |
| `get_dashboard_data` | Every widget's numbers for one dashboard in one call, computed now: counts, tasks grouped by status, person, priority, project, sprint, type or label, due this week and overdue, completed per week (8 weeks), the active sprint's burndown, goal progress, reply times, mail per day (14 days) and workload per person; a widget whose saved filter was removed carries an `error` |
| `create_dashboard` | Make a dashboard with up to 24 widgets, or `starter: "team"` for Team overview (by status, by person, due this week, completed per week); private unless `shared` |
| `add_dashboard_widget` | Add one widget at the end: `type`, `groupBy`, `chart`, `size`, and a source (`savedViewId`, or `projectId` with `filters`, or `mailboxId`) |

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

### Branded auth emails (R25, MB-60)

Registered in src/server/routes/mcp-r25-authmail.ts. Needs a full workspace key or token (read only keys and tokens get `read_only_key`; agent and agent member keys are refused); another workspace's hook id is not found. The same change is on REST as `PATCH /api/v1/auth-email-hooks/{id}`, and `POST /api/v1/auth-email-hooks/{id}/preview?type=signup` shows the result without sending.

| Tool | What it does |
| --- | --- |
| `update_auth_email_hook` | Set how a Supabase auth email hook's emails look: `branding` with `logoUrl` (https), `brandColor` (#RRGGBB), `replyTo`, `footer`, per type `templates` (signup, invite, magiclink, recovery, email_change, email, reauthentication: `subject`, `intro`, `buttonLabel`) and `secondaryLanguage` (`lang`, the same per type `templates`, `note`), shown under the main text. Plain text only, placeholders `{appName}`, `{code}`, `{email}`. Keys left out stay, null clears one, `branding: null` goes back to the default email. Also `appName` and `from`. One row written |

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

### Task queries (R26, MB-86)

| Tool | What it does |
|---|---|
| `search_tasks` | Find tasks with the task query language, for example `assignee:me status:doing label:bug due:<7d sprint:current -label:wontfix "login page"`. Keys: assignee, status, label, priority, due, sprint, type, project, created, updated, points, has, is, title. A bad query returns an error with the character where it went wrong |

### Task watchers and duplicate (R27)

| Tool | What it does |
|---|---|
| `list_task_watchers` | Who watches a task and whether you do (read only keys can call it). Watchers hear about new comments and status changes |
| `watch_task` | Start watching a task: you, or the member named by `userId` (an agent key must name one). One row; twice changes nothing |
| `unwatch_task` | Stop watching a task: you, or the member named by `userId` |
| `duplicate_task` | Copy a task (new number, first to-do status) with notes, assignee, priority, dates, labels, type, estimate, sprint, repeat rule and custom fields; by default also its subtasks (3 levels, 200 tasks) and checklist (unticked). Options: `title`, `projectId`, `subtasks`, `checklist`, `assignee`, `dependencies` |

`search_tasks` also takes `is:watching` for the tasks you watch.
