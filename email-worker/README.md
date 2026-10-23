# MyMail inbound Email Worker

Bridges **Cloudflare Email Routing** to MyMail. Cloudflare receives the SMTP
conversation; this worker forwards each raw message to MyMail over HTTPS with an
HMAC signature, and accepts or bounces based on MyMail's answer.

## Setup (5 minutes)

1. In MyMail: **Settings → Inbound** → *Create key*. Copy the key id and secret (shown once).
2. In Cloudflare, add your domain as a zone and enable **Email → Email Routing**.
   Cloudflare publishes the MX and SPF records for you; MyMail's DNS check will see them.
3. Deploy the worker:
   ```bash
   cd email-worker
   # edit wrangler.toml: MYMAIL_WEBHOOK_URL and MYMAIL_KEY_ID
   npx wrangler deploy
   npx wrangler secret put MYMAIL_KEY_SECRET
   ```
4. Email Routing → **Routes** → *Catch-all address* → action **Send to a Worker** → `mymail-inbound`.

## Protocol

`POST {MYMAIL_WEBHOOK_URL}` with the raw RFC 5322 message as the body and:

| Header | Value |
| --- | --- |
| `x-mymail-key` | inbound key id |
| `x-mymail-timestamp` | unix seconds (±5 min accepted) |
| `x-mymail-envelope-from` / `-to` | SMTP envelope |
| `x-mymail-signature` | hex HMAC-SHA256 of `ts\nfrom\nto\nsha256hex(body)` |

Response: `{ "action": "accept" | "reject" | "retry", "code": 250|450|550|552, "reason": "..." }`.
`reject` bounces the message (e.g. unknown mailbox); `retry` uses `FALLBACK_FORWARD` if set,
otherwise rejects with a temporary-failure reason.
