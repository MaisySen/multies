# Email addresses on the phone (build 13, 1.9.0)

Settings, Email addresses (`src/app/email-setup.tsx`) offers the three ways to get an address,
the same as onboarding on the web:

1. Connect your email (`src/app/connect-mailbox.tsx`). Provider chips (presets mirror
   `src/shared/mail-connect.ts` in the web app), the address (it picks the provider until one is
   picked by hand), the app password with the provider's own steps and a link to its app password
   page, server fields for Other server. Test and save calls `POST /api/connections`, which signs
   in to IMAP and SMTP before saving. A failure is 422 with plain words and `step` (imap or smtp);
   the screen shows both. `?reconnect=<id>` asks only for a new password (`PUT /api/connections/:id`).
   When the server has mailbox connect off (`GET /api/connections` says `enabled: false`) the app
   opens https://multies.si/app/settings/connections in the in-app browser instead.
2. Free address (`src/app/free-address.tsx`). `GET /api/free-address` gives the domain, a
   suggested name and any address already taken; `POST /api/free-address` claims it. The app checks
   only the shape (3 to 40 letters, numbers, dots or dashes); the server keeps role and brand names
   back, checks the name is free and applies its limits, and its words are shown as they come.
3. Your own domain opens https://multies.si/app/domains (DNS records are set up on the web).

Connected accounts are listed under the options with status, last sync, Sync now
(`POST /api/connections/:id/sync`), Reconnect and Remove (`DELETE /api/connections/:id`, which
deletes the stored password). Compose with no address offers "Add an email address".

All calls use the app's own session cookie and the API origin, so the server's CSRF check accepts
them. No server change was needed. The sample workspace answers the same paths
(`src/sample/email.ts`; a password of "wrong" fails the test the way a provider does).

Tests: `__tests__/email-setup.test.tsx`. Screenshots: `node scripts/email-screens.mjs <web build url> <dir>`.
