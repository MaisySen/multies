/**
 * R102 Smart document inbox (DOC_INBOX_R102): Files > Documents.
 *
 * Every new drive upload (and a mail attachment its owner adds) is read: PDFs and images by our own document engine
 * (extract-text with OCR "auto", the same jobs as the attachment index), text, Word and Excel files on the Worker.
 * The text goes to the index database (doc_fts, rowid = doc_inbox.id), never the main one. Dates, amounts, GST, the
 * type and paid words are detected by rules and parsing only (doc-inbox-match.ts), then the workspace's rules run.
 *
 * Limits: DOC_LIMITS.dailyPerWorkspace documents a UTC day per workspace and dailyGlobal in all; over the cap a row
 * stays queued (shown as waiting) and is read the next day. The vv8k workspace is never read.
 * Access: every list, detail, text, field and search hit goes through the R101 drive check (accessForRows); field
 * edits need edit access; rules are written by owners and admins only. Workspace sessions only (no guests, portal or
 * keys: the routes use requireAuth like /api/drive). Nothing here runs on a hot read route.
 */
import { sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import type { DB } from "../../db";
import { driveItems } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import { newId } from "../../lib/crypto";
import { audit } from "../audit";
import { attachmentBytes } from "../mail/store";
import { engineFetch, type EngineConfig } from "../tools/engine-client";
import { extractLocal, ftsWords, orgToken, readableKind, textFromEngine } from "../tools/attachment-index";
import { writeBudget } from "../write-budget";
import { accessForRows, currentBytes, uploadFile } from "./drive-r101";
import { applyRules, detectFields, patternProblem, type ApplyRule } from "./doc-inbox-match";
import { DRIVE_LIMITS, cleanTags } from "@/shared/drive";
import {
  DOC_LIMITS as L, DOC_TYPES, isDocType, type DocCounts, type DocDetail, type DocField, type DocFields, type DocList, type DocMatch, type DocRow, type DocRule, type DocStatus, type DocType, type DocView,
} from "@/shared/doc-inbox";
import { canOpen, isPersonalOwner, personalInfo } from "../mail-access-priv1a";

type Actor = Pick<AuthContext, "orgId" | "userId" | "email" | "role">;
const isAdmin = (a: Actor) => a.role === "owner" || a.role === "admin";
const ENGINE_USER = "doc-inbox";
const EXCLUDED = ["vv8k"];
const FIELDS: DocField[] = ["type", "sender", "docDate", "dueDate", "amount", "gst", "paid"];

export const docInboxOn = (deps: Pick<Deps, "config">) => !!deps.config.docInbox;

interface InboxRow {
  id: number; item_id: string; org_id: string; source: "upload" | "mail"; mail_attachment_id: string | null; added_by: string; status: DocStatus; job_id: string | null; tries: number;
  version_id: string | null; doc_type: string | null; sender: string | null; doc_date: string | null; due_date: string | null; amount: number | null; gst: number | null; currency: string;
  paid: number; edited: string; rules: string; checked: number; chars: number; created_at: number; updated_at: number; read_at: number | null;
}
type ItemRow = typeof driveItems.$inferSelect;

// ---------------------------------------------------------------- workspace checks

const exclCache = new Map<string, boolean>();
/** The client workspace (vv8k) is never read: matched on its id, slug or name, as product analytics does. */
export async function excludedOrg(db: DB, orgId: string): Promise<boolean> {
  const hit = exclCache.get(orgId);
  if (hit !== undefined) return hit;
  const r = await db.all<{ id: string; slug: string | null; name: string | null }>(sql`select id, slug, name from organizations where id = ${orgId} limit 1`);
  const hay = r[0] ? [r[0].id, r[0].slug ?? "", r[0].name ?? ""].map((s) => s.toLowerCase()) : [orgId.toLowerCase()];
  const ex = EXCLUDED.some((x) => hay.some((h) => h.includes(x)));
  if (exclCache.size > 2000) exclCache.clear();
  exclCache.set(orgId, ex);
  return ex;
}

export const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/** Today's count for a workspace and for all; capped when either is at its limit. */
export async function quotaState(db: DB, orgId: string, now: Date): Promise<{ org: number; all: number; capped: boolean }> {
  const day = dayOf(now);
  const rows = await db.all<{ org_id: string; day: string; n: number }>(sql`select org_id, day, n from doc_inbox_state where org_id in (${orgId}, '*')`);
  const n = (id: string) => { const r = rows.find((x) => x.org_id === id); return r && r.day === day ? Number(r.n) : 0; };
  const org = n(orgId); const all = n("*");
  return { org, all, capped: org >= L.dailyPerWorkspace || all >= L.dailyGlobal };
}
async function countRead(db: DB, orgId: string, now: Date) {
  const day = dayOf(now); const t = now.getTime();
  for (const id of [orgId, "*"]) {
    await db.run(sql`insert into doc_inbox_state (org_id, day, n, updated_at) values (${id}, ${day}, 1, ${t})
      on conflict (org_id) do update set n = case when doc_inbox_state.day = ${day} then doc_inbox_state.n + 1 else 1 end, day = ${day}, updated_at = ${t}`);
  }
}

// ---------------------------------------------------------------- queue

/** Puts a drive file in the reading queue (or back in it for a new version or Read again). Files that cannot be read are kept as skipped. */
export async function enqueue(deps: Deps, a: { orgId: string; userId: string }, item: Pick<ItemRow, "id" | "name" | "sizeBytes" | "kind">, opts: { source?: "upload" | "mail"; mailAttachmentId?: string | null } = {}) {
  if (!docInboxOn(deps) || item.kind !== "file") return;
  const now = deps.now().getTime();
  const readable = !!readableKind(item.name) && Number(item.sizeBytes) <= L.maxReadBytes && !(await excludedOrg(deps.db, a.orgId));
  const status: DocStatus = readable ? "queued" : "skipped";
  await deps.db.run(sql`insert into doc_inbox (item_id, org_id, source, mail_attachment_id, added_by, status, tries, created_at, updated_at)
    values (${item.id}, ${a.orgId}, ${opts.source ?? "upload"}, ${opts.mailAttachmentId ?? null}, ${a.userId}, ${status}, 0, ${now}, ${now})
    on conflict (item_id) do update set status = ${status}, job_id = null, tries = 0, updated_at = ${now}`);
}

async function loadRow(db: DB, orgId: string, itemId: string): Promise<InboxRow | null> {
  const r = await db.all<InboxRow>(sql`select * from doc_inbox where org_id = ${orgId} and item_id = ${itemId} limit 1`);
  return r[0] ?? null;
}

function engineOf(deps: Deps): EngineConfig | null {
  const t = deps.config.tools;
  return t.enabled && t.engine ? t.engine : null;
}

async function submitJob(deps: Deps, engine: EngineConfig, orgId: string, name: string, bytes: Uint8Array): Promise<string | "busy" | "failed"> {
  const fd = new FormData();
  fd.append("files", new Blob([bytes as Uint8Array<ArrayBuffer>]), name.replace(/[\r\n"]/g, " ").slice(0, 200) || "file");
  fd.append("ocr", "auto");
  fd.append("language", "eng");
  const req = new Request("http://local/x", { method: "POST", body: fd });
  const body = new Uint8Array(await req.arrayBuffer());
  let res: Response;
  try {
    res = await engineFetch(deps.fetch, engine, {
      method: "POST", path: "/internal/v1/jobs?op=extract-text", ws: orgId, user: ENGINE_USER, maxBytes: body.byteLength,
      body: new Blob([body]).stream(), contentLength: body.byteLength, contentType: req.headers.get("content-type") ?? "multipart/form-data",
    });
  } catch { return "busy"; }
  if (res.status === 429 || res.status >= 500) { await res.body?.cancel().catch(() => undefined); return "busy"; }
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); return "failed"; }
  const j = (await res.json().catch(() => null)) as { id?: string } | null;
  return j?.id && /^[A-Za-z0-9_-]{6,80}$/.test(j.id) ? j.id : "failed";
}

/** Starts reading one queued row: text files at once, PDFs and images through the engine. Answers what happened. */
async function startRead(deps: Deps, row: InboxRow): Promise<"done" | "reading" | "busy" | "failed" | "capped"> {
  const now = deps.now();
  if (await excludedOrg(deps.db, row.org_id)) { await setStatus(deps.db, row.id, "skipped", now); return "failed"; }
  if ((await quotaState(deps.db, row.org_id, now)).capped) return "capped";
  const file = await currentBytes(deps, row.org_id, row.item_id);
  if (!file) { await deps.db.run(sql`delete from doc_inbox where id = ${row.id}`); return "failed"; }
  const kind = readableKind(file.name);
  if (!kind || file.bytes.length > L.maxReadBytes) { await setStatus(deps.db, row.id, "skipped", now); return "failed"; }
  if (kind === "local") {
    const text = extractLocal(file.name, file.bytes);
    await countRead(deps.db, row.org_id, now);
    if (text === null) { await setStatus(deps.db, row.id, "failed", now); return "failed"; }
    await finish(deps, { ...row, version_id: file.versionId }, text);
    return "done";
  }
  const engine = engineOf(deps);
  if (!engine) return "busy";
  const started = await submitJob(deps, engine, row.org_id, file.name, file.bytes);
  if (started === "busy") return "busy";
  await countRead(deps.db, row.org_id, now);
  if (started === "failed") { await deps.db.run(sql`update doc_inbox set status = 'failed', tries = tries + 1, updated_at = ${now.getTime()} where id = ${row.id}`); return "failed"; }
  await deps.db.run(sql`update doc_inbox set status = 'reading', job_id = ${started}, version_id = ${file.versionId}, tries = tries + 1, updated_at = ${now.getTime()} where id = ${row.id} and status = 'queued'`);
  return "reading";
}

async function setStatus(db: DB, id: number, status: DocStatus, now: Date) {
  await db.run(sql`update doc_inbox set status = ${status}, job_id = null, updated_at = ${now.getTime()} where id = ${id}`);
}

/** Checks one engine job: writes the text when it is done. */
async function collect(deps: Deps, row: InboxRow): Promise<"done" | "wait" | "failed" | "busy"> {
  const engine = engineOf(deps);
  if (!engine || !row.job_id) return "busy";
  const now = deps.now();
  const call = (path: string, method: "GET" | "DELETE" = "GET") => engineFetch(deps.fetch, engine, { method, path, ws: row.org_id, user: ENGINE_USER, maxBytes: 0 });
  let res: Response;
  try { res = await call(`/internal/v1/jobs/${row.job_id}`); } catch { return "busy"; }
  const retry = async () => {
    if (row.tries >= L.maxTries) await setStatus(deps.db, row.id, "failed", now);
    else await deps.db.run(sql`update doc_inbox set status = 'queued', job_id = null, updated_at = ${now.getTime()} where id = ${row.id}`);
    return "failed" as const;
  };
  if (res.status === 404) return retry();
  if (res.status === 429 || res.status >= 500) { await res.body?.cancel().catch(() => undefined); return "busy"; }
  const j = (await res.json().catch(() => null)) as { status?: string } | null;
  const status = j?.status ?? "";
  if (status === "done") {
    const out = await call(`/internal/v1/jobs/${row.job_id}/output`);
    if (!out.ok) { await out.body?.cancel().catch(() => undefined); return retry(); }
    const { text } = textFromEngine(await out.json().catch(() => null));
    await finish(deps, row, text);
    await call(`/internal/v1/jobs/${row.job_id}`, "DELETE").then((r) => r.body?.cancel()).catch(() => undefined);
    return "done";
  }
  if (status === "failed" || status === "error" || status === "expired") { await setStatus(deps.db, row.id, "failed", now); return "failed"; }
  if (now.getTime() - Number(row.updated_at) > L.jobTimeoutMs) return retry();
  return "wait";
}

// ---------------------------------------------------------------- finishing: text, fields, rules

async function writeText(deps: Deps, row: Pick<InboxRow, "id" | "item_id" | "org_id">, text: string) {
  const idx = deps.indexDb;
  if (!idx) return;
  await idx.run(sql`delete from doc_fts where rowid = ${row.id}`);
  if (text) await idx.run(sql`insert into doc_fts (rowid, text, scope, item_id, org_id) values (${row.id}, ${text}, ${orgToken(row.org_id)}, ${row.item_id}, ${row.org_id})`);
}

async function readText(deps: Deps, row: Pick<InboxRow, "id" | "org_id">): Promise<string | null> {
  const idx = deps.indexDb;
  if (!idx) return null;
  const r = await idx.all<{ text: string; org_id: string }>(sql`select text, org_id from doc_fts where rowid = ${row.id} limit 1`);
  return r[0] && r[0].org_id === row.org_id ? r[0].text : null;
}

const editedSet = (s: string) => new Set(s.split(",").filter(Boolean) as DocField[]);

async function loadRules(db: DB, orgId: string): Promise<(ApplyRule & { name: string })[]> {
  const rows = await db.all<{ id: string; name: string; match: DocMatch; pattern: string; case_sensitive: number; set_tags: string; set_sender: string | null; set_type: string | null; set_folder_id: string | null; position: number; enabled: number }>(
    sql`select id, name, match, pattern, case_sensitive, set_tags, set_sender, set_type, set_folder_id, position, enabled from doc_rules where org_id = ${orgId} order by position, id limit ${L.rules}`);
  return rows.map((r) => ({
    id: r.id, name: r.name, match: r.match, pattern: r.pattern, caseSensitive: !!r.case_sensitive, setTags: r.set_tags.split(",").filter(Boolean), setSender: r.set_sender,
    setType: isDocType(r.set_type) ? r.set_type : null, setFolderId: r.set_folder_id, position: Number(r.position), enabled: !!r.enabled,
  }));
}

/** Detects fields (keeping the ones a person corrected), runs the rules and writes the outcome to the row and the drive item. */
async function applyAll(deps: Deps, row: InboxRow, text: string, opts: { detect: boolean }) {
  const now = deps.now().getTime();
  const edited = editedSet(row.edited);
  const f = opts.detect ? detectFields(text) : null;
  const rules = await loadRules(deps.db, row.org_id);
  const out = applyRules(rules, text, edited);
  const keep = (field: DocField, detected: unknown, current: unknown) => (edited.has(field) ? current : detected);
  const docType = out.type ?? keep("type", f ? f.type : row.doc_type, row.doc_type);
  const sender = out.sender ?? keep("sender", f ? f.sender : row.sender, row.sender);
  const set = {
    doc_type: docType as string | null, sender: sender as string | null,
    doc_date: keep("docDate", f ? f.docDate : row.doc_date, row.doc_date) as string | null,
    due_date: keep("dueDate", f ? f.dueDate : row.due_date, row.due_date) as string | null,
    amount: keep("amount", f ? f.amount : row.amount, row.amount) as number | null,
    gst: keep("gst", f ? f.gst : row.gst, row.gst) as number | null,
    paid: (keep("paid", f ? (f.paid ? 1 : 0) : row.paid, row.paid) as number) ? 1 : 0,
    currency: f ? f.currency : row.currency,
  };
  await deps.db.run(sql`update doc_inbox set doc_type = ${set.doc_type}, sender = ${set.sender}, doc_date = ${set.doc_date}, due_date = ${set.due_date}, amount = ${set.amount}, gst = ${set.gst},
    paid = ${set.paid}, currency = ${set.currency}, rules = ${out.applied.join(",")}, updated_at = ${now} where id = ${row.id}`);
  // Tags and the folder land on the drive item itself, so Files shows them too.
  const item = (await deps.db.select().from(driveItems).where(sql`${driveItems.id} = ${row.item_id} and ${driveItems.orgId} = ${row.org_id}`).limit(1))[0];
  if (!item || item.trashedAt) return;
  const patch: Partial<ItemRow> = {};
  if (out.tags.length) {
    const tags = cleanTags([...(item.tags ? item.tags.split(",").filter(Boolean) : []), ...out.tags]).join(",");
    if (tags !== item.tags) patch.tags = tags;
  }
  if (out.folderId && out.folderId !== item.parentId) {
    const folder = (await deps.db.select().from(driveItems).where(sql`${driveItems.id} = ${out.folderId} and ${driveItems.orgId} = ${row.org_id}`).limit(1))[0];
    // Only inside the same space and the same My files: a private file never moves into Team files.
    if (folder && folder.kind === "folder" && !folder.trashedAt && folder.space === item.space && (item.space !== "private" || folder.ownerId === item.ownerId) && item.space !== "brand") patch.parentId = folder.id;
  }
  if (Object.keys(patch).length) await deps.db.update(driveItems).set({ ...patch, updatedAt: now }).where(sql`${driveItems.id} = ${item.id}`);
}

async function finish(deps: Deps, row: InboxRow, textIn: string) {
  const text = (textIn ?? "").slice(0, L.textCap);
  const now = deps.now().getTime();
  await writeText(deps, row, text);
  await deps.db.run(sql`update doc_inbox set status = 'done', job_id = null, chars = ${text.length}, version_id = ${row.version_id}, read_at = ${now}, checked = 0, updated_at = ${now} where id = ${row.id}`);
  await applyAll(deps, { ...row, status: "done" }, text, { detect: true });
}

// ---------------------------------------------------------------- passes

export interface DocPassReport { stop: string | null; collected: number; started: number; capped: number; failed: number }

/** The cron pass: collects finished engine jobs, then starts reading queued rows within the caps. */
export async function runDocPass(deps: Deps): Promise<DocPassReport> {
  const rep: DocPassReport = { stop: null, collected: 0, started: 0, capped: 0, failed: 0 };
  try {
    if (!docInboxOn(deps)) { rep.stop = "flag_off"; return rep; }
    const r = await writeBudget(deps);
    if (r.level === "warn" || r.level === "shed") { rep.stop = "d1_level"; return rep; }
    // Files deleted forever leave Documents and the index.
    const gone = await deps.db.all<{ id: number; org_id: string; item_id: string }>(sql`select d.id, d.org_id, d.item_id from doc_inbox d left join drive_items i on i.id = d.item_id where i.id is null limit 100`);
    if (gone.length) {
      const ids = gone.map((g) => Number(g.id));
      if (deps.indexDb) await deps.indexDb.run(sql`delete from doc_fts where rowid in (select value from json_each(${JSON.stringify(ids)}))`);
      await deps.db.run(sql`delete from doc_inbox where id in (select value from json_each(${JSON.stringify(ids)}))`);
    }
    const reading = await deps.db.all<InboxRow>(sql`select * from doc_inbox where status = 'reading' order by updated_at limit 12`);
    for (const row of reading) { const s = await collect(deps, row); if (s === "done") rep.collected++; else if (s === "failed") rep.failed++; else if (s === "busy") break; }
    const queued = await deps.db.all<InboxRow>(sql`select * from doc_inbox where status = 'queued' order by created_at limit 40`);
    const cappedOrgs = new Set<string>();
    for (const row of queued) {
      if (rep.started >= L.submitPerPass) break;
      if (cappedOrgs.has(row.org_id)) continue;
      const s = await startRead(deps, row);
      if (s === "capped") { cappedOrgs.add(row.org_id); rep.capped++; continue; }
      if (s === "busy") break;
      if (s === "failed") rep.failed++; else rep.started++;
    }
  } catch (err) {
    deps.log?.warn("doc_inbox.pass_failed", { error: err instanceof Error ? err.message : String(err) });
    deps.reportError?.(err, { where: "doc_inbox.pass" });
  }
  if (rep.collected || rep.started || rep.failed) deps.log?.info?.("doc_inbox.pass", { ...rep });
  return rep;
}

/** When someone opens Documents: collects up to two finished jobs and starts up to two waiting rows of that workspace, so a new upload shows in seconds. */
export async function nudgeOrg(deps: Deps, orgId: string) {
  if (!docInboxOn(deps)) return;
  try {
    const reading = await deps.db.all<InboxRow>(sql`select * from doc_inbox where org_id = ${orgId} and status = 'reading' order by updated_at limit ${L.collectOnOpen}`);
    for (const row of reading) if ((await collect(deps, row)) === "busy") break;
    const queued = await deps.db.all<InboxRow>(sql`select * from doc_inbox where org_id = ${orgId} and status = 'queued' order by created_at limit ${L.collectOnOpen}`);
    for (const row of queued) { const s = await startRead(deps, row); if (s === "capped" || s === "busy") break; }
  } catch (err) {
    deps.log?.warn("doc_inbox.nudge_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------- reads (all through the drive access check)

interface JoinRow extends InboxRow { name: string; content_type: string | null; size_bytes: number; space: "team" | "private" | "brand"; tags: string; parent_id: string | null; owner_id: string | null }
const CAP_ROWS = 1000;

async function visibleRows(deps: Deps, a: Actor, ids?: number[]): Promise<{ rows: JoinRow[]; edit: Map<string, boolean> }> {
  if (ids && !ids.length) return { rows: [], edit: new Map() };
  const rows = await deps.db.all<JoinRow>(sql`select d.*, i.name as name, i.content_type as content_type, i.size_bytes as size_bytes, i.space as space, i.tags as tags, i.parent_id as parent_id, i.owner_id as owner_id
    from doc_inbox d join drive_items i on i.id = d.item_id
    where d.org_id = ${a.orgId} and i.org_id = ${a.orgId} and i.trashed_at is null and i.kind = 'file'
      ${ids ? sql`and d.id in (select value from json_each(${JSON.stringify(ids.slice(0, 500))}))` : sql``}
    order by d.created_at desc, d.id desc limit ${CAP_ROWS}`);
  // Team and brand files, and the caller's own My files, are open to them; the rest go through the shares check.
  const edit = new Map<string, boolean>();
  const rest: JoinRow[] = [];
  for (const r of rows) {
    if (r.space === "team") edit.set(r.item_id, true);
    else if (r.space === "brand") edit.set(r.item_id, isAdmin(a));
    else if (r.owner_id === a.userId) edit.set(r.item_id, true);
    else rest.push(r);
  }
  if (rest.length) {
    const items = await deps.db.select().from(driveItems).where(inIds(driveItems.id, rest.slice(0, 200).map((r) => r.item_id))).all();
    const acc = await accessForRows(deps.db, a, items);
    for (const [id, v] of acc) edit.set(id, v.edit);
  }
  return { rows: rows.filter((r) => edit.has(r.item_id)), edit };
}

const iso = (ms: number | null) => (ms ? new Date(Number(ms)).toISOString() : null);
function fieldsOf(r: InboxRow): DocFields {
  return { type: isDocType(r.doc_type) ? r.doc_type : null, sender: r.sender, docDate: r.doc_date, dueDate: r.due_date, amount: r.amount === null ? null : Number(r.amount), gst: r.gst === null ? null : Number(r.gst), currency: r.currency || "AUD", paid: !!r.paid };
}
function shapeRow(r: JoinRow, canEdit: boolean, capped: boolean, snippet?: string): DocRow {
  return {
    id: r.item_id, name: r.name, contentType: r.content_type, sizeBytes: Number(r.size_bytes), space: r.space, status: r.status, capped: capped && r.status === "queued",
    source: r.source, fields: fieldsOf(r), edited: [...editedSet(r.edited)], checked: !!r.checked, tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
    addedAt: iso(r.created_at)!, readAt: iso(r.read_at), canEdit, ...(snippet ? { snippet } : {}),
  };
}

const inView = (r: JoinRow, v: DocView) => {
  switch (v) {
    case "check": return !r.checked && (r.status === "done" || r.status === "failed");
    case "all": return true;
    case "unpaid": return r.doc_type === "bill" && !r.paid;
    case "tax": return r.doc_type === "tax";
    case "bills": return r.doc_type === "bill";
    case "receipts": return r.doc_type === "receipt";
  }
};

/** Full text hits in the index for a workspace: rowids with a snippet. */
async function textHits(deps: Deps, orgId: string, q: string, limit = 200): Promise<Map<number, string>> {
  const idx = deps.indexDb;
  const words = ftsWords(q);
  if (!idx || !words.length) return new Map();
  const body = words.map((w, i) => `"${w}"${i === words.length - 1 && w.length >= 2 ? "*" : ""}`).join(" ");
  const match = `scope : "${orgToken(orgId)}" AND text : (${body})`;
  const hits = await idx.all<{ id: number; snip: string | null }>(sql`select rowid as id, snippet(doc_fts, 0, '', '', '...', 16) as snip from doc_fts
    where doc_fts match ${match} and org_id = ${orgId} order by rowid desc limit ${limit}`);
  return new Map(hits.map((h) => [Number(h.id), (h.snip ?? "").replace(/\s+/g, " ").trim()]));
}

export async function listDocs(deps: Deps, a: Actor, view: DocView, opts: { q?: string; cursor?: number } = {}): Promise<DocList> {
  await nudgeOrg(deps, a.orgId);
  const q = (opts.q ?? "").trim().slice(0, 200);
  const { rows, edit } = await visibleRows(deps, a);
  const quota = await quotaState(deps.db, a.orgId, deps.now());
  const counts: DocCounts = { check: 0, all: rows.length, unpaid: 0, tax: 0, bills: 0, receipts: 0, waiting: 0, capped: false };
  for (const r of rows) {
    if (inView(r, "check")) counts.check++;
    if (inView(r, "unpaid")) counts.unpaid++;
    if (inView(r, "tax")) counts.tax++;
    if (inView(r, "bills")) counts.bills++;
    if (inView(r, "receipts")) counts.receipts++;
    if (r.status === "queued" || r.status === "reading") counts.waiting++;
  }
  counts.capped = quota.capped && rows.some((r) => r.status === "queued");
  const searching = q.length >= 2;
  const snippets = searching ? await textHits(deps, a.orgId, q) : new Map<number, string>();
  const lower = q.toLowerCase();
  const list = searching
    ? rows.filter((r) => snippets.has(r.id) || r.name.toLowerCase().includes(lower) || (r.sender ?? "").toLowerCase().includes(lower))
    : rows.filter((r) => inView(r, view));
  const start = Math.max(0, Math.trunc(opts.cursor ?? 0));
  const page = list.slice(start, start + L.page);
  return { items: page.map((r) => shapeRow(r, edit.get(r.item_id) ?? false, quota.capped, snippets.get(r.id))), counts, next: start + L.page < list.length ? String(start + L.page) : null };
}

async function one(deps: Deps, a: Actor, itemId: string): Promise<{ row: JoinRow; canEdit: boolean }> {
  const r = await loadRow(deps.db, a.orgId, itemId);
  if (!r) throw notFound("Document");
  const { rows, edit } = await visibleRows(deps, a, [r.id]);
  if (!rows[0]) throw notFound("Document");
  return { row: rows[0], canEdit: edit.get(itemId) ?? false };
}

export async function getDoc(deps: Deps, a: Actor, itemId: string): Promise<DocDetail> {
  const r0 = await loadRow(deps.db, a.orgId, itemId);
  if (r0?.status === "reading") await collect(deps, r0).catch(() => undefined);
  const { row, canEdit } = await one(deps, a, itemId);
  const quota = await quotaState(deps.db, a.orgId, deps.now());
  const text = row.status === "done" ? await readText(deps, row) : null;
  const ruleIds = row.rules.split(",").filter(Boolean);
  const rules = ruleIds.length ? await deps.db.all<{ id: string; name: string }>(sql`select id, name from doc_rules where org_id = ${a.orgId} and ${inIds(sql`id`, ruleIds)}`) : [];
  let folder = { id: null as string | null, name: row.space === "private" ? "My files" : row.space === "brand" ? "Brand library" : "Team files" };
  if (row.parent_id) {
    const f = await deps.db.all<{ id: string; name: string }>(sql`select id, name from drive_items where id = ${row.parent_id} and org_id = ${a.orgId} limit 1`);
    if (f[0]) folder = f[0];
  }
  return { ...shapeRow(row, canEdit, quota.capped), text: text === null ? null : text.slice(0, 50_000), rulesApplied: rules, folder };
}

// ---------------------------------------------------------------- writes on a document (edit access)

export interface FieldPatch { type?: DocType | null; sender?: string | null; docDate?: string | null; dueDate?: string | null; amount?: number | null; gst?: number | null; paid?: boolean; checked?: boolean }
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function updateDoc(deps: Deps, a: Actor, itemId: string, p: FieldPatch): Promise<DocDetail> {
  const { row, canEdit } = await one(deps, a, itemId);
  if (!canEdit) throw new HttpError(403, "forbidden", "You can look at this document but not change it.");
  const edited = editedSet(row.edited);
  const set: Record<string, unknown> = {};
  const mark = (f: DocField) => edited.add(f);
  if (p.type !== undefined) { if (p.type !== null && !isDocType(p.type)) throw new HttpError(422, "validation_failed", "Pick a type from the list."); set.doc_type = p.type; mark("type"); }
  if (p.sender !== undefined) { set.sender = p.sender ? p.sender.replace(/\s+/g, " ").trim().slice(0, L.sender) || null : null; mark("sender"); }
  for (const [k, col, f] of [["docDate", "doc_date", "docDate"], ["dueDate", "due_date", "dueDate"]] as const) {
    const v = p[k];
    if (v === undefined) continue;
    if (v !== null && !DATE.test(v)) throw new HttpError(422, "validation_failed", "Use a real date.");
    set[col] = v; mark(f);
  }
  for (const [k, col] of [["amount", "amount"], ["gst", "gst"]] as const) {
    const v = p[k];
    if (v === undefined) continue;
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 99_999_999_99)) throw new HttpError(422, "validation_failed", "Use an amount like 120.50.");
    set[col] = v; mark(k);
  }
  if (p.paid !== undefined) { set.paid = p.paid ? 1 : 0; mark("paid"); }
  if (p.checked !== undefined) set.checked = p.checked ? 1 : 0;
  set.edited = [...edited].filter((f) => FIELDS.includes(f)).join(",");
  const now = deps.now().getTime();
  await deps.db.run(sql`update doc_inbox set
    doc_type = ${"doc_type" in set ? set.doc_type as string | null : row.doc_type}, sender = ${"sender" in set ? set.sender as string | null : row.sender},
    doc_date = ${"doc_date" in set ? set.doc_date as string | null : row.doc_date}, due_date = ${"due_date" in set ? set.due_date as string | null : row.due_date},
    amount = ${"amount" in set ? set.amount as number | null : row.amount}, gst = ${"gst" in set ? set.gst as number | null : row.gst},
    paid = ${"paid" in set ? set.paid as number : row.paid}, checked = ${"checked" in set ? set.checked as number : row.checked}, edited = ${set.edited as string}, updated_at = ${now}
    where id = ${row.id}`);
  return getDoc(deps, a, itemId);
}

/** Marks several documents as checked (only the ones the caller can edit). */
export async function checkDocs(deps: Deps, a: Actor, ids: string[], on = true): Promise<{ changed: number }> {
  const list = [...new Set(ids)].slice(0, L.page);
  if (!list.length) return { changed: 0 };
  const rows = await deps.db.all<{ id: number }>(sql`select id from doc_inbox where org_id = ${a.orgId} and ${inIds(sql`item_id`, list)}`);
  const { rows: vis, edit } = await visibleRows(deps, a, rows.map((r) => Number(r.id)));
  const ok = vis.filter((r) => edit.get(r.item_id)).map((r) => r.id);
  if (ok.length) await deps.db.run(sql`update doc_inbox set checked = ${on ? 1 : 0}, updated_at = ${deps.now().getTime()} where id in (select value from json_each(${JSON.stringify(ok)}))`);
  return { changed: ok.length };
}

export async function readAgain(deps: Deps, a: Actor, itemId: string): Promise<DocDetail> {
  const { row, canEdit } = await one(deps, a, itemId);
  if (!canEdit) throw new HttpError(403, "forbidden", "You can look at this document but not change it.");
  await enqueue(deps, a, { id: row.item_id, name: row.name, sizeBytes: row.size_bytes, kind: "file" }, { source: row.source, mailAttachmentId: row.mail_attachment_id });
  await nudgeOrg(deps, a.orgId);
  return getDoc(deps, a, itemId);
}

export async function rulesNow(deps: Deps, a: Actor, itemId: string): Promise<DocDetail> {
  const { row, canEdit } = await one(deps, a, itemId);
  if (!canEdit) throw new HttpError(403, "forbidden", "You can look at this document but not change it.");
  if (row.status !== "done") throw new HttpError(409, "not_ready", "This document has not been read yet.");
  const text = (await readText(deps, row)) ?? "";
  await applyAll(deps, row, text, { detect: false });
  return getDoc(deps, a, itemId);
}

/** "Read this file" on a drive file added before Documents was on (or a skipped one): needs edit access to the file. */
export async function addDriveFile(deps: Deps, a: Actor, itemId: string): Promise<DocDetail> {
  const item = (await deps.db.select().from(driveItems).where(sql`${driveItems.id} = ${itemId} and ${driveItems.orgId} = ${a.orgId}`).limit(1))[0];
  if (!item || item.trashedAt || item.kind !== "file") throw notFound("File");
  const acc = (await accessForRows(deps.db, a, [item])).get(item.id);
  if (!acc) throw notFound("File");
  if (!acc.edit) throw new HttpError(403, "forbidden", "Only people who can change this file can add it to Documents.");
  if (!readableKind(item.name)) throw new HttpError(422, "not_readable", "This kind of file cannot be read. PDFs, pictures, text, Word and Excel files can.");
  const existing = await loadRow(deps.db, a.orgId, item.id);
  if (!existing || existing.status === "skipped" || existing.status === "failed") await enqueue(deps, a, item);
  await nudgeOrg(deps, a.orgId);
  return getDoc(deps, a, item.id);
}

// ---------------------------------------------------------------- mail attachments (chosen by the mailbox's owner)

/** The mailbox is the person's own: their address, a mailbox granted to them, or (owners and admins) a shared mailbox no member's address matches. */
export async function canAddFromMailbox(db: DB, a: Actor, mailboxId: string): Promise<boolean> {
  const mb = (await db.all<{ address: string }>(sql`select address from mailboxes where id = ${mailboxId} and org_id = ${a.orgId} limit 1`))[0];
  if (!mb) return false;
  // PRIV1b (P21): a personal mailbox is decided here: its owner (nobody on an orphan, P9) who
  // can open it; never a share, never an admin by address. Team mailboxes keep the rule below.
  if (await personalInfo(db, a.orgId, mailboxId)) return (await isPersonalOwner(db, a, mailboxId)) === true && await canOpen(db, a, mailboxId);
  const me = (await db.all<{ email: string }>(sql`select email from users where id = ${a.userId} limit 1`))[0];
  if (me && me.email.toLowerCase() === mb.address.toLowerCase()) return true;
  const grant = await db.all<{ x: number }>(sql`select 1 as x from mailbox_access where user_id = ${a.userId} and mailbox_id = ${mailboxId} and org_id = ${a.orgId} limit 1`);
  if (grant.length) return true;
  if (!isAdmin(a)) return false;
  const owner = await db.all<{ x: number }>(sql`select 1 as x from members m join users u on u.id = m.user_id where m.organization_id = ${a.orgId} and lower(u.email) = ${mb.address.toLowerCase()} limit 1`);
  return owner.length === 0;
}

/** Mailboxes whose attachments the caller may add (the same rule as canAddFromMailbox), for the Add to documents button. */
export async function addableMailboxes(db: DB, a: Actor): Promise<string[]> {
  const boxes = await db.all<{ id: string; address: string }>(sql`select id, address from mailboxes where org_id = ${a.orgId} limit 200`);
  if (!boxes.length) return [];
  const me = (await db.all<{ email: string }>(sql`select email from users where id = ${a.userId} limit 1`))[0]?.email.toLowerCase() ?? "";
  const grants = new Set((await db.all<{ mailbox_id: string }>(sql`select mailbox_id from mailbox_access where user_id = ${a.userId} and org_id = ${a.orgId} limit 500`)).map((r) => r.mailbox_id));
  const owned = isAdmin(a) ? new Set((await db.all<{ email: string }>(sql`select lower(u.email) as email from members m join users u on u.id = m.user_id where m.organization_id = ${a.orgId} limit 2000`)).map((r) => r.email)) : new Set<string>();
  // PRIV1b (P21): personal mailboxes as canAddFromMailbox decides them: the owner's own (orphans: the workspace owner).
  const personal = new Map((await db.all<{ id: string; owner: string | null; member: string | null }>(sql`select m.id, m.owner_user_id as owner, x.user_id as member from mailboxes m
    left join members x on x.user_id = m.owner_user_id and x.organization_id = m.org_id where m.org_id = ${a.orgId} and m.personal = 1 limit 500`)).map((r) => [r.id, r.owner && r.member ? r.owner === a.userId : a.role === "owner"]));
  return boxes.filter((b) => (personal.has(b.id) ? personal.get(b.id) === true
    : b.address.toLowerCase() === me || grants.has(b.id) || (isAdmin(a) && !owned.has(b.address.toLowerCase())))).map((b) => b.id);
}

export async function addFromMail(deps: Deps, a: Actor, attachmentId: string): Promise<DocDetail> {
  const att = (await deps.db.all<{ id: string; filename: string; content_type: string; size_bytes: number; content_b64: string | null; storage_key: string | null; mailbox_id: string; org_id: string }>(sql`
    select t.id, t.filename, t.content_type, t.size_bytes, t.content_b64, t.storage_key, m.mailbox_id, m.org_id from attachments t join messages m on m.id = t.message_id
    where t.id = ${attachmentId} and m.org_id = ${a.orgId} limit 1`))[0];
  if (!att) throw notFound("Attachment");
  if (!(await canAddFromMailbox(deps.db, a, att.mailbox_id))) throw new HttpError(403, "forbidden", "Only the person whose mailbox this is can add its attachments.");
  const prior = (await deps.db.all<{ item_id: string }>(sql`select d.item_id from doc_inbox d join drive_items i on i.id = d.item_id
    where d.org_id = ${a.orgId} and d.mail_attachment_id = ${att.id} and d.added_by = ${a.userId} and i.trashed_at is null limit 1`))[0];
  if (prior) return getDoc(deps, a, prior.item_id);
  if (Number(att.size_bytes) > DRIVE_LIMITS.fileBytes) throw new HttpError(413, "file_too_large", `Files can be up to ${Math.round(DRIVE_LIMITS.fileBytes / (1024 * 1024))} MB here.`);
  const bytes = await attachmentBytes({ contentB64: att.content_b64, storageKey: att.storage_key }, deps.bodyStore);
  if (!bytes) throw new HttpError(404, "not_found", "This attachment is no longer stored.");
  const item = await uploadFile(deps, a, { space: "private", parentId: null, name: att.filename, contentType: att.content_type, bytes });
  await enqueue(deps, a, { id: item.id, name: item.name, sizeBytes: item.sizeBytes, kind: "file" }, { source: "mail", mailAttachmentId: att.id });
  // Text the attachment index already read is reused (no second engine job, nothing counted).
  const row = await loadRow(deps.db, a.orgId, item.id);
  if (row && row.status === "queued" && deps.indexDb) {
    const t = (await deps.db.all<{ id: number }>(sql`select id from attachment_text where attachment_id = ${att.id} and org_id = ${a.orgId} and status = 'done' limit 1`))[0];
    const text = t ? (await deps.indexDb.all<{ text: string; org_id: string }>(sql`select text, org_id from attachment_fts where rowid = ${t.id} limit 1`))[0] : undefined;
    if (text && text.org_id === a.orgId && text.text) await finish(deps, row, text.text);
  }
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "documents.added_from_mail", metadata: { itemId: item.id } });
  await nudgeOrg(deps, a.orgId);
  return getDoc(deps, a, item.id);
}

// ---------------------------------------------------------------- rules (owners and admins write; members read)

export interface RuleBody { name: string; match: DocMatch; pattern: string; caseSensitive?: boolean; setTags?: string[]; setSender?: string | null; setType?: DocType | null; setFolderId?: string | null; enabled?: boolean }

export async function listRules(deps: Deps, a: Actor): Promise<DocRule[]> {
  const rows = await deps.db.all<{ id: string; name: string; match: DocMatch; pattern: string; case_sensitive: number; set_tags: string; set_sender: string | null; set_type: string | null; set_folder_id: string | null; position: number; enabled: number; updated_at: number; folder_name: string | null }>(sql`
    select r.*, f.name as folder_name from doc_rules r left join drive_items f on f.id = r.set_folder_id and f.org_id = r.org_id and f.trashed_at is null
    where r.org_id = ${a.orgId} order by r.position, r.id limit ${L.rules}`);
  return rows.map((r) => ({
    id: r.id, name: r.name, match: r.match, pattern: r.pattern, caseSensitive: !!r.case_sensitive, setTags: r.set_tags.split(",").filter(Boolean), setSender: r.set_sender,
    setType: isDocType(r.set_type) ? r.set_type : null, setFolderId: r.folder_name ? r.set_folder_id : null, setFolderName: r.folder_name, position: Number(r.position), enabled: !!r.enabled, updatedAt: iso(r.updated_at)!,
  }));
}

function assertAdmin(a: Actor) { if (!isAdmin(a)) throw new HttpError(403, "forbidden", "Only owners and admins can change rules."); }

async function cleanRule(deps: Deps, a: Actor, b: RuleBody) {
  const name = b.name.replace(/\s+/g, " ").trim().slice(0, L.ruleName);
  if (!name) throw new HttpError(422, "validation_failed", "Give the rule a name.");
  const pattern = b.pattern.trim();
  const problem = patternProblem(b.match, pattern);
  if (problem) throw new HttpError(422, "validation_failed", problem);
  const setTags = cleanTags(b.setTags ?? []);
  const setSender = b.setSender ? b.setSender.replace(/\s+/g, " ").trim().slice(0, L.sender) || null : null;
  const setType = b.setType ?? null;
  if (setType !== null && !(DOC_TYPES as readonly string[]).includes(setType)) throw new HttpError(422, "validation_failed", "Pick a type from the list.");
  let setFolderId: string | null = null;
  if (b.setFolderId) {
    const f = (await deps.db.select().from(driveItems).where(sql`${driveItems.id} = ${b.setFolderId} and ${driveItems.orgId} = ${a.orgId}`).limit(1))[0];
    if (!f || f.kind !== "folder" || f.trashedAt || f.space !== "team") throw new HttpError(422, "validation_failed", "Pick a folder in Team files.");
    setFolderId = f.id;
  }
  if (!setTags.length && !setSender && !setType && !setFolderId) throw new HttpError(422, "validation_failed", "Choose at least one thing the rule sets.");
  return { name, pattern, setTags, setSender, setType, setFolderId };
}

export async function createRule(deps: Deps, a: Actor, b: RuleBody): Promise<DocRule> {
  assertAdmin(a);
  const c = await cleanRule(deps, a, b);
  const n = (await deps.db.all<{ n: number; p: number | null }>(sql`select count(*) as n, max(position) as p from doc_rules where org_id = ${a.orgId}`))[0];
  if (Number(n?.n ?? 0) >= L.rules) throw new HttpError(422, "too_many", `A workspace can have up to ${L.rules} rules.`);
  const id = newId("drl");
  const now = deps.now().getTime();
  await deps.db.run(sql`insert into doc_rules (id, org_id, name, match, pattern, case_sensitive, set_tags, set_sender, set_type, set_folder_id, position, enabled, created_by, created_at, updated_at)
    values (${id}, ${a.orgId}, ${c.name}, ${b.match}, ${c.pattern}, ${b.caseSensitive ? 1 : 0}, ${c.setTags.join(",")}, ${c.setSender}, ${c.setType}, ${c.setFolderId}, ${Number(n?.p ?? -1) + 1}, ${b.enabled === false ? 0 : 1}, ${a.userId}, ${now}, ${now})`);
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "documents.rule_created", metadata: { ruleId: id } });
  return (await listRules(deps, a)).find((r) => r.id === id)!;
}

