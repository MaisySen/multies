# Releases

Every store build, newest first. Add a row for every upload and every OTA update.

| Version | Android versionCode | iOS build | Commit (mobile repo) | Files | Status |
| --- | --- | --- | --- | --- | --- |
| 1.9.0 (iOS) | none | 13 | e76bf16 (feature 996590b) | EAS build cad0bd01-834f-42ea-b9a7-3caa1642222a, multies-1.9.0-13.ipa (sha256 a99065e6...87bcf) | 25 Oct 2026. EAS Build (production-local-credentials, same local Apple Distribution cert and App Store profile), about 6 min from queue to finish. Checked inside the .ipa: au.fintex.multies 1.9.0 (13), PrivacyInfo.xcprivacy at the app root (no tracking, 7 data types, Diagnostics linked, CA92.1, C617.1 and 0A2A.1, 35F9.1, E174.1), JS bundle on https://multies.si with no workers.dev or old preview host. EAS Submit d09930f1-bcc0-4dac-84f0-75887d6f36b4 with the ASC API key; App Store Connect build 94e07260-255d-403d-927b-b87442687c8c VALID, TestFlight internal IN_BETA_TESTING in group Fintex |
| 1.9.0 | 11 | 13 (EAS) | e76bf16 (feature 996590b) | multies-1.9.0-11.aab (sha256 843596e2...b7512) | 25 Oct 2026. Local gradle bundleRelease (arm64-v8a, armeabi-v7a, x86_64), targetSdk 36, signed with the Fintex upload key (SHA-256 0D:E2:49:52:...:EB:39, same as 1.8.1). Uploaded with the Play service account to INTERNAL testing only: internal track now 1.9.0 (11) completed; the closed test (alpha) stays on 1.8.1 (10), untouched |
| 1.8.1 (iOS) | none | 12 | fcd4cef | EAS build 906fdba2-b2a0-4da1-9fc5-dc1656910ccb | iOS bundle au.fintex.multies. EAS Build 24 Oct 2026 (project @multies/mymail, local credentials: Apple Distribution cert and App Store profile made with the ASC API key). Uploaded to App Store Connect app 6826562106, TestFlight internal group Fintex. Build 11 failed at npm ci on a peer dependency conflict, fixed with .npmrc legacy-peer-deps |
| 1.8.1 | 10 | 10 (CI uses 100 plus the run number) | f5d8340 | multies-1.8.1.aab, multies-1.8.1.apk | Package au.fintex.multies. Rebuilt 24 Oct 2026 after the app id change, signed with the same Fintex upload key. On Play internal testing since 24 Oct 2026 |
| 1.8.1 (first build) | 10 | 10 | 64d63a7 (main 991ee1d) | replaced | Package au.mymail.app, never uploaded, files replaced by the build above |
| 1.8.0 | 9 | 9 | c644e83 | multies-android-arm64.apk | Direct install APK only, old key |
| 1.7.0 | 8 | 8 | f2a46fe | APK | Direct install only |
| 1.6.0 | 7 | 7 | 55f097b | mymail-release.aab | Built, never uploaded |

OTA updates: none. EAS Update is not set up yet. The Expo project is @multies/mymail (id 83c874f8-cc92-4440-8ccd-5b99c2d8ec1f), iOS buildNumber is kept remotely by EAS (next is 14). Build 13 (1.9.0) is the first build that needs no redirect at the old preview host: every link and the API are on multies.si.
