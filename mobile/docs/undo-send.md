# Undo send (mobile)

Same behaviour as the web app (app/docs/undo-send.md), built for the phone.

- `src/lib/undo-send.ts`: the timing core (kept in step with `app/src/shared/undo-send.ts`), the
  chosen hold (saved with `secureStorage` under `multies-undo-send-seconds`), the live list of held
  messages and the parked draft that Undo hands back to Compose.
- `src/components/held-send-bar.tsx`: one bar per held message, above the tab bar on tab screens and
  at the bottom edge elsewhere. Countdown, Send now (icon, labelled) and Undo (44 pt targets).
  `announceForAccessibility` says the hold once; the bar is a polite live region on Android.
- `src/app/compose.tsx`: Send validates, starts the hold, closes Compose. Undo opens
  `/compose?restore=1`, which reads the parked draft. Each hold has its own idempotency key.
- Settings, This phone, Undo send: 5, 10, 20 or 30 seconds.

Not covered: if the app is killed during the hold the message is not sent (nothing reached the
server). Tests: `__tests__/undo-send.test.ts`.
