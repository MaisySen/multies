# Deploy

Deploys are manual. GitHub Actions jobs on this repository do not start while the GitHub account
has a billing block (since 24 October 2026, 00:07 UTC; only the account owner can clear it under
Settings, Billing and licensing). Once Actions runs again, CI deploys only when asked: Actions, CI,
Run workflow, with "deploy" ticked, or on every push if the repository variable `AUTO_DEPLOY` is
`true`. The steps below are the same as the CI workflow (`.github/workflows/ci.yml`): staging
first, then the same commit to production. The Cloudflare and Sentry tokens are in "CREDENTIALS (owner email v7)"; export them in
your shell, never write them into the repo.

## Before you start

- [ ] `main` has every commit you mean to ship, and the checks in [../sdlc.md](../sdlc.md) pass on it.
- [ ] A schema change has a backward compatible migration (`npm run db:generate`). After merging branches that each add one, keep `drizzle/meta/_journal.json` in number order and rerun `npx tsx scripts/bundle-migrations.ts`.
- [ ] D1 writes: check `writes.level` on `/api/health` is `ok` before a migration that rebuilds indexes ([d1-daily-limits.md](d1-daily-limits.md)).
- [ ] New environment variables are in `.env.example` and `wrangler.toml`, or set with `wrangler secret put` for staging and production.
- [ ] Before every production deploy, record the Time Travel bookmark (`npx wrangler d1 time-travel info mymail-au`) in the deploy log ([db-backup-restore.md](db-backup-restore.md)). Prefer the bookmark at any hour: it restores to any minute of the last 30 days and blocks nothing. Owner rule (27 Oct 2026): if a full `wrangler d1 export` of production is truly needed, run it only between 07:00 and 21:00 UTC (outside Sydney business hours), never between 21:00 and 07:00 UTC. An export blocks every other query on the database while it runs.
- [ ] Email worker: deploy `email-worker/` only from a checkout whose `MYMAIL_ROUTES` carries the current inbound key ids. An old key id makes support@ and security@ bounce. After any email worker deploy or key rotation, send a test mail to security@multies.si and check that it arrives.

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

Then run the local E2E smoke against this build (`npx playwright test e2e/smoke.spec.ts` plus the specs for what changed). Type checks and unit tests do not load the bundled chunks: in R32 a new editor dependency (`fast-equals`) landed outside the `vendor-editor` chunk in `vite.config.ts`, the two chunks imported each other, and the docs editor failed on load ("reading 'create'") while tsc and vitest were green. A new dependency of the editor, chart or calendar code goes in the matching vendor regex.

`RELEASE` is the 12 character release id that `/api/health`, `/api/config` and Sentry report. It is
normally the commit's short hash; if you use another id, write down the commit it maps to.

## 2. Staging

```bash
npx wrangler d1 migrations apply mymail-staging --remote --env staging
npx wrangler deploy --env staging --var RELEASE:$RELEASE
scripts/smoke.sh https://mymail-staging.mymail-app.workers.dev "$RELEASE"
curl -s https://mymail-staging.mymail-app.workers.dev/api/config   # "release" must equal $RELEASE
# Remote E2E writes to the shared D1 budget: only the read-only pass (404, favicon set, robots, sitemap):
npm run test:e2e:staging-readonly
```

The read-only pass reads public pages only and writes nothing to D1. Staging is a preview, so its robots.txt
keeps every crawler out (`Disallow: /`); the robots check expects that on a staging URL and the app and API
rules everywhere else. It needs no account and no demo, so it does not use up the 10-a-day demo cap.

Then by hand: sign in to a demo, open mail, chat and tasks, and check Sentry for new staging issues.

### Signed in GETs on staging (R42)

Staging allows only 2 new demos a day (`DEMO_DAILY_LIMIT=2`), so the demo cannot sign the deploy gate in. Staging has
a seeded test session instead, made on the app side only (nothing at the identity provider, which is one tenant
shared with production, and no app code change, so production is untouched):

