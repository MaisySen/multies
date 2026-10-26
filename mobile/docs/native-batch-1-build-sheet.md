# Native batch 1: exact build changes (R36 lead, 26 Oct 2026)

Companion to docs/native-batch-1.md (the why and the evidence); this sheet is the exact what.

List only. Nothing here is built. Every change below alters the native fingerprint, so it ships in ONE store build (Multies 1.10.0, new runtime), never by OTA. Add each package with `npx expo install <package>` so the version matches Expo SDK 58 (expo ~58.0.17, react-native 0.88.0). Today's app.json plugins: expo-router, expo-secure-store, expo-sqlite, expo-localization, expo-web-browser, expo-font, expo-splash-screen, expo-notifications, expo-asset, ./plugins/with-release-signing. Android permissions today: POST_NOTIFICATIONS only, with a long blockedPermissions list.

| # | Item | Packages to add | app.json plugins / native fields | iOS Info.plist and entitlements | Android manifest |
|---|------|-----------------|----------------------------------|---------------------------------|------------------|
| 1 | UI thread gestures and springs (swipe rows, detent sheets, list motion) | react-native-gesture-handler, react-native-reanimated, react-native-worklets | none (babel plugin react-native-worklets/plugin in babel.config.js) | none | none |
| 2 | Real blur on tab bar, title bar, sheet headers | expo-blur | none | none | none |
| 3 | Native context menus with lifted preview (mail, task, chat rows; report and block) | zeego, react-native-ios-context-menu, @react-native-menu/menu | none | none | none |
| 4 | Real SF Symbols on iOS (Icon component swap) | expo-symbols | none | none | none |
| 5 | Universal links and app links (mail, task links and magic link open the app) | none | ios.associatedDomains ["applinks:multies.si"]; android.intentFilters [{action VIEW, autoVerify true, data [{scheme https, host multies.si, pathPrefix /app}], category [BROWSABLE, DEFAULT]}] | entitlement com.apple.developer.associated-domains | intent filter above; web side: /.well-known/apple-app-site-association and /.well-known/assetlinks.json on multies.si (publish first) |
| 6 | Passkeys and Face ID / fingerprint unlock | react-native-passkey, expo-local-authentication | ["expo-local-authentication", {"faceIDPermission": "Multies uses Face ID to unlock the app."}]; ios.associatedDomains add "webcredentials:multies.si" | NSFaceIDUsageDescription (from the plugin); associated-domains entitlement | REMOVE android.permission.USE_BIOMETRIC and android.permission.USE_FINGERPRINT from blockedPermissions; add USE_BIOMETRIC to permissions |
| 7 | Home screen widgets (Inbox and due today; Quick add) | @bacons/apple-targets (iOS WidgetKit target), react-native-android-widget | ["@bacons/apple-targets"], ["react-native-android-widget", {widgets: [...]}]; targets/widget/ folder | App Group entitlement com.apple.security.application-groups ["group.au.fintex.multies"] on app and widget | widget receiver and provider XML (from the plugin) |
| 8 | Share extension (share a link, text or file into a task or mail) | expo-share-intent | ["expo-share-intent", {iosActivationRules: {NSExtensionActivationSupportsWebURLWithMaxCount: 1, NSExtensionActivationSupportsText: true, NSExtensionActivationSupportsFileWithMaxCount: 5}}] | share extension target + the same App Group | intent filters for ACTION_SEND and ACTION_SEND_MULTIPLE (text/*, image/*, application/*) |
| 9 | App icon quick actions (New task, Compose, Search, Inbox) | expo-quick-actions | ["expo-quick-actions", {iosActions: [...4 items], androidIcons: {...}}] | UIApplicationShortcutItems (from the plugin) | static shortcuts XML (from the plugin) |
| 10 | Android baseline profile (faster cold start) | none (androidx.profileinstaller via Gradle) | ./plugins/with-baseline-profile (new local plugin that adds the dependency and app/src/main/baseline-prof.txt) | none | none |
| 11 | In app review and in app update prompts | expo-store-review, sp-react-native-in-app-updates | none | none | none |
| 12 | Android launcher badge count | none | notification channel showBadge true (expo-notifications channel config, JS) | none | to support Samsung and Huawei launchers, REMOVE com.sec.android.provider.badge.permission.READ/WRITE and com.huawei.android.launcher.permission.CHANGE_BADGE from blockedPermissions |
| 13 | Notification service extension (re check the block list; rich mail push) | @bacons/apple-targets (notification-service target) | target in targets/notification-service | App Group shared with the app; mutable-content push already sent by the server | none |
| 14 | Drop lucide-react-native (no imports since R34) | remove from package.json | none | none | none |

Not needed (already in the binary, JS only): native large titles (react-native-screens headerLargeTitle is used in src/app/_layout.tsx today), haptics (expo-haptics), Phosphor icons drawn with react-native-svg.

Privacy and review: the App Privacy answers do not change (no new data is collected; Face ID stays on the device). Item 5 needs the AASA file served with content-type application/json and no redirect. Items 7, 8 and 13 add targets, so the provisioning profiles need the App Group (Apple Developer, Identifiers).

Build steps: bump expo.version to 1.10.0, runtimeVersion policy stays fingerprint; `npx expo prebuild --clean`; EAS build iOS and Android; TestFlight internal and Play internal; record the new runtime versions in store/runtime-versions.json (docs/OTA.md). After it is live, OTA updates target the new runtime only, so keep one last 1.9.x OTA for phones that do not update.
