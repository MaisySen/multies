# Multies MCP server

Multies runs a Model Context Protocol server, so Claude, ChatGPT, Cursor and any MCP client can work
in a Multies workspace: mail and agent inboxes, tasks, projects, docs, contacts, chat, meetings and more.

Bring your own AI: connect Claude, ChatGPT or any agent through MCP, free. Multies never pays for
or resells AI model calls. People who want the assistant inside webmail add their own OpenAI,
Anthropic, OpenRouter or Groq key in Settings, General, AI; it is encrypted at rest.

- URL: `https://multies.si/api/v1/mcp` (your own deployment: `<origin>/api/v1/mcp`)
- Transport: Streamable HTTP, stateless. Built on the official MCP TypeScript SDK.
- Tools: 84 (listed below). An agent key sees the agent tools; `create_agent_inbox` is for workspace keys and people.

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
| `create_custom_field` | Add a custom field to a project |
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
