# Database backup and restore

Use this when data is lost or corrupted: a bad migration, a bug that wrote wrong data, a mistaken bulk delete, or a lost database. Read it fully before starting. Restoring production is an incident: open one first ([incident-response.md](incident-response.md)).

## Backups we have

| Layer | What | Retention | Restore time |
| --- | --- | --- | --- |
| D1 Time Travel | Point-in-time restore to any minute | 7 days on the free plan we run on (30 days on Workers Paid) | Minutes |
| Nightly logical dump | `wrangler d1 export` of production and staging, gzip, encrypted with age, stored as a GitHub Actions artifact (`.github/workflows/backup.yml`) | 30 days | 10 to 30 minutes |
| R2 copy (optional) | Same encrypted file in R2 when `R2_BUCKET` is set | Bucket lifecycle | 10 to 30 minutes |

Targets: recovery point objective (RPO) 1 minute with Time Travel, 24 hours from the nightly dump; recovery time objective (RTO) 1 hour.

GitHub Actions has no minutes until 1 November 2026, so the nightly dump is not running. Until then,
take a manual export before every production deploy that carries a migration, and keep it outside
the repo (encrypted with the age key named below):

```bash
npx wrangler d1 export mymail-au --remote --output mymail-au-$(date -u +%Y%m%dT%H%MZ).sql
npx wrangler d1 export mymail-staging --remote --env staging --output mymail-staging-$(date -u +%Y%m%dT%H%MZ).sql
```

The Cloudflare token for these commands is in "CREDENTIALS (owner email v7)", Cloudflare section.

`wrangler d1 export` blocks every other query on that database for as long as it runs (Cloudflare's
documented behaviour). At 02:20 UTC on 26 Oct 2026 a manual export of production made three writes
fail within seconds (since R28 the API answers such failures with 503, `Retry-After` and the code
`busy` instead of 500, and reads retry once). So avoid manual exports in busy hours (Sydney
business hours are 21:00 to 07:00 UTC): before a deploy, prefer a Time Travel bookmark
(`npx wrangler d1 time-travel info mymail-au` prints the current one; note it in the deploy log),
which costs nothing and blocks nothing, and keep exports for quiet hours. The nightly dump is
scheduled for 15:30 UTC (02:30 in Sydney) for the same reason.

R2 needs a payment method on the Cloudflare account even for the free tier, so it is off until the owner enables it. To turn it on: enable R2 in the dashboard, create a bucket (for example `mymail-backups`) with a 90 day lifecycle rule, give the CI token "Workers R2 Storage: Edit", and set the repository variable `R2_BUCKET=mymail-backups`.

## Decide first

1. What broke, and since when? Find the last good moment in Sentry, the logs and the audit log (Settings, Activity).
2. Whole database or a few rows? For a few rows, restore into a scratch database and copy them back (option C). Never roll the whole database back for a handful of rows: it discards every good write since.
3. Put the app in a safe state: if writes are making it worse, roll back the deploy (`npx wrangler rollback`) or pause the feature.

## Option A: Time Travel (whole database, last 30 days)

```bash
# See the current bookmark (note it down: it lets you undo the restore).
npx wrangler d1 time-travel info mymail-au

# Restore to a moment (UTC, RFC 3339) or a bookmark.
npx wrangler d1 time-travel restore mymail-au --timestamp=2026-10-23T05:40:00Z
```

The restore is in place and takes effect immediately. To undo it, restore to the bookmark you noted. Then run `scripts/smoke.sh https://mymail.mymail-app.workers.dev`.

## Option B: From the nightly dump (whole database)

1. Download the artifact: GitHub, Actions, Backup, the run, `mymail-<timestamp>.sql.gz.age`.
2. Decrypt with the private key (kept offline, labelled "Database backup encryption key"):

   ```bash
   age -d -i backup-key.txt mymail-20261023T1530Z.sql.gz.age | gunzip > restore.sql
   ```

3. Restore into a new database first, never straight over production:

   ```bash
   npx wrangler d1 create mymail-restore --location oc
   npx wrangler d1 execute mymail-restore --remote --file restore.sql --yes
   npx wrangler d1 execute mymail-restore --remote --command "select count(*) from organizations"
   ```

4. Check the numbers against what you expect. Then point production at it: change `database_id` (and `database_name`) under `[[d1_databases]]` in `wrangler.toml` to the new database, deploy, and run the smoke test.
5. Keep the old database for 7 days before deleting it.

## Option C: A few rows

Restore into a scratch database (option A with `--timestamp` into a copy is not supported, so use option B's steps 1 to 3, or Time Travel on staging), select the rows you need, and write them back with targeted `INSERT` or `UPDATE` statements through `wrangler d1 execute mymail-au --remote`. Record each statement in the incident notes.

## After any restore

- Run `npx wrangler d1 migrations list mymail-au --remote`: no migration should be pending. If one is, apply it.
- Run the smoke test and check `/status`.
- Tell affected customers what happened and what, if anything, they need to redo (writes after the restore point are gone).
- Write the postmortem.

## Drills

Restore the latest dump into a scratch database once a quarter and record the result here.

| Date | Source | Result |
| --- | --- | --- |
| 2026-10-23 | `wrangler d1 export` of staging, imported into a new D1 database in Oceania | 37 tables and 11 applied migrations restored, then the scratch database was deleted. |
| 2026-10-23 | Production moved from `mymail` (western North America) to `mymail-au` (Oceania) with `wrangler d1 export` | `d1 execute --file` refused the dump twice (rows for a table came before the table it references), so the tables were created first and the rows loaded parent tables first in batches through the D1 query API. Row counts matched for all 46 tables except one new uptime check, and `PRAGMA foreign_key_check` was clean. Old database kept until 2026-10-30. |
