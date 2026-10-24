# Multies brainstorm, 25 October 2026

The question: what makes a startup pick Multies over Google Workspace, Zoho or monday, and what makes it stay. Each idea below was checked against the code on main (9e18a99) so it is new, not a rename of something we already ship.

What already exists, so it is not on this list: custom domain mail with DKIM, SPF and DMARC checks and DMARC reports, IMAP import from Gmail and Outlook, getting started checklist, tasks with boards, timeline, dependencies, custom fields, forms, docs with co-editing, chat, meetings with recurrence, scheduling links, goals, portfolio, time tracking, deals and contacts, guests, automations, webhooks, MCP server, agent members, agent approvals with modes (always, external, never), recipient allow lists, daily send caps, pause, audit log, passkeys, add-ons with Stripe, status page, legal pages with a sub processor list, mobile app with inbox, chat, tasks, approvals and push.

Scale. Impact: High, Medium, Low (effect on signups, activation or retention for a 2 to 20 person startup). Effort: S is under a day, M is 2 to 4 days, L is a week or more.

## The 15 ideas

### Growth loops

1. Public domain mail check at multies.si/check
   Impact High. Effort S.
   Anyone types a domain and sees who hosts its mail today (Google Workspace, Microsoft 365, Zoho, Fastmail, Proton, other), whether SPF and DMARC are set, and a step by step plan to move to Multies without losing a message. No sign in, no database writes, only public DNS reads. Founders search "check my email DNS" and "move off Google Workspace"; a useful free tool ranks and gets shared, and every result ends in "Start free with this domain". It also gives sales and support a link to send.

2. "Sent with Multies" footer, opt in only
   Impact Medium. Effort S (one setting column).
   An optional one line footer on outbound mail for free workspaces. Off by default, because a forced footer on business mail would cost us the trust we are selling. Worth testing only after idea 1, since it needs a migration and a settings toggle.

3. Founder referral that pays in add-ons, not cash
   Impact Medium. Effort M.
   When a workspace refers another startup that verifies a domain, both get a free add-on month (extra domain or agent inbox). Costs us almost nothing because add-ons are cheap to serve. Needs referral codes, a credit ledger and Stripe coupon handling, so it waits until billing is live with real customers.

4. Public share links for docs and task lists
   Impact Medium. Effort M.
   Read only links for a doc, a board or a form result, with a small "Made in Multies" mark. Startups send roadmaps, hiring plans and client updates to outsiders every week; each link is a product demo. Guests exist, but there is no link that works without an account.

### Onboarding and switching

5. In app switch plan on the domain page
   Impact High. Effort S once idea 1 exists.
   The same provider detection inside Domains: when a team adds a domain that Google or Microsoft hosts, the domain page says so and orders the steps (add the domain without touching MX, import old mail, lower the MX TTL, switch MX, keep the old plan for 14 days). Today the page shows records but not the order or the risk, which is where people get scared and stop.

6. Undo send and schedule send
   Impact Medium. Effort S for undo, M for schedule.
   Both are table stakes for anyone leaving Gmail. Undo send is a short hold in the browser before the request goes out: no server change and no database writes. Schedule send needs a send_at column and the cron pass, so it costs one migration.

7. Out of office replies and per mailbox signatures
   Impact Medium. Effort M.
   Two gaps people hit in the first week. Signatures need one column per mailbox. Auto replies need loop protection (one reply per sender per period, skip lists, bulk mail headers) and a small table, so they cost writes on inbound mail and need care with the D1 budget.

### AI agents

8. Earned autonomy for agents
   Impact High. Effort S.
   Every agent already leaves a record: approvals approved as is, approved after edits, rejected, expired. Show that record on the agent page and suggest the next step: after 20 sends with no edits and no rejections, offer to move from "always" to "outside the workspace only"; after rejections, suggest tightening. This is the honest answer to "can I trust this agent", it is unique to a suite where agents are members, and it reads data we already store.

9. Approve from the phone lock screen
   Impact High. Effort M.
   Push notifications for approvals with Approve and Reject buttons (iOS notification categories, Android actions), confirmed with Face ID or the device passcode. Approvals are the moment the product proves its value, and today they need three taps and an app open.

10. Agent sandbox mode
    Impact Medium. Effort M.
    A switch per agent that delivers every send to a test inbox inside the workspace instead of the real recipient, with a banner on each message. Lets a founder try an agent against the real inbox on day one without risk. Fits the existing send path as one more check before delivery.

11. Weekly agent report
    Impact Medium. Effort M.
    One email and one notification each Monday: what each agent sent, what waited for approval, what was rejected, how much of the monthly agent allowance is used. Turns invisible agent work into something the owner sees and forwards. One email per workspace a week, so the write cost is small.

### Pricing

12. Cost comparison on the pricing page, with the visitor's own numbers
    Impact Medium. Effort S.
    A small calculator: seats today, what you pay per seat now, which tools (mail, chat, tasks, meetings). It shows a year's spend next to Multies. No competitor prices hard coded, because they change and a stale number reads as dishonest; the visitor types their own.

13. Compliance pack add-on
    Impact Medium. Effort L.
    Longer retention, legal hold, full audit export and an annual access review, priced as an add-on. Startups selling to enterprises get asked for this in security questionnaires. Real revenue, but it needs retention jobs and export work, so it is later.

### Trust and security

14. Trust page
    Impact Medium. Effort S.
    One public page that answers a security questionnaire in plain words: where data lives (Oceania), sub processors, encryption, backups and restore tests, sign in options (passkeys, 2FA), incident history from the status page, how to report a vulnerability, DPA link. The content mostly exists across legal pages and docs; nobody can find it in one place.

### Mobile

15. Share to Multies from any app
    Impact Medium. Effort M.
    An iOS and Android share target: share a link, photo or PDF from any app into a new task, a chat message or an email draft. Moves Multies from "an app I check" to "where I put things", which is what keeps a work app on the home screen.

## Top 5 for the next two weeks

Ranked by impact for the effort, and by what can ship without new database tables while the D1 write budget is tight.

1. Public domain mail check plus the in app switch plan (ideas 1 and 5). It is the top of the funnel and the scariest step of switching, solved with read only DNS. Built tonight.
2. Earned autonomy for agents (idea 8). The clearest proof that agents as members is a real difference, and it reads data we already have. Built tonight.
3. Approve from the lock screen (idea 9). Makes approvals fast enough to use all day.
4. Undo send, then schedule send (idea 6). Removes the most common "I can't leave Gmail" objection.
5. Trust page (idea 14). Mostly writing, and it unblocks startups that sell to larger customers.

Not in the top 5 on purpose: the referral (needs billing live first), the compliance pack (large), and the footer (risks trust before we have any).
