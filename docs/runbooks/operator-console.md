# Operator console

For Multies operators (staff who look after customers and the platform) and for whoever deploys the console. Every rule here is what the code does today; file names are given so you can check.

## 1. What it is and where it lives

The operator console is at `/console` (the API under it is `/api/console`). It is a separate screen from the customer app, with its own sidebar in five groups: Overview, Customers, Product, Platform and Access. The old address `/app/admin` opens `/console`, and `/app/admin/reports` opens `/console/moderation`.

Only accounts with an operator role can open it. Everyone else sees "This console is for platform operators". The sidebar and the buttons only show what your role can use; the server checks every permission again on every request (`src/shared/operator-permissions.ts`, `src/server/auth/operator.ts`).

The console never applies your own workspace's rules to you: your workspace's single sign-on requirement and its daily write limit do not block console requests.

## 2. Becoming an operator

There are two ways.

**`PLATFORM_ADMIN_EMAILS` (deploy setting).** A comma separated list of user ids or email addresses. On that account's next signed in request it is made an owner (role `admin`, shown as "Owner") (`src/server/auth/guards.ts`).

- A listed user id is promoted whatever the address.
- A listed address is promoted only once the person has confirmed it themselves. An address an operator marked confirmed from the console (Users, Mark verified) never promotes, because that proves nothing about who owns it.
- It does not ask for two-step sign in. A listed owner without it is an owner who can't open the console yet (section 3).
- It never promotes a session that is viewing as someone else.
- Listed operators show as managed by the deployment on the Operators page. Their role can't be changed or removed there (`env_managed`); change the setting instead. Taking someone off the list does not remove their role. After a deploy without them, an owner can change or remove them on the Operators page.

**The Operators page** (`/console/operators`, owners only, needs a recent sign in). Enter the email and pick a role. The account must already exist, have a confirmed address, not be banned, and have two-step sign in turned on. Without two-step the console refuses with "doesn't have two-step sign in turned on. Ask them to turn it on in Account and security first". The same two-step rule applies when you change someone's role. The last owner can't be removed or demoted (`last_owner`).

Removing a role, or lowering it, also ends any "View as" session that the new role no longer allows.

## 3. Signing in

### The two-step rule

With the rule on, the console opens only for a session that proved a second factor at sign in (`meetsTwoFactorRule` in `src/server/auth/operator.ts`, `src/server/auth/two-factor-session.ts`). Either:

- the account has two-step sign in turned on **and** this session gave one of: the two-step code, a backup code, or a passkey (passkeys require user verification, so the passkey is the second factor). Turning on two-step sign in also counts for the session you turned it on in; or
- the session signed in through a method listed in `OPERATOR_SSO_METHODS`.

These do not count:

- Google, Microsoft, Auth0 or any other outside sign in, unless that method is listed in `OPERATOR_SSO_METHODS`.
- A sign in that skipped the code because of a remembered (trusted) device.
- The account having two-step turned on, without this session giving a code.

The phone app's hand off to the web app is recorded with the method `auth0`, so listing `auth0` in `OPERATOR_SSO_METHODS` also accepts those sessions. Only list a method if that provider makes every operator use multi-factor.

On the phone, operators find Operator in More, Settings. The menu sends it to the phone as `/app/admin` (which opens `/console`), because the phone app opens only `/app` pages; it opens in the in-app browser through that hand off, so without `auth0` listed the console shows the two-step card there.

Turning two-step sign in off makes every earlier session stop counting until you turn it on again and sign in with the code.

A passkey counts only on an account that has two-step sign in turned on, and only if it was added from a session that itself proved a second factor (the code, a backup code, the enrolment, or a passkey that counts). On an account without two-step, or with a passkey added from any other session (before the account became an operator, say), a passkey sign in does not open the console: sign in with your password and code, remove that passkey and add it again.

A session that gave no code cannot give itself a second factor. On an operator account (or one in `PLATFORM_ADMIN_EMAILS`), with the rule on:

- adding a passkey needs a session that meets the rule (`two_factor_required`, with the same `details.reason` as the console);
- reading the authenticator setup (`/two-factor/get-totp-uri`) and making new backup codes (`/two-factor/generate-backup-codes`) need a session that meets the rule too (`SECOND_FACTOR_REQUIRED`).

