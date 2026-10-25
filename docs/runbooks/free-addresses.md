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
- DMARC: `_dmarc.mail.multies.si` is `v=DMARC1; p=quarantine; adkim=r; aspf=r; pct=100`. Mail is DKIM signed for mail.multies.si by the provider.

## Check after a deploy

Take a test address, send one message out and one in, then delete the address (and its claim row if it should not count against the one per person limit).
