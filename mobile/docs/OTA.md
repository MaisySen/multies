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

## Runbook: how we ship (OTA by default; store builds only for native changes, batched)

1. Every JavaScript, copy, style or image change ships over the air: preview first, then production
   as a staged rollout. Never cut a store build for a change an update can carry.
2. A store build is only for native changes (new native package, SDK upgrade, permission, plugin,
   `app.json` native field, privacy manifest). Collect them in "Queued for the next store build"
   below and ship them together in one build, then record the new runtime versions in
   `store/runtime-versions.json`. The guard refuses an update that needs native code, so a native
   change can never reach phones by mistake.
3. Production is always staged: 10 percent, watch health, 50, watch, 100. A bad update is rolled
   back with one command, and phones already on it leave it at once.

All commands run through the credentials helper so no value is ever typed or printed:

```bash
C="node ../app/scripts/creds.mjs run EXPO_TOKEN,SENTRY_OPS_TOKEN,SENTRY_ORG,SENTRY_DSN_WEB,APP_CONFIG_TOKEN --"
npm run whats-new                       # after editing CHANGELOG.md; commit the result
npm run ota:check                       # the guard only
$C npm run ota:preview -- --message "What changed"
# open it on a preview build (Settings, Check for updates, Restart to update)
$C npm run ota:production -- --rollout 10 --message "What changed"
$C npm run ota:health                   # HEALTHY, WAIT, HALT or ROLLBACK, from Sentry
$C npm run ota:promote -- 50            # refused unless health says HEALTHY (--force after a manual look)
$C npm run ota:promote -- 100
$C npm run ota:status                   # what each platform runs on production now
```

Something wrong:

```bash
$C npm run ota:rollback                 # ends an active rollout, or republishes the update before it
$C npm run ota:rollback -- --embedded   # back to the bundle inside the store build
$C npm run ota:health -- --auto-rollback  # what a scheduled watcher runs: rolls back on its own above the threshold
```

A rollback also adds the bad update ids to `ota.blocked_update_ids` in the app config, so phones
still running them apply the replacement at once instead of at their next cold start.

An urgent fix: `$C npm run ota:production -- --rollout 100 --critical --message "..."` marks the new
update ids critical in the app config; phones that find it download it and restart into it after a
short notice ("Installing an important update. Multies restarts in a moment.").

The guard (`scripts/ota.js`, `scripts/ota-guard.js`, tests in `__tests__/ota-guard.test.ts`) refuses
to publish when:

- the working tree has uncommitted changes;
- the Android or iOS fingerprint differs from the store build recorded in
  `store/runtime-versions.json`;
- a native file changed since that build's commit (`plugins/`, `android/`, `ios/`, `patches/`,
  `fingerprint.config.js`, native fields of `app.json`, dependencies in `package.json`);
- the What's new notes (`src/lib/ota/whats-new.generated.ts`) are out of date with `CHANGELOG.md`;
- for production: the same commit was not published to preview first.

They bundle with the same `EXPO_PUBLIC_*` values as the channel's build profile in `eas.json`
(`EXPO_PUBLIC_API_BASE=https://multies.si` for production and preview). Each platform has its own
runtime version, so one publish makes one update group per platform; every command above acts on
both.

## Staged rollouts

EAS Update rollouts (`eas update --rollout-percentage`, `eas update:edit --rollout-percentage`,
`eas update:revert-update-rollout`) work on our free plan: checked 26 Oct 2026 with 1.9.6 (see
RELEASES.md). EAS buckets phones by their install id on the server, so a phone stays in or out of
the rollout across launches, and phones outside it keep the previous update. While a rollout runs,
publishing another update to the same runtime fails unless it passes `--force-end-active-rollout`;
promote or roll back first.

## Health gating (Sentry)

