# Tools (document tools) runbook

Tools P1, 30 Oct 2026. Thirteen document tools inside Multies, on the Tools page (/app/tools): merge, split,
rotate, compress, convert to PDF (Word, Excel, PowerPoint, OpenDocument), PDF to images, images to PDF, PDF to Word
(text and basic layout only), redact text (verified), remove metadata, watermark, remove password (with the
password) and OCR. Each stored mail attachment has a Tools menu that opens the page with that file already chosen
(POST /api/tools/jobs/from-attachments reads it from the workspace's own mail; nothing is uploaded again).

## Where the work happens

- Files go from the browser to the Multies Worker and straight on to the document engine. The Worker streams the
  upload through without reading or storing it. Nothing is kept in D1, KV or R2.
- The document engine runs at https://doctool.multies.si: a free Render web service in **Singapore**, behind a
  Cloudflare Worker on the multies.si zone (the Render address answers 403 to anything that did not come through it).
  So files are processed in Singapore, not in Australia. Say so plainly anywhere Tools is described.
- The engine deletes the uploaded files when the operation ends and the result 60 minutes after it is made. A
  restart of the free host deletes everything too (its disk is not kept). Results never go into Multies backups.
- The engine is the open source office toolkit (MaisySen/office-toolkit) in engine only mode: every route except
  /healthz and the signed /internal/v1 API answers 404. No accounts, no database on the engine.

## Switches and keys

| Setting | Where | Value |
| --- | --- | --- |
| TOOLS_ENABLED | wrangler.toml vars | "false" on production, "true" on staging |
| DOC_ENGINE_URL | wrangler.toml vars (staging) | https://doctool.multies.si |
| DOC_ENGINE_KEY_ID | wrangler.toml vars (staging) | stg-1 (production will use prod-1) |
| DOC_ENGINE_KEY | Worker secret per environment | the secret for that key id |
| TOOLS_TOKEN_KEY | Worker secret per environment | 32+ random characters, signs job tokens |
| TOOLKIT_SERVICE_KEYS | engine host env | JSON map of key id to secret (stg-1, prod-1) |
| TOOLKIT_ENGINE_ONLY | engine host env | 1 |

Tools are on only when TOOLS_ENABLED is true and the engine address and both secrets are set. A workspace can be
switched off with organizations.tools_mode = 'off' (migration 0092; the Settings switch comes in P4).

Rotation: add a new key id to TOOLKIT_SERVICE_KEYS on the engine, point the Worker at it (DOC_ENGINE_KEY_ID and
DOC_ENGINE_KEY), then remove the old id from the engine.

## Limits and cost

Per plan (src/shared/plans.ts): Free 100 runs a month, 30 a day, 20 MB a run, 10 files a merge. The engine adds its
own caps: 2 jobs at a time per workspace, 20 queued in all, 500 pages a PDF; OCR 30 pages and 20 MB (about 5 seconds a
page on the free host, with page by page progress); PDF to images 100 pages; images to PDF 50 images. Options are
published per tool at GET /internal/v1/operations and mirrored in src/shared/tools.ts (tests/tools-all-p1.test.ts
checks the two against tests/fixtures/tools-engine-operations.json; refresh that file when the engine changes).
The password for Remove password is passed to the engine for that run only and is never written to disk or logs. D1 per run: 1 read and 2 writes (the
usage upsert in tool_usage, migration 0091, and the audit row tools.run, which never holds a file name). Polling a
job reads no D1 (signed job tokens).

## Checks

- Engine: GET https://doctool.multies.si/healthz answers ok; /login answers 404; an unsigned /internal/v1 call 401.
- Staging end to end: e2e/tools-p1.spec.ts with E2E_ALLOW_REMOTE=1, TOOLS_E2E=1, E2E_BASE_URL=https://preview.multies.si,
  TOOLS_E2E_SESSION_FILE set to the staging test session (scripts/staging-session.mjs) and --grep for one spec.
- The free host sleeps after 15 minutes idle. The Cloudflare Worker in front and the Multies cron both ping /healthz.
  A cold start shows "Tools are warming up" on the page for a few seconds.
