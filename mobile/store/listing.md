# Store listing (en-AU)

The full set of answers, with every field to paste and the owner's checklist, is in
[SUBMISSION.md](SUBMISSION.md). This page is the short version of the listing text.

## Name and subtitle
- App Store name (28 of 30): Multies: Email, Tasks, Agents
  ("myMail" is an existing app from another company; see SUBMISSION.md, step 1, before you rely on it.)
- App Store subtitle (29 of 30): Business email on your domain
- Google Play short description (76 of 80): Business email on your domain, with tasks and AI agent approvals in one app.

## Promotional text (App Store, 161 of 170)
Your business email, team tasks and AI agent approvals in one app. Approve what an agent wants to send before it leaves. Free email, no ads, no in-app purchases.

## Description (both stores, 1830 of 4000)

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
- Two step sign in
- No ads and no tracking
- Delete your account at any time in the app: Settings, then Delete my account

The app is free to download and has no in-app purchases. Sign in with your Multies account, or tap Explore with sample data to look around first.

## Keywords (App Store, 94 of 100)
custom domain,inbox,small business,approvals,AI,team,shared inbox,Australia,timer,CRM,projects

## Category
Business (primary), Productivity (secondary). Google Play: Business.

## URLs
- Support: https://mymail.mymail-app.workers.dev/support
- Marketing and website: https://mymail.mymail-app.workers.dev/
- Privacy policy: https://mymail.mymail-app.workers.dev/privacy
- Account deletion: https://mymail.mymail-app.workers.dev/delete-account
- Contact email: mymail.builder@mail.tab.bot (as shown on the support page)

## Age rating
Apple: answers in SUBMISSION.md (messaging and chat: yes; everything else: no). Google Play (IARC):
no objectionable content, users interact by email, no purchases. Target audience 18 and over.

## Privacy
No tracking, no ads, no analytics or crash SDK in the app. Collected for app function only and
linked to the person: name, email address, the mail itself, tasks and comments, user id and the
push token. Server error reports are not linked. Encrypted in transit. Deletion in the app
(Settings, Delete my account) and on the web.

## Screenshots
- App Store 6.9 inch (1320x2868): `store/screenshots/ios-6.9/`
- App Store 6.5 inch (1284x2778): `store/screenshots/ios-6.5/`
- Google Play phone (1080x1920): `store/screenshots/play-phone/`
- Google Play feature graphic (1024x500) and icon (512x512): `store/play/`

Made from the web build with sample data by `node scripts/store-screens.mjs <url> store/screenshots`
(serve an `EXPO_PUBLIC_SAMPLE_ONLY=1 npx expo export --platform web` build first).