export async function updateRule(deps: Deps, a: Actor, id: string, b: RuleBody): Promise<DocRule> {
  assertAdmin(a);
  const cur = await deps.db.all<{ id: string }>(sql`select id from doc_rules where id = ${id} and org_id = ${a.orgId} limit 1`);
  if (!cur.length) throw notFound("Rule");
  const c = await cleanRule(deps, a, b);
  await deps.db.run(sql`update doc_rules set name = ${c.name}, match = ${b.match}, pattern = ${c.pattern}, case_sensitive = ${b.caseSensitive ? 1 : 0}, set_tags = ${c.setTags.join(",")},
    set_sender = ${c.setSender}, set_type = ${c.setType}, set_folder_id = ${c.setFolderId}, enabled = ${b.enabled === false ? 0 : 1}, updated_at = ${deps.now().getTime()} where id = ${id} and org_id = ${a.orgId}`);
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "documents.rule_updated", metadata: { ruleId: id } });
  return (await listRules(deps, a)).find((r) => r.id === id)!;
}

export async function deleteRule(deps: Deps, a: Actor, id: string): Promise<{ deleted: boolean }> {
  assertAdmin(a);
  const r = await deps.db.all<{ id: string }>(sql`select id from doc_rules where id = ${id} and org_id = ${a.orgId} limit 1`);
  if (!r.length) throw notFound("Rule");
  await deps.db.run(sql`delete from doc_rules where id = ${id} and org_id = ${a.orgId}`);
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "documents.rule_deleted", metadata: { ruleId: id } });
  return { deleted: true };
}

