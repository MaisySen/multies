# Mail apps (IMAP and SMTP) with Stalwart

MyMail's webmail runs on Cloudflare Workers, which cannot accept raw IMAP or SMTP
connections. For Outlook, Apple Mail, Thunderbird and phone mail apps, MyMail drives
[Stalwart](https://stalw.art), an open-source mail server, instead of a homemade one.

## How it fits together

- **Provisioning.** MyMail talks to Stalwart's management API (JMAP, v0.16+) with a
  dedicated provisioner account. It creates the domain and a server account for a
  mailbox the first time someone makes an app password for it, keeps the disk quota
  in sync with the mailbox's quota, and deletes the account with the mailbox.
- **Sign in.** Each server account gets a random password that MyMail stores
  encrypted with `APP_SECRET` and never shows. People sign in to mail apps with
  **app passwords** (Settings, Mail apps). Stalwart only lets an account create its own
  app passwords, so MyMail makes them while signed in as that account. The secret is
  shown once; MyMail keeps only its name and last four characters.
- **Mail flow.** Inbound mail keeps arriving the way it does today (Cloudflare Email
  Routing, then MyMail). For mailboxes with mail app access, MyMail also puts each
  message into the Stalwart inbox (JMAP `Email/import`), so mail apps see it. Mail
  sent from a mail app goes out through Stalwart's SMTP submission.
- **Today's limits.** Mail app folders and webmail folders are separate stores:
  reading or filing a message in Outlook does not change it in webmail, and mail sent
  from a mail app appears in that app's Sent folder only. Pointing the domain's MX at
  Stalwart and reading webmail over JMAP removes that split; it is the next step.

## Deploy (Docker Compose)

Needs a host with ports 25, 465, 587, 993 and 443 open and a DNS name for it
(`MAIL_CLIENT_HOST`, for example `mail.example.com`).

1. `cp .env.example .env` and set `APP_SECRET`, `APP_URL`, `MAIL_CLIENT_HOST`,
   `MAIL_OPS_DOMAIN` (any domain you control, used for the provisioner login),
   `STALWART_ADMIN_SECRET` (24+ random characters), `STALWART_RECOVERY_MODE=1` and
   `STALWART_RECOVERY_ADMIN=admin:<a long random password>`.
2. `docker compose up -d stalwart` starts Stalwart in recovery mode.
3. `docker compose run --rm setup` creates the listeners and the provisioner and
   prints `STALWART_ADMIN_USER`. Put that line in `.env`. It is safe to run again.
4. Remove `STALWART_RECOVERY_MODE` and `STALWART_RECOVERY_ADMIN` from `.env`, then
   `docker compose up -d`.
5. TLS: in Stalwart's web admin (Management, Domains) switch the domain's
   certificate management to ACME (Let's Encrypt). Until then mail apps see a
   self-signed certificate.
6. If MyMail itself runs on Cloudflare, set `STALWART_URL` to Stalwart's HTTPS
   address instead and keep the management API behind an allow list.

## Mail app settings

| | Server | Port | Security | User name | Password |
|---|---|---|---|---|---|
| Incoming (IMAP) | `MAIL_CLIENT_HOST` | 993 | SSL/TLS | the full address | an app password |
| Outgoing (SMTP) | `MAIL_CLIENT_HOST` | 465 | SSL/TLS | the full address | the same app password |

Settings, Mail apps shows the same table for each mailbox.

## Tests

- `tests/mail-access.test.ts` runs on every push against an in-memory stand-in for the
  Stalwart API.
- `tests/stalwart.live.test.ts` runs against a real Stalwart with real clients
  (ImapFlow and Nodemailer): it provisions a mailbox, creates an app password, delivers
  a message through MyMail, sends one over SMTP submission, reads both over IMAP,
  then checks that a revoked app password is refused. Point it at a server with
  `STALWART_TEST_URL`, `STALWART_TEST_ADMIN_USER`, `STALWART_TEST_ADMIN_SECRET`,
  `STALWART_TEST_IMAP` and `STALWART_TEST_SMTP` (host:port).
