/**
 * Tools P2, H4: runs the attachment index cron pass against the local e2e databases until it has nothing left to
 * do, the way the scheduled handler will every 15 minutes: the main database (DATABASE_PATH) and the separate
 * attachment text index next to it (INDEX_DATABASE_PATH, by default "<main>-index.db", as src/entry/node.ts opens it).
 * Local e2e and screenshots only.
 * Usage: DATABASE_PATH=.data/e2e.db TOOLS_ENABLED=true DOC_ENGINE_URL=... npx tsx e2e/support/index-pass.ts
 */
import { openSqlite, indexDbPath } from "@/server/db/node";
import { migrateIndex } from "@/server/db";
import { loadConfig } from "@/server/config";
import { nullLogger } from "@/server/lib/logger";
import type { Deps } from "@/server/context";
import { runIndexPass } from "@/server/services/tools/attachment-index";

const mainPath = process.env.DATABASE_PATH ?? ".data/e2e.db";
const db = openSqlite(mainPath);
const indexPath = indexDbPath(mainPath);
const indexDb = indexPath ? openSqlite(indexPath) : undefined;
if (indexDb) await migrateIndex(indexDb);
const deps = { db, indexDb, config: loadConfig(process.env), now: () => new Date(), fetch, log: nullLogger } as unknown as Deps;
for (let i = 0; i < 12; i++) {
  const r = await runIndexPass(deps);
  console.log(JSON.stringify(r));
  if (r.stop || (!r.queued && !r.submitted && !r.collected && !r.local)) break;
}
