# Changelog

All notable changes to Multies. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0 each build round is a minor
version. Round dates are UTC. Rounds 1 to 9 were reconstructed from `git log` after the fact, so their
boundaries are approximate; from round 10 on, this file is updated in the same release.

## [Unreleased] (rounds 11 to 15)

### Round 53 (28 Oct 2026)

- Connected mailboxes sync with less work: some providers keep one change counter for the whole account, so last round's skip for unchanged folders rarely applied to them. Now a pass asks only for the messages whose read or star state changed since the last pass, and mail that is already stored, or that another folder brought in the same pass (some providers show new mail in two folders at once), is no longer downloaded and read twice.
- Agent API: retrying an MCP create tool, an import run or a webhook endpoint creation after a server error keeps the same id, so a retry never makes a second item, project or signing secret.
- A new worker starts with less to load: the email templates load when the first email is sent, not on every start.
- What's new: the account menu has a What's new item with a small dot when something new has shipped since you last looked (kept in your browser only), and multies.si/changelog lists recent changes, newest first.

### Round 52 (28 Oct 2026)

- Agent API: creating a form, goal, time entry, chat channel, agent, saved reply, custom field, checklist item or sprint keeps the same id when retried after a server error, and a retry after a first attempt that did go through now returns that item instead of failing again. POST /mcp honours Idempotency-Key, now covered by tests and described in the docs.
- Meetings can be deleted through the API, the app and MCP, which sends a meeting.deleted event. Deleting a project sends task.deleted for each of its tasks to anyone subscribed, written in one statement.
- Task lists cost less CPU per request: the query rules and the row mapping are built once per worker instead of on every call.
- Mail sync skips reading flags for a folder that has not changed since its last read, when the mail server reports changes (CONDSTORE), so a quiet pass costs a fraction of the CPU.

### Round 51 (27 Oct 2026)

- Agent API: every write can be retried safely with an Idempotency-Key, and a retry after a server error no longer makes a second doc, deal, comment or meeting. New webhook events tell you when a project, doc or comment is deleted, and when a comment is added or edited.
- The 15 minute background pass first asks, in one check, which of its steps have anything waiting, and skips the rest, so a quiet pass reads the database far less.

### Round 50 (27 Oct 2026)

- My Work (the Home tab on phones) asks the database far less: one check finds which sections have anything, so an empty section costs nothing. Fewer statements per load keeps each request inside the free plan's CPU limit under busy traffic.
- Mail to task on a phone: the reply bar at the foot of a thread has a task button. One tap makes a task from the email; if the thread already has one, the same tap opens it. Task chips on the thread show the task's title and are easy to tap. Back from the task returns to the thread.
- The 15 minute background pass spreads its hourly housekeeping across the four passes of each hour, so each pass does less work. Jobs, mail, imports, reminders and webhook retries still run every pass.

### Round 46 (27 Oct 2026)

- Big projects: board, list and backlog now load every task, page by page, so column counts, point totals and the backlog cover all of a project however large it is. The "Showing the first 500" notice is gone.
- Open boards and backlogs refresh from the list of recent changes every 20 seconds and fetch only the tasks that changed, instead of reading the whole list again, which cuts database reads for anyone with a board open. Moving tasks between sprints now shows up on other people's open backlogs too.
- The API description at /api/v1/openapi.json is prepared when we build the app, so the first request for it no longer does heavy work on the server.

### Multiws (27 Oct 2026)

- One account in several workspaces: switching from the sidebar workspace menu now always lands, on every device, and stays put after a reload or a new sign in. If a switch cannot finish, the menu says so and keeps you where you were.
- The activity log records each workspace switch.

### Round 45 (27 Oct 2026)

- Boards scroll smoothly even when you fling a long column from top to bottom: while a column moves faster than a screen per frame, cards are drawn as light outlines with their title and the full cards return as soon as it slows.
- Dragging a card with the keyboard (Space, then arrows) keeps it in hand past the cards on screen: the column scrolls with it and the drop lands where it is shown.
- Backlog keyboard: Shift with arrows selects a run, Space picks or unpicks a task, Ctrl or Cmd with A selects all, Esc clears, and M opens Move to sprint, which works with arrows and Enter. Screen readers hear the selection.
- Big projects: a board, list or backlog read brings at most 500 tasks. When a read comes back full, the page now says so ("Showing the first 500 tasks") instead of showing counts that only cover those, and the backlog no longer lets done tasks use up its 500, so every open task up to that limit is listed. This corrects the Round 44 note: counts and totals cover every task only up to 500 tasks per project for now.

### Round 44 (27 Oct 2026)

- API: `DELETE /api/v1/projects/{id}` removes a project and its tasks with a workspace key.
- Data moves started with an API key show the email of the person who made the key as the starter, not the key's name.
- Boards, swimlanes, the sprint list and the backlog stay fast with thousands of tasks: only the cards on screen are drawn, every task is still reachable by scrolling or J and K, and the "Show 100 more" button is gone. Column counts and point totals still count every task.
- The backlog has checkboxes (Shift selects a run), a bar with "N selected, X pt" and Move to sprint, and backlog rows can be dragged onto a sprint.

### Round 40, deploy 3: lighter page loads, demo sends no mail (27 Oct 2026)

- The demo can't send email: invitations from a demo workspace are refused with "Invites are off in the demo. Sign up to invite your team.", and no other email tied to a demo workspace leaves Multies. One address can open at most 10 new demos a day (DEMO_PER_IP_DAILY).
- Workspace, Team and Dashboard reads reuse the workspace and plan for up to 15 seconds on the same server (any change made through the app is seen at once), and a successful read no longer writes its own log line, so these pages spend less server time per request.

### Round 40, deploy 2: steadier under load, reliability fixes from the QA pass, mail archive import (27 Oct 2026)

- Fewer empty "503" errors: the free plan's per request CPU limit started being enforced on 27 Oct around 01:05 UTC, so a hotfix went out at 01:19 (request tracing off, errors still reported; the API description is built once instead of on every request; workspace usage, seats and badge counts use fewer database queries).
- If Multies doesn't answer for a moment, the app keeps your last workspace on screen with a "Reconnecting" pill and tries again; only a real sign out sends you to sign in. Reads retry quietly; creating a project, task, invite, import or export is never doubled by a retry (one key per action). Couldn't reach Multies messages are plain and offer Retry.
- Editing a task in two tabs: the other tab refreshes, and a save based on an older copy offers Keep yours or Use theirs instead of overwriting.
- Faster first load of My Work on slow phones (fewer, larger script files; error reporting and prefetch wait on slow links). Meetings has Start now; New task has Add another; new projects start from Simple, Kanban or Sprint; Tasks on phones uses one Filter button with chips; domain errors use our own words.
- Move your data: import a mail archive (.mbox, as Gmail Takeout and Apple Mail export it) into a mailbox, read in your browser and sent in small batches, with progress, Pause and a count of messages already there.
- Timeline labels never sit on top of each other; the demo shows a sample connected mailbox; founders@, finance@ and similar shared addresses are labelled Shared; API keys and webhooks in Developers have a cleaner card layout, and mailbox storage shows on phones.

### Round 40: fewer empty errors on busy moments, lighter database reads (27 Oct 2026)

