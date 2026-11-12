/**
 * Tools P2 (17, 16): the attachment text index behind "search inside attachments" and smart folders.
 *
 * What it stores, in two databases:
 *   - the main database (deps.db): one attachment_text row per mail attachment it reads (the smart folder, the
 *     state, the counts) and attachment_index_state. No text and no virtual table, so `wrangler d1 export` (the
 *     backups and the data export) keeps working.
 *   - the index database (deps.indexDb, binding INDEX_DB, migrations in drizzle-index/): attachment_fts, an
 *     FTS5 table holding the extracted text (capped at textCap characters) with the row's id as its rowid and
 *     the attachment, workspace and mailbox ids. Rebuildable from the mail and not backed up.
 *   One row per attachment, never per message, and no triggers: the messages table and the mail sync code are
 *   untouched. Without an index database the indexer and search inside attachments stay off; the Files
 *   folders keep working from the classes already in attachment_text.
 *
 * How it fills: runIndexPass(deps) is called by the cron (the scheduled handler, every 15 minutes). A pass
 *   1. stops at once when any stop flag is up (see indexStop): TOOLS_FEATURES without "index", no index database, Tools off for
 *      the deployment, or the D1 guard (the same Cloudflare analytics reading /api/health shows and the mail
 *      backfill's MAIL_SYNC_BACKFILL_READ_STOP_PCT reads) at READ_STOP_PCT of the daily read budget or
 *      WRITE_STOP_PCT of the write budget, well below the backfill's own stop;
 *   2. deletes the index of workspaces that turned indexing off (PURGE_PER_PASS rows);
 *   3. sweeps SWEEP_PER_PASS index rows for attachments that are gone (message deleted) and deletes their text;
 *   4. collects finished engine jobs (at most IN_FLIGHT_MAX are ever running) and writes text and folder;
 *   5. walks the attachments table by rowid (no new index on it, no scan): new mail first above the "hi"
 *      cursor, then older mail below the "lo" cursor, SCAN_PER_PASS rows in all, queueing what it can read;
 *   6. starts at most SUBMIT_PER_PASS engine extract-text jobs (PDFs and images, OCR "auto" in the workspace's
 *      language, English by default) and reads at most LOCAL_PER_PASS text, Word and Excel files itself,
 *      newest first, within each workspace's DAILY_PER_WORKSPACE and the account wide DAILY_GLOBAL.
 *
 * Budget per pass (D1 rows), per database:
 *   main:  reads at most about 1,500 (guard 0, state rows up to 21, purge up to 200, sweep up to 1,000, collect
 *          up to 16, scan up to 2 x SCAN_PER_PASS joined rows plus 1 per new candidate for the "already queued"
 *          check, queue pick 40, attachment bytes up to 14); writes at most about 1,000 (queued rows 5 each with
 *          their indexes, each indexed attachment about 5, purge up to 200 and sweep up to 500 rows, each about
 *          5 with the indexes). No text is written here any more.
 *   index: reads only for deletes (a delete reads the row it removes: purge and sweep up to 700 rows plus the
 *          workspace cleanup of a turned off workspace, up to purgePerPass); writes per indexed attachment its
 *          FTS rows, about 1 per 2 KB of text plus a few (a 200 KB document is about 100), at most
 *          submitPerPass + localPerPass + inFlightMax documents a pass, so at most about 2,000; deletes about
 *          the same per document removed.
 * The report a pass returns counts what it did so the scheduled handler can log it.
 *
 * Nothing here runs on a request path except the Files and settings routes and the search group: a search is
 * one FTS statement in the index database and one lookup of the hits' rows in the main database.
 */
import { sql } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import type { Deps } from "../../context";
/** The two databases the index uses. Deletes work without the index database (nothing to delete there). */
export type IndexDbs = Pick<Deps, "db" | "indexDb">;
import type { DB } from "../../db";
import { inIds } from "../../lib/sql-chunks";
import { attachmentBytes } from "../mail/store";
import { writeBudget } from "../write-budget";
import { engineFetch, type EngineConfig } from "./engine-client";
import { classifyAttachment } from "./attachment-classify";
import { ATTACHMENT_FOLDERS, ATTACHMENT_FOLDER_LABELS, INDEX_OCR_LANGS, type AttachmentFolder, type FileFolderCount } from "@/shared/attachment-folders";

// ---------------------------------------------------------------- limits (one place)

