# Changelog

All notable changes to Multies. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0 each build round is a minor
version. Round dates are UTC. Rounds 1 to 9 were reconstructed from `git log` after the fact, so their
boundaries are approximate; from round 10 on, this file is updated in the same release.

## [Unreleased] (rounds 11 to 15)

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
