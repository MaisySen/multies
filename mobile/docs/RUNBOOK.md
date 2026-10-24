# Runbook: build, sign, upload, roll back

## Android release build (Linux build box)

```bash
cd mobile
export ANDROID_HOME=$HOME/Android/Sdk
npx expo prebuild --platform android --clean --no-install
cd android
./gradlew bundleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a,x86_64 -PmymailRequireUploadKey=true --no-daemon
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a,x86_64 -PmymailRequireUploadKey=true --no-daemon
```

Outputs: `android/app/build/outputs/bundle/release/app-release.aab` and
`android/app/build/outputs/apk/release/app-release.apk`. Signing values come from
`~/.gradle/gradle.properties` (docs/SECURITY.md); `-PmymailRequireUploadKey=true` stops the build
if they are missing.

Check before handing over:

```bash
$ANDROID_HOME/build-tools/37.0.0/apksigner verify --print-certs android/app/build/outputs/apk/release/app-release.apk
$ANDROID_HOME/build-tools/37.0.0/aapt2 dump permissions android/app/build/outputs/apk/release/app-release.apk
jarsigner -verify -verbose:summary android/app/build/outputs/bundle/release/app-release.aab
```

The certificate SHA-256 must match the Fintex upload key in the credentials list, and the
permission list must match store/google/permissions.md.

## Every new upload

1. Raise `android.versionCode` and `ios.buildNumber` in app.json (and `version` for a user
   visible release).
2. Build, check, add a row to docs/RELEASES.md and a CHANGELOG entry.
3. Android: Play Console, Test and release, Internal testing, Create new release, upload the AAB.
4. iOS: run the TestFlight workflow (docs/STORE.md, macOS route).

## iOS TestFlight

`ci/github/ios-testflight.yml` (copy into `.github/workflows/`). It prebuilds with Expo, sets the
build number to 100 plus the run number, archives with the Admin API key and uploads. After upload
the build takes 10 to 30 minutes to process. The jobs API shows which step failed.

## Register the bundle id (once)

With the .p8 in `~/.multies-secrets/`, a short script signs an ES256 JWT (iss Issuer ID, kid Key
ID, aud appstoreconnect-v1, 20 minutes or less), then `GET /v1/bundleIds?filter[identifier]=au.mymail.app`
and, if empty, `POST /v1/bundleIds` with platform IOS and name Multies.

## Roll back

- Play: halt the rollout in Play Console, then promote the previous release or upload a fixed
  build with a higher versionCode. A versionCode can never be reused.
- App Store: remove the version from sale or submit a fixed build. Phased release can be paused.
- Server side: the app talks to https://multies.si; server fixes need no app update.

## If the upload key is lost

Ask Google Play support for an upload key reset (Play App Signing keeps the app signing key).
Generate a new key per playbook 4.2 and send its certificate. Then the credentials email.
