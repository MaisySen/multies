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
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { runBatch } from "../../db";
import { attachments, mailboxes, mailConnections, mailSyncOutbox, messages } from "../../db/schema";
import { newId, toB64 } from "../../lib/crypto";
import { makeSnippet, parseMime, type ParsedEmail } from "../mail/mime";
import { MAX_INLINE_ATTACHMENT_BYTES } from "../mail/store";
import { writeBudget } from "../write-budget";
import { connectionSecret, imapConnector, type Connection } from ".";
import { classifyProblem } from "./problems";
import { pickFolders, type FetchedMessage, type FolderPaths, type ImapSession, type RemoteFolder } from "./imap";
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
}
/**
 * Inbox and Sent cursors sit at the top level (round 18); round 19 adds the other synced folders
 * under `boxes` (Archive, Drafts, Spam, Trash, and the person's own folders as "f:<path>"), the
 * user folders the person turned on (`extra`, at most MAX_EXTRA_FOLDERS), and the provider's folder
 * list as last read (`list`, `listedAt`).
 */
export interface SyncState {
  inbox?: FolderState;
  sent?: FolderState;
  paths?: FolderPaths;
  boxes?: Record<string, FolderState>;
  extra?: string[];
  list?: RemoteFolder[];
  listedAt?: number;
}

export interface SyncResult {
  skipped?: "not_found" | "paused" | "auth_failed" | "budget" | "daily_cap" | "busy" | "unchanged" | "sample";
  stored: number;
  duplicates: number;
  flagsUpdated: number;
  pushed: number;
  /** More new mail is waiting than this pass took. */
  more: boolean;
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
  const doneToday = c.day === day ? c.messagesToday : 0;
  const allowance = Math.max(0, cfg.dailyCap - doneToday);

  const state = parseState(c.syncState);
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
        st = { path, v: opened.uidValidity, last: kept.length ? kept[0] - 1 : Math.max(0, opened.uidNext - 1) };
        setCursor(state, box, st);
      }
      if (budget <= 0) { result.more = result.more || (await session.uidsAfter(st.last)).length > 0; continue; }
      const pending = await session.uidsAfter(st.last);
      const take = pending.slice(0, budget);
      if (pending.length > take.length) result.more = true;
      if (take.length) {
        for (const m of await session.fetch(take, MAX_SYNC_BYTES)) fetched.push({ box, m });
        st.last = take[take.length - 1];
        budget -= take.length;
      }
    }


    result.flagsUpdated = flagCount;

    const stored = await storeBatch(deps, c, mb.orgId, fetched);
    result.stored = stored.stored;
    result.duplicates = stored.duplicates;
    const initialDone = c.initialDone || !result.more;
    await runBatch(deps.db, [
      ...stored.statements,
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

async function pullFlags(deps: Deps, c: Connection, session: ImapSession, box: string, st: FolderState) {
  const opened = await session.open(st.path);
  // R52: an unchanged folder (same modseq, count and next UID since its last full read) has no flag changes and
  // no removed mail: skip the FETCH FLAGS of up to FLAG_WINDOW messages and the local read of the same window.
  const fp = folderFingerprint(opened, st.last);
  if (fp && st.f === fp) return [];
  const lo = Math.max(1, st.last - FLAG_WINDOW + 1);
  const remote = await session.flags(lo, st.last);
  const local = await deps.db.select({ id: messages.id, remoteUid: messages.remoteUid, isRead: messages.isRead, isStarred: messages.isStarred, folder: messages.folder })
    .from(messages).where(and(eq(messages.mailboxId, c.mailboxId), eq(messages.remoteBox, box), gte(messages.remoteUid, lo), lte(messages.remoteUid, st.last)));
  const changes = [];
  for (const m of local) {
    const f = remote.get(m.remoteUid!);
    if (!f) {
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
  for (const f of fetched) {
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
  let stored = 0, duplicates = 0, bytes = 0;
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
  return { statements, stored, duplicates };
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
      else await syncConnection(deps, id);
      dispatched++;
    } catch (err) {
      deps.log?.warn("mail_sync.dispatch_failed", { connection: id, error: (err as Error).message });
    }
  }
  return { dispatched };
}