- Signed in pages and the API spend less server time per request, so the free plan's per request limit (the cause of the empty "503" errors) is hit far less: the app is built when the server starts instead of inside the first request, a signed in read reuses its checked session for up to 15 seconds on the same server (any change you make, signing out included, is seen at once; account pages and the operator console always check afresh), and request tracing samples fewer requests.
- Database reads: task lists in their usual order read about one page of rows instead of every task in the workspace (migration 0082 adds two indexes; a new task costs 2 more rows written), subtask counts read only the subtasks, and the per project counts on the project list are kept for 20 seconds and refreshed by any change made through the app.

### Round 39 security hotfix: live demo, audit log and invites (27 Oct 2026)

- Try the live demo works again on multies.si. The demo account is made on the server, so public sign up with a password stays off. The post deploy smoke check now opens a demo and checks it lands in the demo workspace.
- The audit log is for owners and admins only; members get 403. Invitation ids, which work as invite links, are masked everywhere in audit output, exports included (only the last 4 characters show). Members see recent activity without IP addresses or invited emails.
- Accepting an invitation needs a confirmed email that matches it; the link alone is no longer enough. The sign in service's own invitation endpoints are closed over HTTP. Pending invitations made before this fix were expired.
- A teammate who signs up from an invite and lands in their own new workspace sees a Join banner once their email is confirmed.
- D1 reads: `/api/health` shows today's rows read against the free plan's 5 million a day, load scripts refuse to start at 50%, and placing a task at the bottom of a column reads one index entry instead of scanning tasks.

### Round 39: page history for docs, a premium pass over billing, notifications, domains, mailboxes and team, timeline polish (27 Oct 2026)

- Docs: page history. A version is kept when a new editing session starts (10 minutes after the last save, or a different person), when you save one, and before every restore. Name versions to keep them for good (the newest 50 unnamed ones stay), compare any version with the page now as added and removed lines, and restore with Undo, because the current page is saved first. History button in the doc header, or Ctrl or Cmd, Alt, Shift, H; a full sheet on phones. The same in the API (`/api/v1/docs/{id}/versions`) and over MCP (`list_doc_versions`, `read_doc_version`, `save_doc_version`, `restore_doc_version`). Migration 0080.
- Billing opens on a plan card with usage rings, a Compare limits sheet, add-ons as a list with icons and a cleaner invoice list. Notifications show an icon for each kind with the sender's initials and remember your filter on each device; on phones the actions sit on their own line. Domain setup shows its four steps and the next thing to do, each DNS record says Verified, Pending, Wrong value or Check this, and copying a record confirms it. The domain list gets headline numbers and a records ring per row, and Developers opens on two tiles, REST API and MCP tools.
- Mailboxes become cards with a Personal, Shared or Agent pill and a storage ring. Team opens on three headline numbers, shows last active on phones, and the invite sheet picks the role from two cards. Deliverability and Connections show Good, Check this or Not set up with one named next step. Page header labels use the darker brand blue so they pass colour contrast.
- Timeline: a name that would run past the right edge flips to the left of its bar, waiting days and early starts are drawn on the dependency arrows (a dashed band with "+3d", or a bracket with "1d early"), and a days off picker in the project schedule shades the days nobody works.
- Dashboards: `list_dashboard_widget_types` over MCP and `GET /api/v1/dashboards/widget-types` list every widget type with its options and defaults. MCP: 198 tools.

### Round 38: move your data (27 Oct 2026)

- Settings, Import and export: pick where your work lives now from tiles (a spreadsheet, eight work tools, a calendar file, contacts, Markdown docs, or a Multies export), then a wizard checks the columns, maps people and statuses, shows the first 20 rows, imports with a progress ring and keeps an Undo that removes exactly what the import made. Imports write in batches, stay under the database's limits, and carry on from where they stopped.
- Export everything: one ZIP with every record as JSON, CSV files, docs as Markdown, meetings as .ics, contacts as vCard and mail as mbox, behind a link that works for 24 hours. Owners and admins only, one every 10 minutes, written to the audit log. Importing that ZIP into another workspace brings the projects, tasks, contacts, meetings and docs back.
- History of every import and export, with Undo. The same in the API (`/api/v1/data-moves`) and over MCP: 193 tools (`export_workspace`, `list_data_moves`, `import_file`, `undo_import`). The API guide has a section on keeping other tools in sync with webhooks, the changes feed or a scheduled export. Migration 0081.

### Round 38: timeline names never cut, dependencies round 2, seven new dashboard widgets, grouped settings (27 Oct 2026)

- Timeline: a task name that does not fit inside its bar sits to the right of the bar in normal text; the key alone goes inside only when it fits, and no bar shows an ellipsis. The task column is wider, resizes by dragging the divider (remembered per device), and wraps names to two lines with the full name on hover or long press.
- Dependencies: a gap per link (wait days or start early days), working days only per project, a "Same days" mode that moves every waiting task by the same number of days, a red "Date clash" badge on list rows and board cards, and a Today line on the timeline. Migration 0079. MCP: 189 tools (`set_project_schedule`).
- Dashboards: seven new widget types (calculation with a goal, battery, pivot table, created against completed, task list, time tracked, note) and a new add widget sheet with search and previews. No migration.
- Settings: a grouped side list with icons on desktop and a grouped list on phones, instead of the tab strip. The operator console shows a calm empty state to people without access.
- Triage: the demo workspace now has items in Triage, and the comment bar has Cancel, Accept and Decline buttons.

### Round 36: scoped API keys, MCP tool docs, a sharper command menu, drawn empty states, inline edits on board cards (26 Oct 2026)

- API keys can be limited to areas: mail, tasks, chat, docs, calendar, contacts and admin, each read or write (mail read or send). Full access and Read only stay as presets, so existing keys work as before. A call outside a key's scopes is 403 `insufficient_scope` with the scope it needs. Edit a key's scopes from Developers. No migration.
- MCP tool docs at `/developers/mcp` (and `/developers/mcp.md`): every tool by area with its scope, parameters, an example call and result, and five end to end recipes. Generated from the server's own tool list, so they can't drift.
- The agents page uses plain client labels (Desktop app, Command line agent, Code editor, Any MCP client).
- Command menu: opens on recently opened items and recent commands, shows key hints on every command, and is a full height sheet on phones.
- Empty lists have drawings made in code, one clear next step each; calendar, timeline, sprints and workload get shaped loading placeholders.
- Board cards: rename in place, and change status, priority, due date and assignee from small menus, with Undo on a failed save.
- Shortcuts sheet: native looking key caps in two grouped columns.

### Round 35: report and block, a new icon set and Today home, FullCalendar 7, undo for bulk move, swimlanes in saved views (26 Oct 2026)

- Report a message or a person and block them in chat and DMs; blocked people's messages are hidden everywhere and they can't DM you (403 `blocked`). Settings, Account lists blocked people. Migration 0078. MCP: 186 tools (`create_report`, `list_blocks`, `add_block`, `remove_block`).
- Operator moderation queue with a 24 hour target and a mail alert.
- Terms and Acceptable use: objectionable content and abusive users.
- Web: a new icon set matching the phone app, softer depth and motion, a Today home with cards for mail, tasks, your next meeting, mentions and approvals, big titles that fold into the top bar on phones, and swipe on phone rows: archive or snooze mail, mark tasks done, with Undo.
- Mail: a bulk move can be undone like the other bulk actions; a move the provider has not run yet is simply dropped.
- Tasks: a saved view keeps its board swimlanes and grouping (`?lanes=` and `?group=` in the link).
- Calendar: FullCalendar 7, themed with the app's own colours in light and dark.
- Sign up and Forgot password paint from the HTML before the app loads, like Sign in; a tap on the card before the app takes over is kept.

