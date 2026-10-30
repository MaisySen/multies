# Chat channels: WhatsApp, Messenger and Instagram in the shared inbox

Status: phase 1 (WhatsApp) is built and tested on a local test channel. It is off everywhere until the Meta app exists and an admin turns it on for a workspace. Messenger and Instagram webhooks are already understood by the parser; sending on them comes in phase 2.

## What a team gets

* Customer chats appear in the shared inbox next to mail, newest first, with a channel chip on each row and a channel filter.
* A chat opens as a conversation of bubbles, not the email reader: assign, status (open, waiting, done), labels, internal notes, make a task from any message, search by name, number or words.
* Replies go out from the composer as text or a file (up to 5 MB). WhatsApp only allows a free reply within 24 hours of the customer's last message; the conversation shows how long is left ("Reply window closes in 3 h"). After that the composer says so in plain words and offers the approved templates instead.
* Photos and files a customer sends are copied straight away, because Meta's links expire within minutes.

## How it works

| Part | Where |
| --- | --- |
| Shared types and the 24 hour window | `src/shared/channels.ts` |
| Tables (migration 0089) | `msg_channels`, `msg_conversations`, `msg_messages`; notes reuse `thread_comments` (thread id = conversation id); the switch is `organizations.channels_enabled` |
| Provider seam | `src/server/services/channels/provider.ts` |
| Meta Cloud API adapter | `src/server/services/channels/meta.ts` |
| Local test provider | `src/server/services/channels/mock.ts` (CHANNELS_MOCK=on, refused in production) |
| Webhook check and parser | `src/server/services/channels/webhook.ts`, `receive.ts` |
| Storing what arrives | `src/server/services/channels/ingest.ts` |
| Inbox, sending, notes, tasks | `src/server/services/channels/service.ts` |
| Routes | `src/server/routes/channels.ts`: `/api/channels/*` (signed in) and `/api/webhooks/meta` (public, signed by Meta) |

### Webhook

1. Meta calls `GET /api/webhooks/meta` once with `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge`. The challenge is answered only when the token matches `META_VERIFY_TOKEN`.
2. Every delivery is a `POST` with `X-Hub-Signature-256: sha256=<hex>`, the HMAC SHA-256 of the raw body under the app secret. Anything else is answered 401 and never parsed.
3. Meta keeps no copy of a delivery to fetch later, so messages and statuses are stored before the answer (a few small writes, tens of milliseconds); a database failure answers 500 and Meta retries. Only file downloads run after the 200 (`waitUntil` on Workers). Deliveries can carry up to 1,000 updates and 3 MB.
4. Each message is looked up by Meta's message id first (a read). Meta resends a delivery for up to 7 days; a message already stored writes nothing. A unique index on (channel, Meta id) backs this up.
5. Status updates (sent, delivered, read, failed) move an outgoing message forward and never back; a failure keeps Meta's reason in plain words.
6. A customer writing again reopens a conversation marked done.

### Measured cost (local, 28 Oct 2026)

* CPU: signature check plus parse, median 0.18 ms per delivery; the whole path including the database work run in process, median 1.2 ms, p95 1.6 ms per message (200 messages). On Workers the database runs remotely, so the real CPU figure is lower. Limit on the free plan: 10 ms.
* D1 rows written per inbound text message, measured with D1's own counter on a local D1: 7 for a customer already in the inbox (daily counter 1, conversation 2, message 4), 10 for the first message of a new customer (counter 2 on the first message of the day, conversation 4, message 4). Reads: 2 (channel and duplicate check). A status update writes 1 row. A duplicate delivery writes nothing. A message with a file writes 1 more row when its bytes are copied.
* `tests/channels-ingest.test.ts` fails if a change adds a statement to the inbound path.

### Daily guard

Each workspace counts inbound chat messages per UTC day (`usage_counters`, metric `chat_in`). From 80% of `CHANNELS_DAILY_SOFT_CAP` (default 2000) admins see a warning in Settings, Channels; above it, text still lands (nothing is lost) but files are no longer copied. 2000 messages is about 14,000 rows, a seventh of the account's free daily write allowance.

### Files

A file up to 512 KB stays on the message row (base64, the same way mail attachments are kept). A larger file goes to the body store when one is configured (`BODY_STORE_*`); without one it is kept as a name only and the team sees that it was too large to copy. Workers KV is not used for chat files: its free plan allows 1,000 writes a day.

### Tokens

A channel's access token (and the registration PIN Multies sets for a new number) is stored encrypted with AES-GCM under a key derived from `APP_SECRET` (`encryptSecret` in `src/server/lib/crypto.ts`). It is sent to Meta only in the Authorization header and is never logged, returned by the API or put in a URL. Disconnecting a channel wipes the token and keeps every conversation.

### Sending

Sends carry an `Idempotency-Key`; a retry of the same key answers the message the first attempt made instead of sending twice. When the 24 hour window is closed, free text is refused with `409 window_closed` before anything reaches Meta, and templates (listed live from the number's WhatsApp Business Account, approved only) are offered.

### Connecting a number

Settings, Channels, Connect WhatsApp opens Meta's Embedded Signup (v4; v2 and v3 were retired on 15 Oct 2026) in a popup with the app id and configuration id. When it finishes, the page sends the one time code with the phone number id and WhatsApp Business Account id to `POST /api/channels/connect`. The code lives 30 seconds, so the page posts it as soon as both the code and the ids are in. The server exchanges it for a business token (the app secret never reaches the browser), subscribes the app to that account's webhooks and registers the number for the Cloud API (Meta allows 14 days for that). A number that is also used in the WhatsApp Business app (coexistence: event `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, or `is_on_biz_app` in the v5 shape) is already registered; the page sends `coexistence: true` and that step is skipped. After connecting, the business adds a payment method in WhatsApp Manager; Meta bills each business directly.

## What the owner sets

Server settings (names only; values go in as Cloudflare secrets, never in chat or in the repo):

| Name | What it is |
| --- | --- |
| `META_APP_ID` | The Meta app's id |
| `META_APP_SECRET` | The Meta app's secret (signs webhooks, exchanges codes) |
| `META_VERIFY_TOKEN` | Any long random string; typed into the app's webhook settings too |
| `META_ES_CONFIG_ID` | The Embedded Signup configuration id from Facebook Login for Business |
| `META_GRAPH_VERSION` | Optional, for example `v26.0` (the default) |
| `CHANNELS_DAILY_SOFT_CAP` | Optional, inbound messages per workspace per day before the warning |

Until all four `META_*` values are set, Settings, Channels shows "Coming soon" and the switch cannot be turned on. Webhook callback URL for the Meta app: `https://multies.si/api/webhooks/meta`, field `messages`.

The step by step owner checklist (business verification, the Meta app, Tech Provider, App Review) lives outside the repo with the owner's notes.

## Testing locally

`CHANNELS_MOCK=on` (set for E2E in `playwright.config.ts`) turns on a test channel: Settings, Channels, Connect test channel. `POST /api/channels/mock/inbound` makes a test customer write in through the real signed webhook path, and `POST /api/channels/mock/age` moves the reply window back so the template picker can be tested. Tests: `tests/channels-unit.test.ts`, `tests/channels-api.test.ts`, `tests/channels-ingest.test.ts`, `e2e/channels-c1.spec.ts`.

## Phase 2 and later

Template management in Multies, Messenger and Instagram sending (a second App Review), push notifications for new chats, chat identities on contacts, and the needs you ranking with draft replies.
