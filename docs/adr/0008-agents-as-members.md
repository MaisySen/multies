# ADR 0008: AI agents as workspace members

Status: accepted. Date: 26 October 2026. HQ task MB-84 (DF-3).

## Context

Haajir HQ wants a team of six AI agents (Builder, QA and others) that are real members: listed with
people, assignable to tasks, mentionable in chat, comments and docs, each with its own scoped API key,
mailbox optional, and everything they do audited.

Multies already had two kinds of agent:

- Mail agents (the `agents` table): each owns an inbox, a mailbox of kind `agent` on a verified
  domain, so it can't exist without a domain ("Add a domain first"). The Free plan includes 3.
- Agent members (migration 0022, R25): a `members` row with `kind = 'agent'` whose `users` row has no
  password, no sign in method and an address on the reserved `agents.multies.invalid` domain. It takes
  no seat and no inbox.

## What exists (before this slice)

- Data: `members.kind` (`human` or `agent`), `members.title`, `members.bio` (0022).
- Create, list and remove: `POST/DELETE /api/team/agents`, `POST/DELETE /api/v1/agent-members`,
  `GET /api/team/people`, `GET /api/v1/people`, MCP `list_people`. Removing revokes every key; what the
  agent wrote stays under its name.
- Keys: each agent member has its own API keys (`api_keys.created_by_user_id` is the agent's user),
  `full` or `read`, shown once, stored as a SHA-256 hash, rotated by adding a key and revoking the old
  one (`/agent-members/{id}/keys`). `resolveApiKey` turns such a key into the agent member with the
  member role, so admin routes refuse it and read keys can't write (the v1 gate).
- People and Settings, Team: agent members are listed after people with an "AI agent" badge (Lucide
  Bot) and a separate "no seat" counter. `/api/tasks/assignees` and `/api/chat/people` include them
  as `member:<userId>` with `isAgent: true`.
- Attribution: chat posts, task comments and task activity carry the agent's own name, because the key
  acts as its user. Admin actions on agent members go to `audit_logs` (`agent_member.created`,
  `key_created`, `key_revoked`, `removed`).
- Limits: `agentMembers` in src/shared/plans.ts (Free 10, Pro 25, Business 100), separate from
  seats (services/plans.ts and auth/options.ts count only humans as seats) and from agent inboxes.

## What DF-3 still lacked

- No way to pause an agent without deleting it (and losing its keys).
- No avatar colour; every agent looked like a generated person avatar.
- No link between an agent member and an agent inbox, so "mailbox optional" had no optional half.
- No REST read of agent members on their own, no edit route beyond title and bio, no MCP tools to add,
  edit or pause them.
- Pickers: the task assignee pickers, board, list and table showed the Bot icon only for mail agents
  (`type === "agent"`), so an agent member assignee looked like a person. A task assigned to an agent
  member showed its internal address as the assignee email.

## Decision (this slice)

- Keep one identity: an agent member stays a `members` row with `kind = 'agent'` and its own `users`
  row. No new table. Assignee strings stay `member:<userId>`, so assignment, mentions (`<@member:...>`),
  workload, time and every existing filter work unchanged.
- Migration 0056 adds three nullable columns to `members`, with no index: `disabled_at` (paused),
  `avatar_color` (`#rrggbb`; a stable default from the user id when unset) and `linked_agent_id`
  (an optional mail agent, checked to be in the same workspace).
- Pausing: `resolveApiKey` refuses every key of a paused agent member (401) before it writes
  `last_used_at`. A paused agent stays in People and history, and the web pickers hide it
  (`paused: true` on `/api/tasks/assignees` and `/api/chat/people`).
- Routes: `GET /api/team/agents`, `PATCH /api/team/agents/{userId}` (admins); `GET /api/v1/agent-members`,
  `GET` and `PATCH /api/v1/agent-members/{id}`; create takes `avatarColor` and `inboxAgentId`. MCP:
  `list_agent_members`, `create_agent_member`, `update_agent_member` (src/server/routes/mcp-r26-agents.ts).
  Managing needs an admin or a full workspace key; agent keys, agent member keys and read only keys get 403.
- Badge: one helper, `isAgentLike` in src/web/pages/app/work/data.ts, gives agent members the same Lucide
  Bot badge as mail agents in the board, list, table, task panel, forms, fields, automations and the
  chat mention picker. Tasks assigned to an agent member carry `assignee.isAgent` and no email.
- Audit: admin actions on agent members go to `audit_logs` (`agent_member.updated`, `paused`, `resumed`
  added). Work an agent does with its key goes to the per item `activity` log with the agent's user id
  and name as actor (task changes, comments, chat). We do not add an `audit_logs` row per agent write:
  it would double the D1 cost of every write, and `activity` already names the actor.

## Limits (owner decision)

- No limit changed. Agent members keep their own plan limit, `agentMembers` (Free 10), separate from
  seats and from the 3 agent inboxes on Free. Haajir asked for 6, which fits Free today. Whether 10 is
  the right Free number is the owner's call.

## Out of scope for this slice

- Sending mail as a linked inbox with the agent member's key (still refused with
  `agent_member_key_scope`; use the mail agent's own key).
- Per agent key scopes finer than `full` and `read` (per project or per tool).
- Server side refusal of assigning a task to a paused agent (the pickers hide it; the API still allows it).
- Avatar images (colour and initials only).
- A per agent audit page in the app (the audit log and activity are readable by API).

## Consequences

- D1 writes: pause or edit is 8 counted writes (the members row with its key and two indexes, plus one
  audit row with its three); an unchanged edit writes nothing; a colour or inbox at create adds 4.
- Removing an agent member keeps working as before. Existing mail agents and their inboxes are unchanged.

## Slice 2: agent runs (R27)

Status: accepted. Date: 26 October 2026. Migration 0059.

### Context

Slice 1 made an agent a member that can be assigned and mentioned, but what it did while working was spread over task
activity, comments and chat. A person looking at a task could not see that an agent had picked it up, what it tried,
or how it ended.

### Decision

- A run is one agent member's go at one task: `queued`, `running`, `succeeded`, `failed` or `cancelled`, with
  `started_at`, `finished_at`, a result summary and ordered steps (`at`, `kind` note, tool, comment or status_change,
  `text`).
- Storage: one table, `agent_runs`, with the steps as a JSON array in a `steps` column and a `step_count`. We chose this
  over a separate `agent_run_steps` table because of D1's 100k writes a day: a step is appended in place with
  `json_insert` in one UPDATE, which is 1 counted row write and touches no index, where a step row would cost its row,
  its primary key and a run index (3). The step cap and the status are checked in the same statement, so two steps at
  once can't pass the cap. Reading a run is one row. A run of 200 steps of 1,000 characters stays far under D1's row
  size limit. The cost is that steps can't be queried on their own; nothing needs that yet.
- Indexes: `agent_runs_task_idx` (task_id) for the task panel, and a partial unique index on (task_id, agent_user_id)
  where the status is queued or running, which holds "one active run per agent per task" even under a race.
- Who may run: an agent member's own key starts a run on a task it is assigned to or mentioned on (the same mention
  rules as comments), or claims a run queued for it. The explicit allowance is a person or a full workspace key queuing
  a run for a named agent member, which also covers tasks the agent is not on. Only the run's agent adds steps and
  finishes; a person or a workspace key can cancel. Mail agent keys (the `agents` table) can't run tasks.