### Round 33: fewer D1 writes, unique project keys, bulk mail jobs, live chat acks, offline lists, premium admin screens (26 Oct 2026)

- D1: each change writes one row that serves both the activity feed (now a view) and the change log, and project numbers come from their own counter table instead of the projects row. Rows written per action: task create 14 to 9, title edit 10 to 7, move 13 to 8, comment 16 to 13, doc save 9 to 6. Migration 0073.
- Projects: a key must be unique when you edit it too (409 `key_taken`, any case), in the app, the API and MCP `update_project`. Old task refs keep working after a key change.
- Mail: "Select all" across a whole folder runs as one server job (`/v1/mail/bulk-jobs`, MCP `mail_bulk_job`) with a progress toast: Cancel, Undo for 8 seconds, Undoing, Undone, Retry. Migration 0074. MCP: 178 tools.
- Chat: messages are acknowledged by id, sends wait for the server's hello after a reconnect, and an unacknowledged send retries after 12 seconds without doubling.
- Triage: accept or decline with a comment is one step with one Undo; Shift+D opens the full dialog.
- Offline: your last copy of My Work, task lists, projects and the first page of each mail folder opens offline, with "Showing your last copy from 10:42". Copies are per user and wiped on sign-out. A browser notification for the page you already have open is skipped and that page refreshes; notifications older than 6 hours are dropped.
- Docs: images keep their shape while loading (no layout shift). Developer docs are also served as Markdown at `/docs/api.md` and `/docs/mcp.md`, linked from `/llms.txt`.
- Look and feel: the operator console, invite, guest, team, integrations and sign-in screens got a premium pass: stat tiles, themed dialogs instead of browser prompts and confirms, two-tap confirm for revoke, remove and disconnect, 44 px tap targets on phones, larger headings.
- Member screens on phones: My Work, tasks, chat, docs and notifications fit a 390 px screen without spilling or wrapping into extra rows, tap targets are at least 44 px, notification Done, Snooze and Read are reachable without hover, inputs no longer zoom on iPhone, the mail folder picker is styled, and rows move with short transitions that respect Reduce Motion.
- Testing: `npm run test:e2e:staging-readonly` (404, favicon set, robots, sitemap) for a remote pass that writes nothing.

### Round 32: bulk mail, live chat, waiting room, triage queue, offline and web push, D1 write meter (26 Oct 2026)

- Mail: X selects the open conversation, Shift+X or Shift+click a range, Cmd/Ctrl+A everything shown; a bar archives, snoozes, moves, marks read or unread and deletes the selection, with Undo for 8 seconds (also Cmd/Ctrl+Z). Same service over the API (`POST /v1/mail/messages/bulk`) and MCP (`mail_bulk_action`). First-time senders that pass SPF and DKIM and are not bulk mail land in Important.
- Chat is live over a WebSocket: new and changed messages, typing and read state arrive at once, with polling as the fallback. MCP `chat_typing`.
- Meetings: guests give their name on the pre-join screen, wait in a waiting room until a host admits or denies them (a request that times out is asked again once), and "So far" sits in the call dock. Migration 0068.
- Tasks: a Triage queue for tasks from mail, forms, the API and agents: accept, decline, snooze, mark duplicate, restore. MCP `task_triage_list` and `task_triage_action`. Migration 0069.
- Docs: table, image and callout blocks from the / menu.
- The web app works offline after one visit (the app frame, an offline strip, an offline page) and can send browser notifications (Settings). Migration 0070.
- An "Update" pill appears when a new release ships; a critical release reloads on your next page change, never while a change is still saving.
- D1 write budget: a meter on the operator console, alert mail at 60% and 85%, read markers and similar writes are coalesced near the cap, and seven indexes now skip empty rows (migration 0072).
- `/llms.txt` and `/llms-full.txt` for multies.si (public docs only). MCP: 176 tools.

### Round 31: one command list, triage, split inbox, form logic, pre-join (26 Oct 2026)

- One command list drives Cmd+K, every shortcut and the ? sheet. G then I, T, D, C, M or N jumps to Inbox, Tasks, Docs, Chat, Meetings or Notifications. J and K move through tasks; on a focused task S, A, P, L and D change status, assignee, priority, label and due date inside the command menu, instantly, with undo on error. Mail adds R, A, F, U and H.
- Notifications triage: Inbox, Later and Done with counts. E marks done (with undo), H snoozes (later today, tomorrow, next week or a date), U toggles read; a snoozed item comes back to the top of Inbox. The unread badge counts Inbox only. Migration 0065.
- Catch-up: a "Since your last visit" card on channels, tasks and docs with a digest of what changed, who changed it and the latest decisions. "Write a summary" appears only when the workspace has its own AI key.
- Mail: Inbox splits into Important (mail from people) and Other, plus your own splits by sender, domain, recipient, subject, invites or teammates, each with an unread count; Tab moves between them. Read status on sent mail, off by default (Settings > Mail). Migration 0066.
- Forms: show a question only when earlier answers match, answer rules (length, number range, pick at least or at most, pattern) with errors next to each question, a "Several choices" type, routing by answer, and a Responses view with a table, a summary per question and CSV export. A public form that fails validation now answers 400 with every field's error. Migration 0067.
- Docs: a "/" menu for every block, keyboard driven.
- Meetings: a pre-join screen (camera preview, mic level, device pickers, speaker test, who is in; Enter joins). One notes doc per call, and a "So far" panel that opens on its own for anyone joining more than 5 minutes late.
- Faster pages: the theme applies before first paint (inline script allowed by its CSP hash), the command menu, onboarding and call dock load on demand, and idle prefetch only downloads.
- The session cookie is `__Host-mymail.session_token` in production; the old name is still read and moved over, so nobody is signed out. The unused API reference package is gone.
- MCP: 169 tools (notification_list, notification_done, notification_undone, notification_snooze, catchup_get, mail_split_list, mail_split_create, mail_split_update, mail_split_delete, mail_read_status, form_logic_set, form_results, meeting_summary_so_far).
- Mobile 1.9.7 (over the air): Activity tab with Inbox, Later and Done; hold a task or an email for quick actions; swipe mail right to archive and left to snooze, with Undo; a command button or a long press on any tab opens every place and action; Cancel a running agent run.

### Round 30: cancel agent runs, faster first load, tighter security headers, polish (26 Oct 2026)

- Agents: cancel a queued or running run from the run detail (with a confirm and an instant Cancelled state that rolls back if the server refuses), over the API (`POST /api/v1/runs/{id}/cancel`, optional reason, same shape as GET run) and over MCP (`agent_run_cancel`). A cancelled run can't be picked up again; steps and finishes on it answer 409 `run_cancelled`. Every cancel writes one `agent_run.cancelled` audit entry. New MCP tool `agent_trigger_history`. MCP now has 156 tools.
- Sign in with Google uses Google's own downloadable "G" asset (Google's current gradient mark), served as an image.
- Faster first load: the landing page arrives already rendered, sign in no longer jumps as it loads (layout shift 0.37 to 0), sign-in code preloads with the page, web fonts can no longer swap mid-read and `legacy.js` no longer blocks rendering. Lighthouse mobile: landing 92 performance and 100 accessibility, sign in 89 and 100. `npm run perf:lh`.
- Security headers: connect-src no longer allows any websocket host (only our own, LiveKit Cloud and the configured LiveKit URL), the API reference page has no inline script and pins its viewer, HSTS carries `preload`, Permissions-Policy drops `interest-cohort` for `browsing-topics=()`, and CSP violation reports go to `POST /api/csp-report` (log only, no database writes). `npm run security:headers` grades a site the way securityheaders.com does: A+ locally.
- Polish: press ? for the keyboard shortcuts sheet (also G then a key to jump between pages), all from one registry; the command menu reaches every app page plus New task, New doc, theme and shortcuts with fuzzy matching; designed empty states and row-height skeletons on Tasks; mail actions update instantly and roll back with a message if the server refuses.
- `GET /api/v1/app-config` (public, cached 60 s) and `PUT` (behind `APP_CONFIG_TOKEN`) for the phone app: minimum supported store build per platform, critical and rolled back OTA updates, update check throttle and the Sentry DSN for update health. Platform admins have `/api/admin/app-config`.
- Meetings: the page and the landing page no longer say nothing is recorded; recording and transcripts shipped in round 23.