Otherwise someone holding an older session (from before two-step was turned on, a remembered device, an outside sign in or the phone's hand off) could add their own passkey, or read the secret or new backup codes with the password, and then sign in with it to open the console. Everyone else's account is unchanged.

When the console refuses a session it says which case applies (the refusal carries `details.reason`):

- "Turn on two-step sign in" (`not_enrolled`): two-step is off on the account. Open account security, turn it on, then come back to the console (Open the console on the card): the session you turned it on in opens the console, so there is no need to sign in again.
- "Sign in again with your two-step code" (`no_second_factor_this_session`): two-step is on, but this session did not give a code (an outside sign in, or a remembered device). Sign in again signs you out and brings you back to `/console` after you sign in with your password and code, or a passkey.

### Recent sign in ("Sign in again to continue")

Some actions need a sign in from the last `OPERATOR_FRESH_MINUTES` minutes (15 by default). The console then shows "Sign in again to continue"; choose Sign in again, sign in, and repeat the action. Nothing was changed. The actions that need it:

- View as a person (start)
- Ban and unban a person
- Delete an account
- Grant, change or remove an operator
- Set or clear a platform wide feature flag
- Comp a workspace, add a credit
- Replay every dead job at once
- Save the mobile app config
- Suspend a person from a moderation report

### Settings (`src/server/config.ts`)

| Setting | Default | What it does |
| --- | --- | --- |
| `OPERATOR_REQUIRE_2FA` | On in production, off elsewhere | `on` asks for the two-step rule everywhere, `off` turns it off. |
| `OPERATOR_SSO_METHODS` | Empty | Comma separated sign in methods that count as two-step. |
| `OPERATOR_FRESH_MINUTES` | 15 | How recent a sign in must be for the actions above (1 to 1440). |

### Before go-live

- [ ] Every operator, and every account in `PLATFORM_ADMIN_EMAILS`, turns on two-step sign in and signs in once with the code.
- [ ] `OPERATOR_SSO_METHODS` is empty, or lists only a provider that makes every operator use multi-factor.
- [ ] At least two owners, so losing one account does not lock everyone out of operator management.

Why: a listed owner who never turned on two-step sign in can be taken over by anyone holding only their password, who can turn on two-step with their own authenticator app and then open the console. The console narrows this but does not close it: when an operator turns two-step on or off, or adds a passkey, every owner gets an email and the audit log records `operator.two_factor_enrolled`, `operator.two_factor_disabled` or `operator.passkey_added`. If you get that email and did not expect it, check with the person and remove their operator access until it is sorted out.

The audit log records every such change. The owner emails are limited to one per operator per kind of change (on, off, passkey) per hour, so an operator turning two-step off and on in a loop cannot flood the owners' inboxes; the later changes in that hour are still in the audit log. Checking a code again while already signed in is not a change and sends nothing.

Scripts that read `/api/admin/health` with an operator's session cookie (`MULTIES_OPERATOR_COOKIE`, see [deploy.md](deploy.md)) need a cookie from a session that signed in with the code.

## 4. Roles

Generated from `ROLE_PERMISSIONS` in `src/shared/operator-permissions.ts`. "Read" means seeing a section's lists and details.

| What | Read only | Support | Billing | Operations admin | Owner |
| --- | --- | --- | --- | --- | --- |
| **Reading** | | | | | |
| Read every section except Operators | yes | yes | yes | yes | yes |
| See the Operators page | | | | yes | yes |
| **Helping people** | | | | | |
| Notes on a workspace or person | | yes | yes | yes | yes |
| Sign a person out (one session or all) | | yes | yes | yes | yes |
| Clear a sign in lockout | | yes | yes | yes | yes |
| Mark an address confirmed | | yes | yes | yes | yes |
| **Enforcing** | | | | | |
| Suspend and restore a workspace | | yes | | yes | yes |
| Send cap, sending switch, call minutes cap, send a held message | | yes | | yes | yes |
| Ban and unban a person | | yes | | yes | yes |
| Act on reports and abuse signals | | yes | | yes | yes |
| Mail actions (suppressions, domain re-check, send a held message) | | yes | | yes | yes |
| View as a person (view only) | | yes | | yes | yes |
| **Billing** | | | | | |
| Plan, comp, credit, trial, grace, resync, cancel at period end | | | yes | yes | yes |
| **Running the platform** | | | | | |
| Act as a person, end someone's View as session | | | | yes | yes |
| Agents and AI changes | | | | yes | yes |
| Developer platform changes | | | | yes | yes |
| Jobs (replay, stop) | | | | yes | yes |
| Mobile app config, announcements | | | | yes | yes |
| System (Sentry test, Fill in history, and the trends rollup, which has no button: `POST /api/console/metrics/roll` with a reason) | | | | yes | yes |
| Feature flags for one workspace | | | | yes | yes |
| **Owner only** | | | | | |
| Platform wide feature flags | | | | | yes |
| Delete an account | | | | | yes |
| Grant, change and remove operators | | | | | yes |
| Export the audit log | | | | | yes |

Two cross checks: suspending a person from a moderation report needs both report and ban rights; clearing the lockout of an operator's address is owner only.

## 5. The sections

Every change in the console asks for a reason (3 to 300 characters) and is written to the audit log. The exceptions are adding and pinning a note, where the reason is optional (the note is the record).

**Overview** (`/console`). What needs attention first: reports to review, open abuse signals, dead jobs, migrations waiting, the write budget, past due and over limit and suspended workspaces, each linking to the filtered page. Then totals, the newest workspaces and trend charts (section 9). Nothing to change here except Fill in history.

**Workspaces** (`/console/workspaces`). Search by name, id, slug, owner email or domain; filter by plan and state. A workspace has the tabs Overview, Members, Billing, Usage, Mail, Agents, Developer, Flags, Activity and Notes (Billing, Agents, Developer and Flags only for roles that can read them). On the Members tab, roles that can view as a person get a small View as button at the end of each person's row, which opens that person in this workspace (not shown for agent members, banned people or yourself; the server refuses operators with its own message). Suspend and Restore are in the header; the Overview tab has the sending switch and changes the send cap and the call minutes cap; the Mail tab sends a held message (Send anyway). Activity shows the workspace's own log or the operator actions on it, with each target by name (a person whose account is gone shows the address the entry recorded, else "Deleted user"); Open in audit log opens the audit log filtered to this workspace.

**Users** (`/console/users`). Search by email, name or id; filter banned, unconfirmed, operators, two-step on or off. A person's page shows workspaces, sign in methods, two-step state, sessions (marked when an operator opened them) and lockout. Actions: Sign out (one session or everywhere), Clear lockout, Mark verified, Ban and Unban (recent sign in), View as (recent sign in), Delete account (owners, recent sign in). Ban, delete, lockout and session changes are refused on operator accounts (`target_is_operator`); Mark verified is refused on them (`protected_account`). You can't act on yourself. The Audit log link beside the account id lists every operator change to this account.

**Billing** (`/console/billing`). Subscriptions, past due workspaces, Stripe events and referrals across workspaces, and one workspace's billing. A workspace's Billing tab shows the credit the customer holds in Stripe now (read live from Stripe; it includes referral credits and changes made in Stripe) and the last five credits added from the console, with the amount, note and who added them. Actions: change plan, comp with an end date, credit (recent sign in for both comp and credit), extend trial, extend grace, resync from Stripe, cancel at period end. Without Stripe connected, the actions that need it answer `billing_unavailable`; comp and grace work either way. A comp past its end date ends on its own once a day, just after midnight UTC.

**Mail and deliverability** (`/console/mail`). Failed deliveries (by default the last 7 days; never subject, body or addresses), failure rates by workspace, domains, suppressions, held messages, connected mailboxes and imports. Actions: remove a suppression, re-check a domain, send a held message, turn a workspace's sending on or off.

**Agents and AI** (`/console/agents`). Runs that failed or are taking long, triggers, approvals waiting for a person, AI usage by workspace, and workspace AI key problems. Actions: cancel a run, pause or resume a trigger. Run inputs, results, instructions and keys are never shown.

**Developer platform** (`/console/developer`). API keys (never the key), webhook endpoints (never the URL path) and their failed deliveries, OAuth apps and grants. Actions: revoke a key (permanent), turn an endpoint off or on, redeliver, revoke a grant.

**Mobile app** (`/console/mobile`). The phone app's remote config with the values in force. Saving needs a recent sign in; phones pick the change up within about a minute.

**Announcements** (`/console/announcements`). One banner at the top of the web app (the phone app does not show it yet, so tell phone users another way): text, tone, audience (everyone signed in, or workspace owners and admins), optional link, start and end time, dismissible. Publish replaces the current one; Clear removes it. Other servers show the change within about 30 seconds.

**Moderation** (`/console/moderation`). Reports, abuse signals, suspended workspaces and sign in lockouts. Actions: dismiss, resolve, remove a message, suspend the reported person (recent sign in; refused on operators), resolve abuse signals, suspend and restore a workspace (restore also resolves its open abuse signals), clear a lockout.

**Jobs** (`/console/jobs`). Counts by status and type, how long the oldest due job has waited, jobs by status (dead by default), and imports and exports. Actions: replay one dead job, the selected ones (up to 500), or all of them (recent sign in); stop a job that is waiting or whose run has stalled.

**Feature flags** (`/console/flags`). See section 7.

**System health** (`/console/system`). Release, pending migrations, D1 writes and reads against the daily budget, busiest workspaces, uptime, which integrations are set up (never keys), circuit breakers and rate limits. Circuit breakers are those of the server that answered. Action: send a test error to Sentry.

**Operators** (`/console/operators`, operations admins and owners). Two tabs. Operators: each operator's role, two-step state, last sign in and whether the deployment manages them; owners grant, change and remove roles (section 2). Support sessions (`?tab=sessions`): who is viewing as whom, active now by default (section 6).

**Audit log** (`/console/audit`). See section 8.

## 6. Viewing as a person

Open the person in Users and choose View as, or choose View as on their row in a workspace's Members tab to open that workspace (`src/server/routes/console/impersonation.ts`, `src/server/services/console/impersonation.ts`). The dialog starts on View only; roles that can act also see Act as this person.

- **Who:** Support can view only. Operations admins and owners can choose view or act. It needs a reason and a recent sign in.
- **Not allowed:** yourself, an operator, an account in `PLATFORM_ADMIN_EMAILS`, a banned person, or a person with no workspace.
- **View:** you see their account and can't change anything.
- **Act:** changes work and are made in their name.
- **Time:** at most 30 minutes. A bar across the top shows who you are viewing, the time left and Stop. Stop takes you back to the person's page in the console. If your own session ended meanwhile, Stop signs this browser out and you sign in again.
- While you view as someone, the console itself is closed to you (`impersonating`).

Always blocked, in both modes (`IMPERSONATION_ALWAYS_BLOCKED`):

- the operator console and the older operator routes
- the team password vault, even reading it
- passwords, email, two-step, passkeys, sessions and other sign in settings
- deleting the account or the workspace
- data exports (personal data, the workspace export, data moves, data requests, archive exports, the audit log export)
- billing checkout, the Stripe portal, plan changes and add-ons
- new API keys, agent keys, inbound keys, signing secrets and incoming hook addresses
- approving or removing connected AI apps
- app passwords for mail and for calendar and contacts sync
- anything that would outlive the session: share links, secret and file request links, dashboard links, portal links, calendar feed addresses, webhooks and integration endpoints, guests, push to a new device
- workspace control: ownership, member roles, removing or disabling members and agent members, all invites, joining from an invite, the single sign-on rule
- connecting outside accounts: mail, social, chat channels, AI providers, Xero, outside calendars
- mail leaving the workspace: creating or editing mail rules, aliases, mailbox sharing and mailbox settings

**What the customer sees.** The workspace's Activity log shows "opened a Multies support session as" the person, with your address, the mode, the expiry and your reason. It shows "ended a Multies support session as" when the session is ended: you choose Stop, an admin chooses End session, the person is signed out or banned from Users (the entry names the operator who did it), you lose access, or the server notices the time limit on the session's next request (those two name you). A session whose 30 minutes simply run out while nobody uses it has no ended entry; its start entry already says when it expired.

**Seeing and ending sessions.** Operators, Support sessions (`/console/operators?tab=sessions`) lists sessions: Active now by default, or Ended, or All. Each row shows the operator, the person, the workspace, the mode (View only or Acting), when it started, when it ends or ended (with how: stopped by the operator, time limit reached, ended by an admin, operator lost access, or person signed out from Users) and the reason given at the start. Operations admins and owners can choose End session on an active row and give a reason (`POST /api/console/impersonation/{id}/end`). The session ends at once: at their next action the operator leaves the person's account and signs in again to their own. The console's audit log and the workspace's Activity log both record it. Signing the person out from their page in Users (that one session, marked "opened by an operator", or Sign out everywhere), banning them or deleting their account also ends it: the row moves to Ended at once and the workspace's Activity log records it.

Search matches the operator's address, the person's name and address, the workspace's name and the reason. Every operator role can read the sessions list through the API (`impersonation.read`), but the Operators page, and so the tab, opens only for operations admins and owners.

**Limits to know.**

- In act mode, entries written to the workspace's audit log name you (the operator's id is stored with the entry). Changes that do not write an audit entry, such as editing a task or sending a chat message, look like the person did them.
- Invites are blocked entirely, member invites included, because the server can't tell the role from the address alone.

