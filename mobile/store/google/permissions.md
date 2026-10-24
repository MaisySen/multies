# Multies Android permissions (1.8.1, versionCode 10)

Read from the built, signed APK with `aapt2 dump permissions` on 24 October 2026 (the AAB has the
same merged manifest). targetSdk 36, minSdk 24. No permission here needs a Play Console declaration.

| Permission | Why the app has it |
| --- | --- |
| android.permission.INTERNET | Talks to the Multies server over HTTPS |
| android.permission.ACCESS_NETWORK_STATE | Knows when the phone is offline, to show saved mail |
| android.permission.POST_NOTIFICATIONS | Shows alerts for new mail, mentions and approvals, only after the person allows it |
| android.permission.VIBRATE | Notification and haptic feedback |
| android.permission.RECEIVE_BOOT_COMPLETED | expo-notifications keeps notification channels and scheduled reminders after a restart |
| android.permission.WAKE_LOCK | Lets a push message be handled while the phone is asleep (Firebase messaging) |
| com.google.android.c2dm.permission.RECEIVE | Receives push messages through Firebase Cloud Messaging |
| au.mymail.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION | Added by AndroidX so the app's own receivers are not reachable by other apps. Signature level, no prompt |

Blocked with `android.blockedPermissions` in app.json, because the app does not use them:
RECORD_AUDIO, SYSTEM_ALERT_WINDOW, READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_STORAGE,
ACCESS_BACKGROUND_LOCATION, ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION, CAMERA,
FOREGROUND_SERVICE, FOREGROUND_SERVICE_LOCATION, USE_BIOMETRIC, USE_FINGERPRINT, READ_APP_BADGE,
the Play install referrer service, and the launcher badge permissions of Samsung, HTC, Sony,
Huawei, Oppo, Apex, Nova (majeur) and everything.me.

Check again after every native change:
`$ANDROID_HOME/build-tools/37.0.0/aapt2 dump permissions android/app/build/outputs/apk/release/app-release.apk`
