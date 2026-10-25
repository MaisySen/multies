# Multies: App Store listing (source of truth)

Paste these into App Store Connect. Publisher: Fintex Australia Pty Ltd.

## App record (owner creates once)

| Field | Value |
| --- | --- |
| Platform | iOS |
| Name (30 max) | Multies (7 chars). If taken: Multies: Email and Tasks (24) |
| Primary language | English (Australia) |
| Bundle ID | au.fintex.multies (final, chosen by Bidur on 24 Oct 2026; registered as App Store Connect resource 287MW3DW82) |
| SKU | multies-ios-1 |
| User access | Full Access |

## App Information

- Subtitle (29 of 30): Business email on your domain
- Category: Business (primary), Productivity (secondary)
- Content rights: does not contain, show or access third party content (mail is the user's own)
- Age rating: see age-rating.md
- Copyright: © 2026 Fintex Australia Pty Ltd
- Seller: check it reads FINTEX AUSTRALIA PTY LTD before Submit for Review (conversion pending with Apple)

## URLs

- Support URL: https://multies.si/support/
- Marketing URL: https://multies.si
- Privacy policy URL: https://multies.si/privacy/

## Version 1.8.1

- Promotional text (149 of 170): Your business email, team tasks and AI agent approvals in one app. Approve what an agent wants to send before it leaves. No ads, no in-app purchases.
- Keywords (94 of 100): custom domain,inbox,small business,approvals,AI,team,shared inbox,Australia,timer,CRM,projects
- What's New: Version 1.8.1: People screen with your team and AI agents. New sign in page with Google, Apple and GitHub. Fixes: smaller permission list.
- Screenshots: 6.9 inch (1320 x 2868) from store/screenshots/ios-6.9/, 6.5 inch from store/screenshots/ios-6.5/. Made on 24 Oct 2026 from the 1.8.1 web build at phone size with sample data (real screens, not iOS simulator captures). Retake on an iOS simulator through the CI runner once a macOS route is chosen, if Apple asks for device frames that match iOS.

### Description (1951 of 4000)

```text
Multies is business email on the domain you already own, with your team, your tasks and your AI agents in the same place. It is made for Australian startups and small businesses.

READ AND ANSWER MAIL
- Every mailbox you can open, in one inbox: shared addresses like hello@ and accounts@, and your own
- Threads, reply and forward
- Search all your mail, and read recent mail with no signal

APPROVE WHAT AGENTS SEND
Connect your own AI agent (Claude, ChatGPT or any agent) through Multies' MCP server or API. When an agent wants to send an email, it waits in Approvals. Read it, edit it if you like, then tap Approve or Reject. Nothing leaves until a person says so.

TASKS FROM EMAIL
- Turn any email into a task in one tap. Replies on the thread show on the task
- A board and a list of your tasks, with status, due date, priority and assignee
- Custom fields such as budget, client or approved
- Start and stop a timer on a task, or log time by hand
- Start a video meeting from a task or a thread and share a guest link

TEAM CHAT
- Channels and direct messages for your team, with threads and @mentions
- Links to tasks and emails open right in the app
- Press and hold a message to turn it into a task

ONE INBOX FOR NOTIFICATIONS
Mentions, assignments, comments, approvals, due dates and chat in one list. Filter it, mark it read, and choose what comes to your phone as a push.

SEE EVERY PROJECT
A portfolio view shows each project's progress, overdue tasks, time logged and next due date, with a health flag your team sets.

PRIVATE AND IN YOUR CONTROL
- Sign in on the Multies sign in page, with two step sign in
- No ads and no tracking
- Delete your account at any time in the app: Settings, then Delete my account

The app is free to download and has no in-app purchases. Sign in with your Multies account, or tap Explore with sample data to look around first.

Multies is provided by Fintex Australia Pty Ltd. Support: contact@fintex.au
```

## App Review Information

- Contact: Bidur Khatri, phone (Bidur supplies), contact@fintex.au
- Demo account: App Review demo account in CREDENTIALS.local.md (never in this repo)
- Notes (1343 of 4000):

```text
Multies is business email hosting for small businesses, with team chat, tasks and an approval queue for AI agents. This app is the companion to the web app at https://multies.si.

1. On the sign in screen, tap Sign in. The Multies sign in page opens in the system browser.
2. Sign in with the demo account in the sign in fields of this page (email and password). It opens a demo workspace with sample mail, tasks, projects and messages agents are waiting to send. Demo workspaces never deliver mail outside Multies.
3. Or, with no account, tap Explore with sample data. A sample workspace runs on the phone only.
4. Open a thread and tap Make task. Open Approvals and approve or reject a waiting message. Open Tasks and start a timer. Open Settings, People to see people and AI agents.
5. Account deletion: Settings, then Delete my account. Type DELETE and confirm. The account and every workspace only that person uses are deleted at once.

Purchases: none. The app shows no prices, plans or upgrade buttons.
Sign in: the sign in page offers email and password, plus Google, Apple and GitHub. Sign in with Apple is offered.
Encryption: standard HTTPS only (ITSAppUsesNonExemptEncryption is false).
AI: the app has no AI of its own. A workspace may connect its own AI agent; the app shows what an agent asks to send so a person can approve it.
```

## Pricing and availability

Free. Countries as Bidur decides (Australia first or all).
