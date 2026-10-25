# Connect an existing mailbox (path A): design for the next round

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
