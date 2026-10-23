# Releasing: TestFlight, App Store and Google Play

## Ready now

- App name MyMail, bundle id and Android package `au.mymail.app`, version 1.0.0 (build 1).
- Icons, adaptive Android icon, splash, notification icon.
- iOS privacy manifest in app.json (email address, email content and device id, all for app
  function, none for tracking), `ITSAppUsesNonExemptEncryption = false` (only standard HTTPS).
- en-AU as the development region; dates and times in en-AU format.
- In-app account deletion (App Store guideline 5.1.1(v), Google Play's account deletion rule)
  plus the web link for people who signed in with Google or Auth0.
- `eas.json` with development, preview (internal APK) and production profiles.
- Store listing draft: `store/listing.md`. Review notes and a sample login plan are in it.

## What the owner must provide

| For | What | Cost |
| --- | --- | --- |
| TestFlight and the App Store | Apple Developer Program membership (Individual, or Organization with a D-U-N-S number for the "MyMail" seller name) | US$99 a year, A$149 in Australia (unverified, Apple's page shows local pricing at checkout) |
| | Sign in to App Store Connect once, create the app record "MyMail" with bundle id `au.mymail.app`, and give the Apple ID and app-specific password or an App Store Connect API key (App Manager role) | included |
| | Privacy policy and support URLs on a real domain (the legal drafts need the lawyer's review first) | |
| | A reviewer login: a test account with sample mail and one pending approval | free |
| Google Play | Google Play Console developer account | US$25 once (unverified) |
| | A service account JSON for automated uploads (`secrets/play-service-account.json`, never committed) | free |
| | The account deletion web URL for the Data safety form | |
| Push | See docs/push.md: APNs key, Firebase project | free |
| EAS | A free Expo account, or permission for Tab to create one | free |

## Then it is one command each

```bash
npx eas-cli login
npx eas-cli init                                   # writes extra.eas.projectId into app.json
npx eas-cli build -p ios --profile production --auto-submit     # builds in the cloud, uploads to TestFlight
npx eas-cli build -p android --profile production --auto-submit # AAB to the Play internal track
```

The first iOS build asks for the Apple ID once and creates the certificate and provisioning
profile itself. Fill `ascAppId` and `appleTeamId` in eas.json to make later runs fully
non-interactive.

## App review risks for an email app

- Apple asks for a working demo login in App Review Information. Give it a workspace with sample
  mail, an agent and a pending approval.
- "Explore with sample data" makes the app usable without an account, which helps review.
- Account creation happens on the web (opened in the in-app browser) and there is no in-app
  purchase or price shown in the app, so no in-app purchase rules apply. Keep upgrade prompts on
  the web.
- Agent approvals send real mail on the user's behalf after an explicit tap. Say so in the review
  notes.
