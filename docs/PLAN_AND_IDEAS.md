# Multies: plan, launch blockers and ideas

Written 26 Oct 2026, about 5:55 PM Sydney (06:55 UTC), by a separate Tab working for Bidur (the one that runs "Transport: Sydney Live"). This was a read-only review: App Store Connect was read with GET calls only, multies.si was read in a browser, and this repo was read through the GitHub API at main `120c346`. Nothing in App Store Connect, Cloudflare or the code was changed. This file is the only thing added.

Bidur asked (26 Oct, 5:38 PM): "Have a look at whats happening with multies and haajir and suggest or give them better plans and ideas and brainstorm." This repo already has `docs/strategy/brainstorm-2026-10-25.md` and `docs/plan/2026-10-25-product-plan.md`; this file is a second opinion from outside, mostly about launch and focus. Where a number comes from a web search snippet rather than a page read, it says so.

## 1. Where it stands now

App Store Connect (app 6826562106, bundle au.fintex.multies), as read at 06:45 UTC:

| Item | State |
| --- | --- |
| Version | 1.8.1, PREPARE_FOR_SUBMISSION, created 24 Oct |
| Build attached to 1.8.1 | None |
| Builds | 12 (1.8.1) to 17 (1.9.3), all VALID, internal TestFlight group "Fintex" only |
| JS on phones | 1.9.7 by OTA (RELEASES.md, commit `120c346`) |
| Review details | Filled (contact, demo account, notes) |
| Age rating | Answered; Apple computed 4+ (`mobile/store/apple/age-rating.md` expected 13+; either is fine) |
| Price | Free |
| Availability | All 175 territories, including China mainland |
| Screenshots | 7 at 6.7 inch, 7 at 6.5 inch. No previews |
| Description, keywords, promo text, URLs | Filled |
| App Privacy label | Not readable through the API. `mobile/store/apple/app-privacy.md` holds the answers |
| Apple team | B85KQRQZW7, an individual account; conversion to Fintex Australia Pty Ltd pending (`mobile/docs/STORE.md`) |

Live site (multies.si): landing, pricing, privacy, terms, support, delete account, status and trust pages all exist. The privacy page still says "Draft for review by an Australian lawyer before launch. It ... is not yet legal advice or a final agreement."

