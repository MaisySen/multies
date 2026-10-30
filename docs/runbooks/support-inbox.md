# support@ and security@multies.si into the shared inbox (DF-18)

Round 26, 26 October 2026. Replaces the forwarding in docs/runbooks/multies-si-mailboxes.md for these two
addresses. The other company addresses (accounts@, review@, privacy@, legal@, hello@) keep their Cloudflare
forwarding rules; nothing below touches them.

## What the code does (no setting, no change)

- The company domain is the domain of `SUPPORT_EMAIL` (multies.si on production and staging).
- With `OPERATOR_INBOX_ORG_ID` set, mail to the addresses in `OPERATOR_INBOX_ADDRESSES` (default
  `support@multies.si,security@multies.si`) is delivered only into that workspace. Any other multies.si
  address that reaches the app is refused (550, as today: no mailbox) before any database read or write.
- Only that workspace can add `multies.si` under Domains. It is added already verified, with no call to
  the sending provider (multies.si is already verified there for system mail, so registering it again
  would show the provider's MX and clash with Cloudflare Email Routing). The DNS check never demotes it and
  the hourly check skips it. Every other workspace gets "multies.si is reserved for the Multies team."
- The mailboxes are ordinary mailboxes, so the shared inbox (Mail, Shared inbox) shows their threads with
  assign, done, internal notes, presence and saved replies. Replies go out as support@multies.si.
- Without `OPERATOR_INBOX_ORG_ID`, inbound routing is unchanged.
- Free addresses on mail.multies.si are a different domain and are not affected.

## What forwards today (found 26 October 2026)

Cloudflare Email Routing rules on the multies.si zone forward support@, security@, accounts@, review@,
privacy@, legal@ and hello@ to one verified destination: the builder's own working mailbox (see the
multies.si section of CREDENTIALS.local.md). It is not a staff person's inbox. No rule in code or docs sends
these addresses to a person. Step 6 keeps a copy going there anyway for the first week, so nothing is
missed while the team gets used to the shared inbox; drop it after that.

## Live steps (R26 worker, production)

Each step writes a handful of D1 rows (well under 50 in total). Do them when the daily write budget has room.
The company domain and the support@ and security@ mailboxes do not count against the operator workspace's plan (R26), so a workspace on the free plan can hold them.

1. Check nobody holds the domain (a read):
   `npx wrangler d1 execute mymail-au --remote --command "SELECT id, org_id, status FROM domains WHERE name = 'multies.si'"`
   If a row exists in another workspace, move or delete it first (it was never delivered to).
2. Pick the operator workspace: "Multies HQ" (create it if it doesn't exist, signed in as the ops account).
   Note its id from Settings, or:
   `npx wrangler d1 execute mymail-au --remote --command "SELECT id, name FROM organizations WHERE name = 'Multies HQ'"`
3. Set the var on the app worker (wrangler.toml, the top level `[vars]`, which is production; not
   `[env.staging.vars]`, staging has no operator inbox) and deploy as usual:
   `OPERATOR_INBOX_ORG_ID = "org_..."`
   Leave `OPERATOR_INBOX_ADDRESSES` unset for support@ and security@.
4. In that workspace: Domains, Add domain, `multies.si` (it shows as verified straight away). Then Mailboxes,
   New mailbox: `support` and `security`. Give the support team access to support@ and the security owner
   access to security@ (Mailboxes, access). Optional: set the mailbox reply-to to the same address.
5. Settings, Inbound (or `POST /api/v1/inbound-keys` with the workspace key, R26): create an inbound key in this workspace. Keep the secret in CREDENTIALS (multies.si
   section), never in the repo. The key must belong to this workspace: a key from any other workspace
   (the platform key for mail.multies.si included) is refused for these addresses.
6. Email Worker (`email-worker/wrangler.toml`, `[vars]`), keeping the mail.multies.si entry as it is:
   `MYMAIL_ROUTES = '{"mail.multies.si":{...as today...},"multies.si":{"url":"https://multies.si/api/inbound/cloudflare","keyId":"ink_...","secret":"MYMAIL_KEY_SECRET_HQ"}}'`
   `MYMAIL_COPY_TO = '{"support@multies.si":"<the current forward destination>","security@multies.si":"<the same>"}'`
   Then from `email-worker/`: `npx wrangler secret put MYMAIL_KEY_SECRET_HQ` and `npx wrangler deploy`.
   The copy address must stay a verified Email Routing destination (it is today).
7. Cloudflare dashboard, zone multies.si, Email, Email Routing, Routes: delete (or disable) the two custom
   addresses `support@multies.si` and `security@multies.si`. Leave the other five rules. The catch-all
   already sends to the `mymail-inbound` worker, so these two now reach it. No MX or DNS change: the MX
   records already point at Cloudflare.
8. Test: send one message to each address from an outside mailbox. It shows in the shared inbox of Multies
   HQ, and a copy reaches the step 6 destination. Reply from the shared inbox and check the reply threads on
   the outside side. Send to `nobody@multies.si`: it bounces, as before.

## Rolling back

Re-enable the two Email Routing rules (step 7). The app side can stay; nothing reaches it without the rules
gone. To turn it off fully, unset `OPERATOR_INBOX_ORG_ID` and remove the `multies.si` entry from `MYMAIL_ROUTES`.


## Reports and blocks (Apple 1.2)

Apple's rule for apps with user content (guideline 1.2): people can report content and block people, and the operator acts on every report within 24 hours.

- Who acts: the operator on duty (a platform admin, the same people who read this inbox). Every new report mails `SUPPORT_EMAIL` ("N reports to review"), at most once per 15 minutes; the 5 minute maintenance sweep mails again when a report arrived inside a used slot.
- Where: Operator console, Moderation (`/app/admin/reports`). The Operator item in the sidebar shows the open count. Each report shows the reason, where it came from, a copy of the message as it was when reported, the reporter and the reported person, and its age (amber past 12 hours, red past 24).
- How, within 24 hours of the report:
  - Remove message: deletes it for everyone (the normal soft delete; open chats update at once). Other open reports on the same message close with it.
  - Suspend user: bans the account (sign in refused) and ends all its sessions. To lift it, clear `banned` on the user (operator console users search, or the database) and tell the person.
  - Resolve with a note: when you acted another way (a warning by mail, say).
  - Dismiss: nothing wrong.
- Illegal content involving a minor: remove it, suspend the account, and report it to the eSafety Commissioner (esafety.gov.au) the same day. Keep the report row; it holds the copy.
- The person who was blocked is never told. A person who asks why they can't message someone gets: "You can't message this person."
- Terms: the Terms of service make the Acceptable use policy part of the agreement; its "Objectionable content and abusive users" section is the no tolerance rule Apple asks for (updated 27 October 2026).
