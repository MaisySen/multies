# Free addresses and the sending domain cap

Round 17, 25 October 2026. Plan horizon 1, items 1 and 2.

## Free addresses

Every workspace can take an address on the shared Multies domain, for example `ada.acme@multies.si`, with no domain of its own. It sends and receives straight away.

How it works:

- The deployment names the shared domain with `FREE_MAIL_DOMAIN` (production: `multies.si`). Unset, free addresses are off and the app shows the add your domain path only.
- The shared domain is one row in `domains`, owned by the platform workspace `org_platform`, made on first use (`services/free-address.ts`). The same row hosts agent inboxes for workspaces without a domain (`AGENT_MAIL_DOMAIN` defaults to `FREE_MAIL_DOMAIN`).
- The row is marked verified for DNS and for the sending provider, because the operator set the domain up once (below). The hourly domain check skips it.
- Names: 3 to 40 lowercase letters, numbers, dots or dashes. Role and system names (support, security, postmaster, no-reply, relay and others) are kept. The app suggests first name and team, for example `ada.acme`.
- Only a person with a confirmed email can take one, never a sample workspace. Each one counts as a mailbox on the plan.
- A smaller daily allowance protects the shared domain: `FREE_MAIL_DAILY_SENDS` recipients a day per workspace (default 50). Your own domain lifts it.
- API: `GET /api/free-address` (what the app shows), `POST /api/free-address` (take one), and `POST /api/v1/free-address` with a workspace key.

### One time setup on a deployment

1. The shared domain is verified with the sending provider (production: `multies.si` was verified on 24 October for the system sender). Nothing new is registered, so free addresses never use a provider domain slot.
2. Mail for the shared domain reaches the Email Worker: Cloudflare Email Routing on the zone, catch-all to the worker `mymail-inbound`. Named forwarding rules (support@, security@ and the other public addresses) win over the catch-all, so those names are also on the kept list.
3. Make the platform workspace and its inbound key, then give the Email Worker a route for the shared domain:

```
APP_SECRET=<the deployment's> npx tsx scripts/free-mail-setup.ts --out /tmp/free-mail
npx wrangler d1 execute mymail-au --remote --file /tmp/free-mail/setup.sql
cd email-worker && npx wrangler secret put MYMAIL_KEY_SECRET_PROD < /tmp/free-mail/secret
```

   `MYMAIL_ROUTES` in `email-worker/wrangler.toml` sends the shared domain to production with that key id. Deploy the Email Worker, then the app with `FREE_MAIL_DOMAIN` set.
4. Check: mail to an unknown name on the shared domain bounces with "No mailbox", and mail to a taken name lands in its inbox.

## The sending provider's domain cap

The sending provider's free plan counts the domains registered on the account (production holds `multies.si` and `haajir.xyz`). Sign up never depends on it, and a full plan never breaks adding a domain:

- Free addresses use the one shared domain, so free users use no slots at all.
- A custom domain is registered with the provider when it is added. When the provider answers that the plan is full, the domain is kept with the status `queued:` and the provider's words, instead of an error.
- The domain page says "In the queue for a sending slot". The domain still receives mail. Once its own DNS checks pass it can send too: mail goes out from `relay@<shared domain>`, named "<person> via Multies", with the person's own address as Reply-To, so replies reach them (`services/mail/sender.ts`).
- The oldest queued domain is offered the next slot on every maintenance pass and right after any domain leaves Multies (`retryQueuedProviderDomains`). Nothing is written while the plan stays full.

### Free option, and when to pay

Staying free: keep the queue and the relay above. Every customer can sign up, receive on their own domain, and send (via Multies) from day one. The cost is the "via Multies" sender name until a slot frees up.

More slots need a paid sending plan, which needs a card and is an owner decision. Two honest routes, both unverified against the providers' pricing pages on 25 October:

- The current provider's paid plan, which allows more domains.
- A provider without a per domain cap for the customer domains, keeping the current one for the shared domain.

Nothing in the code changes for either: raise the plan, and the queue drains by itself on the next maintenance pass.
