# Incident response

For anything customers notice: the app or API down or slow, mail not arriving or not sending,
data looking wrong, a security problem.

## 1. Declare (first 5 minutes)

- Say it in the team chat (or by email to the owner while the team is one person): "Incident: <what customers see>". One person is the **incident lead**; they coordinate and decide, others investigate.
- Pick a severity:

| Severity | Meaning | Response |
| --- | --- | --- |
| SEV1 | Mail lost, data exposed, or the product down for everyone | All hands, status page within 15 minutes, updates every 30 minutes |
| SEV2 | A major feature down or degraded for many (sending, webmail, billing) | Lead plus one, status update within 30 minutes |
| SEV3 | Minor or a few customers affected | Fix in working hours |

## 2. Look

- `/status` and `/api/status`: which component is red.
- Sentry: new issues and the release they started in (each deploy is a release tied to its commit). Alerts arrive by email at the support mailbox; how to read them: [sentry-triage.md](sentry-triage.md).
- `/api/config`: which release is serving. `/api/health` says only whether the app and its database answer (`{ ok, db }`); the release, D1 writes and reads and the busiest workspaces are on `/api/admin/health` for platform operators, and the status page's 24 hour mail volume is on `/api/admin/status`.
- Workers logs (Cloudflare dashboard, Workers, mymail, Logs): filter on `level:error` or a `requestId` from a customer report. Every response carries `x-request-id`.
- Job queue: the operator console, Jobs (`/console/jobs`) shows queued, dead and failing jobs; outbound mail that cannot be sent waits there instead of being lost.
- Provider status pages: Cloudflare, Resend, Stripe.

## 3. Mitigate first, fix second

| Situation | Action |
| --- | --- |
| Bad deploy | Roll back: [rollback.md](rollback.md) |
| Bad migration or data damage | Stop writes (roll back), then follow [db-backup-restore.md](db-backup-restore.md) |
| Outbound provider down | Nothing to do right away: the circuit breaker opens and sends queue as `delayed`. Replay dead jobs from the operator console (`/console/jobs`) once it recovers |
| Spam or abuse from a workspace | Suspend it or set a send cap in the operator console (`/console/workspaces`, open the workspace) |
| Leaked secret | Rotate it now ([secrets-rotation.md](../security/secrets-rotation.md)), then look for misuse in the audit log |
| Traffic flood | Rate limits answer 429 on their own; for an attack, turn on Cloudflare Under Attack mode or add a WAF rule |

## 4. Communicate

- Customers: a short note on what is affected, what to do (often nothing: mail is queued, not lost), and when the next update comes. No guesses about cause until known.
- Personal data breach likely to cause serious harm: notify affected people and the OAIC under the Notifiable Data Breaches scheme, and within 72 hours for GDPR. Workspaces we process data for get notice within 48 hours (DPA).

## 5. Close and learn

- Confirm the fix with the smoke test and a clean Sentry release.
- Within 5 working days write a blameless postmortem in `docs/postmortems/YYYY-MM-DD-title.md`: timeline (UTC), impact (who, how long, error budget spent), root cause, what went well, what didn't, and action items with owners.

## Operator sign-in (the operator console, /console)

- In production the console opens only for a session that gave a second factor at sign in: the password and the two-step code (or a backup code), or a passkey. Signing in with Google, Auth0, the phone app or a remembered device does not count, unless that sign-in method is listed in `OPERATOR_SSO_METHODS`. List a method there only if that provider makes every operator use multi-factor. It is empty by default.
- If the console says "Sign in with your password and two-step code to open the operator console.", sign out, then sign in with your password and your code.
- Before you give someone an operator role on the Operators page, ask them to turn on two-step sign in (Account and security). The console refuses the grant until they have.
- Every owner gets an email when an operator turns two-step sign in on or off. If you did not expect it, check with that person, and remove their operator access until it is sorted out. An operator who turns two-step off can't open the console until they turn it on again and sign in with the code.
- Accounts listed in `PLATFORM_ADMIN_EMAILS` become owners without two-step, but they can't open the console until they turn it on and sign in with the code. Someone holding only such an owner's password could turn it on first, and the other owners would get the email. Turn on two-step for every operator before go-live.