Infrastructure (from this repo's runbooks):
- Cloudflare Workers Free plan, with production and staging on one account. The D1 cap of 100,000 rows written a day was hit on 24 Oct (`docs/runbooks/d1-daily-limits.md`); at the cap Multies answers "read only for a short while". Durable Object time is capped at 13,000 GB-s a day (`docs/runbooks/live-mail.md`).
- Outbound mail goes through a sending provider on its free plan. That plan's domain cap is full with `multies.si` and `haajir.xyz`, so new customer domains wait in a queue and cannot send to outside addresses until a slot frees (`docs/runbooks/domain-cap.md`). Resend's free plan, which `deploy/au/README.md` names as the sender, is 100 emails a day, 3,000 a month and 3 domains (resend.com/pricing, search snippet).
- Haajir's auth mail and absence alerts also go out through Multies, so they share the same daily limit.
- Expo emailed on 25 Oct that the account's monthly build limit was reached. Haajir builds on the same Expo account (`multies-fintex`).
- Feature surface after 31 rounds in about a week: email hosting, shared inboxes, tasks, boards, docs, chat, meetings with recording, forms, goals, agent runs and triggers, and 169 MCP tools.
- The GitHub account MaisySen has two-factor authentication off (GitHub /user answers `two_factor_authentication: false`).

## 2. Launch blockers

Apple blockers:

1. Version and build mismatch. The store version is 1.8.1, but the build worth shipping is 17 (1.9.3), which carries the OTA runtime phones use now. Change the version string in App Store Connect to 1.9.3 and attach build 17. Attaching build 12 would ship old native code under the 1.9.x JS.
2. China mainland. A new app in the China storefront needs an ICP filing number. Without one, take China off availability so it does not hold up the release.
3. EU Digital Services Act trader status. Apple needs a trader declaration before an app can be on EU storefronts; as a business, Multies is a trader, and the address, phone and email become public on the listing. Check Business, then DSA, in App Store Connect. This is not readable through the API.
4. App Privacy label: enter the answers from `mobile/store/apple/app-privacy.md` if that has not been done.

Business blockers (Apple will approve without these, but customers will hit them):

5. Outside sending is capped at the free plan. The site promises "Free forever for 1 domain, 3 mailboxes and 3 agent inboxes", but only one more customer domain can send outside before the queue starts, and 100 emails a day are shared by everyone, Haajir included. One busy customer stops everyone's mail by mid-morning. This is the most important thing to fix before inviting anyone.
6. Cloudflare Free plan read-only days. One busy day of real mail can hit 100,000 D1 writes, as staging and demo seeds did on 24 Oct. Workers Paid (US$5 a month) lifts the daily caps to monthly ones. Move staging to its own account either way.
7. Seller name. With an individual Apple team, the App Store shows Bidur's own name as the seller while the app and the policies say Fintex Australia Pty Ltd. For a business email product that is a trust problem. Converting the team to Fintex needs a D-U-N-S number.
8. The "draft for review by a lawyer" line on the live privacy page. Get the review done, or reword it, before public launch. Done 27 Oct 2026: the owner decided to publish the legal pages as final (effective 27 October 2026, NSW law); the notice is gone.

## 3. Launch plan, in order

1. Freeze new features for one round. Spend it on sending capacity, the Cloudflare plan, deliverability and abuse controls (sections 6 and 4).
2. In App Store Connect: version 1.9.3 with build 17, remove China, set DSA trader status, check App Privacy, write "What's new". Keep "Explore with sample data", which makes review easy (guidelines 2.1 and 4.2).
3. One real iPhone run through the review notes path: sign in through the browser page, approve an agent message, delete account.
4. Bidur's OK, then submit.
5. Soft launch to 10 Australian small businesses you know. Measure: domain set up within 30 minutes, first outside email in the inbox (not spam) at Gmail and Outlook, weekly active mailboxes.
6. Then marketing: the free domain checker (`/check`) as the way in.

## 4. Product ideas, ranked by impact against effort

| # | Idea | Impact | Effort | Why |
| --- | --- | --- | --- | --- |
| 1 | Sending that scales with customers | High | Medium | A pay per email sender with no domain cap fits multi-tenant hosting. A paid plan with a 10 domain cap only moves the wall |
| 2 | Narrow the pitch to one wedge: "email on your domain where AI agents ask before they send" | High | Low | Agent inboxes plus a human approval queue plus MCP is unusual. Tasks, docs, forms and meetings become "also included", not the headline |
| 3 | Abuse and reputation guard | High | Medium | Shared sending reputation means one spammer hurts every customer. New accounts get low daily send limits that grow with good history, plus outbound spam scoring and a kill switch per workspace |
| 4 | Inbox placement test on every release | High | Low | Send to seed Gmail, Outlook and iCloud mailboxes and check inbox, not spam. Mail that lands in spam ends an email company |
| 5 | Switch from Google Workspace in 10 minutes | High | Medium | The IMAP import exists. A guided move plus a savings calculator (Google Workspace starts around US$7 per user a month, workspace.google.com via search snippet) sells the "no per person pricing" promise |
| 6 | Shared inbox assignment on the phone | High | Low | Push for "assigned to you" and one-tap reply on a shared hello@ address is the phone app's best job. Keep docs, forms and meetings on the web |
| 7 | Free DMARC and domain checker for SEO | Medium | Low | `/check` exists. Pages like "DMARC checker Australia" bring owners whose email is already broken |
| 8 | ABN check at sign up for Australian businesses | Medium | Low | Fewer fake accounts and a clear Australian focus |
| 9 | Accountant and web designer partners | Medium | Low | They set up email for many small businesses. A partner dashboard for many domains |
| 10 | Xero link: invoice emails become tasks | Medium | Medium | Fits Australian small businesses and the "tasks from email" feature |
| 11 | Australian hosted tier | Medium | High | `deploy/au` is ready as groundwork. Sell it as a paid tier to accountants, health and legal practices that ask where data lives |
| 12 | Opt-in "Sent with Multies" footer on the free plan | Low | Low | Free growth from every outside email |
| 13 | Turn off or hide what is not used | Medium | Low | Each feature adds support, security and review surface. Use the activity data to retire the least used |

## 5. Positioning and money

- Market prices (search snippets): Zoho Mail is free for up to 5 users on one domain in some regions, without IMAP. Migadu charges by usage, from about US$19 a year, with unlimited domains and addresses. Proton and Google Workspace charge per user. Shared inbox tools like Missive and Front charge about US$14 to US$105 per user a month.
- Multies' edge: priced per business, not per person, plus tasks from email and safe AI agent sending. Lead with "your whole team on your domain, one small bill, and AI that asks first".
- The current add-ons (A$1 a domain, A$3 per 5 mailboxes, A$2 per 20 GB or per 1,000 sends a day) are cheap and clear. Make sure each add-on costs more than it costs you. Outside sends are the expensive part.
- Keep the phone app free of prices and purchase links, as now. It is a companion to a service businesses buy on the web.

## 6. Costs and security

- Cloudflare: Workers Paid (US$5 a month) for production. Keep staging on a separate account so tests never eat production limits.
- Sending: today 100 emails a day for Multies and Haajir together. Track sends per day per workspace and alert at 80%.
- Meetings run on LiveKit Cloud; its free Build plan has monthly allowances (livekit.com/pricing, search snippet). Cap meeting minutes per free workspace so a few long calls cannot create a bill.
- Expo: the monthly build limit is shared with Haajir. Plan native builds together, and ship JS by OTA.
- Turn on two-factor authentication for the GitHub account MaisySen. It holds every private repo, including this one.
- GitHub Actions on private repos has no minutes left until 1 November (`mobile/docs/STORE.md`). Do not rely on CI alone for release gates this week.
- Demo review password: it is only in App Store Connect, not in this repo. Keep it that way.

## 7. Store listing

- Subtitle (30 max): "Business email on your domain" is clear. A stronger option is "Email, tasks and AI approvals" (29).
- Keywords (100 max) today: `custom domain,inbox,small business,approvals,AI,team,shared inbox,Australia,timer,CRM,projects`. "CRM" promises something the app is not, and "timer" is weak. Suggested: `domain email,business email,shared inbox,custom domain,mail,AI agent,approvals,tasks,team,small business`.
- First screenshot message: "Your business email, on your own domain". Second: "AI agents ask before they send". Third: "Turn any email into a task".
- Description: open with who it is for and the free plan in one line. The current text is good; cut the meeting and portfolio sections from the store text so the main promise stands out.
