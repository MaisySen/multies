# Deploy

Deploys are manual while GitHub Actions has no minutes (until 1 November 2026). The steps are the
same as the CI workflow (`.github/workflows/ci.yml`): staging first, then the same commit to
production. The Cloudflare and Sentry tokens are in "CREDENTIALS (owner email v7)"; export them in
your shell, never write them into the repo.

## Before you start

- [ ] `main` has every commit you mean to ship, and the checks in [../sdlc.md](../sdlc.md) pass on it.
- [ ] A schema change has a backward compatible migration (`npm run db:generate`).
- [ ] New environment variables are in `.env.example` and `wrangler.toml`, or set with `wrangler secret put` for staging and production.
- [ ] A production migration: take a manual D1 export first ([db-backup-restore.md](db-backup-restore.md)).

## 1. Build from a clean checkout

Other work may be in progress in the main working tree, so build from a separate checkout of the
exact commit:

```bash
git worktree add /tmp/mm-deploy main      # or: cd /tmp/mm-deploy && git checkout --detach <commit>
cd /tmp/mm-deploy && npm ci
export RELEASE=$(git rev-parse --short=12 HEAD)
RELEASE=$RELEASE npm run build:web
RELEASE=$RELEASE npm run build:worker
```

`RELEASE` is the 12 character release id that `/api/health`, `/api/config` and Sentry report. It is
normally the commit's short hash; if you use another id, write down the commit it maps to.

## 2. Staging

```bash
npx wrangler d1 migrations apply mymail-staging --remote --env staging
npx wrangler deploy --env staging --var RELEASE:$RELEASE
scripts/smoke.sh https://mymail-staging.mymail-app.workers.dev "$RELEASE"
E2E_BASE_URL=https://mymail-staging.mymail-app.workers.dev npx playwright test e2e/smoke.spec.ts e2e/launch-checklist.spec.ts
```

Then by hand: sign in to a demo, open mail, chat and tasks, and check Sentry for new staging issues.
A remote E2E run can hit the sign up and demo rate limits; see [../testing.md](../testing.md).

## 3. Production

```bash
npx wrangler d1 migrations apply mymail-au --remote
npx wrangler deploy --env="" --var RELEASE:$RELEASE
scripts/smoke.sh https://mymail.mymail-app.workers.dev "$RELEASE"
E2E_BASE_URL=https://mymail.mymail-app.workers.dev npx playwright test e2e/launch-checklist.spec.ts
curl -s https://mymail.mymail-app.workers.dev/api/config     # "release" must equal $RELEASE
```

Only when `email-worker/` changed: `npx wrangler deploy --config email-worker/wrangler.toml`.

Sentry release and source maps (optional while CI is down, needs the Sentry token):

```bash
npx --yes @sentry/cli@2 releases new "$RELEASE" -p mymail-api -p mymail-web
npx --yes @sentry/cli@2 sourcemaps upload --release "$RELEASE" -p mymail-web dist/web/assets
npx --yes @sentry/cli@2 sourcemaps upload --release "$RELEASE" -p mymail-api dist/worker/_worker.js dist/worker/_worker.js.map
npx --yes @sentry/cli@2 releases finalize "$RELEASE"
npx --yes @sentry/cli@2 deploys new --release "$RELEASE" -e production
```

## 4. After

- [ ] `/status` is green and Sentry is quiet for 15 minutes after the deploy.
- [ ] Push `main` to GitHub (never with force).
- [ ] CHANGELOG updated and the docs match what shipped (the release checklist in [../sdlc.md](../sdlc.md)).
- [ ] Remove the worktree: `git worktree remove /tmp/mm-deploy` (or keep it for the next deploy).

If anything looks wrong: [rollback.md](rollback.md).
