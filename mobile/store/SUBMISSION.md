# MyMail store submission (App Store and Google Play)

Everything to paste into App Store Connect and Google Play Console for MyMail 1.4.0 (iOS build 5,
Android versionCode 5), plus the steps only the owner can do. Work top to bottom.

Paths in this file are relative to the `mobile/` folder of the repo.

## 0. What is ready

| Item | Where |
| --- | --- |
| Version 1.4.0, iOS build 5, Android versionCode 5 | `app.json` |
| iPhone only (`supportsTablet: false`), so no iPad screenshots | `app.json` |
| Bundle id and package `au.mymail.app` | `app.json` |
| Production build profiles (`production`, `production-local-credentials`) and submit placeholders | `eas.json` |
| App icon 1024x1024 with no alpha, adaptive Android icon (foreground, background, monochrome), splash, notification icon | `assets/`, `store/icons/app-store-icon-1024.png` |
| iOS privacy manifest with every required reason API the app's native modules use | `app.json` (`ios.privacyManifests`), reference copy `store/ios/PrivacyInfo.xcprivacy` |
| Export compliance: standard HTTPS only, `ITSAppUsesNonExemptEncryption` false | `app.json` |
| In-app account deletion (Settings, Delete my account) plus the web page | app, https://mymail.mymail-app.workers.dev/delete-account |
| No purchases, prices, upgrade or billing buttons in the app (checked by a test) | `__tests__/screens.smoke.test.tsx` |
| Signed release AAB for Google Play (arm64-v8a, armeabi-v7a, x86_64), target SDK 36 | owner copy `mymail-release.aab` |
| Signed release APK (arm64) for direct install | owner copy `mymail-android-arm64.apk` |
| Android upload keystore, outside the repo, with its passwords in CREDENTIALS.local.md | owner copy `mymail-upload-keystore.jks` |
| App Store screenshots: 7 at 1320x2868 (6.9 inch) and 7 at 1284x2778 (6.5 inch) | `store/screenshots/ios-6.9/`, `store/screenshots/ios-6.5/` |
| Play phone screenshots: 7 at 1080x1920, feature graphic 1024x500, hi-res icon 512x512 | `store/screenshots/play-phone/`, `store/play/` |
| Public pages: privacy, terms, support, account deletion | https://mymail.mymail-app.workers.dev/privacy, /terms, /support, /delete-account |

## 1. Owner-only steps (in this order)

1. **Check the name.** "myMail" is already the name of a popular email app on both stores (from Mail.ru
   Group). App Store names must be unique and a similar name can draw a trademark complaint. The
   name below is "MyMail: Email, Tasks, Agents"; if App Store Connect refuses it or you want less
   risk, pick another and change `expo.name` in `app.json` to match the home screen name you want.
2. **Finish the legal pages.** The privacy policy and terms on prod are drafts with placeholders
   such as [Legal entity name] and [ABN]. Fill them in (ideally after a lawyer reads them) before
   you submit. Both stores check the privacy policy URL.
3. **Apple Developer Program**: enrol at developer.apple.com/programs (US$99 a year).
   - As an individual: your own name shows as the seller.
   - As an organisation (seller shows as your company): you need a D-U-N-S number for the company
     (free from Dun and Bradstreet, can take up to about two weeks), an ABN, and a website on a
     domain the company owns.
4. **Google Play developer account**: sign up at play.google.com/console (US$25 once, identity
   check with ID).
   - A new **personal** account must run a closed test with at least 12 opted-in testers for
     14 days in a row before it can apply for production. Start this early (see section 5).
     Organisation accounts do not have this rule.
5. **Expo account** (free): create one at expo.dev, then in `mobile/`:
   ```bash
   npx eas-cli login
   npx eas-cli init          # writes extra.eas.projectId into app.json; commit that change
   ```
6. **Push notifications** (optional for launch, the app works without them; see `docs/push.md`):
   - iOS: an APNs key (.p8) from your Apple Developer account. `eas credentials` uploads it.
   - Android: a Firebase project, its `google-services.json` and the FCM service account key,
     uploaded with `eas credentials`. Then set `PUSH_ENABLED=1` on the Worker.
7. **Custom domain** (optional): the stores accept the workers.dev URLs below. If you move to your
   own domain, update the support, marketing and privacy URLs in both consoles.
