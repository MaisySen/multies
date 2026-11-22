# Run Multies on your own computer

This guide sets up the whole of Multies on one computer you control: the web app, the API,
the database, and a real mail server for sending and receiving email. It works on Windows,
macOS and Linux, and the same setup moves to a small server later without changes.

What runs, each in its own container:

| Container | What it does |
|---|---|
| `mymail` | The Multies web app and API. Data lives in one SQLite file on the `mymail-data` volume. |
| `stalwart` | [Stalwart](https://stalw.art), an open-source mail server, unmodified. It receives mail from the internet (port 25), sends mail out, and serves mail apps (IMAP 993, SMTP 465 and 587). |
| `mail-bridge` | Hands mail that Stalwart receives to Multies, the same way the Cloudflare Email Worker does in the hosted version. |

On this computer alone (no domain yet) you can sign up, use every feature, and send mail between
your own mailboxes. To receive mail from the outside world you need a domain pointed at the
computer and port 25 reachable; see [Pointing a domain at it](#pointing-a-domain-at-it).

## 1. Install Docker

You need about 4 GB of free memory and 5 GB of disk.

### Windows 10 or 11

1. Turn on WSL 2: open PowerShell as administrator and run `wsl --install`, then restart.
2. Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/).
   During setup keep "Use WSL 2 instead of Hyper-V" ticked.
3. Start Docker Desktop and wait until it says "Engine running".
4. Install [Git for Windows](https://git-scm.com/download/win) (the defaults are fine).

Run the commands in this guide in PowerShell. Where a step shows `scripts/selfhost/setup.sh`,
use the `.ps1` file next to it, for example:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\selfhost\setup.ps1
```

### macOS (Apple silicon or Intel)

1. Install [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/).
   Pick "Mac with Apple chip" for M1 or later, "Mac with Intel chip" otherwise.
2. Start Docker Desktop and wait until the whale icon in the menu bar stops animating.
3. Git comes with the Xcode command line tools: run `xcode-select --install` in Terminal if `git` is missing.

### Linux (Ubuntu, Debian, Fedora and others)

1. Install Docker Engine and the Compose plugin from Docker's own repository, following
   [the guide for your distribution](https://docs.docker.com/engine/install/). The package in
   some distributions (for example Debian's `docker.io`) is too old for the Stalwart image.
2. Let your user run Docker: `sudo usermod -aG docker $USER`, then sign out and in again.
3. Check: `docker compose version` should print v2 or later.
4. If something already listens on port 25 (a local Postfix, for example), stop it or set
   `SMTP_IN_PORT` in `.env` to another port.

## 2. Get the code

The repository is private, so sign in to GitHub as an account with access to `MaisySen/multies`.
The easiest way is [GitHub Desktop](https://desktop.github.com/) (File, Clone repository), or the
command line with the [GitHub CLI](https://cli.github.com/):

```sh
gh auth login
gh repo clone MaisySen/multies
cd mymail
```

Plain `git clone https://github.com/MaisySen/multies.git` also works; when it asks for a password,
use a [personal access token](https://github.com/settings/tokens), not your GitHub password.

## 3. Set up and start

From the `mymail` folder:

```sh
scripts/selfhost/setup.sh            # Windows: powershell -ExecutionPolicy Bypass -File scripts\selfhost\setup.ps1
```

The script:

1. creates `.env` from `.env.example` and fills every secret with a strong random value
   (it never overwrites a value you already set, so it is safe to run again);
2. builds the Multies image (a few minutes the first time);
3. starts Stalwart in its setup mode, connects it to Multies, then restarts it normally;
4. starts everything.

Open <http://localhost:8787> and create your account. The first account on a new install is
yours; add your email to `PLATFORM_ADMIN_EMAILS` in `.env` to get the operator console at `/console`
([runbooks/operator-console.md](runbooks/operator-console.md)).

Use Chrome, Edge or Firefox while the address is `http://localhost`. Safari may refuse the
secure sign-in cookie without HTTPS; it works once a domain with HTTPS is set up.

### Turn on incoming mail

Mail arriving at Stalwart is handed to Multies with an inbound key, the same as on Cloudflare:

1. In Multies, open Settings, Inbound, and create a key. Copy the key id and the secret.
2. In `.env`, set `MYMAIL_INBOUND_KEYS=<key id>:<secret>` (more workspaces: comma separated).
3. Run `docker compose -f docker-compose.selfhost.yml up -d mail-bridge`.

Until a key is set, mail arriving on port 25 is answered with "try again later", so nothing is lost.

### Everyday commands

```sh
docker compose -f docker-compose.selfhost.yml ps          # what is running
docker compose -f docker-compose.selfhost.yml logs -f     # live logs
docker compose -f docker-compose.selfhost.yml stop        # stop (data is kept)
docker compose -f docker-compose.selfhost.yml up -d       # start again
git pull && docker compose -f docker-compose.selfhost.yml up -d --build   # update to the latest Multies
```

Docker Desktop starts the containers again after a restart of the computer, as long as Docker
Desktop itself starts with the computer (Settings, General).

## 4. Moving your data across from the hosted Multies

This copies the hosted database (Cloudflare D1) into this computer. The hosted copy is only read,
never changed.

1. In the Cloudflare dashboard, create an API token with the "D1 Read" permission for your account
   (My Profile, API Tokens, Create Token, Custom token). Note your account id (shown on the
   Workers and Pages overview page).
2. In `.env`, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Run:

   ```sh
   scripts/selfhost/d1-import.sh                  # Windows: ...\d1-import.ps1
   ```

   It exports the production database (`mymail-au`), stops Multies, loads the export, applies any
   database migrations this version needs, and starts Multies again. Cloudflare pauses the hosted
   database while it writes the export (seconds for a small business), so run it at a quiet time. The database it replaces is kept
   on the volume as `mymail.db.before-<time>`.
4. Copy `APP_SECRET` from the hosted install into `.env` before starting, otherwise saved secrets
   (DKIM keys, webhook secrets, connected AI keys) cannot be read. Ask whoever runs the hosted
   install for it; it is a Cloudflare secret and cannot be read back from the dashboard.
5. Remove the Cloudflare token from `.env` afterwards.

Sign in with the same email and password as before. Message bodies and attachments stored in
R2 or S3 are not part of the database export; set the `BODY_STORE_*` values to the same bucket to
keep reading them.

Already have an export file? `scripts/selfhost/d1-import.sh --sql path/to/export.sql`.

## 5. Backups

```sh
scripts/selfhost/backup.sh                       # Windows: ...\backup.ps1
```

This writes `backups/mymail-backup-<time>.tar.gz` with:

- a consistent copy of the Multies database, taken while Multies keeps running;
- Stalwart's data (it pauses for a few seconds; sending servers retry, so no mail is lost);
- your `.env`, because the secrets in it are needed to read the backup.

The archive holds your mail and your secrets. Copy it off the computer (an external drive or
cloud storage) and keep it private. To back up every night, schedule the script with Task
Scheduler (Windows), `launchd` or `cron`.

To restore:

```sh
scripts/selfhost/restore.sh backups/mymail-backup-<time>.tar.gz
```

It stops Multies and Stalwart, puts both back, and starts them again. The database it replaces is
kept as `mymail.db.before-<time>`.

## Pointing a domain at it

You can do this any time; nothing above needs to change.

### What you need

- A domain you control, for example `example.com.au`.
- An address the internet can reach this computer on: a fixed public IP from your internet
  provider, or a small virtual server (see below).
- These ports forwarded from your router to the computer:

| Port | For |
|---|---|
| 25 | mail from other mail servers |
| 465 and 587 | mail apps sending (TLS and STARTTLS) |
| 993 | mail apps reading (IMAP, TLS) |
| 443 (and 80) | the web app over HTTPS, through a reverse proxy |

### Port 25 and home internet

Many home internet providers block port 25, both in and out, to stop spam. Without it, other mail
servers cannot deliver to you and Stalwart cannot deliver to them. Ask your provider whether a
business plan or a static IP unblocks it. If not, either:

- send through a relay: set `RESEND_API_KEY` in `.env` so Multies sends through Resend instead of
  Stalwart, or set a relay (smarthost) in Stalwart's admin under the MTA outbound routing settings; or
- run the whole stack on a small virtual server (1 to 2 GB of memory is enough) with port 25 open,
  using exactly the same steps. Check with the provider that port 25 is open on your plan; some
  only open it on request.

### DNS records

Say the web app lives at `app.example.com.au` and mail at `mail.example.com.au`, and your
public IP is `203.0.113.10`:

| Type | Name | Value |
|---|---|---|
| A | `app.example.com.au` | `203.0.113.10` |
| A | `mail.example.com.au` | `203.0.113.10` |
| MX | `example.com.au` | `mail.example.com.au`, priority 10 |
| TXT | `_spf.mail.example.com.au` | `v=spf1 ip4:203.0.113.10 ~all` |
| TXT | `example.com.au` | `v=spf1 include:_spf.mail.example.com.au ~all` |
| TXT | `mymail._domainkey.example.com.au` | the DKIM value Multies shows on the domain's page |
| TXT | `_dmarc.example.com.au` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com.au` |

Then in `.env`:

```sh
APP_URL=https://app.example.com.au
MAIL_CLIENT_HOST=mail.example.com.au
MAIL_MX_HOSTS=mail.example.com.au:10
MAIL_SPF_INCLUDES=_spf.mail.example.com.au
SYSTEM_FROM=no-reply@example.com.au
```

and run `docker compose -f docker-compose.selfhost.yml up -d`, then `scripts/selfhost/setup.sh`
once more so Stalwart learns its new name. Add the domain in Multies (Settings, Domains); its page
lists the records above with a check next to each. Multies signs outgoing mail with that domain's
DKIM key itself, so the DKIM record Multies shows is the one to publish.

Also ask your provider to set the reverse DNS (PTR) of your IP to `mail.example.com.au`; many
receivers distrust mail from an IP without one.

### HTTPS

Put a reverse proxy with automatic certificates in front of the web app.
[Caddy](https://caddyserver.com/) is the simplest: `deploy/au/Caddyfile` is a two-line example
that serves `APP_HOST` and forwards to `mymail:8787`. Stalwart can get its own certificate for
`mail.example.com.au` (Stalwart admin, Domains, TLS certificates, ACME); until then mail apps
show a certificate warning.

## Stalwart's admin

Stalwart's own admin site is at <http://localhost:8080> on this computer only. Sign in with
`STALWART_ADMIN_USER` and `STALWART_ADMIN_SECRET` from `.env`. You rarely need it: Multies creates
mail app accounts there by itself (Settings, Mail apps).

## How mail flows

- **Incoming:** another server connects to Stalwart on port 25. Stalwart calls the mail bridge
  (an MTA Hook at the DATA stage). The bridge signs the message with your inbound key and posts
  it to Multies, exactly like the Cloudflare Email Worker. Multies files it, and for mailboxes with
  mail app access also copies it into the Stalwart inbox. Stalwart keeps no copy of its own.
  Unknown addresses are refused with Multies' reason; if Multies is down the sender is told to
  retry later.
- **Outgoing:** Multies signs the message with the domain's DKIM key and hands it to Stalwart on
  port 587 with its own sending account; Stalwart delivers it. With `RESEND_API_KEY` set, Multies
  sends through Resend instead.
- **Between your own mailboxes:** delivered inside Multies directly.
- **Mail apps:** IMAP and SMTP through Stalwart, as described in [mail-server.md](mail-server.md),
  with the same limit: folders in mail apps and in webmail are separate.
- **Safety:** port 25 accepts mail for any domain because Multies, not Stalwart, knows your domains.
  The bridge never lets a message from an unauthenticated sender go back out, and if the bridge
  cannot be reached Stalwart answers "try again later", so the server is never an open relay.
- **One limit:** a single message to several addresses where Multies accepts some and refuses
  others is delivered to the accepted ones and the refused ones are dropped without a bounce.

## Troubleshooting

| What you see | What to do |
|---|---|
| `port is already allocated` | Another program uses that port. Change `MYMAIL_PORT`, `SMTP_IN_PORT` or `STALWART_ADMIN_PORT` in `.env`. |
| Sign-in does nothing in Safari | Use Chrome, Edge or Firefox on `http://localhost`, or set up HTTPS. |
| Incoming mail gets "try again later" | Set `MYMAIL_INBOUND_KEYS` and restart `mail-bridge`. See `docker compose -f docker-compose.selfhost.yml logs mail-bridge`. |
| Outgoing mail to Gmail or Outlook never arrives | Port 25 is likely blocked by your provider, or SPF, DKIM or PTR are missing. Use a relay or a server. |
| `invalid tar header` when pulling images on Linux | Your Docker is too old. Install Docker Engine from Docker's repository. |
| Start again from scratch | `docker compose -f docker-compose.selfhost.yml down -v` deletes ALL data, then run setup again. |
