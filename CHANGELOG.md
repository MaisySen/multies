# Changelog

All notable changes to Multies. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0 each build round is a minor
version. Round dates are UTC. Rounds 1 to 9 were reconstructed from `git log` after the fact, so their
boundaries are approximate; from round 10 on, this file is updated in the same release.

## [Unreleased] (round 11)

Live on production at multies.si unless marked otherwise. Round 11 becomes 0.11.0 once the parts marked "after the database reset" are switched on.

### Added
- multies.si: the app, the API and the landing page answer on https://multies.si (www redirects to the apex), outbound mail comes from no-reply@multies.si, and inbound mail for multies.si reaches the inbound worker.
- Integrations page (`/app/integrations`): outgoing connectors for Slack, Discord, Microsoft Teams, Zapier, Make, n8n, Google Sheets and any URL, built on the signed webhooks (chat apps get a message body); incoming webhooks at `/api/hooks/in/<token>` that create a task, post a chat message or create a contact; REST, MCP and the `incoming_hook.received` event. Needs migration 0021 (after the database reset).
- Booking pages (`/app/scheduling`, public `/book/<slug>`) behind `SCHEDULING_ENABLED`: weekly hours per time zone, slot lengths from 15 to 60 minutes, buffer, notice and horizon, a meeting with its video link per booking, confirmation email with an .ics and a cancel link; REST, MCP and `booking.created` / `booking.cancelled`. Off on production until migration 0021 runs.
- Sign in through the Multies identity provider page (Authorization Code with PKCE, state and nonce, linking by verified email); the password form stays only where `AUTH_LOCAL_PASSWORD` is on. Mobile signs in the same way in the system browser. Merged, deployed after the database reset.
- Security: a cross workspace sweep over every id route, SSRF guard on outgoing webhooks, stricter CSRF media types, Sentry scrubbing, safer doc links and attachment downloads, audit log entries for account security changes, `npm run security` and a gitleaks pre-commit hook.
- New A3 logo (chunky rounded M with a spark for the AI agent), across web, favicons, social card, email and the mobile icons.
- Mobile 1.6.0 (build 7): new icon, Multies name, send files from chat. Mobile 1.7.0 (build 8): identity provider sign in and multies.si as the default server.
- AI agent members: agents join People with a title, a bio and an AI agent badge, work through their own scoped API keys (member role, posts and comments under their name), need no mailbox and take no seat; 10 on Free. Titles and bios for everyone, in People, REST `/api/v1/people` and MCP `list_people`. Weekly meeting series (every 1 or 2 weeks, chosen days, end date or count) expanded on read, with the RRULE in the .ics. Needs migration 0022 (after the database reset).

### Changed
- Demo workspace opens faster: POST /demo runs 157 queries instead of 382 and the sample seed writes its activity rows in one batch (Sentry MYMAIL-API-H and N).
- D1 daily write budget: the demo has a daily cap, maintenance skips demo workspaces, the cron runs every 15 minutes, and write cap errors become a short read only notice instead of a server error.
- Accessibility: no moderate or worse axe findings on any app or public page, light and dark, desktop and phone; the axe E2E fails on moderate.
- Documentation brought up to date: architecture, API, SDLC, testing, runbooks (D1 daily limits, multies.si mailboxes), decision records, mobile, auth.

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
