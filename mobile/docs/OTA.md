# Over the air updates (EAS Update)

JavaScript and image changes reach phones without a new store build. The app checks for an update
each time it starts, downloads it in the background, and uses it from the next cold start (close the
app fully and open it again). It never waits for the network at launch: with
`fallbackToCacheTimeout: 0` it starts at once on the bundle it already has.

## Setup

- Library: `expo-updates` (SDK 58), served by EAS Update for the Expo project @multies/mymail
  (`83c874f8-cc92-4440-8ccd-5b99c2d8ec1f`), URL `https://u.expo.dev/83c874f8-cc92-4440-8ccd-5b99c2d8ec1f`.
- Runtime version policy: `fingerprint`. The runtime version is a hash of everything native (native
  packages and their versions, config plugins, the native parts of `app.json`). An update only
  reaches builds with the same hash, so an update that needs native code a phone does not have can
  never be sent to that phone. `fingerprint.config.js` uses the "balanced" preset and also leaves out
  npm scripts. The hash is the same on this box and on EAS Build (checked for build 17: both
  `e184c142...`), and the local Gradle build computes it during the build, so the local Android path
  works with it too. That is why we chose `fingerprint` over `appVersion`: `appVersion` would let a
  native change ship under an old version number and crash phones.
- Channels and build profiles (`eas.json`):

| Channel | Build profile | Who has it |
| --- | --- | --- |
| production | production, production-local-credentials | App Store, TestFlight, Play internal, closed and production tracks |
| preview | preview | internal installs (APK and ad hoc builds) |
| development | development | development builds |

  `app.json` also sets `updates.requestHeaders.expo-channel-name` to `production`, so the local Gradle
  build (which does not go through EAS Build) asks for the production channel. EAS Build writes the
  profile's channel over it for preview and development builds.
- Each channel reads the branch of the same name.
- The version line at the bottom of Settings shows `Multies 1.9.3 (17)` on the store bundle and, for
  example, `Multies 1.9.4 (OTA)` with the update id and channel under it when an update is running.
  The number comes from `JS_VERSION` in `src/lib/app-version.ts`; raise it for each update.

## EAS free plan limits (expo.dev/pricing, read 26 Oct 2026)

- Updates: 1,000 monthly active users (a phone that downloads at least one update in the month; a
  phone that only checks and finds nothing new does not count).
- Global edge bandwidth: 100 GiB a month. Storage: 20 GiB.
- End to end code signing for updates: not on the free plan (Production and Enterprise only), so it
  is off. Updates are still served over HTTPS from Expo, and only our Expo account can publish.
- Staying inside: an update here is a few MB (Hermes bundle plus changed assets; EAS only sends
  assets a phone does not have). 1,000 phones times one 5 MB update is about 5 GB, far below 100 GiB.
  Publish a handful of updates a month, not one per commit.

## When an update is fine

Changes to screens, components, styles, copy, API calls, images and fonts loaded from `assets/` or
`src/`. Anything under `src/` and `__tests__/`.

## When a store build is required

- A new or upgraded package with native code (anything `npx expo install` adds that has an `ios` or
  `android` folder), an Expo SDK upgrade, React Native upgrades.
- Config plugins, `plugins/`, and native fields in `app.json` (permissions, `infoPlist`, icons,
  splash, entitlements, schemes, notification settings).
- The guard (below) refuses an update in these cases and says why. The fix is a store build:
  bump `android.versionCode` in `app.json`, build as in docs/release.md, submit, then update
  `store/runtime-versions.json` with the new runtime versions and commit.

## Publishing

```bash
export EXPO_TOKEN=...            # or: npx eas-cli login
npm run ota:check                # the guard only
npm run ota:preview -- --message "What changed"
# check it on a preview build
npm run ota:production -- --message "What changed"
```

The scripts (`scripts/ota.js`, guard in `scripts/ota-guard.js`, tests in
`__tests__/ota-guard.test.ts`) refuse to publish when:

- the working tree has uncommitted changes;
- the Android or iOS fingerprint differs from the store build recorded in
  `store/runtime-versions.json`;
- a native file changed since that build's commit (`plugins/`, `android/`, `ios/`, `patches/`,
  `fingerprint.config.js`, native fields of `app.json`, dependencies in `package.json`);
- for production: the same commit was not published to preview first.

They bundle with the same `EXPO_PUBLIC_*` values as the channel's build profile in `eas.json`
(`EXPO_PUBLIC_API_BASE=https://multies.si` for production and preview).

Check what is live:

```bash
npx eas-cli update:list --branch production --limit 5
npx eas-cli channel:view production
```

## Rolling back

- Back to an earlier update: `npx eas-cli update:republish --group <earlier group id>` (or
  `npx eas-cli update:rollback` and pick it). Phones get it on their next two cold starts.
- Back to the bundle inside the store build: `npx eas-cli update:roll-back-to-embedded --branch
  production --runtime-version <runtime version>`.
- Stop a bad update from spreading: publish with `--rollout-percentage 10` first, then
  `npx eas-cli update:edit --rollout-percentage 100`, or `update:revert-update-rollout`.

## Safety on the phone

expo-updates checks every launch. If an update crashes before the app has rendered, the next launch
marks it as failed and falls back to the previous working update, or to the bundle inside the store
build, so a bad update cannot trap a phone in a crash loop. A failed check or download (no network)
just keeps the current bundle.

## Store builds with EAS Update

| Store build | Runtime version |
| --- | --- |
| iOS 1.9.3 (17) | e184c142208d3b3fae34511c791824950b768f8a |
| Android 1.9.3 (15) | e5a5bb6ce563a5072e021a35eb0966285dc7af8a |

Builds before these (iOS 16 and earlier, Android 14 and earlier) have no EAS Update and need the
store to update them.

The first update, 1.9.4 (OTA), went to preview and then production on 26 Oct 2026 (ids in
docs/RELEASES.md).

## Not proven on a device yet

This box has no hardware acceleration for an Android emulator (no /dev/kvm), so the pickup on a phone
was not filmed here. What was checked: the update manifest that phones request answers with the new
update for each store build's runtime version and channel. On a phone: install build 17 or 15, open
the app, close it fully, open it again, and Settings reads Multies 1.9.4 (OTA).
