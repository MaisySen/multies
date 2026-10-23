# Incident runbook

For anything customers notice: the app or API down or slow, mail not arriving or not sending,
data looking wrong, a security problem.

## 1. Declare (first 5 minutes)

- Say it out loud in the team channel: "Incident: <what customers see>". One person is the **incident lead**; they coordinate and decide, others investigate.
- Pick a severity:

| Severity | Meaning | Response |
| --- | --- | --- |
| SEV1 | Mail lost, data exposed, or the product down for everyone | All hands, status page within 15 minutes, updates every 30 minutes |
| SEV2 | A major feature down or degraded for many (sending, webmail, billing) | Lead plus one, status update within 30 minutes |
| SEV3 | Minor or a few customers affected | Fix in working hours |

## 2. Look

- `/status` and `/api/status`: which component is red.
- Sentry: new issues and the release they started in (each deploy is a release tied to its commit).
- Workers logs (Cloudflare dashboard, Workers, mymail, Logs): filter on `level:error` or a `requestId` from a customer report. Every response carries `x-request-id`.
- Job queue: the operator console (`/app/admin`) shows queued, dead and failing jobs; outbound mail that cannot be sent waits there instead of being lost.
- Provider status pages: Cloudflare, Resend, Stripe.

## 3. Mitigate first, fix second

| Situation | Action |
| --- | --- |
| Bad deploy | `npx wrangler rollback` (production) or `npx wrangler rollback --env staging`, then confirm with `scripts/smoke.sh <url>` |
| Bad migration or data damage | Stop writes (roll back), then follow [restore.md](restore.md) |
| Outbound provider down | Nothing to do right away: the circuit breaker opens and sends queue as `delayed`. Replay dead jobs from the operator console once it recovers |
| Spam or abuse from a workspace | Suspend it or set a send cap in the operator console |
| Leaked secret | Rotate it now ([secrets-rotation.md](../security/secrets-rotation.md)), then look for misuse in the audit log |
| Traffic flood | Rate limits answer 429 on their own; for an attack, turn on Cloudflare Under Attack mode or add a WAF rule |

## 4. Communicate

- Customers: a short note on what is affected, what to do (often nothing: mail is queued, not lost), and when the next update comes. No guesses about cause until known.
- Personal data breach likely to cause serious harm: notify affected people and the OAIC under the Notifiable Data Breaches scheme, and within 72 hours for GDPR. Workspaces we process data for get notice within 48 hours (DPA).

## 5. Close and learn

- Confirm the fix with the smoke test and a clean Sentry release.
- Within 5 working days write a blameless postmortem in `docs/postmortems/YYYY-MM-DD-title.md`: timeline (UTC), impact (who, how long, error budget spent), root cause, what went well, what didn't, and action items with owners.
