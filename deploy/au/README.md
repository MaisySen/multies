# Hosting Multies in Australia (groundwork)

Today Multies runs on Cloudflare Workers with its database (D1) placed in Cloudflare's Oceania
region. That placement is a location hint: Cloudflare does not commit to a country, so Multies
does not say it is hosted in Australia. This folder is the groundwork for a setup where that
claim can be made honestly: the app, its database, the mail server and backups on a VPS in a
Sydney data centre, with large attachments in an S3 bucket in Sydney.

Nothing here is switched on for the live service. Moving to it is a decision for the owner,
and the privacy policy's data location wording changes only after the move is done.

## What runs where

| Part | Where it runs in this layout |
| --- | --- |
| Web app and API (Node, `src/entry/node.ts`) | The Sydney VPS, behind Caddy (HTTPS) |
| Database (SQLite) | The VPS disk |
| Mail server for IMAP and SMTP (Stalwart) | The VPS |
| Large attachments | S3 bucket in `ap-southeast-2` (Sydney), through the body store |
| Backups (restic, encrypted) | S3 bucket in `ap-southeast-2` |
| Outbound mail (Resend) | Outside Australia. Send through Stalwart's own SMTP instead to keep it local; that needs a clean IP reputation and reverse DNS on the VPS |
| Error tracking (Sentry), payments (Stripe) | Outside Australia; leave `SENTRY_DSN_*` empty to turn Sentry off |
| AI assistant | Workers AI is a Cloudflare service and is not used on the VPS; the assistant falls back to its basic rules unless another provider is added |

## Steps

1. A VPS in Sydney with 2 vCPUs, 4 GB of memory and 80 GB of disk is enough to start (any
   provider with a Sydney region). Ask the provider to open port 25 and set reverse DNS for the
   server's IP to `MAIL_CLIENT_HOST`.
2. DNS: `APP_HOST` (for example `app.example.com.au`) and `MAIL_CLIENT_HOST` (for example
   `mail.example.com.au`) as A records to the VPS.
3. Two S3 buckets in `ap-southeast-2`: one for attachments, one for backups, each with its own
   access key limited to that bucket. Block public access on both.
4. On the VPS: install Docker, clone the repo, `cp .env.example .env`, then set `APP_URL`,
   `APP_HOST`, `APP_SECRET`, `MAIL_CLIENT_HOST`, `MAIL_OPS_DOMAIN`, `STALWART_ADMIN_SECRET`,
   `BODY_STORE_BUCKET`, `BODY_STORE_ACCESS_KEY_ID`, `BODY_STORE_SECRET_ACCESS_KEY`,
   `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `BACKUP_ACCESS_KEY_ID`, `BACKUP_SECRET_ACCESS_KEY`.
5. Set up Stalwart once, as in `docs/mail-server.md` (recovery mode, `setup`, then normal mode).
6. Start everything:
   `docker compose -f docker-compose.yml -f deploy/au/compose.au.yml up -d`
7. Point each customer domain's MX at `MAIL_CLIENT_HOST` once Stalwart receives mail directly.

## Moving the live data

1. Export D1: `npx wrangler d1 export mymail --remote --output mymail.sql`.
2. Load it on the VPS: `sqlite3 /var/lib/docker/volumes/<project>_mymail-data/_data/mymail.db < mymail.sql`.
3. Switch `APP_URL` and DNS, then re-run the Stripe and Resend webhook setup for the new URL.

## Restore

```sh
docker compose -f docker-compose.yml -f deploy/au/compose.au.yml run --rm --entrypoint restic backup snapshots
docker compose -f docker-compose.yml -f deploy/au/compose.au.yml run --rm --entrypoint restic backup restore latest --target /restore
```

## Before saying "hosted in Australia"

- Every row in the table above that holds customer mail is in Australia.
- The subprocessor list in `src/shared/legal.ts` and the privacy policy say where each provider
  processes data.
- Outbound mail either goes through Stalwart or the policy names the outside provider.