export const INDEX_LIMITS = {
  /** Rows of attachments looked at per pass, new mail first, then older mail. */
  scanPerPass: 100,
  /** Engine extract-text jobs started per pass. */
  submitPerPass: 4,
  /** Engine jobs running at once for the indexer, all workspaces (the engine also serves people). */
  inFlightMax: 6,
  /** Text, Word and Excel files read on the Worker per pass. */
  localPerPass: 10,
  /** Index rows checked for deleted attachments per pass (2 reads each; 50,000 indexed attachments are covered about once a day). */
  sweepPerPass: 500,
  /** Index rows deleted per pass for workspaces that turned indexing off (more go at once from Settings). */
  purgePerPass: 200,
  /** Attachments read per workspace per UTC day. */
  dailyPerWorkspace: 300,
  /** Attachments read per UTC day, all workspaces. */
  dailyGlobal: 3000,
  /** Larger files are skipped (OCR of big scans is slow on the engine). */
  maxEngineBytes: 15 * 1024 * 1024,
  maxLocalBytes: 5 * 1024 * 1024,
  /** Characters of text kept per attachment (about 200 KB). */
  textCap: 200_000,
  /** Stop while the account's D1 reads today are at or past this percent of the daily read budget (the mail backfill stops at 40). */
  readStopPct: 30,
  /** Stop while D1 writes today are at or past this percent of the write budget. */
  writeStopPct: 30,
  /** An engine job not done after this is given up (engine jobs expire within an hour). */
  jobTimeoutMs: 50 * 60_000,
  /** Engine attempts per attachment. */
  maxTries: 2,
  /** Rows deleted at once when an admin turns indexing off (the rest go with the next passes). */
  purgeNow: 500,
} as const;

export const ENGINE_EXT = new Set(["pdf", "jpg", "jpeg", "png", "tif", "tiff", "webp"]);
export const LOCAL_EXT = new Set(["txt", "csv", "md", "docx", "xlsx"]);
const SKIP_FOLDERS = new Set(["trash", "spam", "drafts"]);

export const extOf = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "").toLowerCase();
export function readableKind(filename: string): "engine" | "local" | null {
  const e = extOf(filename);
  if (ENGINE_EXT.has(e)) return "engine";
  if (LOCAL_EXT.has(e)) return "local";
  return null;
}

/** FTS tokens for a workspace and a mailbox: letters and digits only, so the tokenizer keeps each id whole. */
export const orgToken = (id: string) => `o${id.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
export const mailboxToken = (id: string) => `m${id.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
const scopeOf = (orgId: string, mailboxId: string) => `${orgToken(orgId)} ${mailboxToken(mailboxId)}`;

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------- stop flags

export type IndexStop = "feature_off" | "no_index_db" | "tools_off" | "no_engine" | "d1_reads" | "d1_writes" | "d1_level" | "d1_unknown";

/**
 * Why the indexer must not run now, or null. The D1 reading is the one /api/health shows (services/write-budget,
 * cached a minute per isolate). In production an unknown reading (no analytics token) also stops it.
 */
export async function indexStop(deps: Deps): Promise<IndexStop | null> {
  const t = deps.config.tools;
  if (!t.features.includes("index")) return "feature_off";
  if (!deps.indexDb) return "no_index_db";
  if (!t.enabled) return "tools_off";
  if (!t.engine) return "no_engine";
  const r = await writeBudget(deps);
  if (r.level === "off") return deps.config.mode === "production" ? "d1_unknown" : null;
  if (r.level === "warn" || r.level === "shed") return "d1_level";
  if (r.budget > 0 && (r.rowsWritten / r.budget) * 100 >= INDEX_LIMITS.writeStopPct) return "d1_writes";
  const readsDaily = deps.config.writeBudget.readsDaily;
  if (typeof r.rowsRead !== "number") return deps.config.mode === "production" ? "d1_unknown" : null;
  if (readsDaily > 0 && (r.rowsRead / readsDaily) * 100 >= INDEX_LIMITS.readStopPct) return "d1_reads";
  return null;
}

// ---------------------------------------------------------------- text extraction on the Worker

const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16))).replace(/&amp;/g, "&");

/** Text of a .txt/.csv/.md, .docx or .xlsx file, or null when it cannot be read. Bounded by textCap. */
export function extractLocal(filename: string, bytes: Uint8Array): string | null {
  const e = extOf(filename);
  const cap = INDEX_LIMITS.textCap;
  try {
    if (e === "txt" || e === "csv" || e === "md") return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, cap * 4)).slice(0, cap);
    if (e === "docx") {
      const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" && f.originalSize < 20 * 1024 * 1024 });
      const xml = files["word/document.xml"];
      if (!xml) return null;
      const s = strFromU8(xml).replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, " ");
      const out: string[] = [];
      let n = 0;
      for (const m of s.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|\n/g)) {
        const piece = m[0] === "\n" ? "\n" : decodeXml(m[1]);
        out.push(piece); n += piece.length;
        if (n >= cap) break;
      }
      return out.join("").replace(/\n{3,}/g, "\n\n").slice(0, cap);
    }
    if (e === "xlsx") {
      const files = unzipSync(bytes, { filter: (f) => (f.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name)) && f.originalSize < 20 * 1024 * 1024 });
      const out: string[] = [];
      let n = 0;
      for (const name of Object.keys(files).sort()) {
        for (const m of strFromU8(files[name]).matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) {
          const v = decodeXml(m[1]); out.push(v); n += v.length + 1;
          if (n >= cap) break;
        }
        if (n >= cap) break;
      }
      return out.join("\n").slice(0, cap);
    }
  } catch {
    return null;
  }
  return null;
}