### Round 29: trigger history, bulk reassign watchers, docs and sign in polish (26 Oct 2026)

- Agent triggers: each trigger in the Triggers dialog has History (its last 50 fires and refusals, with the reason in plain words, the source and a link to the run's task) and Edit (the Add form filled in, days of the week and an optional time zone). `GET /api/v1/agent-triggers/{id}/history`. Refused webhook calls before a fire (bad signature, stale, replayed, over the rate) are recorded at most once per trigger every 10 minutes. Migration 0063 adds a partial index on trigger audit rows.
- A bulk reassign makes the new assignee a watcher of each task, the same as a single reassign, in one batch.
- Docs written through the API (append, create or update from text) are stored in the editor's own format, so opening one no longer shows "Unsaved changes" or saves a version nobody typed, and an agent's next `ifVersion` stays valid.
- Sign in with Google uses Google's own four colour G on a white (light) or dark grey (dark) button, as Google's branding rules ask.
- `GET /api/agent-runs` lists the workspace's agent runs for the phone app's new Runs screen.
- Checked the D1 busy retry against the real D1 binding (`npm run qa:d1-retry`); no change needed.
- Mobile 1.9.5 (over the air): agent runs list and detail, and drag to reorder checklist items.

### Round 25: speed, phones, Google and Microsoft sign in (26 Oct 2026)

- Faster reads: My Work answers in about a third of the time (date formatters are made once, not per task), the shared inbox list uses a new composite index, and task lists, boards and sprint views make two fewer database round trips. Field definitions and statuses are cached for 10 seconds per server and cleared on every change. Config, people, assignees, projects and channels answer 304 when nothing changed. Migration 0052 swaps two indexes for composite ones, so writes cost the same.
- Smaller first load: the first script is 171 KB instead of 441 KB, every page loads on its own, sign in and public pages are no longer in the first script, and the next likely page is fetched ahead of time.
- Phones: Tasks opens as a list on a phone and remembers the view you pick, the board scrolls one column at a time, goal key results stack, and chat drops keyboard hints on touch screens. Buttons are at least 40 px tall.
- Continue with Google on sign in and sign up, and Continue with Microsoft on the preview site. A verified Google or Microsoft address signs in to the account that already uses it.
- API fixes found by Haajir: `/health` answers JSON, `GET /projects/{id}/tasks`, sprint dates as workspace days (`startDate` and `endDate` accepted) with a `url` per sprint, epic items take `taskIds`, docs update from plain text, `PATCH /threads/{id}`, `replyTo` on send, and the Supabase auth hook answer lists the rate limit step that otherwise drops signups.
- A default Reply-To per mailbox (MB-61): Settings, Mailboxes, Edit, "Replies go to", `PATCH /api/v1/mailboxes/{id}` and the MCP tool `set_mailbox_reply_to`. Sends that name no Reply-To carry it; a send's own `replyTo` still wins. Migration 0053 adds `mailboxes.reply_to` and renames chat posts stored under the old `API key "..."` author to the agent or the workspace. The Haajir HQ dogfood findings 2, 5, 6, 11, 13, 14, 16 and 17 were already fixed and now have guard tests; the last "this Multies" copy (Xero, booking pages) names the server instead.
- Phones, second pass: chat message actions open in one sheet from a More button or a long press, the mail star is visible and bigger on touch, and the compose footer fits a phone screen.
- A default Reply-To per mailbox (Settings, `PATCH /api/v1/mailboxes/{id}`, MCP `set_mailbox_reply_to`). Migration 0053; old chat posts signed "API key ..." now show the agent or workspace name.
- Branded auth emails for the Supabase hook: logo, colour, Reply-To, footer, per type text and an optional second language block, with `PATCH` and a preview endpoint (MCP `update_auth_email_hook`). Migration 0054.
- Fixed: task lists over 100 tasks failed on the database's 100 variable limit (seen from the iOS app). Tests now run with the same limit.
- Mobile 1.9.2 (iOS build 15, Android 13): a "mentioned you on a thread" notification opens the thread.
- Invitations carry a title and bio (the invite dialog and the API), and the new member starts with them. Invite, list and revoke with a workspace key: `GET`, `POST /api/v1/invites`, `DELETE /api/v1/invites/{id}`. Inviting the same address again now takes the new role. Migration 0055. Haajir HQ findings 12 and 15 (last workspace used, grouped sidebar) have guard tests; the org setup script names a new account's empty workspace instead of making a second one.

### Round 24: planning depth (25 Oct 2026)

- Formula and rollup fields: two new custom field types. A formula is an expression over a task's fields and built ins (`{Budget} * 1.1`, `if({points} > 5, "big", "small")`, `days_between(today(), {due})`), read by a hand written parser with no eval, limits on length and depth, and a clear "#ERROR" per cell instead of a failed page. A rollup sums, counts, averages or takes the min, max or percent done over subtasks, an epic's items, or a whole project (shown above the task list). Values are computed when tasks are read, so they cost no writes. Migration 0047: `custom_fields.config`.
- Dashboards: a Dashboards page with widgets for counts, tasks by status, person, priority, project, sprint, type or label, due this week and overdue, completed per week, sprint burndown, goal progress, reply times, mail volume and workload. Each widget can use a saved filter or a project. One click starts a "Team overview" dashboard; widgets drag to reorder. Data is computed on read; saving a layout is one row. Migration 0048: `dashboards`.
- Automation recipes: 28 ready rules in a Recipes tab (Tasks, Mail, Chat, Meetings, Sprints), turned on in one click or after picking a channel, project or person. The rules engine gains triggers for a new task, a changed assignee, a passed due date, a meeting that ended and a chat keyword, and actions to post in a channel, assign (a person, the project lead or round robin), set status, priority or a label, and add a checklist of subtasks, with a guard against rules that trigger each other.
- Docs: a page tree beside the docs with sub pages, drag to reorder or nest, and a menu for the keyboard; breadcrumbs; "Linked from" at the bottom of each doc and on tasks; type [[ to link a page or task. Link rows change only when a doc's links change. Migration 0050: `docs.parent_id`, `docs.position`, `doc_links`.
- Workload: a weekly capacity per person in points or hours, set on their row (owners and admins for anyone, members for themselves). Migration 0051: `workload_capacity`.
- Meeting notes: type @ in an action item to pick who it is for.
- API and MCP: REST endpoints for all of the above, and 13 new MCP tools (114 in all).
- Meeting notes: live co-editing. Two people in the same notes see each other's typing and cursors through the doc room, with the same save loop as docs (and the plain save when the live link is down).
- Formulas: renaming a field rewrites `{Old Name}` in the project's formulas, so they keep working. MCP create_custom_field takes formula and rollup types.
- Recipes: "when a meeting ends" fires when a call empties; bulk edits fire "assignee changed"; at most 50 rule runs per request, paused at the write budget warning.
- Dashboards: Move up and Move down in each widget's menu. Guests see a project's page tree and "Linked from".
- Sign in (DF-19): passwords set before the sign in move on 25 October work again. The new sign in checks a password it does not have yet against the old one, once, then keeps it; Forgot password finds people who were only on the old one. The sign in page has a one click "Set a new one".
- Onboarding (DF-21): an owner or admin of a workspace that is already set up, or a member who was there before it was, is not asked for their name and zone again; they use the workspace zone until they set their own.
- Saved views in the API (DF-20): GET, POST and DELETE /api/v1/views, and MCP list_saved_views, create_saved_view and delete_saved_view (117 tools), so agents can set up boards for people.

### Round 23: meetings that produce work (25 Oct 2026)

- Agenda and notes: each meeting gets one notes doc (Agenda, Notes, Action items), made the first time someone opens Notes and shown inline on the meeting page with a link back from the doc. Checklist items are action items: "@Name" sets the assignee and "due Fri", "by 30 Oct" or "tomorrow" sets the due date, both editable before "Create N tasks" makes them in one request. A second press makes none. Docs now keep checklists. Migration 0043: `meeting_action_items`.
- Recording and transcript with the workspace's own OpenAI or Groq key: Record in a call mixes everyone's audio in the browser, sends 5 minute chunks to the provider and keeps only the text. Everyone in the call, guests included, sees a red Recording banner. Stop summarises the call with the workspace's model and posts the summary, decisions and action items to the call's channel or DM (or notifies the attendees). Without a key, a setup prompt links to Settings, AI. The summary's action items show on the meeting notes with one click to make them tasks. Migration 0044: `meeting_recordings`.
- Calls in chat: a call in a DM (one to one or group) rings the other members, and so does a channel of up to 8 people. Screen share is granted to members and guests. The call card and the chat header show who is in the call with Join, then "Call ended" with its length, read from the call service with no write per check. Calls open in a docked window so chat stays in view.
- Calendar sync: a personal calendar feed (/cal/<token>.ics) for Google, Apple or Outlook with your meetings and due dates, in Settings, Calendar, with Reset link and Turn off. Other calendars come in read only: CalDAV from a connected mailbox where the provider offers it (Fastmail, iCloud, Zoho, Yahoo, GMX and more) or any secret ICS link, shown on the work calendar beside due dates and your meetings. Migration 0046: `calendar_feeds`, `calendar_sources`.
- A "mentioned you on a thread" push now carries the thread's newest message, so the phone app can open the thread (the app change ships in the next store build).
- Workload view (from the round 24 list): a Workload tab on the tasks page shows each person's open tasks and estimates per week (points or hours) against a weekly capacity, with an Overdue column and an Unassigned row. Drag a task to another person to reassign it, or to another week to move its due date. Reading it writes nothing. Saved views can be Workload views.
- Settings, Calendar takes an optional CalDAV address for a custom mail server.
- MCP has 101 tools. New: get_meeting_notes, create_action_items, get_meeting_transcript, get_call_status, list_calendar_events and get_workload, with matching REST endpoints.

### Round 22: the shared inbox works as a team (25 Oct 2026)

- Assign a shared inbox thread to a person, with All, Mine, Unassigned, Assigned to, Waiting and Done views, Mark done and Reopen. The assignee is notified, and open assigned mail shows in My Work. New mail on a Waiting or Done thread opens it again. Open rows show the age since the last customer message (amber after 24 hours). Migration 0039: `mail_thread_state` (one row per touched thread, one partial index).
- Team notes: internal comments on a thread with an @ mention picker. Mentioned teammates who can open the mailbox are notified. Notes never go into outgoing mail, replies or thread reads. Rows show a note count. Migration 0040: `thread_comments`.
- Live collision warning: "Maya is viewing" and "Maya is replying" in the shared inbox, in webmail, and above Send in Compose. It runs in memory in the ThreadPresence Durable Object, with no D1 write per heartbeat, and the staging write guard lets heartbeats through.
- Shared drafts: draft replies carry their thread and author. Teammates see "Draft by Maya" and can take it over; the first author is notified, and a later save of theirs is refused instead of overwriting.
- Reply times per mailbox and per person: median and average first response and resolution, computed when read.
- Saved replies with variables ({{first_name}}, {{company}}, {{date}} and more), shared or private, from a picker in Compose or "/shortcut" plus Tab, managed in Settings, Mail. Migration 0041: `mail_snippets`.
- Mail rules can assign new threads to one person or round robin, skipping people who lost access. Fixed: switching an email rule off no longer wipes its conditions.
- Chat messages can go to Triage. The board can group by epic, and dragging a card moves it to another epic. New webhook events: `triage.created`, `triage.accepted`, `triage.declined`, `triage.merged`.
- MCP has 95 tools. The 14 new ones are assign_thread, unassign_thread, set_thread_status, list_threads_by_view, get_reply_stats, list_thread_comments, add_thread_comment, delete_thread_comment, get_thread_presence, list_thread_drafts, take_over_draft, list_snippets, render_snippet and create_snippet, all with matching REST endpoints.

### Round 20: AI apps sign in, imports, mail timing, search everything, chat polish (25 Oct 2026)

- MCP sign in with OAuth: Claude, ChatGPT, Cursor and any MCP client add Multies with only https://multies.si/api/v1/mcp. OAuth 2.1 with PKCE (S256), dynamic client registration, protected resource and authorisation server metadata, rotating refresh tokens and RFC 7009 revoke. A consent page at /oauth/authorize picks the workspace and read and write or read only; Settings, Developers lists connected AI apps with Disconnect. Tokens act as the person with their role; access tokens are signed, never stored. API keys work as before (migration 0030: `oauth_clients`, `oauth_grants`).
- Agent thread reads are audited once per agent, thread and hour instead of on every read. docs/MCP.md lists all 65 tools.
- Import from Trello (board JSON), Asana, ClickUp, monday (CSV or .xlsx), Jira, Linear and Notion (CSV) in Settings, Import: detected columns, a mapping you can change, a 20 row preview, statuses grouped to do, doing and done, subtasks, comments, unknown people kept as a note (never a seat). Re-running a file adds only what is missing. 2,000 tasks per workspace a day, and it stops at the write budget's warn level (migration 0031: `tasks.import_key` with a partial unique index). Also on the API: /api/v1/work-imports.
- Mail: snooze a thread, send later and "remind me if no reply" for connected mailboxes, free addresses and own domains, with Snoozed and Scheduled views. Times use the person's time zone. Scheduled mail goes through the normal send path; an idle cron pass writes nothing (migration 0032: `mail_schedules`). MCP: snooze_thread, schedule_send, list_scheduled, cancel_scheduled.
- Search everything in Cmd+K: mail, tasks (including keys like OPS-12), docs, chat, contacts and deals, grouped, with permissions applied and no new writes. A My Work page shows overdue and due today tasks, mentions, mail on my tasks, approvals, today's meetings and snoozed mail coming back. MCP: search_everything, my_work.
- Chat: emoji reactions with who reacted, search inside a chat or across chats, a Call button that starts a meeting and posts a join card, and jump to first unread (migration 0033: `chat_reactions`). MCP: react_to_chat_message.

### Round 18: connect your existing mailbox (25 Oct 2026)

- Connect Gmail, Google Workspace, Outlook.com, Microsoft 365, Yahoo, iCloud, Zoho, Fastmail, GMX or any IMAP and SMTP mailbox with an app password, from onboarding or Settings, Connected accounts. The connection is tested before anything is saved, with plain words for a wrong password, a missing app password, IMAP turned off or a server that can't be reached. The password is stored encrypted and deleted with the connection.
- Sync: the last 30 days first (at most 200 Inbox and 100 Sent messages), then new mail every 10 to 15 minutes, or on Sync now. Read, star, archive and trash go both ways for recent Inbox mail. Each connection syncs in its own Durable Object (MAIL_SYNC), in one database batch per pass, deduplicated by Message-ID, capped per day, and paused while the D1 write budget reads warn or shed (migration 0027: `mail_connections`, `mail_sync_outbox`, `messages.remote_box`, `messages.remote_uid`, index on `messages(mailbox_id, message_id_header)`).
- Replies from a connected address go out through that provider's own SMTP, never Multies' sender, and land in its Sent folder (copied there with IMAP APPEND where the provider doesn't do it).
- Sign in with Google or Microsoft is built behind MAIL_OAUTH (off) until the owner finishes the providers' reviews (docs/runbooks/mail-oauth.md).
- Terms of service: the service section describes what is live (connect your mailbox, a free mail.multies.si address, your own domain) instead of IMAP and SMTP access.
- Demo workspaces create their sample mailboxes and aliases in two inserts: POST /api/account/demo went from 116 queries to 64 (Sentry MYMAIL-API-H and M).

### Round 17: monitoring and tools (25 Oct 2026)

- A D1 "internal error" blip counts as transient in maintenance: the step is skipped with a warning and runs again on the next pass, instead of paging Sentry (MYMAIL-API-P, Q, S, T, one second on 25 Oct 02:45 UTC).
- The dogfood org setup script estimates database rows before writing, stops at --max-writes and can skip whole steps (docs/dogfood.md).

### Round 17: only what is live is shown (25 Oct 2026)

- Stripe test mode and the test card number show to platform admins only; customers see "Paid add-ons aren't on sale yet" without operator instructions.
- Pricing and the landing page no longer promise mail apps over IMAP and SMTP, or imports, which aren't switched on in production. Mail apps settings say "Coming soon" (the Stalwart note is for platform admins), and onboarding marks "Connect your existing email" as coming soon until imports are on.
- Forms no longer tell customers to add Turnstile keys to the server.
- The sidebar group everyone sees is called Workspace, not Admin.

### Round 17: global onboarding, everyone's own time zone (25 Oct 2026)

- New people get a short onboarding before the app: name, company, country (all 249 ISO countries), time zone and language, filled in from the browser; the workspace part only for its owner or admins. Then three ways to get email working: a free @mail.multies.si address, connect existing email (copy mail in today), or your own domain, or straight into tasks, chat and meetings. Email and password sign up saves the same details from the browser.
- Each person has their own time zone and language (`users.timezone`, `users.locale`, migration 0026), changeable in Settings. Dates show in the person's zone, then the browser's, then the workspace's. New workspaces start in UTC with the country from the edge, never Sydney; a later workspace takes its creator's zone. Hard coded Sydney removed from timesheets, meetings, booking pages, invoice reminders, the portfolio and the status page.
- Pricing shows an approximate price in the visitor's currency (daily central bank rates, cached, no writes) with a note that billing is in A$.
- The status page no longer breaks on browsers that refuse a combined date style and zone name.

### Round 17: free personal addresses on mail.multies.si (25 Oct 2026)

- Anyone can take a free personal address name@mail.multies.si (owner decision, 25 Oct 2026, 9:32 PM Sydney), shown on the overview and on Mailboxes for workspaces without a domain. Never on the root multies.si: the config refuses the app's own domain. Kept names (role and system words, whole or as any part, and "multies" or "fintex" anywhere), confirmed emails only, never sample workspaces. Abuse limits: one per person, 3 a day per network and per device, a daily ceiling for the server; free addresses send to 50 recipients a day (20 in the first week), at most 10 in one message, and are held for spam from the lower score. API: `GET`/`POST /api/free-address`, `POST /api/v1/free-address`. DNS: DKIM, return path, DMARC (quarantine) and Cloudflare MX on mail.multies.si; docs/runbooks/free-addresses.md.

### Round 17: domain cap queue; free multies.si addresses rolled back (25 Oct 2026)

- Free addresses on multies.si were live for about 20 minutes and are withdrawn (owner decision: multies.si is the company's own domain, for staff addresses only; customers never get a Multies-branded address). The one test mailbox is deleted and the feature code is removed.
- The sending provider's domain cap can't break adding a domain: a refusal for a full plan keeps the domain "In the queue for a sending slot" (status `queued:`) with a clear message, and the oldest queued domain takes the next free slot on each maintenance pass and right after a domain leaves. docs/runbooks/domain-cap.md.
- E2E mail specs press Send now in the undo send toast instead of waiting out the hold.

### Everything on multies.si (25 Oct 2026)

- The preview of current main is https://preview.multies.si (the staging Worker, `NOINDEX=true`: robots.txt disallows all and every response carries `X-Robots-Tag: noindex, nofollow`). The mobile web preview is https://mobile.preview.multies.si (noindex).
- Support and security addresses are support@multies.si and security@multies.si (Cloudflare Email Routing rules on multies.si, ahead of the catch all to the inbound worker). Also accounts@, review@, privacy@, legal@ and hello@.
- The product plan lives only in this private repo (docs/plan, screenshots in docs/plan/img). It is not published on any website.
- The copy check fails on any host of the old preview domain in any tracked file (scripts/check-copy.ts, rule "host").


Live on production at multies.si unless marked otherwise. Round 11 becomes 0.11.0 once the parts marked "after the database reset" are switched on.

### Added

- Contact page at `/contact` with a working form (name, email, optional company, message). It sends to the support address (SUPPORT_EMAIL, contact@fintex.au on production) through the platform sender with Reply-To set to the visitor, checks each field in the browser and on the server with the error shown next to the field, shows a loading state on the button, drops bots through a hidden honeypot field and allows 5 messages per network per hour. After sending, `/thank-you` (noindex) confirms it. `/contact` is in the sitemap and the footer.
- A small cookie notice on public pages: essential cookies only, cookieless analytics, a link to the privacy policy and one OK button. Closing it is remembered in local storage. The privacy policy's cookie section says the same.
- The phone's sticky "Start free" bar now covers the marketing pages (home, pricing, agents, check, trust, status, support), not only home. It stays hidden while the page's hero button is on screen, on legal and contact pages, and for signed in people.
- After sign up, a person whose email isn't confirmed yet lands on a clear "Check your email to verify your account" screen with a Resend link button (loading and error states) instead of a vague sign in error. `POST /api/account/resend-verification` asks Auth0 to send the link again and answers the same whether or not the address exists.

### Fixed

- Settings, Delete account failed for everyone who signs in through Multies sign in (Auth0) with "Credential account not found", and failed silently. It now goes through `DELETE /api/account`: Auth0 people confirm by typing DELETE (password people still enter their password), a session older than 15 minutes is asked to sign in again before anything changes, the Auth0 login is removed through the Management API first (if that fails nothing is deleted and the dialog says so), and every error shows inside the dialog. `/api/account/me` now says `hasPassword`.

- The sign in page logo loads again. Every multies.si response carried `Cross-Origin-Resource-Policy: same-origin`, so the identity provider's sign in page (on its own domain) could not show the Multies logo and browsers drew a broken image. Brand images now live at `/brand/` (for example `/brand/multies-logo-512.png`) and are served with `Cross-Origin-Resource-Policy: cross-origin`; every other path stays same origin.
- The D1 write budget guard reads the day grouped by date with an exact date filter. The old query (date_geq, grouped only by database) answered 111 rows on 25 Oct while the day had 13,550, so the guard would have stayed "ok" near the limit.
- A domain check no longer asks the sending provider to verify a domain it already shows as verified. The request put the domain back to pending at the provider each time.
- Customer domains list the sending provider's CNAME record (for example `rsend`) on the domain page and in the API as "Sending host (CNAME)". It was dropped before, so the provider never marked sending as verified (found while adding haajir.xyz on 25 Oct). The provider checks it, so it does not hold up domain verification.
- 25 Oct deploy: privacy, abuse and support contacts on the legal pages and the disclosure steps in SECURITY.md use contact@fintex.au, because privacy@, abuse@, support@ and security@multies.si are not read mailboxes yet (docs/runbooks/multies-si-mailboxes.md). Scheduling is switched on in production and staging (SCHEDULING_ENABLED).
- Legal pages and the trust page name the operator: Fintex Australia Pty Ltd, ABN 60 688 406 108, contact contact@fintex.au (approved by the owner 25 Oct).
- Round 16: the legal pages give the company location as "New South Wales, Australia (NSW 2135)" (no street address) and the ACN, per the company runbook. The site footer and the trust page carry the runbook's standard legal line with Fintex Australia Pty Ltd linked to fintex.au. security.txt, the trust page security contact and the support address now use contact@fintex.au instead of an internal mailbox (security@multies.si takes over once it is a live mailbox), and the mail apps page no longer links to the private source repository.
- Undo send (round 15, no migration, no server change): Send holds the message in the browser for 5, 10, 20 or 30 seconds (default 10, saved on the device) with a countdown toast, Undo and Send now. Works for new messages, replies, forwards and drafts. Z or Cmd+Z takes the newest one back, Undo reopens Compose exactly as it was, a failed send reopens it too, and closing the tab during a hold asks first. See docs/undo-send.md.
- Trust page (round 15): a public page at `/trust` with the data region, the sub processors Multies actually calls, backups, sign in options, encryption and incident history, each line read from the code, config or docs; linked from the footer and the sitemap, and `security.txt` now points its policy at it. See docs/trust-page.md.
- Domain mail check (round 14, no migration): a public page at `/check` names who hosts a domain's mail today from its MX records, grades SPF and DMARC, and lists the steps to move to Multies without losing mail, with a link to copy. The same check shows on a domain's page in the app until it is verified. `GET /api/check/domain`, read only, no database writes, 20 checks a minute per IP. See docs/domain-check.md.
- Agent track record (round 14, no migration): the agent page shows how people decided its last 50 requests (approved as written, after edits, rejected, expired) and suggests loosening the approval mode after a clean streak or tightening it after rejections, applied with one tap by an admin. `GET /api/agents/{id}/track-record`, read only.
- Customer domains on any DNS provider (round 13, deploy pending, migration 0024): a new domain is registered with the outbound provider for sending and receiving, and the setup page lists the exact records with copy buttons (ownership, receiving MX, SPF, the provider's DKIM, the return path MX and SPF on `send.`, DMARC). Check DNS asks the provider to verify too; mail to the domain arrives through the provider's MX (`email.received`). No nameserver change. See docs/transactional-email.md.
- Transactional email without SMTP (round 13): `POST /api/v1/messages` accepts `from` (a mailbox address), and a Supabase Send Email Hook endpoint (`/api/v1/auth-email-hooks`, `/api/auth-hooks/supabase/{id}`) sends a Supabase project's auth emails from a workspace mailbox such as no-reply@.
- Save as template in the doc editor (round 13).
- Chat (round 13): posts made with an agent member's key show its name, title and an agent label; a workspace key posts as the workspace name.
- multies.si: the app, the API and the landing page answer on https://multies.si (www redirects to the apex), outbound mail comes from no-reply@multies.si, and inbound mail for multies.si reaches the inbound worker.
- Integrations page (`/app/integrations`): outgoing connectors for Slack, Discord, Microsoft Teams, Zapier, Make, n8n, Google Sheets and any URL, built on the signed webhooks (chat apps get a message body); incoming webhooks at `/api/hooks/in/<token>` that create a task, post a chat message or create a contact; REST, MCP and the `incoming_hook.received` event. Needs migration 0021 (after the database reset).
- Booking pages (`/app/scheduling`, public `/book/<slug>`) behind `SCHEDULING_ENABLED`: weekly hours per time zone, slot lengths from 15 to 60 minutes, buffer, notice and horizon, a meeting with its video link per booking, confirmation email with an .ics and a cancel link; REST, MCP and `booking.created` / `booking.cancelled`. Off on production until migration 0021 runs.
- Sign in through the Multies identity provider page (Authorization Code with PKCE, state and nonce, linking by verified email); the password form stays only where `AUTH_LOCAL_PASSWORD` is on. Mobile signs in the same way in the system browser. Merged, deployed after the database reset.
- Security: a cross workspace sweep over every id route, SSRF guard on outgoing webhooks, stricter CSRF media types, Sentry scrubbing, safer doc links and attachment downloads, audit log entries for account security changes, `npm run security` and a gitleaks pre-commit hook.
- New A3 logo (chunky rounded M with a spark for the AI agent), across web, favicons, social card, email and the mobile icons.
- Mobile 1.6.0 (build 7): new icon, Multies name, send files from chat. Mobile 1.7.0 (build 8): identity provider sign in and multies.si as the default server.
- Pinned chat messages (round 12): pin a channel's welcome, rules or key links from the message menu; the newest pin shows in a bar above the messages with the rest a tap away. REST `POST`/`DELETE /api/v1/chat/messages/{id}/pin`, `GET /api/v1/chat/channels/{id}/pins`, MCP `pin_message`. Needs migration 0023 (after the database reset).
- Doc templates and templates from scratch (round 12): a New template dialog writes a task, doc or project template without a source item, doc templates make a doc (starters: Meeting notes, Project brief), and a doc can be saved as a template (`fromDocId`). REST `POST /api/v1/templates`, MCP `create_template`.
- Public API (round 12): `PATCH /api/v1/chat/channels/{id}` (name, topic, archive) and `DELETE /api/v1/docs/{id}`.
- Teams Workflows (round 12): a Microsoft Teams connector with a Workflows (Power Automate) URL gets an Adaptive Card; older connector URLs keep plain text.
- Dashboard (round 12): a People stat counts people against seats and shows AI agent members apart; the operator console lists people and agents per workspace.
- AI agent members: agents join People with a title, a bio and an AI agent badge, work through their own scoped API keys (member role, posts and comments under their name), need no mailbox and take no seat; 10 on Free. Titles and bios for everyone, in People, REST `/api/v1/people` and MCP `list_people`. Weekly meeting series (every 1 or 2 weeks, chosen days, end date or count) expanded on read, with the RRULE in the .ics. Needs migration 0022 (after the database reset).

### Changed
- D1 daily write budget (24 Oct 2026, after the account passed 100,000 rows written and production went read only): a write budget guard reads the account's rows written today from Cloudflare analytics (`CF_ANALYTICS_TOKEN`, no database writes), logs `d1.write_budget` each cron pass and reports to Sentry from 60%; from 80% production stops opening new demo workspaces, and staging (`WRITE_BUDGET_GUARD=strict`) answers writes read only from 60%. `/api/health` shows the count. Demo cap 10 a day on production and 2 on staging (each demo costs about 2,000 rows over its life); staging cron hourly; API key, inbound key and auth hook last used times written at most every 15 minutes; redundant `companies_org_idx` dropped (migration 0025); the web app shows a read only banner and the sign in page names the read only state instead of "Something went wrong"; Playwright refuses a remote base URL without `E2E_ALLOW_REMOTE=1` and `--grep`; `tests/write-cost.test.ts` holds sign in, an idle cron pass and a demo to measured ceilings.
- Dogfood fixes (round 13): new projects use To do, In progress, In review, Done; sign in returns to the workspace used last; doc previews drop a repeated title; Settings Team lists members first with agents counted beside seats; the sidebar is grouped into Work, Mail and Admin and Team inbox is now Shared inbox; video and import copy name the workspace; the default support address is support@multies.si.
- Booking pages (round 12): every occurrence of the host's weekly meeting series counts as busy, worked out on read with no extra rows.
- Calendar files (round 12): a meeting series' .ics carries a VTIMEZONE for its time zone, so older Outlook versions accept it.
- Demo speed (round 12): the plan limit check counts only what it creates, so opening a demo no longer reads usage counters once per mailbox, alias and domain (157 to 115 queries, Sentry MYMAIL-API-M).
- Dogfood setup (round 12): `scripts/dogfood/org-setup.ts` makes agents as agent members, pins each channel's welcome and writes templates through the public API.
- Demo workspace opens faster: POST /demo runs 157 queries instead of 382 and the sample seed writes its activity rows in one batch (Sentry MYMAIL-API-H and N).
- D1 daily write budget: the demo has a daily cap, maintenance skips demo workspaces, the cron runs every 15 minutes, and write cap errors become a short read only notice instead of a server error.
- Accessibility: no moderate or worse axe findings on any app or public page, light and dark, desktop and phone; the axe E2E fails on moderate.
- Documentation brought up to date: architecture, API, SDLC, testing, runbooks (D1 daily limits, multies.si mailboxes), decision records, mobile, auth.

### Fixed
- The agent page no longer overflows on phones: its two columns may shrink below the width of the connect snippets (round 14).

## [0.10.0] (round 10, 24 Oct 2026)

### Added
- Team chat: public and private channels, direct messages, threads, mentions of people, agents and the whole channel, links to tasks, mail threads and docs, file attachments with signed short lived links, guest channels on projects, turn a message into a task.
- Notifications inbox with categories, filters, mark read by category, and per person settings for in app and push.
- Repeating tasks: daily, weekly on chosen days, monthly, yearly, or every N of any of those, with an optional end date.
- Templates: a starter gallery (client onboarding, content calendar, sales pipeline, bug tracker) plus saved project and task templates.
- Goals with key results (number, currency in AUD, percent, or linked tasks), progress rolled up from key results and child goals, and health.
- REST (`/api` and `/api/v1`), MCP tools and webhook events for chat, notifications, repeat rules, templates and goals.
- 20 point launch checklist with an E2E spec (`e2e/launch-checklist.spec.ts`): titles, descriptions, canonical and social tags, sitemap, robots, favicons, 404.
- SEO head written by the Worker per page; `/api/config` reports the release and an optional cookieless Cloudflare Web Analytics beacon token.

### Changed
- Product renamed from myMail to Multies in the app, emails, legal pages, API copy and brand files. The copy lint now flags the old name in user facing text.
- Apple style design: light and dark modes from `brand/tokens.json`, system font, one blue accent, muted status colours, AA contrast, iOS style segmented controls, large titles on phones, no emoji or text symbols as icons.
- Unknown pages answer HTTP 404 while still showing the page not found screen.
- The demo seed runs in two smaller parts with a short lease and finishes on the next app load if it was cut short.

### Fixed
- Maintenance: a busy, reset or not yet migrated database skips the step with a warning, and a failed rate limit prune is skipped instead of reported (Sentry MYMAIL-API-P and Q).
- Chat avatars show initials; message actions use a labelled menu.

## [0.9.0] (round 9, 24 Oct 2026)

### Added
- `DELETE /api/account` with a typed confirmation, public `/support` and `/delete-account` pages for the store listings, operator account deletion.
- Fixed App Review demo login.
- Self host on one computer: Docker Compose stack with Stalwart, a mail bridge, SMTP sending with the domain's DKIM key.
- QA feature inventory generated from the code (`docs/qa/inventory.md`) and the round 9 QA report.

### Fixed
- 503s from the Workers Free CPU limit: the public v1 API is built on its first request.
- 500s under concurrency: Better Auth request state is opened per request, with one retry.
- v1 fields, guests and portfolio routes now require an API key; deleting another workspace's automation answers 404.
- Accessibility: labelled drag handles on board and deal cards, tab labels on phones, focusable scrolling tables.

## [0.8.0] (round 8, 23 Oct 2026)

### Added
- Live co-editing of docs: a Durable Object per doc with SQLite storage, names and carets.
- Custom fields per project, guests on projects with a limited view, files on tasks, and the portfolio with project health.
- An agent's guest invite waits for a person's approval.

## [0.7.0] (round 7, 23 Oct 2026)

### Added
- Time tracking with timers and timesheets, task dependencies, public forms with spam checks, a reports dashboard, and meetings with emailed calendar invites.

## [0.6.0] (round 6, 23 Oct 2026)

### Added
- The work suite: tasks from email, projects with custom statuses and board, list, calendar and timeline views, docs, contacts and companies, deals, automations, phone push and a change feed, with REST and MCP tools.

## [0.5.0] (round 5, 23 Oct 2026)

### Added
- Free plan plus per business add-ons on one Stripe subscription, and a pricing page with a calculator.
- Agent inboxes with scoped keys, approvals, events and an audit trail; MCP server at `/api/v1/mcp`.
- Assistant for triage, summaries and drafted replies, on the user's own AI key (bring your own AI).
- Mail import from Gmail, Outlook and IMAP; Xero behind config.

### Changed
- Production database moved to Oceania (`mymail-au`) and the Worker placed in Sydney next to it.

## [0.4.0] (round 4, 23 Oct 2026)

### Added
- Strict CSP and hardening headers, security.txt, rate limits per scope, sign in lockout, Idempotency-Key, zod on every query string.
- Durable D1 job queue with backoff and dead letters; outbound spam scoring and send caps; uptime checks and a status history.
- Sentry tracing and releases, nightly encrypted D1 backups and a restore runbook, data export, legal drafts, React Email templates, dunning, SSO enforcement, operator console, k6 load test, ZAP baseline.

## [0.3.0] (round 3, 23 Oct 2026)

### Added
- Mail apps over IMAP and SMTP through Stalwart, API keys, an OpenAPI v1 REST API with docs, Standard Webhooks.
- Deliverability page, onboarding checklist, command palette, public status page, AUD pricing and Australian regional defaults, axe clean pages.

## [0.2.0] (round 2, 23 Oct 2026)

### Added
- Password change, sessions, 2FA, password reset and verification on Better Auth; team invitations and roles; Stripe billing; Sentry; the copy lint; CI.

## [0.1.0] (round 1, 23 Oct 2026)

### Added
- First version: custom domains with live DNS checks, mailboxes and aliases, inbound mail through Cloudflare Email Routing, webmail, marketing site, sign up and sign in, Playwright smoke tests.
