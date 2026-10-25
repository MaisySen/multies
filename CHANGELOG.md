# Changelog

All notable changes to Multies. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0 each build round is a minor
version. Round dates are UTC. Rounds 1 to 9 were reconstructed from `git log` after the fact, so their
boundaries are approximate; from round 10 on, this file is updated in the same release.

## [Unreleased] (rounds 11 to 15)

Live on production at multies.si unless marked otherwise. Round 11 becomes 0.11.0 once the parts marked "after the database reset" are switched on.

### Added

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