/** The engine's extract-text answer as one text (pages joined) and the OCR page count. */
export function textFromEngine(json: unknown): { text: string; pagesOcr: number } {
  const pages = (json as { pages?: { page?: number; text?: string; ocr?: boolean }[] } | null)?.pages;
  if (!Array.isArray(pages)) return { text: "", pagesOcr: 0 };
  let text = "";
  let pagesOcr = 0;
  for (const p of pages) {
    if (p?.ocr) pagesOcr++;
    if (typeof p?.text === "string" && text.length < INDEX_LIMITS.textCap) text += (text ? "\n\f\n" : "") + p.text;
  }
  return { text: text.slice(0, INDEX_LIMITS.textCap), pagesOcr };
}

// ---------------------------------------------------------------- index writes

/** What the index database row of an attachment_text row carries besides the text. */
export interface IndexRowRef { id: number; filename: string; attachment_id: string; org_id: string; mailbox_id: string }

/**
 * Writes one row's folder and state in the main database, then its text in the index database. The main row
 * turns done first (only while it is still queued or pending, so a row purged meanwhile gets no text); when the
 * text cannot be written the row is marked failed again.
 */
export async function writeIndexed(dbs: IndexDbs, row: IndexRowRef, text: string, pagesOcr: number, now: Date) {
  const indexDb = dbs.indexDb;
  if (!indexDb) throw new Error("no_index_db");
  const body = text.split(String.fromCharCode(0)).join("").slice(0, INDEX_LIMITS.textCap);
  const cls = classifyAttachment({ filename: row.filename, text: body });
  const n = now.getTime();
  const done = await dbs.db.all<{ id: number }>(sql`update attachment_text set status = 'done', chars = ${body.length}, pages_ocr = ${pagesOcr},
    class = case when class_manual = 1 then class else ${cls} end, job_id = null, indexed_at = ${n}, updated_at = ${n}
    where id = ${row.id} and status in ('queued', 'pending') returning id`);
  if (!done.length) return;
  try {
    await indexDb.run(sql`delete from attachment_fts where rowid = ${row.id}`);
    await indexDb.run(sql`insert into attachment_fts (rowid, text, scope, attachment_id, org_id, mailbox_id)
      values (${row.id}, ${body}, ${scopeOf(row.org_id, row.mailbox_id)}, ${row.attachment_id}, ${row.org_id}, ${row.mailbox_id})`);
  } catch (err) {
    await dbs.db.run(sql`update attachment_text set status = 'failed', updated_at = ${n} where id = ${row.id}`);
    throw err;
  }
}

/** Deletes rows from both databases: their text from the index database first, then the main rows. */
export async function dropIndexRows(dbs: IndexDbs, ids: number[]) {
  if (!ids.length) return;
  const list = JSON.stringify(ids);
  if (dbs.indexDb) await dbs.indexDb.run(sql`delete from attachment_fts where rowid in (select value from json_each(${list}))`);
  await dbs.db.run(sql`delete from attachment_text where id in (select value from json_each(${list}))`);
}

// ---------------------------------------------------------------- settings

export interface IndexSettings { on: boolean; lang: string }
const COUNTS_TTL_MS = 5 * 60_000;
const countsCache = new Map<string, { at: number; rows: { mailbox_id: string; status: string; class: string | null; n: number }[] }>();
export function forgetIndexCounts(orgId?: string) { if (orgId) countsCache.delete(orgId); else countsCache.clear(); }

export async function readIndexSettings(db: DB, orgId: string): Promise<IndexSettings> {
  const r = await db.get<{ mode: string | null; lang: string }>(sql`select mode, lang from attachment_index_state where org_id = ${orgId}`);
  return { on: r?.mode !== "off", lang: r?.lang ?? "eng" };
}

/**
 * Turns indexing on or off for a workspace, or sets its OCR language. Off deletes the index: the first
 * purgeNow rows at once, the rest with the next cron passes (the workspace sees none of it from now on).
 * On again rewinds the indexer's backfill cursor so older attachments are read again over the next days.
 */
export async function writeIndexSettings(dbs: IndexDbs, orgId: string, next: Partial<IndexSettings>, now: Date): Promise<IndexSettings & { purged: number }> {
  const db = dbs.db;
  const cur = await readIndexSettings(db, orgId);
  const on = next.on ?? cur.on;
  const lang = next.lang && INDEX_OCR_LANGS.some((l) => l.id === next.lang) ? next.lang : cur.lang;
  const n = now.getTime();
  await db.run(sql`insert into attachment_index_state (org_id, mode, lang, updated_at) values (${orgId}, ${on ? "on" : "off"}, ${lang}, ${n})
    on conflict (org_id) do update set mode = excluded.mode, lang = excluded.lang, updated_at = excluded.updated_at`);
  let purged = 0;
  if (!on && cur.on) purged = await purgeOrg(dbs, orgId, INDEX_LIMITS.purgeNow);
  if (on && !cur.on) {
    const top = await db.get<{ m: number | null }>(sql`select max(rowid) as m from attachments`);
    await db.run(sql`update attachment_index_state set lo = ${Number(top?.m ?? 0) + 1}, updated_at = ${n} where org_id = '*'`);
  }
  forgetIndexCounts(orgId);
  return { on, lang, purged };
}

/**
 * Deletes up to `limit` rows of a workspace from both databases. Once its main rows are all gone, any text left
 * in the index database for the workspace (a write that failed half way) goes too, found through the
 * workspace token inside the index. Answers how many main rows went.
 */
