# Dogfood: running a company inside Multies

We run a real startup (Haajir, with Tab as CEO, the owner as board chair and a team of AI
agents) inside a Multies workspace, so every feature gets used for real and every rough edge
becomes a ticket. Two scripts do the setup and the day to day posting; both talk to the public
REST API (`/api/v1`) with API keys.

## Scripts

| File | What it does |
| --- | --- |
| `scripts/dogfood/org-setup.ts` | Builds the whole org from one JSON config: workspace, AI agent members with their own keys, channels with a purpose and a welcome post, projects and tasks, goals and key results, docs, a weekly meeting, task templates, invites. Idempotent: it finds each item by name and creates only what is missing. |
| `scripts/dogfood/post-update.ts` | Posts an update (a release note by default) to a channel as one of the agents, and moves the tasks it closes to done. |
| `scripts/dogfood/example-org.json` | An example config with every field used. |
| `scripts/dogfood/findings.json` | The findings below as tasks for a "Dogfood findings" project; add with `--merge`. |
| `e2e/dogfood-tour.mjs` | Walks the main screens at 1440 and 390 px in light and dark, records console errors, failed requests, overflow and headings, and saves a screenshot of each. |

### Config shape

```
workspace  { name, timezone?, domain? }        domain hosts the agents' addresses
founder    { name, email, title? }             the account the script signs in as
invites    [{ email, role: admin|member, name?, title? }]   sent only with --send-invites
agents     [{ key, name, title, bio, inbox?, localPart?, approvalMode? }]   agent members by default; inbox: true makes a mail agent
channels   [{ name, purpose, welcome?, welcomeBy?: "agent:<key>" }]
projects   [{ name, key?, color?, description?, owner?, tasks?: [{ title, notes?, priority?, due?, assignee?, labels?, status? }] }]
goals      [{ name, description?, due?, keyResults?: [{ name, kind?, start?, target?, current?, unit?, project? }] }]
docs       [{ title, text, project? }]         text: one paragraph per line, # headings, - bullets
meetings   [{ title, weekday (0 Sunday), time "HH:MM", timezone, durationMin?, prepTask?: { project, assignee? } }]
templates  [{ name, kind?: task|doc, description?, category?, title, notes }]   notes is the body of a doc template
```

People references: `member:self` (the founder), `member:<email>` (a member who has joined),
`agent:<key>` (an agent from the `agents` list). Since round 12 agents are agent members: a
title, a bio (which should say it is an AI agent), their own key ("<Agent name> key"), no seat
and no mailbox, 10 on Free. Channel purposes go through `PATCH /api/v1/chat/channels/{id}`, each
welcome post is pinned, and templates are written from scratch with `POST /api/v1/templates`
(`kind: doc` for a doc template, with `notes` as its body).

### Run locally

```
npm run build:web
PORT=8796 DATABASE_PATH=/tmp/dogfood/a.db OUTBOX_DIR=/tmp/dogfood/out APP_URL=http://localhost:8796 npx tsx src/entry/node.ts
ORG_PASSWORD=<any strong password> npx tsx scripts/dogfood/org-setup.ts \
  --config scripts/dogfood/example-org.json --merge scripts/dogfood/findings.json \
  --base http://localhost:8796 --state /tmp/dogfood/state.json
```

A second run with the same config makes no new items (only a workspace switch).

### Run on production

Run once after the daily D1 write reset (00:00 UTC). The founder password is in
CREDENTIALS.local.md, section "Haajir workspace (dogfood, added 2026-10-24)".

```
cd /home/user/tab/work/mymail/app
ORG_PASSWORD='<from that section>' npx tsx scripts/dogfood/org-setup.ts \
  --config /home/user/tab/files/haajir/org-config.json --merge scripts/dogfood/findings.json \
  --base https://multies.si --state /home/user/tab/work/mymail/dogfood-state/haajir-prod.json \
  --send-invites
```

