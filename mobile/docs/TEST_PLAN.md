# Test plan

Run before every store upload. Record the result in docs/RELEASES.md.

## Automatic

```bash
npm run check     # typecheck, copy check (no em or en dashes), unit and smoke tests
```

The tests also check the privacy manifest against the native modules, the release signing plugin,
the store config (target SDK, permissions) and account deletion.

## Build checks

- AAB and APK signed with the Fintex upload key (SHA-256 in the credentials list).
- `aapt2 dump permissions` matches store/google/permissions.md exactly.
- targetSdk 36 in the merged manifest.

## On a real phone (Android internal track, iPhone TestFlight)

1. Install, open, see the sign in screen in light and dark mode.
2. Explore with sample data: inbox, a thread, Make task, Approvals approve and reject, Tasks
   board, timer, People, Settings.
3. Sign in with the App Review demo account on the Multies sign in page; the inbox loads.
4. Allow notifications when asked; the app works if they are refused.
5. Turn on airplane mode: saved mail still opens and search works on the saved copy.
6. Settings, Privacy and Terms open the Fintex pages.
7. Sign out: cached mail is gone; sign in again works.
8. Account deletion on a throwaway account: Settings, Delete my account, type DELETE, confirm;
   the app returns to sign in and the account cannot sign in again.
9. VoiceOver or TalkBack reads the tab bar and icon only buttons; large text does not cut off the
   inbox rows.

## Store screenshots

Taken from the current build, looked at one by one, real content only. Sizes: Play phone
1080 x 1920; App Store 6.9 inch 1320 x 2868 and 6.5 inch 1242 x 2688 or 1284 x 2778.