export async function purgeOrg(dbs: IndexDbs, orgId: string, limit: number): Promise<number> {
  const rows = await dbs.db.all<{ id: number }>(sql`select id from attachment_text where org_id = ${orgId} limit ${limit}`);
  await dropIndexRows(dbs, rows.map((r) => Number(r.id)));
  const left = limit - rows.length;
  if (left > 0 && dbs.indexDb) {
    await dbs.indexDb.run(sql`delete from attachment_fts where rowid in (select rowid from attachment_fts where attachment_fts match ${`scope : "${orgToken(orgId)}"`} limit ${left})`);
  }
  return rows.length;
}

// ---------------------------------------------------------------- the cron pass

export interface IndexPassReport {
  stop: IndexStop | null; purged: number; swept: number; collected: number; failed: number;
  scanned: number; queued: number; submitted: number; local: number; skippedCap: number; engineBusy: boolean;
}

interface StateRow { org_id: string; mode: string | null; lang: string; day: string; n: number; hi: number; lo: number; sw: number }

/** One cron pass. Never throws (a failure is logged and the next pass carries on). */
export async function runIndexPass(deps: Deps): Promise<IndexPassReport> {
  const rep: IndexPassReport = { stop: null, purged: 0, swept: 0, collected: 0, failed: 0, scanned: 0, queued: 0, submitted: 0, local: 0, skippedCap: 0, engineBusy: false };
  try {
    rep.stop = await indexStop(deps);
    if (rep.stop) return rep;
    await pass(deps, rep);
  } catch (err) {
    deps.log?.warn("tools.index_pass_failed", { error: err instanceof Error ? err.message : String(err) });
    deps.reportError?.(err, { where: "tools.index_pass" });
  }
  if (rep.collected || rep.queued || rep.submitted || rep.local || rep.purged || rep.swept) deps.log?.info?.("tools.index_pass", { ...rep });
  return rep;
}