Add `--dry-run` first to see the plan: it signs in and reads, and prints each write instead of
making it. `--send-invites` sends the real invite emails (the board chair's). If password sign in
is switched off on prod by then, sign in on the web and pass the session cookie as
`ORG_SESSION_COOKIE` instead of `ORG_PASSWORD`.

Credentials: the script never prints a key. The workspace key ("Org setup script") and one key
per agent ("<Agent name> agent key") go to the state file (mode 600, outside the repo).

Write cost: a fresh run of the example config plus the findings made 240 new rows locally
(56 activity, 56 change log, 30 tasks, 24 project statuses, 10 audit, the rest one or a few
each) in 72 calls, well under the 1,500 row budget for a prod run. A re-run costs one or two.

### After every production deploy (the builder)

```
npx tsx scripts/dogfood/post-update.ts --base https://multies.si \
  --state /home/user/tab/work/mymail/dogfood-state/haajir-prod.json \
  --release <release id from /api/config> --notes-file <notes.md> \
  --tasks "<task ref, id or exact title>|<another>" [--label release:<id>]
```

It posts "Release <id>" with the notes in #releases as the Builder agent, closes the listed
tasks (and any open task with the label), and links them in the post. A second run with the
same release id posts nothing. About 1 + (tasks closed) writes.

## Findings, ranked

Found on 2026-10-24 by setting up an example startup on a local build (main at 7e0dcd9 plus the
round 11 work in progress) through the API and the web app at 1440 and 390 px, light and dark.
The full steps to reproduce for each are in `scripts/dogfood/findings.json` and land as tasks in
the "Dogfood findings" project. The tour found no console errors, no failed requests and no
horizontal overflow on inbox, mail, chat, tasks, goals, docs, meetings, team, settings, agents,
templates, notifications, integrations or portfolio.

1. **High.** `GET /api/v1/docs` answers the API reference page instead of the docs list (the two share a path), so no integration can list docs and find-or-create makes duplicates.
2. **Fixed in round 13** (an agent member's key posts under its name with its title and an agent label; a workspace key posts as the workspace). Chat shows an agent's post as `API key "Builder agent key"` instead of "Builder"; a workspace key's post shows as a member named `API key "Org setup script"`.
3. **High, top feature.** Agents are mail inboxes, not team members: each needs a mailbox on a domain, they are missing from People and Settings Team, the Agents page shows only addresses (no title or bio), and Free stops at 3, so a six agent team cannot be built.
4. **Medium.** Members have no title or bio; invites cannot carry one; nobody can be invited as Owner (only admin or member).
5. **Medium.** Key results that count down ("open high severity bugs, 10 to 0") show "10 of 0" and 0 percent.
6. **Medium.** Meetings cannot repeat, and meeting times show in the browser's zone with no label (a Monday 10:00 Sydney meeting reads "Sun, 25 Oct, 11:00 pm" in a UTC browser), while chat times follow the workspace zone.
7. **Medium, partly fixed in round 12** (channel update, pins, templates create, docs delete and the people list are in /api/v1; creating a workspace, minting the first key and inviting still need a session). Public API gaps: no route to create a workspace, mint the first key, invite or list members, update a channel, pin a message, create a template or delete a doc.
8. **Fixed in round 12.** Chat has no pinned messages, so each channel's welcome and rules scroll away.
9. **Fixed in round 12** (doc templates with two starters, templates from scratch in the app and the API). Templates are only for projects and tasks, saved from an existing item; no doc templates and no template from scratch.
10. **Medium.** Phone: Tasks opens as a board with the second column cut off; goal key result names wrap to four lines; the chat composer shows keyboard hints and a sample ref (OPS-12) from another workspace.
11. **Medium, unblocked in round 13; the builder finishes it after the deploy** (multies.si per docs/runbooks/multies-si-mailboxes.md; a customer domain on any DNS provider now receives through the provider's MX, see docs/transactional-email.md). Inbound: support@ and security@ on the company domain do not reach the workspace shared inbox yet (the builder owns the Email Routing side).
12. **Fixed in round 13** (To do, In progress, In review, Done). New projects default to the email status "Waiting on reply".
13. **Fixed in round 13** (a new sign in opens the workspace used last; the first workspace stays, since a new account needs a place to land). Sign up makes an extra empty workspace, and a new sign in opens it rather than the last one used.
14. **Fixed in round 13.** The docs list preview repeats the title and runs headings into the body.
15. **Fixed in round 13** (members first, agents counted beside seats, SSO card last). Settings Team leads with the single sign on card; agents are not shown beside the seats.
16. **Fixed in round 13** (grouped into Work, Mail and Admin; Team inbox is now Shared inbox under Mail). The sidebar has Mail and Team inbox side by side and more than 20 items.
17. **Fixed in round 13** ("Video calls aren't switched on for this workspace yet"). Copy: "Video isn't switched on for this Multies yet".
18. **Fixed in round 13** (support@multies.si). On the node entry without SUPPORT_EMAIL, `/api/config` reports the old support@mymail.au.

## Screenshots

Haajir HQ on the local build, light and dark, desktop and phone, in
`/home/user/tab/files/dogfood-org/` (not in the repo): haajir-hq-desktop-light-chat,
haajir-hq-desktop-dark-tasks, haajir-hq-desktop-light-goals, haajir-hq-desktop-dark-docs,
haajir-hq-phone-light-chat, haajir-hq-phone-dark-tasks.

## The Haajir config on the local build

`/home/user/tab/files/haajir/org-config.json` with `--merge scripts/dogfood/findings.json` ran
clean locally: workspace Haajir HQ, 3 of 7 agents (Builder, Design, Growth; Partnerships,
Success, QA and Finance stop at the Free plan's 3 agent inboxes, finding 3), 11 channels with
welcome posts, 5 projects with 55 tasks, 3 goals with 12 key results, 5 docs, 2 weekly meetings
with prep tasks, 3 templates. 342 new rows in 107 calls. A second run made no new items. The
invite to the board chair is skipped unless `--send-invites` is passed. For post-update.ts on
this org pass `--agent cto` (the config's key for Builder).
