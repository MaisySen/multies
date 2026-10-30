# Releasing the phone app

There is ONE working copy: this folder (`/home/user/tab/work/mymail/mobile`), branch `ota`. It is
the code line of the store builds phones have now (1.10.0: iOS TestFlight build 20, Android Play
internal versionCode 16) plus the over the air (OTA) updates on top. Its `node_modules` matches those
builds: `npx expo-updates fingerprint:generate` gives iOS `fe703a98...` and Android `5c9046a2...`,
the runtimes of the live builds. Do not cut OTA branches from older lines and do not publish from
another folder. Older worktrees were removed on 31 Oct 2026; their branches are kept (see "Old
branches" below).

## Over the air update (JavaScript and assets only)

Always through `scripts/ota-publish.js`, with the Expo token from the credentials helper:

```
node ../app/scripts/creds.mjs run EXPO_TOKEN -- npm run ota:check        # what would happen, no publish
node ../app/scripts/creds.mjs run EXPO_TOKEN -- npm run ota:preview
node ../app/scripts/creds.mjs run EXPO_TOKEN -- npm run ota:production
node ../app/scripts/creds.mjs run EXPO_TOKEN -- npm run ota:verify       # ask the update server again
```

What it does, in order, and it stops at the first failure:

1. **Reads the live store builds, every time.** iOS: App Store Connect builds for the app that are
   processed and not expired (TestFlight), joined to `eas build:list` for each build's runtime.
   Android: every version code in a completed or in progress release on any Play track, joined to
   `store/android-builds.json` for its runtime (Android bundles are built locally, so EAS has no
   record of them). There is no hand kept "current store build" file any more: the old
   `store/runtime-versions.json` went stale on the 1.9 line and let 1.9.12 and 1.9.13 go to runtimes
   no phone had. A Play version code that is not in `store/android-builds.json` is a refusal.
2. **Refuses unless the runtimes match.** The fingerprint of this code must equal the runtime of
   the newest live store build on each platform. It also refuses uncommitted changes, native files
   changed since that build's commit, stale What's new, and production without the same commit on
   preview first.
3. **Publishes** with `eas update` on the channel, bundled with that channel's `EXPO_PUBLIC_*`
   values from `eas.json` (production: `https://multies.si`, preview: `https://preview.multies.si`).
4. **Proves it landed.** It asks the update server (`u.expo.dev`, protocol 1, with the
   platform, runtime and channel headers a phone sends) for each targeted runtime, and fails unless
   the answer is the new update id (it retries for up to 2 minutes).
5. **Prints one line**, for example
   `ota-publish: OK production ios 1.10.0(20) rt fe703a98 -> 01a18d1a-...; android 1.10.0(16) rt 5c9046a2 -> 01a18d1a-...`
   or `ota-publish: REFUSED production, 2 problem(s), nothing published`.

A drill: `--runtime ios=<hash>,android=<hash>` pretends the code has those runtimes and only runs the
check (it never publishes). With the 1.9.13 runtimes it refuses:

```
node ../app/scripts/creds.mjs run EXPO_TOKEN -- node scripts/ota-publish.js production \
  --runtime ios=e184c142208d3b3fae34511c791824950b768f8a,android=e5a5bb6ce563a5072e021a35eb0966285dc7af8a
```

After it says OK: raise nothing else. Phones take the update on the next cold start after it has
downloaded (close the app fully, open it, close again, open again). The version line at the bottom
of Settings then shows the `JS_VERSION` of the update. Health, staged rollout and rollback stay in
`scripts/ota.js` (`npm run ota:status`, `ota:health`, `ota:promote`, `ota:rollback`; see docs/OTA.md).

## Store build (native change)

Needed when the fingerprint changes (a native package, a config plugin, native parts of `app.json`).
The publish script refuses an OTA in that case. After a new store build reaches TestFlight or Play:

- iOS: nothing to record; EAS keeps the runtime and App Store Connect says it is live.
- Android (built locally with Gradle): add a row to `store/android-builds.json` with the version code,
  version, runtime (`npx expo-updates fingerprint:generate --platform android` at the build commit),
  channel and commit, in the same commit that records the build in docs/RELEASES.md.
- Then `npm run ota:check` must pass on this folder before any update.

## Old branches

Kept, not checked out anywhere: `mobile`, `r27-mobile`, `r31-mobile` to `r36-mobile`,
`tools-mobile`, `mobile-tools-p2`, `release-1.10`, `release-1.10-ota`, `auth-r11`, `ota-ws` (all
already inside `ota`). Two hold a commit that is not in `ota`:
`multiws-198` (an earlier take of the Workspaces screen; the shipped version is `ota-ws` f08a84f)
and `r37-pages` (an email setup restyle that was never merged or shipped). Do not delete them
without a look.