async function pass(deps: Deps, rep: IndexPassReport) {
  const db = deps.db;
  const L = INDEX_LIMITS;
  const now = deps.now();
  const day = dayOf(now);
  const engine = deps.config.tools.engine as EngineConfig;

  // Cursors and every workspace that turned indexing off (a small table: one row per workspace that ever changed it).
  let star = await db.get<StateRow>(sql`select org_id, mode, lang, day, n, hi, lo, sw from attachment_index_state where org_id = '*'`);
  const offRows = await db.all<{ org_id: string }>(sql`select org_id from attachment_index_state where mode = 'off' and org_id != '*' limit 20`);
  if (!star) {
    const top = await db.get<{ m: number | null }>(sql`select max(rowid) as m from attachments`);
    const m = Number(top?.m ?? 0);
    star = { org_id: "*", mode: null, lang: "eng", day, n: 0, hi: m, lo: m + 1, sw: 0 };
    await db.run(sql`insert into attachment_index_state (org_id, day, n, hi, lo, sw, updated_at) values ('*', ${day}, 0, ${m}, ${m + 1}, 0, ${now.getTime()}) on conflict (org_id) do nothing`);
  }
  if (star.day !== day) { star.day = day; star.n = 0; }
  const offOrgs = new Set(offRows.map((r) => r.org_id));

  // 2. Purge the index of workspaces that turned it off.
  let purgeLeft = L.purgePerPass;
  for (const orgId of offOrgs) {
    if (purgeLeft <= 0) break;
    const n = await purgeOrg(deps, orgId, purgeLeft);
    rep.purged += n; purgeLeft -= n;
  }

  // 3. Sweep: rows whose attachment is gone (its message was deleted) lose their text and index rows.
  const sweep = await db.all<{ id: number; gone: number }>(sql`select t.id as id, (a.id is null) as gone from attachment_text t
    left join attachments a on a.id = t.attachment_id where t.id > ${star.sw} order by t.id limit ${L.sweepPerPass}`);
  const gone = sweep.filter((r) => Number(r.gone) === 1).map((r) => Number(r.id));
  if (gone.length) { await dropIndexRows(deps, gone); rep.swept = gone.length; }
  star.sw = sweep.length < L.sweepPerPass ? 0 : Number(sweep[sweep.length - 1].id);

  // 4. Collect finished engine jobs.
  const pending = await db.all<PendingRow>(sql`
    select id, attachment_id, org_id, mailbox_id, job_id, filename, tries, updated_at from attachment_text where status = 'pending' order by msg_date desc limit ${L.inFlightMax + 2}`);
  let inFlight = pending.length;
  for (const p of pending) {
    if (!p.job_id) { await requeueOrFail(db, p, now); inFlight--; continue; }
    const done = await collectJob(deps, engine, p, now).catch((err) => { deps.log?.warn("tools.index_collect_failed", { error: err instanceof Error ? err.message : String(err) }); return "wait" as const; });
    if (done === "done") { rep.collected++; inFlight--; }
    else if (done === "failed") { rep.failed++; inFlight--; }
    else if (done === "busy") { rep.engineBusy = true; break; }
  }

  // 5. Walk attachments: new mail above hi, then older mail below lo. Only rows not yet in the index.
  const orgCache = new Map<string, { toolsOff: boolean; state: StateRow | null }>();
  const candidates: Cand[] = [];
  const newer = await db.all<CandRow>(sql`select a.rowid as r, a.id as id, a.message_id as message_id, a.filename as filename, a.size_bytes as size_bytes,
      (a.content_b64 is not null or a.storage_key is not null) as avail, m.org_id as org_id, m.mailbox_id as mailbox_id, m.folder as folder, m.date as date,
      (t.id is not null) as known
    from attachments a cross join messages m on m.id = a.message_id left join attachment_text t on t.attachment_id = a.id
    where a.rowid > ${star.hi} order by a.rowid asc limit ${L.scanPerPass}`);
  rep.scanned += newer.length;
  if (newer.length) star.hi = Number(newer[newer.length - 1].r);
  candidates.push(...newer.map(toCand));
  const room = L.scanPerPass - newer.length;
  if (room > 0 && star.lo > 1) {
    const older = await db.all<CandRow>(sql`select a.rowid as r, a.id as id, a.message_id as message_id, a.filename as filename, a.size_bytes as size_bytes,
        (a.content_b64 is not null or a.storage_key is not null) as avail, m.org_id as org_id, m.mailbox_id as mailbox_id, m.folder as folder, m.date as date,
        (t.id is not null) as known
      from attachments a cross join messages m on m.id = a.message_id left join attachment_text t on t.attachment_id = a.id
      where a.rowid < ${star.lo} order by a.rowid desc limit ${room}`);
    rep.scanned += older.length;
    star.lo = older.length < room ? 1 : Number(older[older.length - 1].r);
    candidates.push(...older.map(toCand));
  }
  const fresh = candidates.filter((c) => !c.known && c.avail && !SKIP_FOLDERS.has(c.folder) && readableKind(c.filename) !== null && c.size > 0
    && c.size <= (readableKind(c.filename) === "engine" ? L.maxEngineBytes : L.maxLocalBytes));
  await loadOrgs(db, orgCache, fresh.map((c) => c.orgId));
  const toQueue = fresh.filter((c) => { const o = orgCache.get(c.orgId); return o && !o.toolsOff && o.state?.mode !== "off"; });
  const n = now.getTime();
  for (let i = 0; i < toQueue.length; i += 10) {
    const part = toQueue.slice(i, i + 10);
    await db.run(sql`insert into attachment_text (attachment_id, org_id, mailbox_id, message_id, msg_date, filename, size_bytes, updated_at) values
      ${sql.join(part.map((c) => sql`(${c.id}, ${c.orgId}, ${c.mailboxId}, ${c.messageId}, ${c.date}, ${c.filename.slice(0, 255)}, ${c.size}, ${n})`), sql`, `)}
      on conflict (attachment_id) do nothing`);
    rep.queued += part.length;
  }

  // 6. Read queued attachments, newest first, within the daily caps.
  const queued = await db.all<{ id: number; attachment_id: string; org_id: string; mailbox_id: string; filename: string; tries: number; updated_at: number }>(sql`
    select id, attachment_id, org_id, mailbox_id, filename, tries, updated_at from attachment_text where status = 'queued' order by msg_date desc limit 40`);
  await loadOrgs(db, orgCache, queued.map((q) => q.org_id));
  const touched = new Set<string>();
  let engineOpen = !rep.engineBusy;
  for (const q of queued) {
    if (star.n >= L.dailyGlobal) { rep.skippedCap++; break; }
    const o = orgCache.get(q.org_id);
    if (!o || o.toolsOff || o.state?.mode === "off") continue;
    const st = o.state ?? { org_id: q.org_id, mode: null, lang: "eng", day, n: 0, hi: 0, lo: 0, sw: 0 };
    if (st.day !== day) { st.day = day; st.n = 0; }
    o.state = st;
    if (st.n >= L.dailyPerWorkspace) { rep.skippedCap++; continue; }
    const kind = readableKind(q.filename);
    if (kind === "local" && rep.local >= L.localPerPass) continue;
    if (kind === "engine" && (!engineOpen || rep.submitted >= L.submitPerPass || inFlight >= L.inFlightMax)) continue;
    if (rep.local >= L.localPerPass && (!engineOpen || rep.submitted >= L.submitPerPass || inFlight >= L.inFlightMax)) break;
    const a = await db.get<{ content_b64: string | null; storage_key: string | null }>(sql`select content_b64, storage_key from attachments where id = ${q.attachment_id}`);
    if (!a) { await dropIndexRows(deps, [Number(q.id)]); continue; }
    const bytes = await attachmentBytes({ contentB64: a.content_b64, storageKey: a.storage_key }, deps.bodyStore).catch(() => null);
    if (!bytes) { await db.run(sql`update attachment_text set status = 'skipped', updated_at = ${n} where id = ${q.id}`); continue; }
    st.n++; star.n++; touched.add(q.org_id);
    if (kind === "local") {
      const text = extractLocal(q.filename, bytes);
      if (text === null) await db.run(sql`update attachment_text set status = 'failed', updated_at = ${n} where id = ${q.id}`);
      else await writeIndexed(deps, { id: Number(q.id), filename: q.filename, attachment_id: q.attachment_id, org_id: q.org_id, mailbox_id: q.mailbox_id }, text, 0, now);
      rep.local++;
      continue;
    }
    const started = await submitJob(deps, engine, q, bytes, st.lang);
    if (started === "busy") { engineOpen = false; rep.engineBusy = true; st.n--; star.n--; continue; }
    if (started === "failed") { await db.run(sql`update attachment_text set status = 'failed', tries = tries + 1, updated_at = ${n} where id = ${q.id}`); rep.failed++; continue; }
    await db.run(sql`update attachment_text set status = 'pending', job_id = ${started}, tries = tries + 1, updated_at = ${n} where id = ${q.id} and status = 'queued'`);
    rep.submitted++; inFlight++;
  }

  // State: the cursors and today's counts, one statement for "*" and one per workspace touched.
  await db.run(sql`update attachment_index_state set day = ${star.day}, n = ${star.n}, hi = ${star.hi}, lo = ${star.lo}, sw = ${star.sw}, updated_at = ${n} where org_id = '*'`);
  for (const orgId of touched) {
    const st = orgCache.get(orgId)!.state!;
    await db.run(sql`insert into attachment_index_state (org_id, day, n, updated_at) values (${orgId}, ${st.day}, ${st.n}, ${n})
      on conflict (org_id) do update set day = excluded.day, n = excluded.n, updated_at = excluded.updated_at`);
  }
  if (rep.collected || rep.local || rep.purged || rep.swept) forgetIndexCounts();
}

