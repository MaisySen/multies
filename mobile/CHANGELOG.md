# Changelog

All notable changes to the Multies mobile app. Versions follow the store version (versionName on
Android, CFBundleShortVersionString on iOS).

## Unreleased (next build after 1.8.1)

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
