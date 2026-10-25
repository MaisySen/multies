# Live mail for connected mailboxes

Round 19, 25 October 2026. Code: src/server/services/connect/live.ts, the /live and /lease paths of
MailSyncRunner (src/entry/worker.ts), POST /api/connections/live, src/web/lib/live-mail.ts.

## What a person sees

While Multies mail is open and the tab is visible, new mail at a connected provider shows up in a
few seconds instead of at the next 15 minute scheduled pass. With the tab hidden or closed, the
scheduled pass (and Sync now) still applies.

## How it works

1. The app beats every 10 seconds (POST /api/connections/live, reads only) and pokes once a minute
   (`{"poke": true}`). A beat answers each connection's synced count; when it changes, the mail
   lists refresh at once.
2. A poke gives each of the workspace's connections (at most 5) a live window of 90 seconds, extended
   by every poke. On Workers the window runs in the connection's Durable Object.
3. In the window, one IMAP connection sits in IDLE on the Inbox (RFC 2177; ImapFlow restarts it every
   4 minutes). The server reports new mail the moment it lands and a pass copies it in. Servers
   without IDLE are asked with NOOP every 20 seconds over the same connection.
4. A pass started by the window ends without writing anything when there is no new UID and nothing
   is queued for the provider (`syncConnection(..., { onlyIfNew: true })`).
5. OAuth connections (off today) and connections whose password stopped working get a check pass
   per minute instead of a held connection.

## Free plan limits

- Durable Object duration: 13,000 GB-s a day for the account. One object at 128 MB held for a
  minute is 7.5 GB-s, so the whole day is about 1,700 object minutes, shared with doc co-editing and
  sync passes. Live windows draw from MAIL_LIVE_MINUTES_PER_DAY (default 900) in 5 minute leases,
  granted by one object named "live-budget" (one Durable Object storage write per lease). When the
  day's minutes are used, connections fall back to one check pass per heartbeat minute.
- D1 writes (100,000 a day, account wide): the window and the beats write nothing. A pass writes only
  when it stores mail or applies queued changes, the same rows as a scheduled pass.
- Requests: one beat per open tab every 10 seconds is 360 Worker requests an hour per person; one
  poke a minute is 60 Durable Object requests an hour per connection. Both are far under the free
  daily limits (100,000 each) at today's size; revisit at about 30 people with mail open all day.

## Measured

tests/live-mail.live.test.ts against the local Stalwart server, 25 October 2026: from the moment the
provider accepted a message to the moment Multies had stored it, 5 messages: median 102 ms, slowest
158 ms (push, IDLE). The app's next beat (at most 10 seconds, about 5 on average) then shows it.
Before round 19 the same message waited for the next scheduled pass: 10 to 15 minutes.

## Turning it off

MAIL_LIVE=off in [vars] stops live windows; the beat still answers (reads only) and the scheduled
pass carries on. MAIL_LIVE_MINUTES_PER_DAY changes the daily allowance.