## 7. Feature flags

The registry is `src/shared/feature-flags.ts`; the rules are in `src/server/services/console/flags.ts`.

- **Scopes.** A platform wide flag has one value for everyone. A workspace flag can also have a value for one workspace. A flag is platform wide when the server can only read it without a workspace at hand (public pages, scheduled passes).
- **Order.** The deployment's own setting, then the platform wide override, then the workspace's override. With no overrides at all, everything behaves as the deployment's settings say.
- **The lock.** A locked platform wide value wins over every workspace override (a kill switch). Only the platform wide value can be locked.
- **Set at deploy.** Some flags are read once when the server starts (their routes are added at start, or the sign in page is built then), are read in sign in code the console can't change yet, or protect access or a duty (form passwords, portal access levels, the anonymous reporting channel, e-sign email codes, trash for tables and courses). The console shows these as set at deploy, gives the reason, and refuses overrides. Change them in the deployment's settings.
- **Timing.** Other servers see a change within a minute.
- **Legal holds.** A change that would turn the mail archive off for a workspace with an active legal hold is refused (`legal_hold_active`). Release the hold first. The holds themselves apply whatever the flag says.
- **Background work.** Scheduled passes for a workspace flag follow each workspace's value: a workspace turned off is skipped, and a workspace turned on is served even while the platform wide value is off.
- Who can change what: workspace values need an operations admin or owner; platform wide values need an owner and a recent sign in.