/** Sets the order: ids top to bottom (ids of other workspaces are ignored). */
export async function reorderRules(deps: Deps, a: Actor, ids: string[]): Promise<DocRule[]> {
  assertAdmin(a);
  const mine = new Set((await deps.db.all<{ id: string }>(sql`select id from doc_rules where org_id = ${a.orgId} limit ${L.rules}`)).map((r) => r.id));
  const order = [...new Set(ids)].filter((x) => mine.has(x));
  const now = deps.now().getTime();
  for (const [i, id] of order.entries()) await deps.db.run(sql`update doc_rules set position = ${i}, updated_at = ${now} where id = ${id} and org_id = ${a.orgId}`);
  return listRules(deps, a);
}

/** Team folders a rule can file into (bounded). */
export async function ruleFolders(deps: Deps, a: Actor): Promise<{ id: string; name: string }[]> {
  return deps.db.all<{ id: string; name: string }>(sql`select id, name from drive_items where org_id = ${a.orgId} and space = 'team' and kind = 'folder' and trashed_at is null order by lower(name) limit 200`);
}

// ---------------------------------------------------------------- search (R98 Files group)

export interface DocSearchHit { itemId: string; name: string; snippet: string; at: number; sizeBytes: number }
/** Documents whose text matches, only ones the caller can open (the same check as Files). */
export async function searchDocs(deps: Deps, a: Actor, q: string, limit: number): Promise<DocSearchHit[]> {
  if (!docInboxOn(deps)) return [];
  const hits = await textHits(deps, a.orgId, q, Math.min(200, limit * 4));
  if (!hits.size) return [];
  const { rows } = await visibleRows(deps, a, [...hits.keys()]);
  return rows.slice(0, limit).map((r) => ({ itemId: r.item_id, name: r.name, snippet: hits.get(r.id) ?? "", at: Number(r.created_at), sizeBytes: Number(r.size_bytes) }));
}
