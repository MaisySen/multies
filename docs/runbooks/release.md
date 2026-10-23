# Release checklist

Releases are continuous: every push to `main` that passes CI goes to staging, then the same build
goes to production behind the `production` environment gate.

## Before merging

- [ ] Tests, typecheck, lint, copy lint, coverage thresholds, Playwright and Lighthouse pass in CI.
- [ ] A schema change has a migration (`npm run db:generate`) that is backward compatible: add columns and tables first, remove in a later release once no running code reads them.
- [ ] New environment variables are in `.env.example`, `wrangler.toml` (vars) or set as secrets for both staging and production.
- [ ] New user facing copy passes `npm run lint:copy` and reads well on a phone.
- [ ] Anything touching auth, billing or mail delivery has an integration test.

## Staging (automatic)

CI applies migrations, deploys with the commit as the Sentry release, uploads source maps and runs
`scripts/smoke.sh`. Then check:

- [ ] https://mymail-staging.mymail-app.workers.dev loads; sign in, open the mailbox, send a test message.
- [ ] No new issues in Sentry for the staging release.

## Production

- [ ] Approve the `production` deployment in GitHub Actions (it promotes the exact artifact staging ran).
- [ ] Smoke test passes in the workflow; `/status` is green; `/api/health` shows the new release.
- [ ] Watch Sentry for 15 minutes after the deploy marker.
- [ ] Billing or email changes: send yourself a receipt or verification email from production.

## Rolling back

`npx wrangler rollback` returns the worker to the previous version in seconds. Migrations do not
roll back: that is why they must be backward compatible. For data problems use [restore.md](restore.md).
