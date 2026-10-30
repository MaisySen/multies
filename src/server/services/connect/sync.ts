/**
 * Syncing a connected mailbox (round 18).
 *
 * One pass, per connection: apply read, star and move changes made in Multies at the provider, copy
 * new mail from Inbox and Sent, and pull read and star changes made elsewhere for recent Inbox mail.
 *
 * The D1 account has 100,000 rows written a day, shared by production and staging, so a pass is cheap
 * by construction:
 * - Each folder keeps a UIDVALIDITY and last UID cursor; only UIDs above it are fetched.
 * - Messages already stored (same Message-ID in the mailbox, for example a reply sent from Multies)
 *   are skipped with one indexed read per batch.
 * - At most `batch` messages a pass and `dailyCap` a day per connection; the first sync takes the
 *   last `initialDays` days, at most `initialCap` per folder.
 * - All rows of a pass go to the database in one batch (one round trip on D1).
 * - Nothing runs while the write budget reads warn or shed.
 * - Flag changes from the provider write only the rows that changed.
 */
import { and, asc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { runBatch } from "../../db";
import { attachments, mailboxes, mailConnections, mailSyncOutbox, messages } from "../../db/schema";
import { newId, toB64 } from "../../lib/crypto";
import { makeSnippet, parseMime, type ParsedEmail } from "../mail/mime";
import { MAX_INLINE_ATTACHMENT_BYTES } from "../mail/store";
import { PENDING_FROM } from "../mail/pending-from";
import { writeBudget } from "../write-budget";
import { connectionSecret, imapConnector, type Connection } from ".";
import { classifyProblem } from "./problems";
import { headerEnd, pickFolders, type FetchedMessage, type FolderPaths, type ImapSession, type RemoteFolder } from "./imap";
import type { Folder } from "@/shared/mail";
import type { ConnectPresetId } from "@/shared/mail-connect";
import { inIds } from "../../lib/sql-chunks";

interface FolderState {
  path: string; v: string; last: number;
  /**
   * R52: the folder as last read in full for flags: "<modseq>:<exists>:<uidNext>:<last>". When the server keeps
   * CONDSTORE mod-sequences and all four are the same at the next pass, nothing in the folder changed (a flag change
   * moves the modseq, an expunge moves the count, new mail moves the next UID), so the pass reads no flags for it.
   */
  f?: string;
  /**
   * R57 full history backfill: the lowest UID stored from this folder. UIDs below it are older mail still to copy,
   * walked downward, newest first. `left` is how many were below it at the last pass; `done` once none are.
   * A UIDVALIDITY change starts the folder again (new cursor, new `low`); Message-ID dedupe keeps that from doubling mail.
   */
  low?: number;
  left?: number;
  done?: boolean;
  /** R57: the folder's message count at the provider when last opened (EXISTS), for the progress total. */
  size?: number;
}
/** R57: backfill bookkeeping for the connection: messages backfilled on `day` (UTC), the person's pause, and why it waits. */
export interface BackfillState { day: string; n: number; paused?: boolean; wait?: "daily" | "budget" | null }
/** R59: the header repair sweep over older rows stored with placeholders or no preview: `at` is the last row id read, `done` ends it. */
export interface RepairState { at?: string; done?: boolean }
/**
 * Inbox and Sent cursors sit at the top level (round 18); round 19 adds the other synced folders
 * under `boxes` (Archive, Drafts, Spam, Trash, and the person's own folders as "f:<path>"), the
 * user folders the person turned on (`extra`, at most MAX_EXTRA_FOLDERS), and the provider's folder
 * list as last read (`list`, `listedAt`).
 */
export interface SyncState {
  /** R59: header repair sweep (see repairStep). */
  rp?: RepairState;
  inbox?: FolderState;
  sent?: FolderState;
  paths?: FolderPaths;
  boxes?: Record<string, FolderState>;
  extra?: string[];
  list?: RemoteFolder[];
  listedAt?: number;
  bf?: BackfillState;
}

export interface SyncResult {
  skipped?: "not_found" | "paused" | "auth_failed" | "budget" | "daily_cap" | "busy" | "unchanged" | "sample";
  stored: number;
  duplicates: number;
  flagsUpdated: number;
  pushed: number;
  /** More new mail (or, R57, older mail the backfill may take now) is waiting than this pass took. */
  more: boolean;
  /** R57: older messages stored header and snippet only by this pass. */
  backfilled?: number;
  error?: string;
}

/**
 * Synced folders, by key: the provider's standard folders by role, and the person's own folders as
 * "f:<path>". The key is what messages.remote_box holds.
 */
export type BoxKey = "inbox" | "sent" | "archive" | "drafts" | "spam" | "trash" | `f:${string}`;
const ROLE_KEYS = ["archive", "drafts", "spam", "trash"] as const;
/** The person's own folders synced at once, per connection. */
export const MAX_EXTRA_FOLDERS = 10;

/** Where synced mail from a folder sits in Multies. The person's own folders file under Archive and keep their name in remote_box. */
export function localFolderFor(key: string): Folder {
  if (key === "inbox" || key === "sent" || key === "drafts" || key === "spam" || key === "trash" || key === "archive") return key;
  return "archive";
}

/** The provider path of a synced folder. */
export function pathFor(state: SyncState, key: string): string | undefined {
  if (key.startsWith("f:")) return key.slice(2);
  return state.paths?.[key as keyof FolderPaths];
}

/** Every folder a pass syncs, in order: Inbox and Sent first, then the standard folders, then the person's own. */
export function syncedKeys(state: SyncState): BoxKey[] {
  const p = state.paths ?? { inbox: "INBOX" };
  const keys: BoxKey[] = ["inbox", "sent"];
  const seen = new Set([p.inbox, p.sent]);
  for (const k of ROLE_KEYS) { const path = p[k]; if (path && !seen.has(path)) { keys.push(k); seen.add(path); } }
  for (const path of state.extra ?? []) if (!seen.has(path)) { keys.push(`f:${path}`); seen.add(path); }
  return keys;
}

function cursor(state: SyncState, key: string): FolderState | undefined {
  return key === "inbox" || key === "sent" ? state[key] : state.boxes?.[key];
}
function setCursor(state: SyncState, key: string, st: FolderState) {
  if (key === "inbox" || key === "sent") state[key] = st;
  else (state.boxes ??= {})[key] = st;
}
type Box = BoxKey;

/** Largest message copied whole; bigger ones keep their headers and a note. */
const MAX_SYNC_BYTES = 10 * 1024 * 1024;
const FLAG_WINDOW = 200;

/**
 * R61 D1 reads: the sync's reads on messages, each walking an index built for it (0093). Before 0093 the flag window
 * and the oldest UID read every row of the mailbox through the mailbox prefix of another index (5,000 to 7,000 rows a
 * call on a 10,500 row mailbox), and the repair sweep read and sorted the whole mailbox (9,300 rows a call).
 * `remote_box = ?` satisfies the partial index's `remote_box IS NOT NULL`.
 */
type Db = Deps["db"];
const flagCols = { id: messages.id, remoteUid: messages.remoteUid, isRead: messages.isRead, isStarred: messages.isStarred, folder: messages.folder };
/** The copies of one folder's UID window lo..hi (messages_mailbox_remote_idx, a range). */
export function flagWindowQuery(db: Db, mailboxId: string, box: string, lo: number, hi: number) {
  return db.select(flagCols).from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.remoteBox, box), gte(messages.remoteUid, lo), lte(messages.remoteUid, hi)));
}
/** The copies of a few changed UIDs of one folder (messages_mailbox_remote_idx, one probe each; at most 90, the bound parameter limit). */
export function flagRowsQuery(db: Db, mailboxId: string, box: string, uids: number[]) {
  return db.select(flagCols).from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.remoteBox, box), inArray(messages.remoteUid, uids.slice(0, 90))));
}
/** The lowest UID stored from a folder (messages_mailbox_remote_idx: one index row). */
export function oldestUidQuery(db: Db, mailboxId: string, box: string) {
  return db.select({ lo: sql<number | null>`min(${messages.remoteUid})` }).from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.remoteBox, box)));
}
/**
 * Rows still waiting for the header repair, in id order after `after` (messages_mailbox_repair_idx). The condition is
 * written with literals, word for word the partial index's WHERE: SQLite only uses a partial index when the query
 * carries its terms, and a bound parameter in place of 'unknown@invalid' or '' would not match.
 */
