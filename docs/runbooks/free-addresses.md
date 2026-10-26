# Free personal addresses on mail.multies.si

Round 17, 25 October 2026. Owner decision at 9:32 PM Sydney: anyone can get a free personal address name@mail.multies.si. Never on the root multies.si, which stays the company's own domain for staff addresses (support@, hello@ and the rest).

## How it works

- The deployment names the shared domain with `FREE_MAIL_DOMAIN` (production: `mail.multies.si`). The config refuses the app's own domain and its www and app hosts (`freeMailDomain` in `src/server/config.ts`), so the root domain can never be handed out. Unset, free addresses are off.
- The shared domain is one row in `domains`, owned by the platform workspace `org_platform`, made on first use (`services/free-address.ts`). The same row hosts agent inboxes for workspaces without a domain (`AGENT_MAIL_DOMAIN` defaults to `FREE_MAIL_DOMAIN`). The hourly domain check skips it.
- Names: 3 to 40 lowercase letters, numbers, dots or dashes. Role and system words (support, security, admin, hello, legal, privacy, accounts, review, postmaster, abuse, no-reply, billing, ops and more) are kept whole, without dots and dashes, and as any one part of a name ("support.team", "admin1"), and no name may contain "multies" or "fintex".
- Only a person with a confirmed email can take one, never a sample workspace. It counts as a mailbox on the plan.

## Abuse limits

- Sign up: one free address per person (ever, also after deleting it), 3 a day per network, 3 a day per device (the app sends a random device id kept in the browser), and `FREE_MAIL_DAILY_CLAIMS` a day for the whole server (300). Counted from the claim's own audit rows (`free_address.claimed`), so the limits cost no extra database writes.
- Sending: `FREE_MAIL_DAILY_SENDS` recipients a day per workspace (50), and `FREE_MAIL_NEW_DAILY_SENDS` (20) in a workspace's first week. At most 10 recipients in one message.
- Spam checks: every outside send is scored (`services/abuse.ts`); mail from a free address is held from the lower "flag" score, not only the "hold" score.

## DNS and providers (set up on 25 October 2026)

- Sending provider: `mail.multies.si` registered (sending on, receiving off). Records on the multies.si zone: DKIM `resend._domainkey.mail`, return path MX and SPF on `send.mail`, `rsend.mail` CNAME. This is the account's third domain (with `multies.si` for system mail and `haajir.xyz`); every free user shares this one slot. Customer domains that find the plan full are queued (docs/runbooks/domain-cap.md).
- Inbound: Cloudflare Email Routing turned on for the subdomain (MX route1/2/3.mx.cloudflare.net and SPF on `mail.multies.si`). The zone's catch-all sends it to the Email Worker `mymail-inbound`, whose `MYMAIL_ROUTES` sends `mail.multies.si` to production, signed with the platform workspace's inbound key (secret `MYMAIL_KEY_SECRET_PROD`, made with `scripts/free-mail-setup.ts`).
- DMARC: `_dmarc.mail.multies.si` is `v=DMARC1; p=none; adkim=r; aspf=r; pct=100; rua=mailto:<id>@dmarc-reports.cloudflare.net` since 25 October 2026 (round 19), while the new domain builds a reputation. Reports go to Cloudflare DMARC Management on the multies.si zone (the apex record carries the same rua). It was `p=quarantine`; go back to that once a few weeks of reports show only our own senders. Mail is DKIM signed for mail.multies.si by the provider.
- Checking a message: SPF that matters is on the envelope (`smtp.mailfrom=...@send.mail.multies.si`), which passes and aligns under relaxed DMARC. A `spf=none` on `smtp.helo=...amazonses.com` is only the HELO check on the provider's host and is expected; some mail views show that result first.
- Spam score (mail-tester, 25 October 2026): 10/10 with a subject, 8.3/10 with none (MISSING_SUBJECT; the provider drops an empty Subject header). Compose asks for a subject before sending one without. Not on any of the 20 blocklists checked.
- Threading: the provider sends our mail under its own Message-ID (`<...@email.amazonses.com>`). The first delivery event reads it once (`GET /emails/{id}`) and stores it on the Sent copy (`messages.provider_message_id_header`, migration 0029), so outside replies join the thread. Round 26: the `email.sent` event reads it too (seconds after the send, so a fast reply already threads), with a 5 second timeout; a failure is logged as `resend.sent_message_id_failed` and the reply starts its own thread. The provider's webhook must include `email.sent` (Resend dashboard, Webhooks, the multies.si endpoint, events). A reply that lands in another mailbox of the same workspace (a reply-to address) joins the thread too; another workspace's mail never does.
- Google Postmaster Tools: owner step. Sign in at https://postmaster.google.com as fintexaustralia@gmail.com and add `multies.si` (already verified through Search Console with the zone's `google-site-verification` TXT) and `mail.multies.si`. Data shows once Gmail sees a few hundred messages a day.

## Check after a deploy

Take a test address, send one message out and one in, then delete the address (and its claim row if it should not count against the one per person limit).