interface PendingRow { id: number; attachment_id: string; org_id: string; mailbox_id: string; job_id: string | null; filename: string; tries: number; updated_at: number }
interface CandRow { r: number; id: string; message_id: string; filename: string; size_bytes: number; avail: number; org_id: string; mailbox_id: string; folder: string; date: number; known: number }
interface Cand { id: string; messageId: string; filename: string; size: number; avail: boolean; orgId: string; mailboxId: string; folder: string; date: number; known: boolean }
const toCand = (r: CandRow): Cand => ({
  id: r.id, messageId: r.message_id, filename: r.filename, size: Number(r.size_bytes), avail: Number(r.avail) === 1, orgId: r.org_id, mailboxId: r.mailbox_id,
  folder: r.folder, date: Number(r.date), known: Number(r.known) === 1,
});

/** Tools switch and index state for the workspaces not loaded yet, in one statement. */
async function loadOrgs(db: DB, cache: Map<string, { toolsOff: boolean; state: StateRow | null }>, ids: string[]) {
  const want = [...new Set(ids)].filter((id) => !cache.has(id));
  if (!want.length) return;
  const rows = await db.all<{ id: string; tools_mode: string | null; mode: string | null; lang: string | null; day: string | null; n: number | null }>(sql`
    select o.id as id, o.tools_mode as tools_mode, s.mode as mode, s.lang as lang, s.day as day, s.n as n
    from organizations o left join attachment_index_state s on s.org_id = o.id where ${inIds(sql`o.id`, want)}`);
  for (const r of rows) {
    cache.set(r.id, { toolsOff: r.tools_mode === "off", state: r.day === null && r.mode === null && r.lang === null ? null
      : { org_id: r.id, mode: r.mode, lang: r.lang ?? "eng", day: r.day ?? "", n: Number(r.n ?? 0), hi: 0, lo: 0, sw: 0 } });
  }
}

async function requeueOrFail(db: DB, p: { id: number; tries: number }, now: Date) {
  const next = p.tries >= INDEX_LIMITS.maxTries ? "failed" : "queued";
  await db.run(sql`update attachment_text set status = ${next}, job_id = null, updated_at = ${now.getTime()} where id = ${p.id} and status = 'pending'`);
}

// Semgrep (QUAL1): a label for the indexer in the activity log, not a login.
const INDEX_USER = "indexer"; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username