8. **Demo account check**: sign in on a phone with the App Review demo account (see "App Review demo
   account" in CREDENTIALS.local.md) and check that the inbox, tasks and Approvals have items.

## 2. Build and upload

### iOS (EAS builds in the cloud, no Mac needed)

```bash
cd mobile
npx eas-cli build -p ios --profile production
npx eas-cli submit -p ios --profile production --latest
```

The first build asks for your Apple ID and creates the distribution certificate and provisioning
profile. Before `submit`, fill the three `OWNER_FILL_IN_...` values in `eas.json`
(`submit.production.ios`): your Apple ID email, the App Store Connect app id (App Information,
Apple ID, a number) and your Team ID (developer.apple.com, Membership).

### Android

The signed AAB is already built (`mymail-release.aab`). Upload it by hand in Play Console the first
time (Play needs one manual upload before API uploads work). On that first upload, accept **Play App
Signing**: Google keeps the app signing key and our keystore becomes the upload key.

To build again locally (keystore details in CREDENTIALS.local.md, "Android upload keystore (round 9)"):
see `docs/release.md`. To build with EAS instead, use `--profile production-local-credentials` with a
`credentials.json` that points at the same keystore (never committed).

## 3. App Store Connect answers

Create the app: My Apps, +, New App. Platform iOS, name below, primary language English (Australia),
bundle id `au.mymail.app`, SKU `mymail-ios`, full access.

### App Information

- **Name** (28 of 30): `MyMail: Email, Tasks, Agents`
- **Subtitle** (29 of 30): `Business email on your domain`
- **Category**: Business (primary), Productivity (secondary)
- **Content rights**: does not contain, show or access third-party content (mail is the user's own)
- **Age rating**: see below

### Pricing and Availability

- Price: Free (AUD 0). Availability: all countries or Australia first, your choice.

### Version 1.4.0, iOS App

- **Promotional text** (161 of 170):

  Your business email, team tasks and AI agent approvals in one app. Approve what an agent wants to send before it leaves. Free email, no ads, no in-app purchases.

- **Keywords** (94 of 100): `custom domain,inbox,small business,approvals,AI,team,shared inbox,Australia,timer,CRM,projects`
- **Support URL**: https://mymail.mymail-app.workers.dev/support
- **Marketing URL**: https://mymail.mymail-app.workers.dev/
- **Copyright**: 2026 [your legal entity name]
- **Screenshots**: 6.9 inch display, upload `store/screenshots/ios-6.9/01..07` (1320x2868). 6.5 inch
  display, upload `store/screenshots/ios-6.5/01..07` (1284x2778). No iPad screenshots (iPhone only).
- **Build**: pick build 5 after it finishes processing.
- **Description** (1469 of 4000):

```text
MyMail is business email on the domain you already own, with your team, your tasks and your AI agents in the same place. It is made for Australian startups and small businesses.

READ AND ANSWER MAIL
- Every mailbox you can open, in one inbox: shared addresses like hello@ and accounts@, and your own
- Threads, reply and forward
- Search all your mail, and read recent mail with no signal

APPROVE WHAT AGENTS SEND
Connect your own AI agent (Claude, ChatGPT or any agent) through MyMail's MCP server or API. When an agent wants to send an email, it waits in Approvals. Read it, edit it if you like, then tap Approve or Reject. Nothing leaves until a person says so.

TASKS FROM EMAIL
- Turn any email into a task in one tap. Replies on the thread show on the task
- A board and a list of your tasks, with status, due date, priority and assignee
- Custom fields such as budget, client or approved
- Start and stop a timer on a task, or log time by hand
- Start a video meeting from a task or a thread and share a guest link

SEE EVERY PROJECT
A portfolio view shows each project's progress, overdue tasks, time logged and next due date, with a health flag your team sets.

PRIVATE AND IN YOUR CONTROL
- Two step sign in
- No ads and no tracking
- Delete your account at any time in the app: Settings, then Delete my account

The app is free to download and has no in-app purchases. Sign in with your MyMail account, or tap Explore with sample data to look around first.
```

### App Review Information

- Sign-in required: Yes. User name and password: the App Review demo account in CREDENTIALS.local.md
  (the owner's PDF copy of this file includes it).
- Contact: your name, phone and email.
- **Notes** (1490 of 4000):

```text
MyMail is business email hosting for small businesses, with tasks and an approval queue for AI agents. This app is a companion to the web app at https://mymail.mymail-app.workers.dev.

Sign in: use the demo account in the App Review Information sign-in fields (email and password below). It holds sample mail, tasks and projects, and messages agents are waiting to send.
No account needed: "Explore with sample data" on the sign-in screen opens a sample workspace that runs on the phone only.

Things to try: open a thread, tap Make task, open the Approvals tab and approve or reject a waiting message (the demo workspace shows it as sent but never delivers mail outside MyMail), open Tasks and start a timer.

Purchases: none. The app is free, email is free, and the app shows no prices, plans, upgrade or billing buttons and links to no purchase page.
Account deletion: Settings, then Delete my account. Type DELETE and the account password, then confirm. The account and every workspace only that person uses are deleted at once. The same is available on the web at https://mymail.mymail-app.workers.dev/delete-account.
Sign in is email and password only (no third-party or social sign in), so Sign in with Apple is not required.
Encryption: standard HTTPS only (ITSAppUsesNonExemptEncryption is false).
AI: the app has no AI features of its own. People may connect their own AI agent to their MyMail account through our MCP server; the app only shows what those agents ask to send so a person can approve it.
```

### Age rating questionnaire

Answer honestly; Apple works out the rating from the answers.

| Question | Answer |
| --- | --- |
| Parental controls | No |
| Age assurance | No |
| Unrestricted web access | No (links open in the system browser, the app has no web browser of its own) |
| User-generated content (public posts other users can browse) | No. Mail, tasks and comments are private to the people in a workspace |
| Messaging and chat | Yes. People send and receive email with any address |
| Advertising | No |
| Gambling, contests, loot boxes | No |
| Violence, horror, sexual content, nudity, profanity, drugs, alcohol, tobacco, mature themes | None |
| Medical or treatment information | No |
| Made for Kids | No |

Expected result: 4+ or a higher band because of messaging, whichever Apple computes. Either is fine
for a business app.

### App Privacy (nutrition label)

Privacy policy URL: https://mymail.mymail-app.workers.dev/privacy. Tracking: **No** (no data is used to track people across other
companies' apps or websites, no ads, no data brokers). The app has no analytics or crash reporting
SDK. Data collected:

| Data type | Collected | Linked to the person | Used for tracking | Purpose |
| --- | --- | --- | --- | --- |
| Contact Info: Name | Yes | Yes | No | App Functionality |
| Contact Info: Email Address | Yes | Yes | No | App Functionality |
| User Content: Emails or Text Messages | Yes (the mail itself) | Yes | No | App Functionality |
| User Content: Other User Content (tasks, comments, docs, time entries) | Yes | Yes | No | App Functionality |
| Identifiers: User ID | Yes | Yes | No | App Functionality |
| Identifiers: Device ID (push notification token, only after notifications are allowed) | Yes | Yes | No | App Functionality |
| Diagnostics: Other Diagnostic Data (server error reports) | Yes | No | No | App Functionality |
| Location, Contacts, Health, Financial Info, Browsing or Search History, Purchases, Photos, Audio, Usage Data, Sensitive Info | No | | | |

This matches the privacy manifest in `app.json`.

### Export compliance

"Does your app use encryption?" The app sets `ITSAppUsesNonExemptEncryption` to false, so App Store
Connect does not ask. If it ever asks: Yes, standard encryption only (HTTPS/TLS through the
operating system), exempt; no documentation needed.

## 4. Google Play Console answers

Create app: name `MyMail: Email, Tasks, Agents` (or the name you chose), default language English
(Australia) en-AU, App, Free. Accept the declarations.

### Main store listing

- **Short description** (76 of 80): `Business email on your domain, with tasks and AI agent approvals in one app.`
- **Full description** (1480 of 4000): the same text as the App Store description above.
- **App icon**: `store/play/play-icon-512.png` (512x512)
- **Feature graphic**: `store/play/feature-graphic-1024x500.png` (1024x500)
- **Phone screenshots**: `store/screenshots/play-phone/01..07` (1080x1920)
- **Tablet screenshots**: none needed. The listing can stay phone only.

### Store settings

- Category: App, **Business**. Tags: Email, Productivity, Business.
- Contact email: mymail.builder@mail.tab.bot (the address shown on https://mymail.mymail-app.workers.dev/support; change it when you
  have your own support address). Website: https://mymail.mymail-app.workers.dev/

### App content

- **Privacy policy**: https://mymail.mymail-app.workers.dev/privacy
- **Ads**: No, the app contains no ads.
- **App access**: All or some functionality is restricted. Add instructions: name "Demo account",
  user name and password from the App Review demo account in CREDENTIALS.local.md, note "Sign in
  with email and password. Or tap Explore with sample data on the sign-in screen."
- **Content rating** (IARC questionnaire): category "Utility, Productivity, Communication or
  Other". Violence, fear, sexuality, language, controlled substances, gambling, crude humour: No to
  all. "Do users interact or exchange content?" Yes (email). "Does the app share the user's
  current physical location with other users?" No. "Does the app allow users to purchase digital
  goods?" No. "Is the app a web browser or search engine?" No. Expected: Everyone or PEGI 3 or G,
  with a "Users Interact" note.
- **Target audience and content**: 18 and over only. Not designed for children. The store
  listing is not aimed at children.
- **News app**: No. **COVID-19 tracing**: No. **Government app**: No. **Financial features**: none.
  **Health**: No.
- **Account deletion**: answer that people can create an account (the app links to sign up on the
  web). Deletion URL: https://mymail.mymail-app.workers.dev/delete-account (also in the app: Settings, Delete my account).
- **Data safety**:

| Section | Answer |
| --- | --- |
| Does the app collect or share any of the required user data types? | Yes |
| Is all collected data encrypted in transit? | Yes |
| Do you provide a way for users to request that their data is deleted? | Yes, https://mymail.mymail-app.workers.dev/delete-account and in the app |
| Personal info: Name | Collected, not shared, required, App functionality, Account management |
| Personal info: Email address | Collected, not shared, required, App functionality, Account management |
| Personal info: User IDs | Collected, not shared, required, App functionality |
| Messages: Emails | Collected, not shared, required, App functionality |
| Messages: Other in-app messages (task comments) | Collected, not shared, optional, App functionality |
| Files and docs | Not collected by the app (it views attachments, it does not upload them) |
| App info and performance: Diagnostics (server error reports) | Collected, not shared, required, App functionality |
| Device or other IDs (push token) | Collected, not shared, optional (only if notifications are allowed), App functionality |
| Location, financial info, health, photos and videos, audio, contacts, calendar, web browsing, app activity | Not collected |
| Data shared with third parties | None. Mail goes to the recipients a person chooses (a user-initiated transfer). Hosting and email delivery providers process data for MyMail as service providers, which Play does not count as sharing |

### Release

1. Testing, Closed testing, create a track, upload `mymail-release.aab`, add at least 12 testers
   by email list, roll out. Keep them opted in for 14 days (personal accounts only).
2. Then Production, apply for access, answer the questions about the test, and roll out the same
   or a newer build.
3. Organisation accounts can go straight to Production (an Internal test first is still a good idea).

## 5. Timeline

| When | What |
| --- | --- |
| Day 1 | Enrol in both programs, create the Expo project, fill the legal pages |
| Day 1 to 3 | Apple verifies the account; Play verifies identity |
| Day 2 | iOS: `eas build`, `eas submit`, fill App Store Connect, send to review (usually one to two days) |
| Day 2 | Play: upload the AAB to a closed test with 12 testers |
| Day 16 or later | Play: apply for production after 14 days of testing (personal accounts) |

## 6. If a reviewer pushes back

- "Needs a demo account": check the demo account still signs in, then reply with it. If a reviewer
  deleted it (they may test account deletion), re-create it with the command under "App Review demo
  account" in CREDENTIALS.local.md, then reply.
- "Guideline 3.1.1 (purchases)": the app has no purchases or links to buy; say so and point to the
  Settings screen (no billing entry).
- "Guideline 5.1.1(v) (account deletion)": Settings, Delete my account, deletes in the app.
- "Name too similar": pick another name in App Store Connect and in `app.json`.
