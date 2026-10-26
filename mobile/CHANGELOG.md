# Changelog

All notable changes to the Multies mobile app. Versions follow the store version (versionName on
Android, CFBundleShortVersionString on iOS).

## 1.9.6 (OTA, runs on Android versionCode 15 and iOS build 17), 26 October 2026

- What's new: after an update this sheet shows once, with what changed in the version you just
  got. It reads from this changelog.
- Updates in the background: Multies now also looks for an update when you come back to it, not
  only when it starts, at most every 30 minutes. An update still installs on the next start, so
  nothing reloads while you work. An important fix can install at once, with a short notice first.
- Check for updates: Settings, About shows the version, the update and channel it runs, and a
  Check for updates button with a Restart to update button once one is ready.
- Keeping up to date: if a store build ever becomes too old to work with Multies, the app says so
  and opens the App Store or Google Play for you.
- Shipped over the air (no store build): Settings reads Multies 1.9.6 (OTA).

What to test: open Settings and tap Check for updates; it should say Multies is up to date. Leave
the app for a minute, come back, and check nothing reloads. After the next update, the What's new
sheet appears once on the first start and not again.

## 1.9.5 (OTA, runs on Android versionCode 15 and iOS build 17), 26 October 2026

- Agent runs: Settings, Agent runs lists what AI agent members have run, newest first, with a
  status chip (queued, running, succeeded, failed, cancelled), the agent, the task, when it
  started and how long it took. Filter by status and pull to refresh. Tap a run for each step in
  order and the result. A task's own runs show on the task screen. Read only.
- Checklists: hold the grip on the right of an item and drag it into place. The new order shows
  at once and goes back with a short message if it can't be saved. VoiceOver and TalkBack users
  get Move up and Move down actions on each item.
- Shipped over the air (no store build): Settings reads Multies 1.9.5 (OTA).

What to test: open Settings, Agent runs, try the Failed filter and open a run. Then open a task
with a checklist, hold an item's grip, drag it down two rows and let go; reopen the task to check
the order stuck.

## 1.9.3 (Android versionCode 15, iOS build 17), 26 October 2026

- Over the air updates: the app now checks for an update each time it starts and uses it from the
  next start, so most fixes reach phones without a store build (EAS Update, channel production;
  see docs/OTA.md). Settings shows when an update is running. Nothing else changed from build 16.

What to test: open Settings and check the version line at the bottom reads Multies 1.9.3 (17) on
iPhone or 1.9.3 (15) on Android. After an update is announced, close the app fully, open it twice,
and check the line shows the new version with (OTA).

## 1.9.3 (Android versionCode 14, iOS build 16), 26 October 2026

- Checklists inside a task: the task shows "3 of 5 done" with a progress bar. Tap an item to tick
  it, add items at the bottom, and long press an item (or tap its dots) to rename, move or delete
  it. Changes show at once and come back if they can't be saved. Task rows show checklist progress.
- A search box at the top of Tasks takes the same searches as the web app, for example
  assignee:me due:<7d label:bug status:doing, with tappable starters. If a search can't be read,
  the box says which part to fix. The phone remembers your last search.

What to test: open a task with a checklist, tick an item and check the count on the Tasks list.
Then search label:bug, tap Mine, and try a typo like foo:bar to see the message.

## 1.9.2 (Android versionCode 13, iOS build 15), 25 October 2026

- A push saying someone mentioned you on an email thread now opens that mail thread (the server
  sends the newest message in the thread). If the push has no message, it opens Notifications.

What to test: ask a teammate to mention you in the team notes of a shared inbox thread, then tap
the push. The thread should open on its newest message.

## 1.9.1 (Android versionCode 12, iOS build 14), 25 October 2026

- Sign in now opens the Multies sign in page at multies.au.auth0.com (the Multies tenant in
  Australia) instead of the old development host. Same account: people sign in with the same email
  (password accounts set a new password with Forgot password, or use a one time code); the server
  links the sign in to the existing Multies account by verified email. Older builds keep working.