export const REPAIR_WHERE = sql.raw(`"messages"."remote_uid" IS NOT NULL AND ("messages"."from_address" = '${PENDING_FROM.replace(/'/g, "''")}' OR ("messages"."size_bytes" < 0 AND "messages"."snippet" = ''))`);
export function repairRowsQuery(db: Db, mailboxId: string, after: string) {
  return db.select({ id: messages.id, remoteBox: messages.remoteBox, remoteUid: messages.remoteUid, fromAddress: messages.fromAddress, snippet: messages.snippet, sizeBytes: messages.sizeBytes })
    .from(messages).where(and(eq(messages.mailboxId, mailboxId), gt(messages.id, after), REPAIR_WHERE)).orderBy(asc(messages.id)).limit(REPAIR_BATCH);
}

/**
 * R61: D1's free plan refuses every read once the account passes 5M rows read in a UTC day (an outage, not a slowdown).
 * Older mail (backfill and repair sweep) waits once the day's reads reach `readStopPct` percent of that, as it already
 * does for writes at `stopPct`. New mail and flag changes keep going. Unknown reads (no analytics) do not hold it.
 * R61a: the stop is a number of rows read today (`readCeiling`): on Workers Paid there is no daily limit, so the ceiling
 * is set outright (MAIL_SYNC_BACKFILL_READ_CEILING); by default it is readStopPct of the daily read budget.
 */
export function readsHold(reading: { rowsRead?: number }, readCeiling: number) {
  return typeof reading.rowsRead === "number" && reading.rowsRead >= readCeiling;
}
/** The provider's folder list is read again after this long. */
export const FOLDER_LIST_TTL_MS = 6 * 3600_000;

const today = (d: Date) => d.toISOString().slice(0, 10);

export function parseState(raw: string | null | undefined): SyncState {
  try { return JSON.parse(raw || "{}") as SyncState; } catch { return {}; }
}

/** Runs one sync pass for a connection. Never throws: failures are recorded on the connection. */
/**
 * `onlyIfNew` (live mail, round 19): when nothing is queued for the provider and no new UID sits
 * above the Inbox and Sent cursors, the pass ends without writing anything, so checking often
 * costs no database writes.
 */
