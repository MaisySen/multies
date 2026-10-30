# Storage cost and the move to R2 (design, not done yet)

Written 30 October 2026 (R62). Status: design only. Nothing here has been built or migrated.

## Where mail is stored today
- Every message (headers, plain text body, HTML body) is a row in the D1 database `mymail-au` (Cloudflare, Oceania location hint).
- Attachments up to 1 MB are stored in the same row set, base64 encoded in `attachments.content_b64` (`MAX_INLINE_ATTACHMENT_BYTES` in `src/server/services/mail/store.ts`). Base64 makes each one about a third bigger than the file.
- Attachments over 1 MB go to the body store (`BODY_STORE_*`, any S3 compatible bucket, `src/server/services/storage/body-store.ts`) when one is configured. None is configured on production or staging today, so those parts are kept as a name only.
- Chat channel files follow the same rule with a 512 KB limit (docs/channels.md).

## Why this matters for plans
- A D1 database on the Free plan holds at most 10 GB (500 MB per database on the free tier for new accounts, 10 GB on the paid plan; check the account's current limit in the Cloudflare dashboard before relying on either). Every workspace shares the one production database.
- The plans promise far more than that: Free 3 GB per workspace, each storage pack 20 GB more (up to 50 packs, 1,000 GB), legacy Pro 250 GB, legacy Business 1,000 GB (2,500 GB for the workspaces from before R62).
- So the database fills long before any single workspace reaches its plan limit. Three or four Free workspaces near 3 GB each would fill a 10 GB database.
- D1 also bills reads and writes by rows, not bytes, so large rows do not cost more per query, but a full database stops every write for every customer.

## What storage costs us
- R2: 10 GB stored free a month, then about US$0.015 per GB a month (about A$0.023). No charge for data leaving R2. Class A writes 1 million free a month, class B reads 10 million free a month.
- At those prices: a full Free workspace (3 GB) about A$0.07 a month; a storage pack (20 GB) about A$0.46 against A$2 charged; a full legacy Business workspace at 1,000 GB about A$23 against A$49 charged. That is why R62 lowered Business from 2,500 GB (about A$57, more than its price).

## The rule until the move is done
No workspace may get near the database limit. Watch the database size (Cloudflare dashboard, D1, mymail-au, or `wrangler d1 info mymail-au`) weekly. If it passes 5 GB, do the move below before selling more storage packs.

## The move (steps, in order)
1. Create an R2 bucket `multies-mail-au` with location hint Oceania (`wrangler r2 bucket create multies-mail-au --location oc`). This needs an API token with R2 edit permission; the current Cloudflare token has none.
2. Make an R2 S3 API token scoped to that bucket and set `BODY_STORE_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`), `BODY_STORE_BUCKET`, `BODY_STORE_REGION=auto`, `BODY_STORE_ACCESS_KEY_ID`, `BODY_STORE_SECRET_ACCESS_KEY` as Worker secrets, staging first. From then on new attachments over 1 MB go to R2 instead of being dropped. Or bind R2 directly (`[[r2_buckets]]` in wrangler.toml) and add a binding backed implementation of the body store interface, which avoids request signing CPU on the free plan's 10 ms budget.
3. Lower the inline limit step by step (1 MB, then 64 KB, then 0) so new attachments stop landing in D1.
4. Move message bodies: add `messages.body_key` (nullable) in a migration. New mail writes the HTML body (and text bodies over a few KB) to R2 under `org/<org id>/msg/<message id>.html` and keeps only a short preview in D1. Reads fetch the body from R2 when `body_key` is set.
5. Backfill old rows in small batches from the maintenance pass: read N rows that still have `content_b64` or a large `html_body`, write each to R2, then update the row to clear the column and set the key. Respect the D1 daily read and write budgets (stop at 40 percent, like the mail backfill guard), and never touch rows being synced.
6. Count storage from R2 object sizes per workspace (keep `mailboxes.used_bytes` as the source of truth, updated on write and delete).
7. Deleting mail, a mailbox, or a workspace deletes its R2 objects (a delete job keyed by prefix), so the privacy page's deletion promise still holds. Backups: R2 objects are not in the D1 export; add the bucket to the backup runbook (db-backup-restore.md) with the same 30 day retention.
8. Update /privacy, /trust and the data residency table: attachments and bodies stored in Cloudflare R2, Oceania location hint.

## Tests to write with the move
- Body store round trip on a fake bucket; a read falls back to D1 for rows not yet moved.
- Backfill batch: stops at the read budget, idempotent when re run, never clears a column before the object write succeeded.
- Delete paths remove the objects.
