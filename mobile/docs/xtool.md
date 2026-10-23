# xtool on this Linux box: what it can and can't do

Tested 2026-10-23 on Debian 12 (x86_64, 16 CPUs, no KVM, no USB devices) with xtool 1.23.0
(AppImage) and Swift 6.4.1 from swiftly.

## What worked

- Installing xtool (AppImage extracted, no FUSE needed) and the Swift 6.4.1 toolchain.
- `xtool new MyMail` generates a SwiftPM app project.
- `ios-native/` here is a real SwiftUI app: sign in (with the two step code) and approve or reject
  what agents want to send. Its networking, cookie jar and models live in `MyMailKit`, plain
  Foundation, which **builds and passes its 4 tests on Linux** (`swift build && swift test`).
  The SwiftUI screens are inside `#if canImport(SwiftUI)`, so they compile only with the iOS SDK.

## Where it stops

`xtool dev build` asks for `Xcode.xip` to generate the iOS SDK:

```
Now generating the Darwin SDK.
Please download Xcode from http://developer.apple.com/download/all/?q=Xcode
and enter the path to the downloaded Xcode.xip.
```

Xcode.xip (about 3 GB) only downloads after signing in with an Apple ID and accepting Apple's
licence, so it can't be fetched for the owner. Two more limits:

- Installing on a phone needs the iPhone plugged in by USB to the machine running xtool
  (`usbmuxd`). This box is a remote server with no USB.
- xtool builds native Swift only. It can't build the Expo app (React Native needs Xcode's
  build system and CocoaPods). For the Expo app, EAS Build is the path (docs/release.md).

## What the owner would provide to use xtool

1. An Apple ID (free works for installing on your own phone for 7 days; a paid Developer
   Program membership gives 1 year profiles and TestFlight).
2. `Xcode.xip` 27.1 downloaded from https://developer.apple.com/download/all/?q=Xcode
3. A Linux or Windows (WSL) computer with the iPhone connected by USB, then:

```bash
xtool setup                 # log in with the Apple ID, point it at Xcode.xip
cd mobile/ios-native
xtool dev                   # builds, signs and installs MyMail Approvals on the phone
```

## Verdict

Useful later for small native pieces the Expo app can't do in JavaScript, such as a home screen
widget or a share extension. Those would reuse `MyMailKit`. Not the route to TestFlight or the
App Store for the main app: EAS Build does that without a Mac and without USB.
