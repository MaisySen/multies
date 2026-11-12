# Native batch 1 (queued, not built)

One store build, one review: Multies 1.10.0 with a new runtime version. Everything here changes the native fingerprint, so none of it can ship by OTA. JS 1.9.8 and later OTA updates keep shipping to 1.9.x until this build is live; after it, OTA updates target the new runtime only. Not to be built now. Evidence lives in /home/user/tab/files/teardowns/rea/ (build list: MOBILE-BUILD-LIST.md, items 6 to 14).

1. react-native-gesture-handler + react-native-reanimated: move swipe rows (src/components/swipe-row.tsx, PanResponder today) and sheets onto the UI thread for 60 to 120 fps springs and detent sheets for compose and quick add. Why: JS thread gestures stutter while lists load. Teardown: clickup/mobile-architecture.md, clickup/mobile-ux.md, slack/mobile-ux.md.
2. Home screen widgets, "Inbox and due today" and "Quick add": iOS WidgetKit and Android Glance through a config plugin, fed by a small shared store the app writes. Why: every top app ships one and it is a daily return path. Teardown: todoist/mobile-manifest.md, things/mobile-store.md, spark/mobile-manifest.md.
3. Share extension + 4 app icon quick actions (New task, Compose, Search, Inbox): share a link, text or file into a task or a mail. Why: capture from anywhere without opening the app. Teardown: todoist/mobile-manifest.md, slack/mobile-manifest.md, superhuman/mobile-manifest.md.
4. Associated domains (iOS universal links) + Android app links, plus the web files /.well-known/apple-app-site-association and /.well-known/assetlinks.json on multies.si: mail and task links open in the app, and the sign in magic link lands in the app. Why: today only the mymail:// scheme works. Teardown: clickup/mobile-manifest.md, monday/mobile-manifest.md, slack/mobile-manifest.md.
5. Passkeys + biometric app lock (Credential Manager on Android, AuthenticationServices on iOS; Face ID or fingerprint to open the app): Why: sign in is the top store complaint (ClickUp 28 of 94 bad reviews, Superhuman 20 of 109). The OTA half (silent refresh, never sign out on a network error) is in JS 1.9.8. Teardown: superhuman/mobile-store.md, clickup/mobile-store.md, linear/mobile-store.md, slack/mobile-architecture.md.
6. Android baseline profile: precompiles the startup path for a faster cold start. Why: cheap startup win the native apps all ship. Teardown: slack/mobile-architecture.md, todoist/mobile-architecture.md.
7. Blur behind the tab bar and sheet headers, or expo-router native tabs: the iOS 26 glass look with the #0071E3 accent. Why: the premium feel the owner asked for. Teardown: clickup/mobile-architecture.md, clickup/mobile-ux.md.
8. In-app review + in-app update prompts (StoreKit review request, Play in-app updates): ask for a rating after a good moment, prompt when a store build is required. Why: ratings and update reach. Teardown: monday/mobile-architecture.md, todoist/mobile-store.md.

Before building: bump runtimeVersion, run the fingerprint guard (scripts/ota-guard.js) to confirm the new fingerprint, publish the web files from item 4 first, and test on a TestFlight and an internal Play track build.

## Added in R34 (premium pass 2)
9. Real blur materials (expo-blur, or expo-router native tabs): the tab bar, the compact title bar and sheet headers use a semi-opaque surface with a hairline today (src/components/chrome.tsx, `chrome`); swap that one object for a BlurView with the system thin material. Why: the owner asked for a native, premium feel; JS cannot blur what is behind a view.
10. Native context menus (react-native-ios-context-menu or zeego on UIMenu and Android popup menus): long-press on mail and task rows opens a JS action sheet with a haptic today; native menus add the lifted row preview. Why: the press and hold preview is the strongest native cue on iOS.
11. SF Symbols proper (expo-symbols, iOS only): the Icon component (src/components/Icon.tsx) draws Phosphor paths today, the closest open set; with expo-symbols it can render the real SF Symbol per name on iOS with weight and hierarchical colour, keeping Material Symbols on Android. The name map is already semantic, so the swap is inside Icon only.
12. Native large titles (react-native-screens headerLargeTitle with a native stack on each tab): the large title folds on scroll in JS today (useCollapse + LargeTitle collapsed); native large titles track the scroll on the UI thread with the system spring.
13. Badge count on Android launchers: expo-notifications sets the iOS badge; Android needs a notification channel badge or a launcher plugin for a count on the icon.


## Added in R35 (phone helper, 26 Oct 2026)

- Native report and block menu: iOS UIMenu (context menu with a preview) and Android popup menu on a
  chat message, so Report message and Block sit in the system press and hold menu instead of the JS
  sheet. Needs the native context menu module already listed above; the JS sheet stays as fallback.
- Native destructive confirm on Android: Alert.alert works today; a Material 3 dialog with a red
  Block button needs a small native module or the new Expo dialog API when it lands in the binary.
- Spring physics on the UI thread: shared motion values (src/lib/motion.ts SPRING) run on the JS
  thread through Animated and LayoutAnimation. Reanimated is not in the binary; adding it would let
  list inserts, sheet drags and swipe release run at 120 Hz without JS frames.
- Interactive sheet dismissal: swipe down to close the report sheet and action sheets with the
  native sheet presentation (iOS UISheetPresentationController detents, Android bottom sheet).
  Today they close by tapping outside or Cancel.
- Blocked user filter in the notification service extension: push for a DM or mention is already
  dropped server side for blocked people; a Notification Service Extension could re check the
  cached block list on iOS so a stale server never shows one. Needs a native target.

## Added in R36 (phone helper, pass 2 on the remaining screens, 26 Oct 2026)

- Native search field: the Search screen draws its own 44 pt rounded field in JS. A native
  search bar (react-native-screens headerSearchBarOptions on the native stack, UISearchController
  on iOS and the Material search view on Android) would give the system cancel button, dictation
  and scope bar. Needs the native stack header on that route.
- Native date picker for task Due: the Due row opens a JS sheet with Today, Tomorrow, Next week and
  No date. A calendar wheel or inline calendar needs @react-native-community/datetimepicker (native
  module, not in the binary).
- Haptic on the subtask check with the system "success" pattern plus the sound off switch already
  works through expo-haptics; a richer tick (UIImpactFeedbackGenerator with intensity, Android
  performHapticFeedback CONFIRM) needs a newer expo-haptics in the binary.
- Calendar events from the phone: the meetings list shows Multies meetings only. Showing the phone's
  own calendar beside them needs expo-calendar plus the NSCalendarsFullAccessUsageDescription key
  (iOS) and READ_CALENDAR (Android).
- Rich mail bodies: the thread shows the plain text part with quoted text folded. Rendering the
  HTML part safely needs react-native-webview (native module), sandboxed with remote images off by
  default.