## 8. Reasons and the audit log

- Every console change records your reason with your address, role, IP address, browser and the request id. A change that fails is not recorded as done.
- Most changes to a workspace are also written to that workspace's own Activity log, with your reason, so workspace owners and admins can see what was done and why, including in the Activity export (CSV or JSON). Notes are staff only and never go there.
- Refused attempts are logged too: when an operator is refused a console change (no permission, no recent sign in, no two-step, or while viewing as someone) the log gets an `access.denied` row naming the route, at most one per operator per route per minute. Reads are not logged.
- The log can't be edited: nothing in the app updates or deletes its rows.
- Filter by Area (the kind of action), When (the last day, 7 or 30 days) or a From and To day range (whole days in your time zone; a range replaces When), and the workspace (type part of its name). A row's Details has Only this operator and Only this target. Every filter lives in the address, so a link opens the same view: `/console/audit?orgId=...`, `?actor=<user id or address>`, `?targetType=user&targetId=...`, `?from=2026-11-17&to=2026-11-17`. Search matches the action, the operator's address, the target id and the reason. Owners can export the filtered log as CSV, up to 5,000 rows; the export itself is logged.

## 9. Trends

`src/server/services/console/metrics.ts`.

- **Daily record.** Once a day, on the first maintenance pass after midnight UTC, the console stores yesterday's numbers. If passes were missed, it catches up to 7 days. It skips while optional writes are paused because the database is near its daily write budget.
- **Counts per day** (sign ups, new workspaces, mail sent and failed, AI calls and units, agent runs and failures, dead jobs, abuse signals, reports, failed webhook deliveries) are worked out from the records, so they can be filled in for past days.
- **Rolling up by hand.** `POST /api/console/metrics/roll` (operations admins and owners, with a reason) stores the daily record now instead of waiting for the next maintenance pass. There is no button; it is rarely needed.
- **Fill in history** on the Overview (operations admins and owners, with a reason) recomputes those counts for the last 7, 30 or 90 days. It shows only when none of those counts has a stored day in the range shown.
- **Totals** (accounts, workspaces, paid, comped, past due, suspended, mailboxes, verified domains, mail storage, D1 rows written, uptime) can't be filled in. Their history starts with the first daily record after deploy; today's value is live.
- **AI history.** AI usage is kept for 2 days, so AI calls and units can only be filled in for the last 2 days. Dead jobs and failed webhooks are kept 30 days, so they go back 29 days.
- A day with no record shows as a gap, never as 0.

