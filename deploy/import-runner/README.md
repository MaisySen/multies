# Import runner

Moves old mail from Gmail, Google Workspace, Outlook, Microsoft 365 or any IMAP server into MyMail.

Importing is off until you set `IMPORT_RUNNER_TOKEN` (24+ random characters) on MyMail and run at
least one runner with the same token. Customers then start an import from Settings, Mail, Import:
they pick a mailbox, their old address and an app password. MyMail queues the job; the runner
claims it, reads the old mailbox over IMAP and posts each message back. Messages already imported
(same Message-ID) are skipped, so a second run only adds new mail. The app password is stored
encrypted and wiped when the job ends.

## Run it

```sh
# Cloudflare: the token as a secret
npx wrangler secret put IMPORT_RUNNER_TOKEN

# The runner, on any machine or container host with outbound internet
docker build -t mymail-import-runner deploy/import-runner
docker run -d --restart unless-stopped \
  -e MYMAIL_URL=https://mymail.mymail-app.workers.dev \
  -e IMPORT_RUNNER_TOKEN=... \
  mymail-import-runner
```

Logs are JSON lines: `import.started`, `import.finished`, `import.failed`.

## What gets copied

- Gmail: Inbox, Sent Mail and All Mail (archived mail). Spam, Trash and Drafts are skipped.
  Labels aren't folders in MyMail, so labelled mail lands in Archive.
- Outlook and IMAP: every folder except Junk, Deleted Items and Drafts. Sent goes to Sent, the
  rest to Inbox or Archive.

## App passwords

- Gmail: 2-Step Verification on, then myaccount.google.com/apppasswords.
- Outlook.com: account.microsoft.com/security, Advanced security options, App passwords.
- Microsoft 365: an admin may need to allow IMAP for the user first.

## imapsync

`imapsync.sh` wraps the official `gilleslamiral/imapsync` image for a direct IMAP to IMAP copy.
Use it when MyMail's mail server is the store of record (the Australian VPS layout in
`deploy/au`); while mail lives in the app's database, use the runner so webmail sees it.
