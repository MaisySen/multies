# Attachment index database (search inside attachments)

Tools P2 (17, 16). Text extracted from mail attachments and its full text index live in a **separate D1 database**
(binding `INDEX_DB`), never in the main one. The main database (`mymail-au`, `mymail-staging`) must hold no virtual
table: `wrangler d1 export` refuses a database with one, and the encrypted backups and the data export depend on
export.

- Main database (migration `drizzle/0096_tools_p2_index.sql`): `attachment_text` (one row per attachment: workspace,
  mailbox, message, smart folder, status, counts; no text) and `attachment_index_state` (switch, OCR language, daily
  counts, the indexer's cursors). Backed up as usual.
- Index database (migrations in `drizzle-index/`, tracked in its own `d1_migrations`): `attachment_fts`, an FTS5
  table with the text, a scope token column, and the attachment, workspace and mailbox ids (UNINDEXED). Its rowid is
  `attachment_text.id`. **Not backed up and rebuildable**: losing it only means the indexer reads the attachments
  again (see "Rebuild" below).
- Without the `INDEX_DB` binding the indexer and search inside attachments stay off quietly ("index" is left out of
  GET /api/tools features); the Files folders keep working from the classes already in `attachment_text`.

## Create (once per environment)

```sh
npx wrangler d1 create multies-index --location oc
npx wrangler d1 create multies-index-staging --location oc
```

Then add the binding with the ids the create commands print (production at top level, staging under env.staging):

```toml
[[d1_databases]]
binding = "INDEX_DB"
# Tools P2 (17): attachment text index. Rebuildable, NOT backed up (the main database holds no virtual table).
database_name = "multies-index"
database_id = "<id from wrangler d1 create>"
migrations_dir = "drizzle-index"
migrations_table = "d1_migrations"

[[env.staging.d1_databases]]
binding = "INDEX_DB"
database_name = "multies-index-staging"
database_id = "<id from wrangler d1 create>"
migrations_dir = "drizzle-index"
migrations_table = "d1_migrations"
```

## Migrate (each deploy, before the code, next to the main database's migrations)

```sh
npx wrangler d1 migrations apply multies-index --remote
npx wrangler d1 migrations apply multies-index-staging --remote --env staging
```

The hosted preview's deploy hook (POST with DEPLOY_TOKEN) applies the index migrations too when `INDEX_DB` is bound;
its answer lists them as `index:<name>`. On Node the index is a second SQLite file next to `DATABASE_PATH`
(`x.db` -> `x-index.db`), or `INDEX_DATABASE_PATH` (`off` leaves it out).

## Check

- `npx wrangler d1 export mymail-staging --remote --env staging --output /tmp/check.sql` succeeds (no virtual table).
- `npx wrangler d1 execute multies-index-staging --remote --env staging --command "select count(*) from attachment_fts"`
  grows after the cron passes; GET /api/tools features lists "index".

## Rebuild (lost or damaged index database)

Recreate it and apply its migrations, then in the main database send the indexed rows back to the queue so the
cron passes read them again (within the daily caps):

```sql
update attachment_text set status = 'queued', tries = 0, job_id = null where status in ('done', 'pending');
```

## Deleting

Every delete goes to both databases, text first: the sweep (attachment gone because its message was deleted or
purged), a workspace turning indexing off (Settings, then the cron passes; once its main rows are gone any text left
for the workspace is removed through its scope token), and an attachment that vanished before it was read.