export async function syncConnection(deps: Deps, connectionId: string, opts: { force?: boolean; onlyIfNew?: boolean } = {}): Promise<SyncResult> {
  const empty: SyncResult = { stored: 0, duplicates: 0, flagsUpdated: 0, pushed: 0, more: false };
  const c = await deps.db.select().from(mailConnections).where(eq(mailConnections.id, connectionId)).get();
  if (!c) return { ...empty, skipped: "not_found" };
  if (c.status === "paused") return { ...empty, skipped: "paused" };
  // R40: the demo's sample connection has no password and a .example host: never open a network connection for it.
  if ((await import("../demo")).isSampleConnection(c)) return { ...empty, skipped: "sample" };
  if (c.status === "auth_failed" && !opts.force) return { ...empty, skipped: "auth_failed" };
  const now = deps.now();
  // A pass that started under two minutes ago is still running (another invocation took it).
  if (c.status === "syncing" && c.lastSyncAt && now.getTime() - c.lastSyncAt.getTime() < 120_000 && !opts.force) return { ...empty, skipped: "busy" };

  const reading = await writeBudget(deps);
  if (reading.level === "warn" || reading.level === "shed") {
    deps.log?.warn("mail_sync.deferred", { connection: c.id, reason: "write_budget", level: reading.level });
    return { ...empty, skipped: "budget" };
  }
  const cfg = deps.config.mailConnect;
  const day = today(now);
  const state = parseState(c.syncState);
  const doneToday = c.day === day ? c.messagesToday : 0;
  // R57: messagesToday counts every message stored today; older mail from the backfill has its own caps, so only new
  // mail counts against the new mail cap (otherwise a big backfill used it up and stopped the chain at 500).
  const backfilledToday = state.bf?.day === day ? state.bf.n : 0;
  const allowance = Math.max(0, cfg.dailyCap - Math.max(0, doneToday - backfilledToday));

  let session: ImapSession;
  try {
    const secret = await connectionSecret(deps, c);
    const access = c.authKind === "oauth" ? await (await import("./oauth")).accessTokenFor(deps, c, secret) : secret;
    session = await imapConnector(deps)({ host: c.imapHost, port: c.imapPort, security: c.imapSecurity }, { user: c.username, secret: access, xoauth2: c.authKind === "oauth" }, { allowSelfSigned: cfg.allowSelfSigned });
  } catch (err) {
    const problem = classifyProblem(err, "imap", c.provider as ConnectPresetId, c.imapHost);
    const authProblem = ["auth_failed", "app_password_needed", "imap_disabled", "oauth_required"].includes(problem.code);
    await deps.db.update(mailConnections).set({
      status: authProblem ? "auth_failed" : "error", lastError: problem.message,
      // Network trouble: try again at the next interval. A refused password waits for the person.
      nextSyncAt: new Date(now.getTime() + cfg.intervalMinutes * 60_000),
    }).where(eq(mailConnections.id, c.id));
    deps.log?.warn("mail_sync.connect_failed", { connection: c.id, code: problem.code });
    return { ...empty, skipped: authProblem ? "auth_failed" : undefined, error: problem.message };
  }

  const result: SyncResult = { ...empty };
  if (opts.onlyIfNew && c.initialDone && state.paths && state.inbox) {
    try {
      if (!(await hasWork(deps, c.id, session, state))) {
        await session.close().catch(() => undefined);
        return { ...empty, skipped: "unchanged" };
      }
    } catch {
      // Fall through to a normal pass, which records the problem.
    }
  }
  try {
    if (!state.paths || !state.listedAt || now.getTime() - state.listedAt > FOLDER_LIST_TTL_MS) {
      // Round 19: the full list, for Drafts, Spam and the person's own folders. Read again every few hours.
      const list = (await session.listFolders()).filter((f) => !f.noSelect);
      state.list = list;
      state.paths = { ...pickFolders(list), inbox: state.paths?.inbox ?? "INBOX" };
      state.listedAt = now.getTime();
    }
    result.pushed = await pushChanges(deps, c, session, state);

    if (allowance <= 0) result.skipped = "daily_cap";
    let budget = Math.min(cfg.batch, allowance);
    const mb = (await deps.db.select({ orgId: mailboxes.orgId }).from(mailboxes).where(eq(mailboxes.id, c.mailboxId)).get())!;
    // Read, star and moves made at the provider first: mail that left a folder is let go of here,
    // so that when it shows up in another synced folder below it is filed there, not skipped.
    const flagChanges = [];
    let flagCount = 0;
    if (c.initialDone) {
      for (const box of syncedKeys(state)) {
        const st = cursor(state, box);
        if (!st) continue;
        try { flagChanges.push(...await pullFlags(deps, c, session, box, st)); } catch (err) {
          if (!box.startsWith("f:")) throw err;
        }
      }
      flagCount = flagChanges.length;
      if (flagChanges.length) await runBatch(deps.db, flagChanges.splice(0));
    }

    const fetched: { box: Box; m: FetchedMessage }[] = [];
    const passIds = new Set<string>(); // R53: Message-IDs this pass already brought (Gmail shows new mail in Inbox and All Mail)
    for (const box of syncedKeys(state)) {
      const path = pathFor(state, box);
      if (!path) continue;
      let opened: { uidValidity: string; uidNext: number };
      try { opened = await session.open(path); } catch (err) {
        // A folder the person deleted at the provider: stop syncing it, keep the rest.
        if (box.startsWith("f:")) { state.extra = (state.extra ?? []).filter((x) => `f:${x}` !== box); continue; }
        throw err;
      }
      let st = cursor(state, box);
      if (!st || st.v !== opened.uidValidity || st.path !== path) {
        // First sync of this folder (or the provider renumbered it): the recent ones only.
        const since = new Date(now.getTime() - cfg.initialDays * 86_400_000);
        const recent = await session.searchSince(since);
        const cap = box === "inbox" ? cfg.initialCap : box === "sent" ? Math.ceil(cfg.initialCap / 2) : Math.ceil(cfg.initialCap / 4);
        const kept = recent.slice(-cap);
        st = { path, v: opened.uidValidity, last: kept.length ? kept[0] - 1 : Math.max(0, opened.uidNext - 1), low: kept.length ? kept[0] : Math.max(1, opened.uidNext) };
        setCursor(state, box, st);
      }
      // R57: the folder's message count, for the progress total (no extra round trip: SELECT answers it).
      const exists = (opened as { exists?: number }).exists;
      if (typeof exists === "number") st.size = exists;
      if (budget <= 0) { result.more = result.more || (await session.uidsAfter(st.last)).length > 0; continue; }
      const pending = await session.uidsAfter(st.last);
      const take = pending.slice(0, budget);
      if (pending.length > take.length) result.more = true;
      if (take.length) {
        for (const m of await session.fetch(take, MAX_SYNC_BYTES, (heads) => needBodies(deps, c.mailboxId, heads, passIds))) fetched.push({ box, m });
        st.last = take[take.length - 1];
        budget -= take.length;
      }
    }


    result.flagsUpdated = flagCount;
    const newMore = result.more;

    // R57: full history backfill, with what this pass has left once new mail is handled.
    if (!newMore) {
      const bf = await backfillStep(deps, c, session, state, reading, day, passIds);
      fetched.push(...bf.fetched);
      if (bf.more) result.more = true;
    }
    // R59: rows stored with placeholder headers or no preview get their headers read again, a batch a pass.
    const repair = !newMore ? await repairStep(deps, c, session, state, reading) : { statements: [], more: false, repaired: 0 };
    if (repair.more) result.more = true;

    const stored = await storeBatch(deps, c, mb.orgId, fetched);
    // A row still without a sender starts the repair sweep again on a later pass.
    if (stored.pending) state.rp = undefined;
    result.backfilled = stored.lazy;
    if (stored.lazy) { const b = (state.bf ??= { day, n: 0 }); if (b.day !== day) { b.day = day; b.n = 0; } b.n += stored.lazy; }
    result.stored = stored.stored;
    result.duplicates = stored.duplicates;
    const initialDone = c.initialDone || !newMore;
    await runBatch(deps.db, [
      ...stored.statements,
      ...repair.statements,
      ...flagChanges,
      deps.db.update(mailConnections).set({
        status: "active", lastError: null, lastSyncAt: now, initialDone, syncState: JSON.stringify(state),
        nextSyncAt: new Date(now.getTime() + (result.more ? 30_000 : cfg.intervalMinutes * 60_000)),
        messagesSynced: sql`${mailConnections.messagesSynced} + ${stored.stored}`,
        messagesToday: doneToday + stored.stored, day,
      }).where(eq(mailConnections.id, c.id)),
    ]);
  } catch (err) {
    const problem = classifyProblem(err, "imap", c.provider as ConnectPresetId, c.imapHost);
    result.error = problem.message;
    await deps.db.update(mailConnections).set({ status: "error", lastError: problem.message, nextSyncAt: new Date(now.getTime() + cfg.intervalMinutes * 60_000) }).where(eq(mailConnections.id, c.id));
    deps.log?.warn("mail_sync.failed", { connection: c.id, code: problem.code });
  } finally {
    await session.close().catch(() => undefined);
  }
  return result;
}

