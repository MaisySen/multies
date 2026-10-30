# Sentry triage

Sentry projects: `mymail-api` (the Worker) and `mymail-web` (the browser app), in the `mymail`
organisation. Environments: `production`, `staging` and `preview`. Each deploy is a release with a
12 character id (normally the commit's short hash), so an issue shows the release it started in. Alerts go by email to the
support mailbox. Sign in details: "CREDENTIALS (owner email v7)", Sentry section.

## For each new or regressed issue

1. **Where:** environment and release. A `preview` or `staging` issue does not touch customers; still fix it before the next production deploy.
2. **How many:** events and users in the last 24 hours. One event from a demo workspace is low; a spike after a deploy is an incident ([incident-response.md](incident-response.md)), and the first move is a [rollback](rollback.md).
3. **What:** read the stack trace and the request id (`x-request-id`), then find the request in the Workers logs.
4. **Decide** and record it on the issue:

| Kind | Action |
| --- | --- |
| Customer facing error | Fix now with a regression test, deploy, resolve "in next release" |
| Background job (cron, maintenance, demo seed) | Fix in the current round; make the step skip safely with a warning when the cause is transient (busy or not yet migrated database) |
| Performance note (N+1 query, slow span) | Batch the queries; fine to schedule for the next round when only the demo seed is affected |
| Noise (bots, a browser extension) | Ignore with a reason, or filter in the SDK setup |

5. **Close:** resolve with the fixing release, and mention the issue id (for example MYMAIL-API-P) in the commit message and the CHANGELOG.

## Open at the time of writing (24 Oct 2026)

- MYMAIL-API-H, M and N: N+1 queries on the demo seed. Being fixed in round 11.
- MYMAIL-API-5: N+1 query regressed in release e45a037. Check after the round 11 seed fix.
- MYMAIL-API-P and Q (maintenance on a busy or reset database): fixed in 0.10.0, resolve once quiet for a day.