- Audit: `agent_run.started`, `agent_run.queued` and `agent_run.finished` go to `audit_logs` with the task as target and
  metadata naming the agent (`agentUserId`, `agentName`), the task (`taskRef`, `taskTitle`), the run and its status.
  Steps are not audited (they are the run log itself). The audit page reads them in plain words: "Builder started a run
  on MB-12".
- Optional side effects: starting can move the task to doing; finishing can move it to done or to the project's status
  named like "In review" (422 if there is none, checked before anything is written) and post the result as the agent's
  comment. These go through the normal task service, so activity, webhooks and notifications behave as for any edit.
- Surfaces: REST (`/api/v1/tasks/{id}/runs`, `/api/v1/runs`, `/api/v1/runs/{id}`, `/steps`, `/finish`), MCP
  (`start_task_run`, `add_run_step`, `finish_task_run`, `list_task_runs`), and the Runs section on the task panel.
- Limits: 200 steps per run, 1,000 characters per step, 4,000 per result; lists return at most 200 runs. List reads
  over task and agent ids go through the shared `inChunks` helper (chunks of 90).

### Out of scope

- Running an agent from Multies (we log what an outside agent does; we don't host or call it).
- Live streaming of steps (the panel refreshes every 10 seconds while a run is active, and with the task panel).
- Per run cost or token accounting, and retries or schedules.