## 10. Lists that show recent activity only

Some lists across every workspace read busy tables that have no index for that list (an index there would cost a database write on every new row). Those lists look only at the newest 5,000 rows of the table, and show "Showing recent activity only. Pick a workspace to see older rows." (`src/server/services/console/recent-rows.ts`). This applies to:

- Mail: deliveries with any status other than the failure ones, across workspaces.
- Agents: runs by a status other than failed or long running, across workspaces.
- Developer: delivered webhook deliveries across workspaces, OAuth grants across workspaces, and OAuth apps (apps have no workspace, so that list always shows recent registrations only).

To see older rows, pick a workspace in the list's filters. Failed deliveries, failed runs and failed webhook deliveries are not limited this way.

## 11. Deploying this change

### Migrations

Apply in order with the usual `npx wrangler d1 migrations apply` ([deploy.md](deploy.md)):

| Migration | Adds |
| --- | --- |
| `0171_platform_audit_ops1` | The platform audit log table `platform_audit_logs` and its indexes. |
| `0172_operator_notes_ops1` | `operator_notes`, private notes on a workspace or person. |
| `0173_operator_impersonations_ops1` | `operator_impersonations`, one row per View as session. |
| `0174_billing_comp_ops1` | `billing_events.summary`, and `organizations.comp_until` and `comp_note`. |
| `0175_feature_flag_overrides_ops1` | `feature_flag_overrides`, the flag overrides. |
| `0176_platform_metrics_daily_ops1` | `platform_metrics_daily`, the daily trend numbers. |
| `0177_console_indexes_ops1` | Indexes for the console's lists across workspaces. |

