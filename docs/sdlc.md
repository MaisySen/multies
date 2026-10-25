# How we build and ship

## Branching and commits

- One branch, `main`. Work lands in small commits that each leave the app working. A larger or risky change (a security pass, for example) may use a short lived branch or worktree that is merged back into `main` before it ships.
- Several people and agents may share one working tree, so commit only your own paths: `git add <files> && git commit -m "..." -- <files>`. Never `git add -A`, `git commit -a`, stash or reset other people's files.
- Conventional prefixes, as in `git log`: `feat(area):`, `fix(area):`, `perf:`, `test:`, `docs:`, `design:`, `copy:`, `brand:`, `security:`, `chore:`, `ci:`, `ops:`. The subject says what changed for a person, in plain words. Mention a Sentry issue id when a commit fixes one.
- Never commit secrets. Values live in Cloudflare secrets and in the owner's "CREDENTIALS (owner email v7)" list.
- Push to GitHub (`MaisySen/mymail`) only after a deploy has passed, and never with force.

## Checks before every deploy

```bash
npm run typecheck
npm run lint
npm run lint:copy          # no em or en dashes, no stock phrases, no old product name
npx vitest run
npm run build:web
npx playwright test
npm run a11y:audit -- http://localhost:8792 /tmp/a11y.json    # axe, WCAG 2.2 AA
```

`npm run check` runs the first four. All must pass; a flaky test is fixed, not retried until green.
Details and counts: [testing.md](testing.md).

## Rules every change follows

- Clean room: no code from other products; dependencies MIT, Apache 2.0 or ISC only ([adr/0003](adr/0003-clean-room-licences.md)).
- Free tier only: stay inside the Workers Free 10 ms CPU limit, so heavy routers load on their first request ([adr/0005](adr/0005-cloudflare-free-tier.md)).
- No AI that we pay for: users bring their own ([adr/0002](adr/0002-bring-your-own-ai.md)).
- Apple style design from `brand/tokens.json`, light and dark, no emoji in the UI.
- Copy for small businesses and startups worldwide, AUD as the default currency, no claim about where data is hosted.

## Deploy flow

Manual. CI runs the fast checks on every push and deploys only when asked (Run workflow with
"deploy" ticked, or `AUTO_DEPLOY=true`); while the GitHub account has a billing block its jobs do
not start. Full steps in
[runbooks/deploy.md](runbooks/deploy.md):

1. Build from a clean checkout with `RELEASE` set.
2. Apply D1 migrations to `mymail-staging`, `wrangler deploy --env staging`, run `scripts/smoke.sh`.
3. Run the E2E smoke and `e2e/launch-checklist.spec.ts` against staging with `E2E_BASE_URL`.
4. Apply migrations to `mymail-au`, deploy production, run the smoke test and the launch checklist.
5. Confirm the release on `/api/config`.

Rollback: `wrangler rollback`, or redeploy the previous release ([runbooks/rollback.md](runbooks/rollback.md)).
Migrations never roll back, so they are always backward compatible.

## Release checklist

- [ ] All checks above pass on the commit being shipped.
- [ ] Staging deployed, smoke test and E2E pass, no new Sentry issues. Run E2E locally (Playwright refuses a remote base URL unless `E2E_ALLOW_REMOTE=1` and `--grep` name one spec) and confirm deploys with one GET of `/api/config`; production and staging share one D1 budget of 100,000 rows written a day ([runbooks/d1-daily-limits.md](runbooks/d1-daily-limits.md)). Skip migrations a release does not need. A change that adds writes on a hot path (sign in, every request, the cron) updates `tests/write-cost.test.ts`.
- [ ] Production deployed, smoke test and launch checklist pass, `/api/config` shows the release.
- [ ] Sentry quiet for 15 minutes after the deploy.
- [ ] CHANGELOG updated: the round moves from Unreleased to its version.
- [ ] Docs updated: README, API, architecture, runbooks and decision records match what shipped.
- [ ] `npm run security` passes (npm audit, gitleaks over history and pending changes, the authorisation and isolation tests).
- [ ] The gitleaks pre-commit hook is installed on the machine that commits (`npm run hooks:install`, once per clone).
- [ ] `main` pushed to GitHub.
- [ ] Mobile: when the API changed in a way the app uses, the app is checked against production.

## Versioning

- Web app and API: semantic versioning, one minor version per build round before 1.0.0 (round 10 is 0.10.0). Each deploy also carries a 12 character release id shown on `/api/health` and `/api/config` and in Sentry.
- Public API: `/api/v1` changes are additive. A breaking change needs a new version path.
- Mobile app: its own version and build number per store release ([mobile.md](mobile.md)).