/** Starts one engine extract-text job. Answers its id, "busy" (engine full or down: try later) or "failed" (the engine refused this file). */
async function submitJob(deps: Deps, engine: EngineConfig, q: { org_id: string; filename: string }, bytes: Uint8Array, lang: string): Promise<string | "busy" | "failed"> {
  const fd = new FormData();
  fd.append("files", new Blob([bytes as Uint8Array<ArrayBuffer>]), q.filename.replace(/[\r\n"]/g, " ").slice(0, 200) || "file");
  fd.append("ocr", "auto");
  fd.append("language", lang || "eng");
  const req = new Request("http://local/x", { method: "POST", body: fd });
  const body = new Uint8Array(await req.arrayBuffer());
  let res: Response;
  try {
    res = await engineFetch(deps.fetch, engine, {
      method: "POST", path: "/internal/v1/jobs?op=extract-text", ws: q.org_id, user: INDEX_USER, maxBytes: body.byteLength,
      body: new Blob([body]).stream(), contentLength: body.byteLength, contentType: req.headers.get("content-type") ?? "multipart/form-data",
    });
  } catch {
    return "busy";
  }
  if (res.status === 429 || res.status >= 500) { await res.body?.cancel().catch(() => undefined); return "busy"; }
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); return "failed"; }
  const j = (await res.json().catch(() => null)) as { id?: string } | null;
  return j?.id && /^[A-Za-z0-9_-]{6,80}$/.test(j.id) ? j.id : "failed";
}

/** Checks one running job: writes the text when it is done. */
async function collectJob(deps: Deps, engine: EngineConfig, p: PendingRow, now: Date): Promise<"done" | "failed" | "wait" | "busy"> {
  const call = (path: string) => engineFetch(deps.fetch, engine, { method: "GET", path, ws: p.org_id, user: INDEX_USER, maxBytes: 0 });
  let res: Response;
  try { res = await call(`/internal/v1/jobs/${p.job_id}`); } catch { return "busy"; }
  if (res.status === 404) { await requeueOrFail(deps.db, p, now); return "failed"; }
  if (res.status === 429 || res.status >= 500) { await res.body?.cancel().catch(() => undefined); return "busy"; }
  const j = (await res.json().catch(() => null)) as { status?: string } | null;
  const status = j?.status ?? "";
  if (status === "done") {
    const out = await call(`/internal/v1/jobs/${p.job_id}/output`);
    if (!out.ok) { await out.body?.cancel().catch(() => undefined); await requeueOrFail(deps.db, p, now); return "failed"; }
    const { text, pagesOcr } = textFromEngine(await out.json().catch(() => null));
    await writeIndexed(deps, { id: Number(p.id), filename: p.filename, attachment_id: p.attachment_id, org_id: p.org_id, mailbox_id: p.mailbox_id }, text, pagesOcr, now);
    // The engine deletes job files within the hour anyway; asking now frees its disk sooner.
    await engineFetch(deps.fetch, engine, { method: "DELETE", path: `/internal/v1/jobs/${p.job_id}`, ws: p.org_id, user: INDEX_USER, maxBytes: 0 }).then((r) => r.body?.cancel()).catch(() => undefined);
    return "done";
  }
  if (status === "failed" || status === "error" || status === "expired") {
    await deps.db.run(sql`update attachment_text set status = 'failed', job_id = null, updated_at = ${now.getTime()} where id = ${p.id}`);
    return "failed";
  }
  if (now.getTime() - Number(p.updated_at) > INDEX_LIMITS.jobTimeoutMs) { await requeueOrFail(deps.db, p, now); return "failed"; }
  return "wait";
}

// ---------------------------------------------------------------- reads for the Files view and search

/** Folder counts for the mailboxes a caller can open (null scope = every mailbox), from one grouped statement cached per workspace. */
export async function folderCounts(db: DB, orgId: string, scope: string[] | null, nowMs = Date.now()): Promise<{ folders: FileFolderCount[]; indexed: number; waiting: number }> {
  let c = countsCache.get(orgId);
  if (!c || nowMs - c.at > COUNTS_TTL_MS) {
    const rows = await db.all<{ mailbox_id: string; status: string; class: string | null; n: number }>(sql`
      select mailbox_id, status, class, count(*) as n from attachment_text where org_id = ${orgId} group by status, mailbox_id, class`);
    c = { at: nowMs, rows };
    if (countsCache.size > 500) countsCache.clear();
    countsCache.set(orgId, c);
  }
  const allowed = scope ? new Set(scope) : null;
  const by = new Map<AttachmentFolder, number>();
  let indexed = 0, waiting = 0;
  for (const r of c.rows) {
    if (allowed && !allowed.has(r.mailbox_id)) continue;
    const n = Number(r.n);
    if (r.status === "done") { indexed += n; const k = (ATTACHMENT_FOLDERS as readonly string[]).includes(r.class ?? "") ? (r.class as AttachmentFolder) : "other"; by.set(k, (by.get(k) ?? 0) + n); }
    else if (r.status === "queued" || r.status === "pending") waiting += n;
  }
  return { folders: ATTACHMENT_FOLDERS.map((id) => ({ id, label: ATTACHMENT_FOLDER_LABELS[id], count: by.get(id) ?? 0 })), indexed, waiting };
}

/** Words of a search for MATCH: letters, digits and marks only, each quoted; the last one also matches as a prefix. */
export function ftsWords(term: string): string[] {
  return (term.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).slice(0, 8);
}

/** The MATCH expression: the workspace token, the caller's mailbox tokens (when the scope is short) and the words. */
export function ftsMatch(orgId: string, scope: string[] | null, words: string[]): string {
  const body = words.map((w, i) => `"${w}"${i === words.length - 1 && w.length >= 2 ? "*" : ""}`).join(" ");
  const parts = [`scope : "${orgToken(orgId)}"`];
  if (scope && scope.length <= 40) parts.push(`scope : (${scope.map((m) => `"${mailboxToken(m)}"`).join(" OR ")})`);
  parts.push(`text : (${body})`);
  return parts.join(" AND ");
}

export interface AttachmentHit {
  attachment_id: string; filename: string; size_bytes: number; class: string | null; class_manual: number; snip: string | null;
  message_id: string; thread_id: string; mailbox_id: string; folder: string; subject: string; from_name: string; from_address: string; date: number;
}

/**
 * Full text search over the attachments a caller can open. One FTS statement in the index database: the
 * workspace and mailbox tokens are part of the MATCH (so the index never walks another workspace's rows) and
 * org_id and mailbox_id are then compared exactly (mailbox_id in the caller's scope). Then one lookup of the
 * hits' rows in the main database, which checks the scope again on the row exactly as mail search does, leaves
 * out trash and removed messages, and drops a hit whose attachment or mailbox does not match its row. Nothing
 * when the workspace switched Tools off or there is no index database.
 */
export async function searchAttachmentText(dbs: IndexDbs, orgId: string, scope: string[] | null, term: string, opts: { limit: number; folder?: AttachmentFolder; beforeId?: number }): Promise<(AttachmentHit & { id: number })[]> {
  const indexDb = dbs.indexDb;
  if (!indexDb) return [];
  if (scope && !scope.length) return [];
  const words = ftsWords(term);
  if (!words.length) return [];
  const match = ftsMatch(orgId, scope, words);
  const inner = Math.min(200, opts.limit * (scope && scope.length > 40 ? 8 : 3) * (opts.folder ? 2 : 1));
  const hits = await indexDb.all<{ id: number; attachment_id: string; mailbox_id: string; snip: string | null }>(sql`
    select rowid as id, attachment_id, mailbox_id, snippet(attachment_fts, 0, '', '', '...', 16) as snip from attachment_fts
    where attachment_fts match ${match} and org_id = ${orgId}
      ${scope ? sql`and ${inIds(sql`mailbox_id`, scope)}` : sql``}
      ${opts.beforeId ? sql`and rowid < ${opts.beforeId}` : sql``}
    order by rowid desc limit ${inner}`);
  if (!hits.length) return [];
  const rows = await dbs.db.all<AttachmentHit & { id: number }>(sql`
    select t.id as id, t.attachment_id as attachment_id, t.filename as filename, t.size_bytes as size_bytes, t.class as class, t.class_manual as class_manual, null as snip,
      m.id as message_id, m.thread_id as thread_id, t.mailbox_id as mailbox_id, m.folder as folder, m.subject as subject, m.from_name as from_name, m.from_address as from_address, m.date as date
    from attachment_text t
    join attachments a on a.id = t.attachment_id
    join messages m on m.id = t.message_id
    where t.id in (select value from json_each(${JSON.stringify(hits.map((h) => Number(h.id)))}))
      and t.org_id = ${orgId} and t.status = 'done' and m.org_id = ${orgId} and m.folder != 'trash'
      ${scope ? sql`and ${inIds(sql`t.mailbox_id`, scope)}` : sql``}
      ${opts.folder ? sql`and coalesce(t.class, 'other') = ${opts.folder}` : sql``}
      and exists (select 1 from organizations o where o.id = ${orgId} and (o.tools_mode is null or o.tools_mode != 'off'))`);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const out: (AttachmentHit & { id: number })[] = [];
  for (const h of hits) {
    const r = byId.get(Number(h.id));
    if (!r || r.attachment_id !== h.attachment_id || r.mailbox_id !== h.mailbox_id) continue;
    out.push({ ...r, id: Number(r.id), snip: h.snip });
    if (out.length >= opts.limit) break;
  }
  return out;
}

/** One folder's attachments, newest first, for the mailboxes a caller can open. Keyset paging on (msg_date, id). */
export async function listFolder(db: DB, orgId: string, scope: string[] | null, folder: AttachmentFolder, opts: { limit: number; before?: { date: number; id: number } }): Promise<(AttachmentHit & { id: number })[]> {
  if (scope && !scope.length) return [];
  return db.all<AttachmentHit & { id: number }>(sql`
    select t.id as id, t.attachment_id as attachment_id, t.filename as filename, t.size_bytes as size_bytes, t.class as class, t.class_manual as class_manual, null as snip,
      m.id as message_id, m.thread_id as thread_id, m.mailbox_id as mailbox_id, m.folder as folder, m.subject as subject, m.from_name as from_name, m.from_address as from_address, t.msg_date as date
    from attachment_text t
    join attachments a on a.id = t.attachment_id
    join messages m on m.id = t.message_id
    where t.org_id = ${orgId} and t.class = ${folder} and t.status = 'done' and m.folder != 'trash'
      ${scope ? sql`and ${inIds(sql`t.mailbox_id`, scope)}` : sql``}
      ${opts.before ? sql`and (t.msg_date < ${opts.before.date} or (t.msg_date = ${opts.before.date} and t.id < ${opts.before.id}))` : sql``}
    order by t.msg_date desc, t.id desc limit ${opts.limit}`);
}

/** A person moves an attachment to another folder; the rules leave it there from then on. Answers false when it is not in the caller's scope. */
export async function moveToFolder(db: DB, orgId: string, scope: string[] | null, attachmentId: string, folder: AttachmentFolder, now: Date): Promise<boolean> {
  const row = await db.get<{ id: number; mailbox_id: string }>(sql`select id, mailbox_id from attachment_text where attachment_id = ${attachmentId} and org_id = ${orgId} and status = 'done'`);
  if (!row || (scope && !scope.includes(row.mailbox_id))) return false;
  await db.run(sql`update attachment_text set class = ${folder}, class_manual = 1, updated_at = ${now.getTime()} where id = ${row.id}`);
  forgetIndexCounts(orgId);
  return true;
}