**One-time cost of 0177.** Building its indexes reads each table once: `deliveries` and `agent_runs` are the big ones, plus `send_approvals`, `suppressions`, `import_jobs`, `data_moves` and `users`. It writes one index row per failed, rejected, bounced or complained delivery, per failed agent run and per pending send approval, and one per row of `suppressions`, `import_jobs`, `data_moves` and `users`. Before applying, count those rows and check them against the day's budgets (100,000 rows written and 5 million read per day on the Free plan, shared by production and staging; [d1-daily-limits.md](d1-daily-limits.md)), check `writes.level` on `/api/admin/health` is `ok`, and apply it off peak.

**Ongoing cost.** One extra row written each time a delivery becomes failed, rejected, bounced or complained, an agent run fails, a send approval is created and again when it is decided, an account signs up, an address is suppressed, an import starts, and an export or data move starts. Ordinary deliveries, runs and approvals cost nothing extra. The daily trends write about 23 rows a day.

### Settings

New: `OPERATOR_REQUIRE_2FA`, `OPERATOR_SSO_METHODS`, `OPERATOR_FRESH_MINUTES` (section 3). All are optional and in `.env.example`. `PLATFORM_ADMIN_EMAILS` is unchanged. In production the two-step rule is on unless set to `off`, so do the go-live checklist in section 3 first.

### Removed routes

Better Auth's own `/api/auth/admin/*` answers 404 for everyone. Under `/api/admin`, only three reads remain, all for operators:

- `GET /api/admin/health` (the deploy and smoke scripts read it)
- `GET /api/admin/status`
- `GET /api/admin/reports/count` (the report count in the menu)

Every other `/api/admin` path answers 404, for operators too (`src/server/routes/admin.ts`, `src/server/routes/reports-r35.ts`, `src/server/app.ts`). Where each one went:

| Old | Now |
| --- | --- |
| `GET /api/admin/overview` | `GET /api/console/overview` |
| `GET /api/admin/users`, `DELETE /api/admin/users/:id` | `GET /api/console/users`, `DELETE /api/console/users/:id` |
| `GET /api/admin/abuse`, `POST /api/admin/abuse/resolve` | `GET /api/console/moderation/abuse`, `POST /api/console/moderation/abuse/resolve` |
| `POST /api/admin/workspaces/:id/suspend` and `/unsuspend` | `POST /api/console/workspaces/:id/suspend` and `/unsuspend` |
| `PUT /api/admin/workspaces/:id/send-cap`, `/sending`, `/meeting-cap` | `PUT /api/console/workspaces/:id/send-cap`, `/sending`, `/meeting-cap` |
| `GET /api/admin/workspaces/:id/queued-sends`, `POST .../queued-sends/:sid/send` | the same paths under `/api/console/workspaces` |
| `GET /api/admin/jobs`, `POST /api/admin/jobs/replay` | `GET /api/console/jobs`, `POST /api/console/jobs/replay` |
| `POST /api/admin/sentry-test` | `POST /api/console/system/sentry-test` |
| `GET /api/admin/reports`, `POST /api/admin/reports/:id/action` | `GET /api/console/moderation/reports`, `POST /api/console/moderation/reports/:id/action` |

Every console change needs a `reason` in its body. The scripts in `scripts/` and the runbooks only use the three reads that remain.

## 12. Not yet tried in production conditions

These parts are covered by tests in Node with local SQLite and fakes, and have not been checked on the real services yet:

- The Cloudflare Workers runtime paths: closing a viewed person's live chat and doc connections (Durable Object sockets), and the queries and index plans on D1.
- Real browser cookie behaviour when starting and stopping View as (the operator's own session is set aside and restored).
- Billing actions against real Stripe; they were tested against a fake. Try each action once in Stripe test mode before relying on it.
- The Auth0 tenant's multi-factor policy. Check it before listing `auth0` in `OPERATOR_SSO_METHODS`.

## 13. Troubleshooting

| Code | What it means | What to do |
| --- | --- | --- |
| `two_factor_required` | This session did not give a second factor at sign in (section 3). `details.reason` says whether two-step is off (`not_enrolled`) or on but not given by this session (`no_second_factor_this_session`), and the console card says the matching fix. | If two-step is off, turn it on in Account and security, then open the console again in that session. If it is on, choose Sign in again and sign in with your password and code (or a passkey). The same code on adding a passkey means the same thing for an operator account. |
| `SECOND_FACTOR_REQUIRED` | An operator's session that gave no code tried to view the authenticator setup or make new backup codes (section 3). | Sign out, sign in with your password and code, then try again. |
| `step_up_required` | The action needs a sign in from the last `OPERATOR_FRESH_MINUTES` minutes. Nothing was changed. | Choose Sign in again, then repeat the action. |
| `forbidden` | Your role can't do this, or the account is not an operator, or (when starting View as) your role can view but not act. | Ask an owner for a different role if you need it. |
| `impersonating` | You are viewing as someone, so the console is closed. | Choose Stop in the bar at the top. |
| `impersonation_blocked` | While viewing as someone, the action is always blocked or you are in view mode. | Ask the person to do it, or stop and use the console. |
| `cannot_impersonate_operator` | The person is an operator or listed in `PLATFORM_ADMIN_EMAILS`. | Ask them to share their screen. |
| `protected_account` | Mark verified was refused because the account is an operator or listed in `PLATFORM_ADMIN_EMAILS`. | The person confirms the address from the email we send. |
| `target_is_operator` | Ban, delete, lockout or session changes are refused on an operator account; clearing an operator's lockout is owner only. | Change their access on the Operators page first, or ask an owner. |
| `env_managed` | The operator is listed in `PLATFORM_ADMIN_EMAILS`. | Change the deployment setting. |
| `last_owner` | This is the only owner. | Make someone else an owner first. |
| `two_factor_off` | You tried to give or change a role for an account without two-step sign in. | Ask them to turn it on first. |
| `legal_hold_active` | The flag change would turn the mail archive off for a workspace with an active legal hold. | Release the hold first. |
| `billing_unavailable` | Stripe is not connected on this deployment. | Comp and grace still work; the rest needs Stripe. |
| `bad_cursor` | A list's page link is out of date. | Start the list again. |