/**
 * R53: of the headers just fetched, the UIDs whose body is still needed. A message whose Message-ID is already stored in
 * this mailbox (`known`), or that an earlier folder of this pass already brought (`dup`), keeps its header only: the
 * store step treats both as the duplicates they are, so their bodies were downloaded and parsed for nothing before.
 * One indexed read per 90 Message-IDs, the same read the store step makes.
 */
export async function needBodies(deps: Deps, mailboxId: string, heads: FetchedMessage[], passIds: Set<string>): Promise<Set<number>> {
  const ids = [...new Set(heads.map((h) => h.envelope?.messageId).filter((x): x is string => !!x && x.length > 2 && !passIds.has(x)))];
  const stored = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const hits = await deps.db.select({ mid: messages.messageIdHeader }).from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), inArray(messages.messageIdHeader, ids.slice(i, i + 90))));
    for (const h of hits) if (h.mid) stored.add(h.mid);
  }
  const want = new Set<number>();
  for (const h of heads) {
    const mid = h.envelope?.messageId;
    if (mid && mid.length > 2 && passIds.has(mid)) h.dup = true;
    else if (mid && stored.has(mid)) h.known = mid;
    else want.add(h.uid);
  }
  for (const h of heads) { const mid = h.envelope?.messageId; if (mid && mid.length > 2) passIds.add(mid); }
  return want;
}

/** Whether a pass has anything to do: queued changes for the provider, or new UIDs in Inbox or Sent. Reads only. */
async function hasWork(deps: Deps, connectionId: string, session: ImapSession, state: SyncState) {
  const queued = await deps.db.select({ id: mailSyncOutbox.id }).from(mailSyncOutbox).where(eq(mailSyncOutbox.connectionId, connectionId)).limit(1).get();
  if (queued) return true;
  for (const box of syncedKeys(state)) {
    const st = cursor(state, box);
    if (!st) continue;
    const opened = await session.open(st.path);
    if (opened.uidValidity !== st.v) return true;
    if ((await session.uidsAfter(st.last)).length) return true;
  }
  return false;
}

/** Where a queued folder action moves mail at the provider (a folder key). */
const ACTION_DEST: Record<string, string> = { archive: "archive", trash: "trash", inbox: "inbox", spam: "spam" };

/**
 * Applies queued Multies changes at the provider, then clears them (one delete). Moves record the
 * message's new UID when the server answers it (UIDPLUS); otherwise the message is matched by
 * Message-ID when its new folder syncs.
 */
async function pushChanges(deps: Deps, c: Connection, session: ImapSession, state: SyncState): Promise<number> {
  const rows = await deps.db.select().from(mailSyncOutbox).where(eq(mailSyncOutbox.connectionId, c.id)).limit(200);
  if (!rows.length) return 0;
  const relink: PromiseLike<unknown>[] = [];
  for (const box of new Set(rows.map((r) => r.remoteBox))) {
    const path = pathFor(state, box);
    const mine = rows.filter((r) => r.remoteBox === box);
    if (!path || !mine.length) continue;
    try { await session.open(path, { write: true }); } catch { continue; }
    const uids = (a: string) => [...new Set(mine.filter((r) => r.action === a).map((r) => r.remoteUid))];
    await session.addFlags(uids("seen"), ["\\Seen"]);
    await session.removeFlags(uids("unseen"), ["\\Seen"]);
    await session.addFlags(uids("flag"), ["\\Flagged"]);
    await session.removeFlags(uids("unflag"), ["\\Flagged"]);
    const moves = mine.filter((r) => ACTION_DEST[r.action] || (r.action === "move" && r.dest));
    for (const destKey of new Set(moves.map((r) => (r.action === "move" ? r.dest! : ACTION_DEST[r.action])))) {
      const dest = pathFor(state, destKey);
      const group = moves.filter((r) => (r.action === "move" ? r.dest : ACTION_DEST[r.action]) === destKey);
      if (!dest || dest === path) continue;
      const map = await session.move([...new Set(group.map((r) => r.remoteUid))], dest);
      if (!map) continue;
      for (const r of group) {
        const uid = map.get(r.remoteUid);
        if (uid && r.messageId) relink.push(deps.db.update(messages).set({ remoteBox: destKey, remoteUid: uid }).where(and(eq(messages.id, r.messageId), eq(messages.remoteBox, destKey))));
      }
    }
  }
  await runBatch(deps.db, [...relink, deps.db.delete(mailSyncOutbox).where(inIds(mailSyncOutbox.id, rows.map((r) => r.id)))]);
  return rows.length;
}

/**
 * Read and star changes made at the provider on the most recent mail of a synced folder; only
 * changed rows are written. Mail that left the folder at the provider is let go of here (its UID is
 * cleared, and mail that left the Inbox leaves the Multies inbox too); when it shows up in another
 * synced folder, that folder's sync picks it up again by Message-ID and files it there.
 */
/** R52: what a folder looked like when its flags were last read in full (see FolderState.f); undefined without CONDSTORE. */
export function folderFingerprint(opened: { uidNext: number; exists?: number; modseq?: string }, last: number): string | undefined {
  return opened.modseq ? `${opened.modseq}:${opened.exists ?? ""}:${opened.uidNext}:${last}` : undefined;
}

/** R53: the parts of a stored fingerprint, or undefined when it is missing or not all numbers. */
export function parseFingerprint(f: string | undefined): { modseq: string; exists: number; uidNext: number; last: number } | undefined {
  const p = (f ?? "").split(":");
  if (p.length !== 4 || !p.every((x) => /^\d+$/.test(x))) return undefined;
  return { modseq: p[0], exists: Number(p[1]), uidNext: Number(p[2]), last: Number(p[3]) };
}

/**
 * R53: how many messages left the folder since the fingerprint was taken. Every message that arrives (or is moved in)
 * takes a new UID, so arrivals = the growth of the next UID, and whatever the count did not grow by was removed.
 * 0 means nothing left the folder at all; undefined when it can't be told.
 */
export function removedSince(prev: { exists: number; uidNext: number } | undefined, opened: { uidNext: number; exists?: number }): number | undefined {
  if (!prev || opened.exists === undefined) return undefined;
  const arrived = opened.uidNext - prev.uidNext;
  const removed = arrived - (opened.exists - prev.exists);
  return arrived >= 0 && removed >= 0 ? removed : undefined;
}