- `node scripts/creds.mjs run APP_SECRET_STAGING,CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID -- node scripts/staging-session.mjs`
  writes one session row to the staging D1 (`mymail-staging` only; it refuses anything else) for the staging test
  user `usr_g946j7sotvkn4vvo` in "Staging's workspace" (a normal, non demo workspace, so it can send email), signs the
  cookie with the staging app secret the way the app does, and saves it to `~/.multies-secrets/staging-test-session.json`
  (mode 600, never printed; the SQL goes through a mode 600 temp file). Older seeded sessions of that user are removed
  first. The session lasts 30 days and rolls forward daily while used; run it again if the GETs script says so.
- `python3 scripts/staging-signed-gets.py 50` makes 50 signed in GETs over the hot routes with that session and prints
  the status counts and empty 503s (exit 1 on any non 200, 2 when the session needs reseeding). It checks prod
  `/api/health` reads first and refuses at 50% or more. Never point it at prod.

Sign in client login URI: since R42 the "Multies Staging" client's login URI is
`https://preview.multies.si/login?confirmed=1`, the same pattern as production's `https://multies.si/login?confirmed=1`
(R41), so "Back to Multies" after a staging email confirmation lands on the staging sign in page.
A remote E2E run can hit the sign up and demo rate limits; see [../testing.md](../testing.md).

### Signed in UI checks on production (R45)

The public demo can be paused, and production has no seeded cookie the way staging does (the production app secret
lives only in the worker). R45 added a test session the worker mints itself, for one test user in one test workspace:

- `POST /api/_test-session` with header `x-test-session` equal to the `TEST_SESSION_TOKEN` secret makes a 24 hour
  session for `TEST_SESSION_USER_ID` and answers the cookie (src/server/routes/test-session-r45.ts). Without the three
  `TEST_SESSION_*` secrets, or with a wrong header, it is a plain 404. It refuses (409) unless the user belongs to exactly
  one workspace, the one named by `TEST_SESSION_ORG_ID`, and that workspace is not a demo. Each mint replaces the last
  test session and writes an audit line (`session.test_minted`).
- The test user is "Prod QA" (the build team's prodqa plus address) in "Multies QA (test)": a normal workspace with no
  domain and no mailbox. It holds a "Windowing check" project (90 tasks, one sprint) for board and backlog checks.
- `node scripts/creds.mjs run CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID -- node scripts/prod-session.mjs --setup` once
  (rows, a new random token in `~/.multies-secrets/prod-test-session-token.json`, the worker secrets through
  `wrangler secret bulk` from a mode 600 file). Then `node scripts/prod-session.mjs` mints a session into
  `~/.multies-secrets/prod-test-session.json` (never printed); `--seed` also creates the project once.
- Turn it off: `... prod-session.mjs --off` deletes the token secret.
- Use it for clicking through UI on live only: no load, no mail, nothing outside the test workspace.

## 3. Production

```bash
npx wrangler d1 migrations apply mymail-au --remote
npx wrangler deploy --env="" --var RELEASE:$RELEASE
scripts/smoke.sh https://mymail.mymail-app.workers.dev "$RELEASE"
E2E_ALLOW_REMOTE=1 E2E_BASE_URL=https://mymail.mymail-app.workers.dev npx playwright test e2e/launch-checklist.spec.ts --grep 'real 404|robots|sitemap'
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

## GitHub main and the local tree hash (R53)

GitHub main's root tree hash never equals the local app checkout's, and that is expected: GitHub main also carries the
phone app under `mobile/` (replayed there from the mobile repository by the push tooling), while the app checkout has no
`mobile/` folder. Checked on 28 Oct 2026: GitHub tree 0487ac4 (commit de2e2f4) against local tree 3e4e568 (b60184a):
all 1,789 app files have the same blob hash and mode; GitHub's 297 extra files are all under `mobile/`. Line endings,
filters and submodules play no part.

To check that a push carried the app exactly, compare the root entries of both trees with `mobile` left out (same names,
modes and hashes at the root means every file below them is identical). The push tooling's `tree_check()` does this and
answered "38 root entries, 0 differences" on 28 Oct. No force push and no history rewrite is needed or wanted.
