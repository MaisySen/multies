# Connect an existing mailbox (path A)

Status 25 October 2026: built and shipped in round 18 (see "What shipped" at the end). The design below is kept as written in round 17.

## Design (round 17)

Written 25 October 2026 (round 17), after the owner's decision that customers use their own mailbox, their own domain, or a free address on mail.multies.si.

## Goal

Anyone, with any provider, uses Multies with their real address: Gmail, Outlook or Microsoft 365, Yahoo, iCloud, Zoho, Fastmail, or any IMAP and SMTP server. Mail syncs both ways and replies go out as that address, so SPF and DKIM pass as the person's own provider.

## Steps

1. **IMAP and SMTP with an app password (every provider).** Workers can open TCP and TLS sockets (`connect()` from `cloudflare:sockets`, with `secureTransport: "on"` for 993 and 465, `"starttls"` for 587). A small IMAP client (LOGIN, SELECT, UID SEARCH, UID FETCH BODY.PEEK[], IDLE is not needed on Workers) and an SMTP client (EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA). Presets from `src/shared/mail-check.ts` fill the hosts. The app password is stored encrypted with APP_SECRET, like Xero tokens, and is never shown again.
2. **Sync model.** A `mail_connections` table (org, mailbox, provider, host, port, user, encrypted secret, last UID per folder, state). A job every 5 minutes fetches new UIDs into the linked mailbox (Inbox and Sent first), a few hundred messages a pass, writing one row per message. Flags (read, starred) push back with UID STORE. The first sync copies the last 30 days only, to stay inside the daily write budget.
3. **Send as that address.** A connected mailbox sends through its own SMTP (or the Gmail and Graph APIs in step 4), never through our provider, so no shared domain reputation is spent and no provider domain slot is used.
4. **OAuth.** Microsoft 365 and Outlook through Microsoft Graph (needs a verified publisher on the app registration). Gmail through the Gmail API (restricted scopes need Google's security review, which takes weeks and is an owner step). Until then Gmail works with an app password over IMAP.
5. **Onboarding.** The "Connect your existing email" card turns from "Coming soon" into a two field form (address and app password) with provider help links, then shows the first synced messages.

## Tests

Unit tests against an in-process fake IMAP and SMTP server (Node `net`/`tls`), local E2E for connect, sync and reply. Never against real providers in CI; one live check with a Yahoo test account by hand.

## Owner steps

Google OAuth review, Microsoft publisher verification, and a Yahoo or iCloud test account for the live check.

## What shipped (round 18)

- Presets: Gmail, Google Workspace, Outlook.com, Microsoft 365, Yahoo, iCloud, Zoho, Fastmail, GMX, and any other server (src/shared/mail-connect.ts). The provider is guessed from the address.
- Test before save: IMAP sign in, then SMTP sign in. Failures are explained in plain words (wrong password, app password needed, IMAP off, password sign in off at Microsoft, server not reachable, certificate problem). 10 tries per person per 15 minutes.
- IMAP through ImapFlow (runs on Workers with nodejs_compat). SMTP through a small client over cloudflare:sockets (Workers) or node:tls (Node): Nodemailer's own SMTP transport could not open sockets on Workers; its MIME composer builds the message.
- The app password is AES-GCM encrypted with APP_SECRET, never logged or returned, and deleted with the connection.
- The mailbox sits on one shared row, connected.multies.invalid, owned by the platform workspace: it never takes a sending domain slot, and inbound routing never treats the address as hosted here.
- Sync: the 15 minute cron hands each due connection to its own Durable Object (MAIL_SYNC, MailSyncRunner), so a connection's work never shares the cron's request budget. A pass applies Multies changes at the provider (read, star, archive, trash), copies new Inbox and Sent mail above the UID cursor, and pulls read and star changes for the latest 200 Inbox messages. The first sync takes the last 30 days, at most 200 Inbox and 100 Sent messages, 25 per pass, with a pass every 20 seconds until done.
- D1 budget: every row of a pass is one batch; duplicates (same Message-ID) are skipped with one indexed read; 500 messages per connection per day; nothing syncs while the account's write budget reads warn or shed. Roughly 6 rows written per message (row and indexes) plus one per attachment.
- Sending as that address: through the provider's own SMTP; Sent copies filed by IMAP APPEND at providers that don't file them (everyone but Gmail and Microsoft), skipped when a copy with that Message-ID is already there.
- Settings, Connected accounts: status, last sync, messages synced, Sync now, Reconnect (tests the new password first), Remove (deletes the stored password and the Multies copy; nothing changes at the provider).
- OAuth for Google and Microsoft: built behind MAIL_OAUTH, off. Owner steps: docs/runbooks/mail-oauth.md.

Tests: tests/connect.test.ts, tests/connect-units.test.ts, tests/connect.live.test.ts (real IMAP and SMTP server), e2e/connect-mailbox.spec.ts.

Known limits: moving a message back to the inbox in Multies isn't sent to the provider (the provider renumbers moved mail); a copy of a message sent to yourself shows once (same Message-ID); no IDLE push, so new mail arrives within about 10 to 15 minutes, or at once with Sync now.