async function pullFlags(deps: Deps, c: Connection, session: ImapSession, box: string, st: FolderState) {
  const opened = await session.open(st.path);
  // R52: an unchanged folder (same modseq, count and next UID since its last full read) has no flag changes and
  // no removed mail: skip the FETCH FLAGS of up to FLAG_WINDOW messages and the local read of the same window.
  const fp = folderFingerprint(opened, st.last);
  if (fp && st.f === fp) return [];
  const lo = Math.max(1, st.last - FLAG_WINDOW + 1);
  // R53: Gmail keeps one mod-sequence for the whole account, so any change anywhere moves every folder's modseq and
  // the R52 skip almost never applies there. When nothing left the folder since the last read, ask only for the
  // messages whose flags changed after the stored modseq (CONDSTORE CHANGEDSINCE) and read only those rows here.
  const prev = parseFingerprint(st.f);
  const incremental = !!(fp && prev && opened.modseq && removedSince(prev, opened) === 0);
  const remote = await session.flags(lo, st.last, incremental ? { changedSince: prev!.modseq } : {});
  if (incremental && remote.size === 0) { st.f = fp; return []; }
  const changedUids = incremental ? [...remote.keys()].filter((u) => u >= lo && u <= st.last) : [];
  if (incremental && changedUids.length === 0) { st.f = fp; return []; }
  const local = await (incremental ? flagRowsQuery(deps.db, c.mailboxId, box, changedUids) : flagWindowQuery(deps.db, c.mailboxId, box, lo, st.last));
  if (incremental && changedUids.length > 90) {
    // Over 90 changed messages (the bound-parameter limit per statement): read the rest of the window the old way.
    const rest = await flagWindowQuery(deps.db, c.mailboxId, box, lo, st.last);
    const have = new Set(local.map((m) => m.id));
    for (const m of rest) if (!have.has(m.id) && remote.has(m.remoteUid!)) local.push(m);
  }
  const changes = [];
  for (const m of local) {
    const f = remote.get(m.remoteUid!);
    if (!f) {
      // Only a full read can say a message is gone; an incremental read lists changed messages only.
      if (incremental) continue;
      changes.push(deps.db.update(messages).set(box === "inbox" && m.folder === "inbox" ? { folder: "archive", remoteUid: null } : { remoteUid: null }).where(eq(messages.id, m.id)));
      continue;
    }
    const isRead = f.has("\\Seen");
    const isStarred = f.has("\\Flagged");
    if (isRead !== m.isRead || isStarred !== m.isStarred) changes.push(deps.db.update(messages).set({ isRead, isStarred }).where(eq(messages.id, m.id)));
  }
  // Saved with the rest of the state when the pass commits (a failed pass keeps the old value and reads again).
  if (fp) st.f = fp; else delete st.f;
  return changes;
}

function stub(m: FetchedMessage): ParsedEmail {
  const e = m.envelope ?? {};
  return {
    messageId: e.messageId, from: { address: e.from?.address ?? "unknown@invalid", name: e.from?.name }, to: [], cc: [], subject: e.subject ?? "(no subject)",
    text: `This message is larger than ${MAX_SYNC_BYTES / 1024 / 1024} MB, so Multies kept only its headers. Open it in your provider's own app to read it.`,
    date: e.date ?? new Date(), attachments: [],
  } as unknown as ParsedEmail;
}

/**
 * Builds the inserts for a pass: skips mail already stored (by Message-ID), threads replies on
 * In-Reply-To and References with one read, and returns the statements for the caller's batch.
 */
export async function storeBatch(deps: Deps, c: Pick<Connection, "id" | "mailboxId">, orgId: string, fetched: { box: Box; m: FetchedMessage }[]) {
  const parsed: { box: Box; m: FetchedMessage; e: ParsedEmail }[] = [];
  let skippedDup = 0, pending = 0;
  for (const f of fetched) {
    // R53: headers only for mail already held (see needBodies): no MIME parse, straight to the duplicate path below.
    if (f.m.dup) { skippedDup++; continue; }
    if (f.m.known) { parsed.push({ ...f, e: { messageId: f.m.known } as unknown as ParsedEmail }); continue; }
    if (f.m.partial) { const e = await parsePartial(f.m); if (e.pending) pending++; parsed.push({ ...f, e }); continue; }
    try { parsed.push({ ...f, e: f.m.source ? await parseMime(f.m.source) : stub(f.m) }); } catch (err) {
      deps.log?.warn("mail_sync.unparsable", { connection: c.id, uid: f.m.uid, error: (err as Error).message });
    }
  }
  const ids = [...new Set(parsed.flatMap(({ e }) => [e.messageId, e.inReplyTo, ...(e.references ?? "").split(/\s+/)]).filter((x): x is string => !!x && x.length > 2))];
  const known = new Map<string, string>();
  const rows = new Map<string, { id: string; remoteBox: string | null; remoteUid: number | null; folder: string }>();
  for (let i = 0; i < ids.length; i += 90) {
    const hits = await deps.db.select({ id: messages.id, mid: messages.messageIdHeader, threadId: messages.threadId, remoteBox: messages.remoteBox, remoteUid: messages.remoteUid, folder: messages.folder }).from(messages)
      .where(and(eq(messages.mailboxId, c.mailboxId), inArray(messages.messageIdHeader, ids.slice(i, i + 90))));
    for (const h of hits) if (h.mid) { known.set(h.mid, h.threadId); if (!rows.has(h.mid) || rows.get(h.mid)!.remoteUid !== null) rows.set(h.mid, h); }
  }
  const statements: PromiseLike<unknown>[] = [];
  let stored = 0, duplicates = skippedDup, bytes = 0, lazy = 0;
  const seen = new Set<string>();
  for (const { box, m, e } of parsed) {
    if (e.messageId && (known.has(e.messageId) || seen.has(e.messageId))) {
      duplicates++;
      // A copy we hold that isn't tied to a provider folder any more (moved, or sent from Multies): tie it to this one.
      const r = rows.get(e.messageId);
      if (r && r.remoteUid === null && !seen.has(e.messageId)) {
        const moved = r.remoteBox !== null && r.remoteBox !== box;
        statements.push(deps.db.update(messages).set({ remoteBox: box, remoteUid: m.uid, ...(moved ? { folder: localFolderFor(box) } : {}) }).where(eq(messages.id, r.id)));
        r.remoteUid = m.uid;
      }
      continue;
    }
    if (e.messageId) seen.add(e.messageId);
    const refs = [e.inReplyTo, ...(e.references ?? "").split(/\s+/)].filter((x): x is string => !!x && x.length > 2);
    const threadId = refs.map((r) => known.get(r)).find(Boolean) ?? newId("thr");
    if (e.messageId) known.set(e.messageId, threadId);
    const id = newId("msg");
    if (m.partial) {
      // R57: older mail, header and snippet only: one row, no attachment rows, no storage counted. A negative size marks
      // the body as still at the provider; loadBody fetches it the first time the message is opened.
      statements.push(deps.db.insert(messages).values({
        id, orgId, mailboxId: c.mailboxId, folder: localFolderFor(box), messageIdHeader: e.messageId ?? null,
        inReplyTo: e.inReplyTo ?? null, references: e.references ?? null, threadId,
        fromAddress: e.from?.address ?? PENDING_FROM, fromName: e.from?.name ?? "", to: JSON.stringify(e.to ?? []), cc: JSON.stringify(e.cc ?? []), bcc: "[]",
        replyTo: e.replyTo ?? null, subject: e.subject ?? "", text: "", html: null, snippet: makeSnippet(e.text ?? "", e.html),
        sizeBytes: -Math.max(1, m.size), isRead: box === "sent" || box === "drafts" || m.flags.has("\\Seen"), isStarred: m.flags.has("\\Flagged"), isAnswered: m.flags.has("\\Answered"),
        hasAttachments: looksLikeAttachments(m), authResults: null, remoteBox: box, remoteUid: m.uid, date: e.date ?? m.envelope?.date ?? new Date(),
      }));
      stored++; lazy++;
      continue;
    }
    const size = m.source?.byteLength ?? m.size;
    bytes += size;
    const keepAtts = (e.attachments ?? []).filter((a) => a.content.byteLength <= MAX_INLINE_ATTACHMENT_BYTES);
    statements.push(deps.db.insert(messages).values({
      id, orgId, mailboxId: c.mailboxId, folder: localFolderFor(box), messageIdHeader: e.messageId ?? null,
      inReplyTo: e.inReplyTo ?? null, references: e.references ?? null, threadId,
      fromAddress: e.from.address, fromName: e.from.name ?? "", to: JSON.stringify(e.to ?? []), cc: JSON.stringify(e.cc ?? []), bcc: "[]",
      replyTo: e.replyTo ?? null, subject: e.subject ?? "", text: e.text ?? "", html: e.html ?? null, snippet: makeSnippet(e.text ?? "", e.html),
      sizeBytes: size, isRead: box === "sent" || box === "drafts" || m.flags.has("\\Seen"), isStarred: m.flags.has("\\Flagged"), isAnswered: m.flags.has("\\Answered"),
      hasAttachments: (e.attachments?.length ?? 0) > 0, authResults: e.authResults ? JSON.stringify(e.authResults) : null,
      remoteBox: box, remoteUid: m.uid, date: e.date ?? new Date(),
    }));
    // Attachments over the inline limit keep their name and size only; the provider still has them.
    for (const a of e.attachments ?? []) {
      const inline = keepAtts.includes(a);
      statements.push(deps.db.insert(attachments).values({ id: newId("att"), messageId: id, filename: a.filename.slice(0, 255), contentType: a.contentType.slice(0, 255), sizeBytes: a.content.byteLength, contentB64: inline ? toB64(a.content) : null, storageKey: null }));
    }
    stored++;
  }
  if (bytes && stored) statements.push(deps.db.update(mailboxes).set({ usedBytes: sql`${mailboxes.usedBytes} + ${bytes}` }).where(eq(mailboxes.id, c.mailboxId)));
  return { statements, stored, duplicates, lazy, pending };
}

