# Undo send

Round 15. After Send, the browser holds the message for a few seconds before it posts it to
`POST /api/mail/send`. During the hold a toast counts down with Undo and Send now. Nothing reaches
the server until the hold ends, so an undone message leaves no trace and costs no database writes.

## How it works

- `src/shared/undo-send.ts` is the timing core with no DOM or React: `createSendHold()` returns a
  queue; `hold({ seconds, send, onSent, onError, onUndo })` starts one hold with its own timer;
  `undo(id?)` takes back one message (the newest when no id is given); `busy()` is true while any
  message is held or on its way. Unit tests: `tests/undo-send.test.ts`.
- `src/web/lib/undo-send.tsx` holds one queue for the browser tab, shows the toast, wires the
  keyboard shortcut and asks before the page is closed while a message is held.
- `Compose` (new message, reply, forward, drafts) closes at once on Send. The hold lives outside the
  component, so it keeps counting if the person opens another page in the app.
- Undo puts the message back into Compose exactly as it was (recipients, subject, body, reply
  thread, draft id). If the mail page is not open, the app opens it first. A failed post does the
  same, with an error toast, so nothing typed is lost.
- Each hold gets its own idempotency key, so the existing retry in the API client can never deliver
  a message twice.

## Settings

5, 10, 20 or 30 seconds, default 10. The choice is kept in the browser's `localStorage` under
`multies-undo-send-seconds`: no account field, no migration. People change it in Settings, Mail
routing, Undo send, or from the small selector next to Send in Compose. The mobile app keeps the
same key in AsyncStorage.

## Keyboard and screen readers

- `Z`, or `Cmd+Z` / `Ctrl+Z`, takes back the newest held message when focus is not in a text field
  (inside a field those keys keep undoing typing).
- The toast is a `role="status"` live region that announces the hold once ("Message held for 10
  seconds ...") instead of every tick. Undo carries `aria-keyshortcuts="Z"`; Send now has a label.

## Limits

- Closing the tab during the hold asks first (`beforeunload`); if the person leaves anyway the
  message is not sent and stays wherever it was (a draft stays a draft).
- Schedule send is the next step and needs a migration; this change does not touch the server.
