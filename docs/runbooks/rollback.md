# Rollback

Use this when a deploy made things worse: errors in Sentry for the new release, a failing smoke test,
or a page or API that broke. Roll back first, find the cause second.

## 1. Roll back the Worker (seconds)

```bash
npx wrangler deployments list                 # production; add --env staging for staging
npx wrangler rollback                         # back to the previous version
npx wrangler rollback <version-id>            # or to a chosen version from the list
```

Then confirm the release that is serving and run the smoke test:

```bash
curl -s https://mymail.mymail-app.workers.dev/api/config     # "release" is the serving release id
scripts/smoke.sh https://mymail.mymail-app.workers.dev <release>
```

`wrangler rollback` brings back the code and its vars, not secrets or the database.

## 2. Or redeploy a known good release

When the bad version is further back, or the rollback list is unclear, build and deploy the last good
commit the normal way ([deploy.md](deploy.md)) from a clean checkout:

```bash
git worktree add /tmp/mm-good <good-commit>
cd /tmp/mm-good && npm ci
export RELEASE=$(git rev-parse --short=12 HEAD)
RELEASE=$RELEASE npm run build:web && RELEASE=$RELEASE npm run build:worker
npx wrangler deploy --env="" --var RELEASE:$RELEASE
```

## 3. Migrations do not roll back

D1 migrations stay applied after a rollback. That is why every migration must be backward
compatible: add tables and columns first, remove them in a later release once no running code
reads them. If a migration damaged data, follow [db-backup-restore.md](db-backup-restore.md).

## 4. After

- Watch Sentry for the restored release for 15 minutes.
- Note the bad release, what broke and the fix in the CHANGELOG entry for the next release.
- If customers noticed, it is an incident: [incident-response.md](incident-response.md).
