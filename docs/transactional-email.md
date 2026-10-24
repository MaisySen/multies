# Customer domains and transactional email

How a workspace puts its own domain on Multies (for example `haajir.xyz`), what DNS records it adds, and
how an app it runs (for example a Supabase project) sends its auth emails through Multies.

## Short answers

- **Does the domain have to move to Cloudflare?** No. The records below work at any DNS provider
  (GoDaddy, Namecheap, Cloudflare and others). The nameservers stay where they are.
- **Is Multies an SMTP server?** No. Production Multies runs on Cloudflare Workers, which cannot accept
  SMTP connections, so there is no SMTP host, port or password to give an app. (Self hosted installs can
  add Stalwart for mail apps, see [mail-server.md](mail-server.md); production does not run it.)
- **Can an app send transactional email through Multies?** Yes, over HTTPS, two ways:
  1. `POST /api/v1/messages` with a workspace API key, from any mailbox on a verified domain.
  2. For Supabase Auth: the Send Email Hook. Supabase calls Multies for every auth email (sign up
     confirmation, magic link, password reset, invite, email change, reauthentication code) and Multies
     sends it from a mailbox such as `no-reply@`. Supabase's own SMTP settings stay empty.

## 1. Add the domain

Domains, Add domain (or `POST /api/v1/domains { "name": "haajir.xyz" }`). The Free plan includes one domain.

When outbound mail runs through the email provider (production), Multies registers the domain with the
provider at once, with sending and receiving on, and the setup page shows the provider's exact records.
Every record has a copy button for the host and the value.

| Record | Type | Host | Value | Why |
| --- | --- | --- | --- | --- |
| Ownership | TXT | `_mymail` | `mymail-verify=<token>` | Proves the domain is yours |
| Inbound mail | MX | `@` | the provider's receiving host, priority 10 (for example `inbound-smtp.us-east-1.amazonaws.com`) | Mail to the domain reaches Multies |
| Sender policy | TXT | `@` | as shown (by default `v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all`) | Servers allowed to send as the domain; merge with an existing SPF record |
| Signing key | TXT | `resend._domainkey` | the provider's DKIM key (`p=...`) | Outgoing mail is signed |
| Bounce handling | MX | `send` | `feedback-smtp.<region>.amazonses.com`, priority 10 | Return path for mail you send |
| Sending permission | TXT | `send` | `v=spf1 include:amazonses.com ~all` | SPF for the return path |
| Policy | TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@<domain>; adkim=r; aspf=r; pct=100` | Recommended |

Always copy the values from the setup page: the provider picks the DKIM key and the regional hosts.
Remove any other MX record on `@`, or mail splits between two places.

Where the outbound driver is the local log (development) or the provider refuses the domain (for
example its plan's domain limit), the page falls back to Multies' own DKIM key and the Cloudflare
Email Routing MX, and a note at the top says why sending is not set up.

## 2. Verify

Check DNS now (or `POST /api/v1/domains/{id}/verify`). Multies asks the provider to look again, then runs
its own lookups for every record. The domain turns Verified when every required record passes; the
"Sending and receiving are ready" note shows once the provider agrees. While the page is open it
re-checks every 30 seconds, and a background job re-checks pending domains hourly.

## 3. Mailboxes

Mailboxes, New mailbox: `support@`, `hello@` and `no-reply@` (or `POST /api/v1/mailboxes`). The Free plan
includes 3 mailboxes. Mail to them arrives in the workspace through the provider's receiving MX
(`email.received` on `POST /api/webhooks/resend`, which fetches the raw message and delivers it exactly
like mail from the Cloudflare Email Worker). Put `support@` in the shared inbox to work it as a team.

## 4. Send from an app: the API

```bash
curl https://multies.si/api/v1/messages \
  -H "Authorization: Bearer $MULTIES_KEY" -H "Content-Type: application/json" \
  -d '{"from":"no-reply@haajir.xyz","to":["teacher@example.com"],"subject":"Welcome","text":"Hello","html":"<p>Hello</p>"}'
```

`from` is the mailbox address (or pass `mailboxId`). The domain must be verified. Each recipient counts
toward the plan's daily sending limit, and a copy is kept in the mailbox's Sent folder.

## 5. Supabase auth emails: the Send Email Hook

1. In Supabase: Authentication, Hooks, Add hook, **Send Email Hook**, type **HTTPS**. Generate the secret
   and copy it (`v1,whsec_...`). Leave the URL for step 3.
2. In Multies, with a workspace key:

   ```bash
   curl https://multies.si/api/v1/auth-email-hooks \
     -H "Authorization: Bearer $MULTIES_KEY" -H "Content-Type: application/json" \
     -d '{"from":"no-reply@haajir.xyz","secret":"v1,whsec_...","supabaseUrl":"https://<ref>.supabase.co","appName":"Haajir"}'
   ```

   The answer carries `hook.url` (`https://multies.si/api/auth-hooks/supabase/ahk_...`). The secret is
   stored encrypted and never shown again.
3. Paste `hook.url` into the Supabase hook and enable it. From then on Supabase sends no auth email
   itself, so its built in mailer's limit (2 an hour, team addresses only) no longer applies.

What Multies sends: a plain, clean email in the app's name with the confirmation link
(`<supabaseUrl>/auth/v1/verify?token=<token_hash>&type=<type>&redirect_to=<redirect_to>`) and the
6 digit code. Email change with Secure Email Change on sends two emails, one to each address, with
Supabase's reversed field names handled (`token_hash_new` goes to the current address). Calls with a
bad signature get 401; a sending failure answers Supabase with its error object so the user sees it.

`GET /api/v1/auth-email-hooks` lists hooks (no secrets), `DELETE /api/v1/auth-email-hooks/{id}` removes one.

## Operator notes

- The provider webhook (Resend, endpoint `https://multies.si/api/webhooks/resend` or the workers.dev
  address) must include the `email.received` event, or mail to customer domains is accepted by the
  provider and never reaches Multies.
- The provider's Free plan has a domain limit (3 on its pricing page as of October 2026; multies.si
  uses one). A refusal shows on the domain's setup page; deleting a domain in Multies frees its slot.