/**
 * The scheduled run: hands each due connection to its own invocation (a Durable Object on Workers,
 * so one connection's mail can't use up the others' request budget), or runs them inline on Node.
 */
export async function runDueMailSyncs(deps: Deps, limit = 20) {
  if (!deps.config.mailConnect.enabled) return { dispatched: 0 };
  const { dueConnections } = await import(".");
  const due = await dueConnections(deps, limit);
  let dispatched = 0;
  for (const { id } of due) {
    try {
      if (deps.dispatchMailSync) await deps.dispatchMailSync(id);
      else await syncAndChain(deps, id);
      dispatched++;
    } catch (err) {
      deps.log?.warn("mail_sync.dispatch_failed", { connection: id, error: (err as Error).message });
    }
  }
  return { dispatched };
}


/**
 * R57: headers and the start of the body of an older message (a partial fetch), for its row and snippet. Never throws.
 * R59: parseMime fills a missing From, Subject or Date with placeholders (unknown@invalid, empty, now). On a partial fetch
 * those headers can simply lie past the cut (a long Received/ARC/DKIM chain), so the server's envelope comes first and a
 * parsed header counts only when it is really there. With no sender anywhere the row is marked pending: lists hide it
 * and the repair sweep reads it again.
 */
export async function parsePartial(m: FetchedMessage): Promise<ParsedEmail & { pending?: boolean }> {
  const env = m.envelope ?? {};
  let e: Partial<ParsedEmail> = {};
  let h: Record<string, string> = {};
  if (m.source) { try { e = await parseMime(m.source); h = e.headers ?? {}; } catch { e = {}; } }
  const valid = (d?: Date) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d : undefined);
  const parsedFrom = "from" in h && e.from?.address && e.from.address !== PENDING_FROM ? e.from : undefined;
  let from = env.from?.address ? { address: env.from.address, name: env.from.name || parsedFrom?.name } : parsedFrom;
  // The server answered and the message has no From at all: say so plainly rather than retrying it for ever.
  if (!from && m.envelope && m.source && headerEnd(m.source) >= 0) from = { address: "", name: "Unknown sender" };
  const subject = env.subject ?? ("subject" in h ? e.subject : undefined);
  const date = valid(env.date) ?? ("date" in h ? valid(e.date) : undefined) ?? valid(m.internalDate);
  return {
    ...e,
    messageId: e.messageId ?? env.messageId,
    inReplyTo: e.inReplyTo ?? env.inReplyTo,
    from: from ?? { address: PENDING_FROM },
    pending: !from,
    subject: subject ?? "",
    date: date ?? new Date(),
    to: env.to?.length ? env.to : e.to ?? [],
    cc: env.cc?.length ? env.cc : e.cc ?? [],
    attachments: [],
    text: e.text ?? "",
  } as ParsedEmail & { pending?: boolean };
}

/** R57: whether the top of a partly fetched message says it carries attachments (multipart/mixed, or an attachment part seen). */
export function looksLikeAttachments(m: FetchedMessage): boolean {
  if (!m.source) return false;
  const head = new TextDecoder().decode(m.source.subarray(0, Math.min(m.source.byteLength, 8192)));
  return /^content-type:\s*multipart\/mixed/im.test(head) || /content-disposition:\s*attachment/i.test(head);
}