Phones report to Sentry over plain HTTPS (`src/lib/ota/telemetry.ts`, no native SDK), each event
tagged `app:mobile`, `ota_event`, `update_id`, `channel`, `runtime_version`, `js_version`,
`native_build` and `os`, with a random per-install id as the user (not the person's account):

| `ota_event` | When |
| --- | --- |
| `applied` | The first launch of a new update on a phone (once per update). The denominator. |
| `crash` | A fatal JavaScript error (global handler; the original handler still runs). |
| `launch_crash` | The previous launch ended within 10 s of starting without going to the background, natively or in JS. |
| `failed` | expo-updates fell back to an earlier bundle (emergency launch) or logged a load error. |
| `download_failed` | A found update could not be downloaded. |

Reports are queued on the phone and sent when the DSN is known (from the app config), so a crash
before the network is reached is sent on the next launch. `scripts/ota-health.js` counts distinct
installs per event for the newest production update ids through the Sentry events API:

- ROLLBACK: crash rate above 2 percent with at least 20 installs, or 5 or more crashed installs;
- HALT: update failures above 5 percent, or any crash on fewer than 20 installs;
- WAIT: fewer than 20 installs; HEALTHY otherwise. Thresholds: `--max-crash-rate`, `--min-installs`.
- Time rule (R34): an update that has been out 24 hours (from the earliest update in its group)
  with 0 crash and 0 failed (rolled back) reports is HEALTHY even below 20 installs. Whichever
  comes first wins: 24 hours clean, or 20 installs with good rates. `--min-age-hours` changes it.

The events land in the `mymail-web` Sentry project (environment `mobile-production`, tag
`app:mobile`) because the builder token cannot create projects; `SENTRY_DSN_MOBILE` on the server
moves them to a dedicated project later without an app change.

## Remote app config (force update, critical updates)

`GET https://multies.si/api/v1/app-config` (server: `src/server/routes/app-config-r29b.ts`), public,
cached 60 s, read at launch and on resume (at most every 5 minutes) and kept on the phone:

```json
{ "mobile": {
  "min_supported": { "ios": { "build": null, "version": null }, "android": { "build": null, "version": null } },
  "store_url": { "ios": "https://apps.apple.com/app/id6826562106", "android": "https://play.google.com/store/apps/details?id=au.fintex.multies" },
  "ota": { "critical_update_ids": [], "blocked_update_ids": [], "check_interval_minutes": 30, "apply_on_resume_after_minutes": 240 },
  "telemetry": { "sentry_dsn": "...", "sample_rate": 1 },
  "message": null } }
```

- A store build below `min_supported` (build number, else version) shows only a blocking screen,
  "Update Multies to continue", with a button to the App Store or Google Play. Use it rarely: when
  an API change breaks old builds. Set it with
  `curl -X PUT https://multies.si/api/v1/app-config -H "authorization: Bearer $APP_CONFIG_TOKEN" -H "content-type: application/json" -d '{"min_supported":{"ios":{"build":18}}}'`
  (inside `$C`), or from the operator console API (`PUT /api/admin/app-config`, platform admins).
- Junk or an unreachable server never blocks: the phone keeps its last good config, else the safe
  defaults.

## How phones take an update

- Cold start: expo-updates checks and downloads in the background natively (`ON_LOAD`,
  `fallbackToCacheTimeout: 0`), and the app never waits for the network. 8 s later the app checks
  once more in JavaScript to read the critical flag.
- Back to the front after 30 s or more away: the app checks again if the last check is older than
  `check_interval_minutes` (30), so switching apps never floods the update server.
- A downloaded update is used from the next cold start. After 4 hours away
  (`apply_on_resume_after_minutes`) it is applied on resume, since the screen state is stale anyway.
- Critical update, or a phone running a rolled back update: applied at once after a short notice.
- Settings, Updates: Check for updates (Checking, Downloading, Up to date, Ready) and Restart to
  update once one is ready. The line at the bottom shows the version, the update id, the channel and
  the store build.
- What's new: a sheet once, on the first start of a newer `JS_VERSION`, listing that version's
  CHANGELOG bullets (never on a fresh install). Raise `JS_VERSION` and add a CHANGELOG entry for each
  update, then `npm run whats-new`.

## Queued for the next store build (native, batched)

Nothing in R29b needed native code. Add native items here as they come up; ship them together.

- Privacy: the update health reports are diagnostics (crash data) sent to Sentry. App Store Connect
  App Privacy ("Crash data", not linked to the user, not used for tracking) and the Play data safety
  form can be updated now without a build; also add `NSPrivacyCollectedDataTypeCrashData` to
  `ios.privacyManifests` in `app.json` with the next store build.
- Optional: `@sentry/react-native` for native crash symbolication (native module).
- Optional: EAS Update code signing needs a paid EAS plan; not on the free plan.

## How this compares (R29b review, 26 Oct 2026)

| Practice | Who does it | Multies now |
| --- | --- | --- |
| JS ships over the air, store builds batched | Shopify, Discord, Microsoft (CodePush) | Yes, enforced by the fingerprint guard |
| Staged percentage rollout | Shopify (EAS/CodePush), Shorebird, Capgo | Yes, 10 / 50 / 100 with EAS rollouts |
| Health gate before widening | Shopify, Linear (Sentry release health) | Yes, crash and failure rates per update id, scripted |
| One command rollback, phones leave at once | CodePush (rollback + mandatory), Capgo | Yes, rollback plus blocked ids |
| Forced store update below a minimum | Slack, Notion, Discord | Yes, server driven, per platform |
| Critical update applied now | CodePush `mandatory`, Capgo | Yes, server flag per update id with a notice |
| Background check on resume, throttled | Slack, Discord | Yes, 30 minute floor |
| What's new after an update | Linear, Notion | Yes, from CHANGELOG |
| Code signed updates | Shopify, Shorebird | Not on the EAS free plan (HTTPS only) |

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
docs/RELEASES.md). 1.9.5 (OTA) followed the same day (agent runs and checklist drag to reorder).

Commit docs about an update (RELEASES rows) only after production is published: the guard
publishes to production only the exact commit that went to preview.

## Not proven on a device yet

This box has no hardware acceleration for an Android emulator (no /dev/kvm), so the pickup on a phone
was not filmed here. What was checked: the update manifest that phones request answers with the new
update for each store build's runtime version and channel. On a phone: install build 17 or 15, open
the app, close it fully, open it again, and Settings reads Multies 1.9.4 (OTA).