- Compose asks gently before sending mail with no subject: "Add a subject? Mail without one is more
  likely to go to spam." with Add subject (puts the cursor in Subject) and Send anyway. It never
  blocks the send.

## 1.9.0 (Android versionCode 11, iOS build 13), 25 October 2026

- Email addresses from inside the app (Settings, Email addresses). Three ways, the same as the web:
  connect an existing mailbox (Gmail, Google Workspace, Outlook.com, Microsoft 365, Yahoo, iCloud,
  Zoho, Fastmail, GMX or any IMAP and SMTP server: pick the provider or let the address pick it,
  paste an app password, Test and save; the server signs in before saving and answers in plain words
  which step failed), take a free name@mail.multies.si address (prefilled suggestion, the server's
  own words for a taken or kept name and its limits), or add your own domain on the web. Connected
  accounts show status and last sync with Sync now, Reconnect (new password only) and Remove (deletes
  the stored password). Calls /api/connections and /api/free-address with the app's own session; no
  server change. Compose with no address now offers "Add an email address" instead of "Add one on
  the web first".
- The app talks to https://multies.si (was the workers.dev host); development builds use
  https://preview.multies.si. Every link the app opens is on multies.si.
- The iOS privacy manifest is checked in the prebuild output (ios/Multies/PrivacyInfo.xcprivacy).
- Store answers in the repo match what was entered on 25 Oct 2026: Play data safety now lists Files and docs (chat attachments) and Diagnostics; App Store Diagnostics is Linked to the user, and the privacy manifest (app.json and store/ios/PrivacyInfo.xcprivacy) says so too. Play's content rating came out IARC 12+, and its delete data URL is the privacy policy for now.
- Undo send: Send closes Compose and holds the message for 5, 10, 20 or 30 seconds (default 10).
  A bar above the tabs counts down with Undo and Send now; Undo reopens Compose exactly as it was
  (recipients, subject, body, the reply it belongs to). A failed send reopens it too. VoiceOver and
  TalkBack hear the hold once. The choice is in Settings, This phone, and is saved on the phone. No
  server change; the same timing core as the web app (docs/undo-send.md).

## 1.8.1 (Android versionCode 10, iOS build 10), 24 October 2026

- App id is now au.fintex.multies for the iOS bundle id and the Android package (was au.mymail.app,
  never uploaded to either store). Rebuilt and re-signed with the same Fintex upload key; the version
  stays 1.8.1 (10). The sign in callback is unchanged (mymail://auth/callback), so Auth0 needs no change.
- Store publishing prep for Fintex Australia Pty Ltd, following the Fintex publishing playbook.
- Android: target SDK 36, compile SDK 37 (needed by the AndroidX libraries in Expo SDK 58).
- Android: new upload key for Fintex (Play App Signing). The round 9 key was never uploaded and is retired.
- Android: blocked permissions the app does not use (biometric and fingerprint, launcher badge
  permissions, the install referrer service, location, camera, storage, audio, overlay,
  foreground service). Final list in store/google/permissions.md.
- iOS: `ITSAppUsesNonExemptEncryption` false in Info.plist as well as `ios.config`.
- Privacy, terms, support and account deletion pages written as Fintex and published.
- The app's Privacy and Terms links open the Fintex pages.
- store/ folder split into apple/ and google/ answers; new docs: RELEASES, STORE, SECURITY,
  RUNBOOK, TEST_PLAN; TestFlight workflow in ci/github/.

## 1.8.0 (versionCode 9, build 9)

- People screen (Settings, People): people and their roles, AI agents with a badge, title and bio.

## 1.7.0 (versionCode 8, build 8)

- Sign in and sign up on the Multies sign in page in the system browser (PKCE), session traded at
  /api/auth/mobile/exchange. The app talks to https://multies.si by default.

## 1.6.0 (versionCode 7, build 7)

- Renamed to Multies; release docs name Multies.
