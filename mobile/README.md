# MyMail mobile

The MyMail companion app for iPhone and Android. One TypeScript codebase on Expo (React Native,
Expo Router), talking to the same API as the web app.

| Area | What works |
| --- | --- |
| Sign in | Email and password against production Better Auth, two step codes (authenticator or backup code), "trust this phone", session kept in the iOS Keychain or Android Keystore |
| Mail | Inbox, Starred, Sent and Archive, per mailbox filter, read a thread, reply, forward, compose with a From picker, archive, star, trash, search |
| Offline | The first page of each folder and the last 60 threads are saved in SQLite on the phone. With no connection the app shows the saved copy and searches it |
| Agent approvals | Waiting and Decided lists, approve or reject in one tap, review and edit the subject or body before approving, a note when rejecting, haptics, badge count on the tab |
| Tasks | Make a task from any email, list and board (To do, Doing, Done) views. Saved on the phone behind a feature flag until the API has tasks (docs/api-gaps.md) |
| Notifications | Permission prompt, Android channels for mail and approvals, a local alert when a new approval arrives while the app is in the background. Push from the server is documented in docs/push.md |
| Settings | Account, workspace and plan, storage, notifications, clear saved mail, en-AU, privacy, terms, support, sign out and in-app account deletion (App Store and Google Play rule) |
| Sample workspace | "Explore with sample data" runs every screen on made up data with no server. The browser preview uses it |

## Run it

```bash
npm install
npm start            # Expo dev server; press a for Android, w for web
npm run check        # typecheck, copy check (no em or en dashes), unit and smoke tests
npm run export:web   # static web build in dist/ (sample data only)
```

`EXPO_PUBLIC_API_BASE` points a build at another server, for example staging:
`EXPO_PUBLIC_API_BASE=https://mymail-staging.mymail-app.workers.dev npm start`.

## Build an Android APK on Linux

Needs JDK 17 (with javac) and the Android SDK (`ANDROID_HOME`). Gradle downloads the platform,
build tools and NDK it needs on the first run.

```bash
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
# app/build/outputs/apk/release/app-release.apk
```

That APK is signed with the debug key, so it installs on any phone for testing (allow
"install unknown apps"). Play Store builds go through EAS (docs/release.md).

## iOS

EAS builds iOS in the cloud, so no Mac is needed: `npx eas-cli build -p ios --profile production`.
It needs the owner's Apple Developer Program membership. Everything else is ready: bundle id
`au.mymail.app`, icons, splash, privacy manifest, en-AU, and the listing draft in `store/`.
See docs/release.md for the exact steps.

`ios-native/` is a small native SwiftUI app (approvals only) built with xtool, kept as an
experiment. docs/xtool.md says what xtool can and can't do from Linux.

## How it fits together

```
src/
  app/            screens (Expo Router): sign-in, two-factor, (tabs)/inbox|approvals|tasks|settings,
                  thread/[id], compose, search, approval/[id], task/[id], task/new, delete-account
  api/            v1.d.ts generated from the API's OpenAPI spec, types.ts, endpoints.ts, transport.ts
  lib/            session (cookie jar in secure storage), offline cache (SQLite), tasks, push, format
  sample/         the sample workspace: fixtures and an in-memory transport with the same routes
  components/     accessible UI pieces in the web app's vermilion dark theme
```

- Types come from `openapi/mymail-v1.json` through `openapi-typescript` (`npm run gen:api`).
  The app's session routes return the same shapes as the public API, so a schema change in the
  API becomes a type error here.
- The app uses the web app's cookie session routes (`/api/mail`, `/api/approvals`, `/api/agents`,
  `/api/account`) and Better Auth under `/api/auth`. It keeps the cookies itself and sends the
  API's own origin, which the server's CSRF check accepts. No server change was needed.
- Every request goes through a `Transport`. The live one is HTTP; the sample one answers the same
  paths from memory, which is what the web preview, the screenshots and the smoke tests use.

## Accessibility

Every control has a role and a label, touch targets are at least 44 points, text uses the web
app's contrast-checked colours, and status changes are announced. `scripts/screens.mjs` runs axe
on each screen of the web build and saves phone sized screenshots.

## Builds and preview

- Web preview (sample data only): https://mymail-mobile.sites.tab.bot/
- Android debug-signed APKs come from `npx expo prebuild --platform android` and `cd android && ./gradlew assembleRelease`. Add `-PreactNativeArchitectures=arm64-v8a` for a smaller APK (about 31 MB) that runs on modern phones.
- Live API check (never commit the values): `MYMAIL_LIVE_EMAIL=... MYMAIL_LIVE_PASSWORD=... npx jest live`
