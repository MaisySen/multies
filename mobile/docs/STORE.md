# Store publishing: Multies

Follows the Fintex publishing playbook (version 1, 24 October 2026). The answers to paste live in
`store/`; this page holds the decisions and the owner steps.

## Identifiers

| Item | Value |
| --- | --- |
| Publisher | Fintex Australia Pty Ltd, ABN 60 688 406 108, contact@fintex.au |
| Store name | Multies (fallback if Apple refuses it: Multies: Email and Tasks) |
| Bundle id (iOS) and package (Android) | au.mymail.app. Internal id kept because builds already use it. Cannot change after the first upload; Bidur confirms before then |
| SKU | multies-ios-1 |
| Primary language | English (Australia) |
| Apple team | B85KQRQZW7 (individual, conversion to FINTEX AUSTRALIA PTY LTD pending) |
| App Store Connect API key | Key ID GQ43YP4N5K, Issuer de0b7491-5b63-4b19-b34f-f7cea7fe5395, Admin |
| Version | 1.8.1, Android versionCode 10, iOS build 10 locally, 100 plus the run number on CI |
| Android SDK | target 36, compile 37 |
| Copyright | © 2026 Fintex Australia Pty Ltd |

## Public pages

- Privacy: https://multies.sites.tab.bot/privacy/
- Terms: https://multies.sites.tab.bot/terms/
- Support: https://multies.sites.tab.bot/support/
- Account deletion: https://multies.sites.tab.bot/delete-account/

The pages on multies.si (/privacy, /terms) are drafts with placeholder company details in the web
app (`app/src/shared/legal.ts`). Use the pages above in both stores until the web app's pages are
rewritten as Fintex.

## Building iOS without a Mac

Expo needs macOS to build iOS. Free routes, none needing a new account:

1. GitHub Actions macOS on a public repo. Free minutes. Means making the mobile code public (a
   new repo with only `mobile/`, history checked for secrets first). Copy
   `ci/github/ios-testflight.yml` into `.github/workflows/`, set `APP_DIR: "."`, add the four
   secrets. Bidur decides; nothing has been made public.
2. GitHub Actions macOS on the private MaisySen/mymail repo. Same workflow with `APP_DIR: mobile`.
   Private repos pay for macOS minutes (billed at 10 times the Linux rate) and this account has
   no Actions minutes left until 1 November. Not free.
3. EAS Build (Expo's cloud). Free tier with a monthly build limit, but needs an Expo account;
   none exists (no EXPO_TOKEN anywhere). Creating one is a new account, so not done.

Recommended: route 1 if Bidur is fine with the app code being public (it holds no secrets and
the server is separate), otherwise route 3 with an Expo account he creates.

## What Tab does

Builds, signing, store copy, privacy answers, screenshots, docs, the credentials email, the
bundle id registration with the API key, App Store Connect fields through the API.

## What only Bidur does (playbook section 8)

1. Done 24 Oct 2026: the .p8 arrived and bundle id au.mymail.app is registered (App Store Connect resource QX49MLU6LF).
2. Create the App Store Connect app record: Name Multies, Primary Language English (Australia),
   Bundle ID au.mymail.app, SKU multies-ios-1, User Access Full Access.
3. Give the App Review phone number.
4. Done: the Fintex Australia Play developer account exists. Its invite to mymail.builder@mail.tab.bot needs a Google account on that address; Google's signup stops at a phone QR check. Either Bidur scans it, invites a Google account he owns, or does steps 5 and 6 himself.
5. Create the Play app record: App name Multies, English (Australia), App, Free.
6. Upload the first AAB on the Internal testing track and accept Play App Signing. Release name
   1.8.1 (10).
7. Pick the macOS route above.
8. Approve Submit for Review and the production rollout.