/** R57: why the backfill waits, or how many older messages it may store now (per connection, account wide, write level). */
export async function backfillAllowance(deps: Deps, state: SyncState, reading: { rowsWritten: number; budget: number; level: string; rowsRead?: number }, day: string) {
  const cfg = deps.config.mailConnect.backfill;
  if (!cfg.enabled) return { n: 0, wait: null as BackfillState["wait"] };
  if (state.bf?.paused) return { n: 0, wait: null as BackfillState["wait"] };
  if (reading.level !== "off" && reading.budget > 0 && (reading.rowsWritten / reading.budget) * 100 >= cfg.stopPct) return { n: 0, wait: "budget" as const };
  if (readsHold(reading, cfg.readCeiling)) return { n: 0, wait: "budget" as const };
  const mine = state.bf?.day === day ? state.bf.n : 0;
  const perConn = Math.max(0, cfg.dailyCap - mine);
  if (perConn <= 0) return { n: 0, wait: "daily" as const };
  // Account wide: what every connection backfilled today (a few rows, one read). Two passes at the same moment can
  // each take one batch past the line; that is bounded by the batch size.
  const row = await deps.db.select({ n: sql<number>`coalesce(sum(json_extract(${mailConnections.syncState}, '$.bf.n')), 0)` }).from(mailConnections)
    .where(sql`json_extract(${mailConnections.syncState}, '$.bf.day') = ${day}`).get();
  const global = Math.max(0, cfg.globalDaily - Number(row?.n ?? 0));
  if (global <= 0) return { n: 0, wait: "daily" as const };
  return { n: Math.min(cfg.batch, perConn, global), wait: null as BackfillState["wait"] };
}

/**
 * R57: one backfill step. For each synced folder, Inbox and Sent first (R58: sharing the pass), walks the UIDs below the folder's `low` cursor,
 * newest first, with one bulk header fetch per folder, until this pass's allowance is spent. Mail already stored (same
 * Message-ID) keeps its header only and is skipped by the store step, so a restart or a UIDVALIDITY change never doubles
 * mail. Answers the fetched heads (marked partial) and whether more older mail may be taken right away.
 */
export async function backfillStep(deps: Deps, c: Pick<Connection, "id" | "mailboxId">, session: ImapSession, state: SyncState, reading: { rowsWritten: number; budget: number; level: string; rowsRead?: number }, day: string, passIds: Set<string>) {
  const fetched: { box: Box; m: FetchedMessage }[] = [];
  if (!session.uidsBefore || !session.fetchHeads) return { fetched, more: false };
  const keys = syncedKeys(state).filter((k) => { const st = cursor(state, k); return st && !st.done; });
  const bf = (state.bf ??= { day, n: 0 });
  if (!keys.length) { bf.wait = null; return { fetched, more: false }; }
  const allow = await backfillAllowance(deps, state, reading, day);
  bf.wait = allow.wait;
  let budget = allow.n;
  if (budget <= 0) return { fetched, more: false };
  const peek = deps.config.mailConnect.backfill.peekBytes;
  // R58: Inbox and Sent share each pass, so a huge Inbox never leaves Sent waiting until it is done. Sent goes first
  // (it is usually the smaller one) with half the pass; what it does not use flows on to Inbox, then to other folders.
  const shared = (["sent", "inbox"] as BoxKey[]).filter((k) => keys.includes(k));
  const order = [...shared, ...keys.filter((k) => !shared.includes(k))];
  let sharesLeft = shared.length;
  for (const box of order) {
    if (budget <= 0) break;
    const share = sharesLeft > 1 ? Math.ceil(budget / sharesLeft) : budget;
    if (sharesLeft > 0) sharesLeft--;
    const st = cursor(state, box)!;
    const path = pathFor(state, box);
    if (!path) continue;
    try {
      const opened = await session.open(path);
      if (opened.uidValidity !== st.v) continue; // renumbered since the new mail step: the next pass starts it again
      if (st.low === undefined) {
        // A folder synced before R57: start below the oldest copy already stored from it.
        const r = await oldestUidQuery(deps.db, c.mailboxId, box).get();
        st.low = r?.lo ? Number(r.lo) : st.last + 1;
      }
      const older = await session.uidsBefore(st.low);
      if (!older.length) { st.left = 0; st.done = true; continue; }
      const take = older.slice(-share);
      const heads = await session.fetchHeads(take, peek);
      await needBodies(deps, c.mailboxId, heads, passIds);
      for (const m of heads) fetched.push({ box, m: { ...m, partial: true } });
      st.low = take[0];
      st.left = older.length - take.length;
      if (st.left === 0) st.done = true;
      budget -= take.length;
    } catch (err) {
      // A person's own folder that went away: leave it; Inbox and Sent problems surface through the pass.
      if (!box.startsWith("f:")) throw err;
      st.done = true;
    }
  }
  const more = syncedKeys(state).some((k) => { const st = cursor(state, k); return st && !st.done; });
  return { fetched, more: more && allow.n > 0 };
}

/** R59: rows one pass reads again at most in the header repair sweep. */
export const REPAIR_BATCH = 100;

/**
 * R59: the header repair sweep. Older rows stored before R59 with placeholder headers (sender unknown@invalid, empty
 * subject, the store time as date) or with no preview get their envelope and first bytes read again from the provider,
 * REPAIR_BATCH rows a pass in id order, under the same write level stop as the backfill (one UPDATE per row; a row
 * that already has a good sender only gets its preview). The sweep ends when a read finds fewer rows than a batch,
 * and starts again when a pass stores a new row without a sender. Cursors, caps and the backfill are not touched.
 */
export async function repairStep(deps: Deps, c: Pick<Connection, "id" | "mailboxId">, session: ImapSession, state: SyncState, reading: { rowsWritten: number; budget: number; level: string; rowsRead?: number }) {
  const statements: PromiseLike<unknown>[] = [];
  const none = { statements, more: false, repaired: 0 };
  const cfg = deps.config.mailConnect.backfill;
  if (!session.fetchHeads || state.rp?.done || !cfg.enabled || state.bf?.paused) return none;
  if (reading.level !== "off" && reading.budget > 0 && (reading.rowsWritten / reading.budget) * 100 >= cfg.stopPct) return none;
  if (readsHold(reading, cfg.readCeiling)) return none;
  const rows = await repairRowsQuery(deps.db, c.mailboxId, state.rp?.at ?? "");
  let repaired = 0;
  const byBox = new Map<string, typeof rows>();
  for (const r of rows) if (r.remoteBox) byBox.set(r.remoteBox, [...(byBox.get(r.remoteBox) ?? []), r]);
  for (const [box, list] of byBox) {
    const path = pathFor(state, box);
    const st = cursor(state, box);
    if (!path || !st) continue;
    try {
      const opened = await session.open(path);
      if (opened.uidValidity !== st.v) continue; // renumbered: these UIDs mean other mail now; the folder sync relinks them
      const heads = new Map((await session.fetchHeads(list.map((r) => r.remoteUid!), cfg.peekBytes)).map((m) => [m.uid, m]));
      for (const r of list) {
        const m = heads.get(r.remoteUid!);
        if (!m) continue; // gone at the provider: the folder sync lets it go
        const e = await parsePartial(m);
        const set: Partial<typeof messages.$inferInsert> = {};
        if (r.fromAddress === PENDING_FROM && !e.pending) {
          Object.assign(set, { fromAddress: e.from.address, fromName: e.from.name ?? "", subject: e.subject ?? "", date: e.date, to: JSON.stringify(e.to ?? []), cc: JSON.stringify(e.cc ?? []) });
        }
        // " " marks a preview that was looked for and is truly empty, so the sweep does not read it again.
        if (r.sizeBytes < 0 && !r.snippet) set.snippet = makeSnippet(e.text ?? "", e.html) || " ";
        if (Object.keys(set).length) { statements.push(deps.db.update(messages).set(set).where(eq(messages.id, r.id))); repaired++; }
      }
    } catch (err) {
      // A folder that went away: its rows wait; Inbox and Sent problems surface through the pass.
      if (!box.startsWith("f:")) throw err;
    }
  }
  state.rp = rows.length < REPAIR_BATCH ? { done: true } : { at: rows[rows.length - 1].id };
  if (repaired) deps.log?.info?.("mail_sync.repaired", { connection: c.id, rows: rows.length, repaired });
  return { statements, more: rows.length >= REPAIR_BATCH, repaired };
}

