# Releases

Every store build, newest first. Add a row for every upload and every OTA update.

| Version | Android versionCode | iOS build | Commit (mobile repo) | Files | Status |
| --- | --- | --- | --- | --- | --- |
| 1.8.1 (iOS) | none | 12 | fcd4cef | EAS build 906fdba2-b2a0-4da1-9fc5-dc1656910ccb | iOS bundle au.fintex.multies. EAS Build 24 Oct 2026 (project @multies/mymail, local credentials: Apple Distribution cert and App Store profile made with the ASC API key). Uploaded to App Store Connect app 6826562106, TestFlight internal group Fintex. Build 11 failed at npm ci on a peer dependency conflict, fixed with .npmrc legacy-peer-deps |
| 1.8.1 | 10 | 10 (CI uses 100 plus the run number) | f5d8340 | multies-1.8.1.aab, multies-1.8.1.apk | Package au.fintex.multies. Rebuilt 24 Oct 2026 after the app id change, signed with the same Fintex upload key. On Play internal testing since 24 Oct 2026 |
| 1.8.1 (first build) | 10 | 10 | 64d63a7 (main 991ee1d) | replaced | Package au.mymail.app, never uploaded, files replaced by the build above |
| 1.8.0 | 9 | 9 | c644e83 | multies-android-arm64.apk | Direct install APK only, old key |
| 1.7.0 | 8 | 8 | f2a46fe | APK | Direct install only |
| 1.6.0 | 7 | 7 | 55f097b | mymail-release.aab | Built, never uploaded |

OTA updates: none. EAS Update is not set up yet. The Expo project is @multies/mymail (id 83c874f8-cc92-4440-8ccd-5b99c2d8ec1f), iOS buildNumber is kept remotely by EAS (next is 13).
