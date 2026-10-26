# security@ and support@ on multies.si

Today (25 Oct 2026) these addresses forward to the team inbox through Cloudflare Email Routing rules
on multies.si: support@, security@, accounts@, review@, privacy@, legal@ and hello@. A named rule wins
over the catch all, so the rest of multies.si still goes to the inbound worker. The steps below replace
the forwarding with real Multies mailboxes once multies.si is a workspace domain.

Mail for multies.si already reaches Cloudflare Email Routing; the catch-all rule hands every message to the `mymail-inbound` worker. These steps make security@ and support@ land in a real Multies inbox on production. They write to D1, so run them when the daily write budget has room (after 00:00 UTC on a capped day).

1. Sign in to https://multies.si as the ops account (or create the "Multies HQ" workspace) and add the domain `multies.si` under Domains. Add the ownership TXT record it shows through the Cloudflare API (zone multies.si); MX and SPF are already in place. Run the domain check until it is verified.
2. Create the mailboxes `security` and `support` (Mailboxes, New mailbox) and give the people who handle them access.
3. Settings, Inbound: create an inbound key for this workspace. Note the key id and its secret (store the secret in CREDENTIALS under the multies.si section, never in the repo).
4. In `email-worker/`, set the route for the domain and the secret, then deploy the worker:
   - `MYMAIL_ROUTES = '{"multies.si":{"url":"https://multies.si/api/inbound/cloudflare","keyId":"ink_...","secret":"MYMAIL_KEY_SECRET_PROD"}}'` in `[vars]`
   - `npx wrangler secret put MYMAIL_KEY_SECRET_PROD` (from `email-worker/`)
   - `npx wrangler deploy` (from `email-worker/`)
   Other domains keep going to the default host (`MYMAIL_WEBHOOK_URL`, the preview).
5. Send a test message to security@multies.si from an outside address and check it arrives in the inbox.