export { backfillProgress } from "./backfill-progress";

/**
 * R57: the body of an older message stored header and snippet only (negative size), fetched from the provider the first
 * time it is opened, then kept: one UPDATE of the row (plus its attachment rows). Answers false when the provider no
 * longer has it at that UID (moved or deleted there); the row keeps its snippet and the next folder sync ties it again.
 */
export async function loadBody(deps: Deps, messageId: string): Promise<boolean> {
  const m = await deps.db.select({ id: messages.id, mailboxId: messages.mailboxId, sizeBytes: messages.sizeBytes, remoteBox: messages.remoteBox, remoteUid: messages.remoteUid, fromAddress: messages.fromAddress })
    .from(messages).where(eq(messages.id, messageId)).get();
  if (!m || m.sizeBytes >= 0) return true;
  if (!m.remoteBox || m.remoteUid === null) return false;
  const c = await deps.db.select().from(mailConnections).where(eq(mailConnections.mailboxId, m.mailboxId)).get();
  if (!c) return false;
  const state = parseState(c.syncState);
  const path = pathFor(state, m.remoteBox);
  if (!path) return false;
  const cfg = deps.config.mailConnect;
  const secret = await connectionSecret(deps, c);
  const access = c.authKind === "oauth" ? await (await import("./oauth")).accessTokenFor(deps, c, secret) : secret;
  const session = await imapConnector(deps)({ host: c.imapHost, port: c.imapPort, security: c.imapSecurity }, { user: c.username, secret: access, xoauth2: c.authKind === "oauth" }, { allowSelfSigned: cfg.allowSelfSigned });
  try {
    const opened = await session.open(path);
    const st = cursor(state, m.remoteBox);
    if (st && st.v !== opened.uidValidity) return false;
    const [f] = await session.fetch([m.remoteUid], MAX_SYNC_BYTES);
    if (!f || f.uid !== m.remoteUid) return false;
    const e = f.source ? await parseMime(f.source) : stub(f);
    const size = f.source?.byteLength ?? f.size;
    const statements: PromiseLike<unknown>[] = [
      deps.db.update(messages).set({
        // R59: a row stored with placeholder headers gets the real ones from the whole message.
        ...(m.fromAddress === PENDING_FROM && f.source && e.from?.address && e.from.address !== PENDING_FROM ? { fromAddress: e.from.address, fromName: e.from.name ?? "", subject: e.subject ?? "", date: e.date, to: JSON.stringify(e.to ?? []), cc: JSON.stringify(e.cc ?? []) } : {}),
        text: e.text ?? "", html: e.html ?? null, snippet: makeSnippet(e.text ?? "", e.html), sizeBytes: Math.max(0, size), hasAttachments: (e.attachments?.length ?? 0) > 0, authResults: e.authResults ? JSON.stringify(e.authResults) : null }).where(eq(messages.id, m.id)),
    ];
    for (const a of e.attachments ?? []) {
      const inline = a.content.byteLength <= MAX_INLINE_ATTACHMENT_BYTES;
      statements.push(deps.db.insert(attachments).values({ id: newId("att"), messageId: m.id, filename: a.filename.slice(0, 255), contentType: a.contentType.slice(0, 255), sizeBytes: a.content.byteLength, contentB64: inline ? toB64(a.content) : null, storageKey: null }));
    }
    if (size) statements.push(deps.db.update(mailboxes).set({ usedBytes: sql`${mailboxes.usedBytes} + ${size}` }).where(eq(mailboxes.id, m.mailboxId)));
    await runBatch(deps.db, statements);
    return true;
  } finally {
    await session.close().catch(() => undefined);
  }
}

/**
 * R57: a pass, then the next ones on their own while more mail is waiting. On Workers the connection's Durable Object
 * chains passes on its alarm (dispatchMailSync); on Node a timer does, when MAIL_SYNC_CHAIN_MS is set (the local E2E server).
 */
export async function syncAndChain(deps: Deps, connectionId: string, opts: { force?: boolean } = {}): Promise<SyncResult> {
  const r = await syncConnection(deps, connectionId, opts);
  if (r.more && !r.skipped) {
    if (deps.dispatchMailSync) {
      await deps.dispatchMailSync(connectionId).catch((err) => deps.log?.warn("mail_sync.chain_failed", { connection: connectionId, error: (err as Error).message }));
    } else if (deps.config.mailConnect.chainMs > 0) {
      const t = setTimeout(() => { void syncAndChain(deps, connectionId).catch(() => undefined); }, deps.config.mailConnect.chainMs);
      (t as unknown as { unref?: () => void }).unref?.();
    }
  }
  return r;
}

/** R57: the person pauses or resumes copying older mail (one write). New mail keeps syncing either way. */
export async function setBackfillPaused(deps: Deps, connectionId: string, paused: boolean) {
  const c = await deps.db.select({ syncState: mailConnections.syncState }).from(mailConnections).where(eq(mailConnections.id, connectionId)).get();
  if (!c) return;
  const state = parseState(c.syncState);
  const b = (state.bf ??= { day: today(deps.now()), n: 0 });
  b.paused = paused;
  await deps.db.update(mailConnections).set({ syncState: JSON.stringify(state), ...(paused ? {} : { nextSyncAt: deps.now() }) }).where(eq(mailConnections.id, connectionId));
}
