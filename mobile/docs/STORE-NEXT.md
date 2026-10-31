# Next store build: what waits for it

Things the over the air updates leave out because they need native code. None of them blocks 1.10.7.

## From 1.10.8 (1 Nov 2026)

- Nothing new. The Social inbox and account health use only modules already in iOS build 20 and Android versionCode
  16 (expo-web-browser for Reconnect, React Native's own lists and inputs). A push notification that opens a
  conversation straight from the bell alert would need the notification route mapping only (JavaScript), not a store
  build.

## From 1.10.7 (31 Oct 2026)

- Translate in place on iPhone. 1.10.7 sends Translate to the share sheet on iOS (where the system Translate and any
  translate app sit) and to the system translate intent on Android (falls back to the share sheet). Showing the
  translation inside Multies, without leaving the app, needs Apple's Translation framework (iOS 17.4 and later) through
  a native module, so it waits for the next store build.
- A native long press menu (context menu with a preview) on mail rows and posts. 1.10.7 uses the app's own sheet, which
  works on every build; the system preview menu needs a native module.
- Picking from Photos in the Social composer (carried over from 1.10.6, see docs/SOCIAL-STORE-PREP.md).

Everything else in 1.10.7 (inbox tabs, Snoozed, labels, rules, Copy, Copy link, Share, Copied toast with haptic, text
selection, paste) uses modules already in iOS build 20 and Android versionCode 16: expo-clipboard, expo-haptics and
React Native's own Share and Linking.
