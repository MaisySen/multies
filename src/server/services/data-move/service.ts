/**
 * R38 move your data: the history of imports and exports, the export download link, the calendar, contacts and docs
 * importers, the whole workspace importer (a Multies export zip) and Undo.
 *
 * D1 writes (all essential: a person started each one):
 *   start a run       1 row (data_moves) plus its index
 *   each chunk        1 update on the run row, plus the items: a meeting 2, a contact 4 (its unique email and two indexes),
 *                     a doc about 6 (the doc, its tree position, a change row), tasks as counted in work-import/service.ts
 *   undo              1 delete per item (cascades remove comments, checklists, field values), 1 update on the run row
 * Item lists are written in chunks of 50 and read back in chunks of 90 ids (D1 binds at most 100 values a statement).
 * A big import stops near 15 seconds, at the day's cap or at the write budget's warn level, and the same call with the
 * run id carries on from where it stopped.
 */
import { and, desc, eq, inArray, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import type { AuthContext, Deps } from "../../context";
import { contacts, dataMoves, docs, mailboxes, meetings, messages, projectStatuses, projects, tasks, users } from "../../db/schema";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { newId, randomToken, sha256Hex } from "../../lib/crypto";
import { inIds } from "../../lib/sql-chunks";
import { audit } from "../audit";
import { writeBudget } from "../write-budget";
import { enqueue, registerJob } from "../jobs";
import { sendSystemEmail } from "../system-mail";
import { assertWritable, createdBy, sortableId, type SuiteActor } from "../suite/common";
import { hash36 } from "../suite/chat-ack-r33"; // R53 (MB-239): stable item ids under an Idempotency-Key
import { createDoc } from "../suite/docs";
import { markdownToDoc } from "../suite/markdown-doc";
import { invalidateStatuses } from "../suite/read-cache";
import { previewImport, runImport, type RunInput } from "../work-import/service";
import { base64Bytes, pageBody, pageTitle, ZIP_PREFIX } from "../work-import/parse";
import { MoveFileError, parseIcsEvents, readContacts, type ContactIn, type EventIn } from "./formats";
import { dropKeptFile, keepImportInput } from "./kept-file"; // R43 imports finish after the page closes

export const EXPORT_LINK_HOURS = 24;
/** One export a workspace every 10 minutes: an export reads everything, so a loop of them would be costly. */
export const EXPORT_EVERY_MS = 10 * 60_000;
export const CHUNK = 50;
export const MAX_ITEMS = 5_000;
const STEP_MS = 15_000;

export type MoveKind = "tasks" | "calendar" | "contacts" | "docs" | "workspace";
type Created = { tasks?: string[]; statuses?: string[]; projects?: string[]; projectCreated?: boolean; meetings?: string[]; contacts?: string[]; docs?: string[]; messages?: string[]; mailboxId?: string };

const parseJson = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };

// PRIV1b (P8): an agent key resolves as role admin, but it acts only as its agent. An export (which adds the key
// creator's own mailboxes) or an import is for people and workspace keys.
function refuseAgentKey(actor: SuiteActor) {
  if (actor.agentId) throw new HttpError(403, "agent_key_scope", "Agent keys can't export or import the workspace. Use a workspace key.");
}

function requireAdmin(actor: SuiteActor) {
  refuseAgentKey(actor);
  if (actor.role !== "owner" && actor.role !== "admin") throw forbidden("Only workspace owners and admins can export the whole workspace.");
}

/* R40 sec: imports bring a whole file into the workspace and undo deletes everything an import made, whoever made
 * it, so both are for owners and admins (and workspace keys, which act as admin), like the export. */
function requireImportAdmin(actor: SuiteActor) {
  if (actor.system) return;
  refuseAgentKey(actor);
  if (actor.role !== "owner" && actor.role !== "admin") throw forbidden("Only workspace owners and admins can import or undo an import.");
}

/** R44: a real email address (a workspace key's actor email is its label, "api-key:mm_live_..."). */
export function isAddress(v: string | null | undefined): v is string {
  return !!v && /^[^\s@:]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * R44: the email a run records as who started it. Started through a workspace key, the actor email is the key label,
 * so the history line read "by api-key:mm_live_..." (and, before R43b's fix, the done email went to that label).
 * Read the key creator's account email instead: one indexed read, only when a run starts through a key, never on a
 * hot read route. Null when the key outlived its creator's membership (the line then names nobody).
 */
export async function starterEmail(deps: Deps, actor: SuiteActor): Promise<string | null> {
  if (isAddress(actor.email)) return actor.email;
  if (!actor.userId) return null;
  const u = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, actor.userId)).get();
  return isAddress(u?.email) ? u!.email : null;
}

export function presentMove(m: typeof dataMoves.$inferSelect) {
  const created = parseJson<Created>(m.created, {});
  const counts = parseJson<Record<string, number>>(m.counts, {});
  const made = (created.tasks?.length ?? 0) + (created.meetings?.length ?? 0) + (created.contacts?.length ?? 0) + (created.docs?.length ?? 0) + (created.messages?.length ?? 0);
  return {
    id: m.id, kind: m.kind, source: m.source, fileName: m.fileName, status: m.status, projectId: m.projectId,
    total: m.total, done: m.done, counts, created: made,
    canUndo: m.kind === "import" && m.status !== "undone" && made > 0,
    expiresAt: m.expiresAt?.toISOString() ?? null, error: m.error, by: isAddress(m.createdByEmail) ? m.createdByEmail : null, // R44: never a key label
    createdAt: m.createdAt.toISOString(), finishedAt: m.finishedAt?.toISOString() ?? null, undoneAt: m.undoneAt?.toISOString() ?? null,
    // R43: the upload is kept, so the scheduled pass finishes the run if its page closes.
    background: Boolean(m.fileKey) && (m.status === "running" || m.status === "stopped"),
  };
}

/** The last 50 imports and exports in the workspace, newest first. */
export async function listMoves(deps: Deps, actor: SuiteActor) {
  const rows = await deps.db.select().from(dataMoves).where(eq(dataMoves.orgId, actor.orgId)).orderBy(desc(dataMoves.createdAt)).limit(50);
  const now = deps.now().getTime();
  return { items: rows.map((r) => presentMove(r.status === "ready" && r.expiresAt && r.expiresAt.getTime() < now ? { ...r, status: "expired" as const } : r)) };
}

async function moveRow(deps: Deps, orgId: string, id: string) {
  const m = await deps.db.select().from(dataMoves).where(and(eq(dataMoves.id, id), eq(dataMoves.orgId, orgId))).get();
  if (!m) throw notFound("Import or export");
  return m;
}

export async function getMove(deps: Deps, actor: SuiteActor, id: string) {
  return presentMove(await moveRow(deps, actor.orgId, id));
}

// ------------------------------------------------------------------ export

/** Counts what an export holds, so the summary can show it before the download starts. Reads only. */
async function exportCounts(deps: Deps, orgId: string) {
  const one = async (t: typeof tasks | typeof projects | typeof docs | typeof meetings | typeof contacts) =>
    (await deps.db.select({ n: sql<number>`count(*)` }).from(t).where(eq(t.orgId, orgId)).get())?.n ?? 0;
  const [p, t, d, m, c] = await Promise.all([one(projects), one(tasks), one(docs), one(meetings), one(contacts)]);
  return { projects: p, tasks: t, docs: d, meetings: m, contacts: c };
}

/**
 * Starts a workspace export: admins only, one every 10 minutes, written to the audit log. Answers a download link that
 * works for 24 hours without signing in (the token is stored only as a hash). The ZIP is built while it downloads,
 * so nothing large is stored.
 */
export async function startExport(deps: Deps, actor: SuiteActor) {
  requireAdmin(actor);
  const last = await deps.db.select({ createdAt: dataMoves.createdAt }).from(dataMoves)
    .where(and(eq(dataMoves.orgId, actor.orgId), eq(dataMoves.kind, "export"))).orderBy(desc(dataMoves.createdAt)).limit(1).get();
  const now = deps.now();
  if (last && now.getTime() - last.createdAt.getTime() < EXPORT_EVERY_MS) {
    const wait = Math.ceil((EXPORT_EVERY_MS - (now.getTime() - last.createdAt.getTime())) / 60_000);
    throw new HttpError(429, "rate_limited", `An export was started a moment ago. Use its link below, or start a new one in ${wait} minute${wait === 1 ? "" : "s"}.`);
  }
  const counts = await exportCounts(deps, actor.orgId);
  const token = randomToken(32).replace(/[^A-Za-z0-9]/g, "");
  const id = newId("mov");
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  // Essential write: one row for the run.
  await deps.db.insert(dataMoves).values({
    id, orgId: actor.orgId, kind: "export", source: "workspace", status: "ready", total, done: 0, counts: JSON.stringify(counts),
    tokenHash: await sha256Hex(token), expiresAt: new Date(now.getTime() + EXPORT_LINK_HOURS * 3600_000),
    createdByUserId: actor.userId || null, createdByEmail: await starterEmail(deps, actor), createdAt: now, updatedAt: now,
  });
  await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email || null, action: "workspace.export_requested", targetType: "data_move", targetId: id });
  const row = await moveRow(deps, actor.orgId, id);
  return { ...presentMove(row), downloadPath: `/api/data-moves/exports/${id}/download?token=${token}` };
}

/** Checks a download link. Answers the run and the auth to build the ZIP with, or throws 404 or 410. */
export async function openExport(deps: Deps, id: string, token: string) {
  const m = await deps.db.select().from(dataMoves).where(and(eq(dataMoves.id, id), eq(dataMoves.kind, "export"))).get();
  if (!m || !token || !m.tokenHash || (await sha256Hex(token)) !== m.tokenHash) throw notFound("Export");
  if (!m.expiresAt || m.expiresAt.getTime() < deps.now().getTime()) throw new HttpError(410, "expired", "This download link has expired. Start a new export in Settings, Import and export.");
  const auth = { orgId: m.orgId, userId: m.createdByUserId ?? "", email: m.createdByEmail ?? "", name: m.createdByEmail ?? "", role: "admin", sessionId: "" } as AuthContext;
  return { move: m, auth };
}

/** Marks a finished download (essential: one update, the person sees it in the history). */
export async function exportFinished(deps: Deps, id: string, counts: Record<string, number>) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  await deps.db.update(dataMoves).set({ done: total, finishedAt: deps.now(), updatedAt: deps.now() }).where(eq(dataMoves.id, id));
}

// ------------------------------------------------------------------ imports

export interface ImportInput extends RunInput { kind: MoveKind; moveId?: string | null }

/**
 * R53 (MB-239): an import run under an Idempotency-Key. The run row keeps one id (moveId) and a new project keeps
 * one id (projectId) on every retry of that key, and each item the run makes takes an id made from the run's id and
 * the item's place in the file, so a retry whose first attempt committed (then answered 5xx or was cut off) finds
 * the run, skips the meetings already in (same id, insert or nothing), returns the docs already in (one read per
 * doc, only on a retry), and contacts and tasks skip as before (by email, by import key). Without a key: {}.
 */
export interface MoveKeys { moveId?: string; projectId?: string; retry?: boolean }

function keyedItemId(prefix: string, m: typeof dataMoves.$inferSelect, key: string) {
  return `${prefix}_${new Date(m.createdAt).getTime().toString(36).padStart(9, "0")}${hash36(`${m.id}|${key}`).slice(0, 10)}`;
}

async function startRow(deps: Deps, actor: SuiteActor, kind: MoveKind, source: string, fileName: string | undefined, total: number, id = newId("mov")) {
  const now = deps.now();
  // Essential write: the run row the history and Undo read.
  await deps.db.insert(dataMoves).values({ id, orgId: actor.orgId, kind: "import", source: `${kind}:${source}`, fileName: fileName?.slice(0, 255) ?? null, status: "running", total, done: 0,
    createdByUserId: actor.userId || null, createdByEmail: await starterEmail(deps, actor), createdAt: now, updatedAt: now });
  await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email || null, action: "data.import_started", targetType: "data_move", targetId: id, metadata: { kind, source } });
  return moveRow(deps, actor.orgId, id);
}

async function saveProgress(deps: Deps, m: typeof dataMoves.$inferSelect, patch: { created: Created; done: number; total?: number; status: "running" | "stopped" | "done"; projectId?: string | null; counts?: Record<string, number> }) {
  const now = deps.now();
  // Essential write: one update per chunk.
  await deps.db.update(dataMoves).set({
    created: JSON.stringify(patch.created), done: patch.done, ...(patch.total !== undefined ? { total: patch.total } : {}), status: patch.status,
    ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}), ...(patch.counts ? { counts: JSON.stringify(patch.counts) } : {}),
    updatedAt: now, lastStepAt: now, ...(patch.status === "done" ? { finishedAt: now } : {}),
  }).where(eq(dataMoves.id, m.id));
  if (patch.status === "done") {
    await notifyMoveEnded(deps, { ...m, created: JSON.stringify(patch.created), done: patch.done, total: patch.total ?? m.total, status: "done" }, "done");
    if (m.fileKey) await dropKeptFile(deps, m); // R43: a finished run keeps no file
  }
  return presentMove({ ...m, created: JSON.stringify(patch.created), done: patch.done, total: patch.total ?? m.total, status: patch.status, projectId: patch.projectId ?? m.projectId, counts: patch.counts ? JSON.stringify(patch.counts) : m.counts, updatedAt: now, finishedAt: patch.status === "done" ? now : m.finishedAt });
}

async function resume(deps: Deps, actor: SuiteActor, moveId: string | null | undefined) {
  if (!moveId) return null;
  const m = await moveRow(deps, actor.orgId, moveId);
  if (m.kind !== "import") throw new HttpError(422, "validation_failed", "That run is an export.");
  if (m.status === "undone") throw new HttpError(409, "undone", "This import was undone. Start a new one.");
  return m;
}

/**
 * R42: "choose the same file again" carries on. When a new run starts without a run id, the newest paused run of the
 * same kind with the same file name and the same number of items is continued from where it stopped, instead of a
 * second run that would add the same events or pages again (calendar and docs have no duplicate check; tasks and
 * contacts do). One read on data_moves_org_idx, only when an import starts (not a hot route). A paused run that already
 * had its "paused" email gets its claim cleared, so the run can still send its one "finished" email.
 */
async function findPaused(deps: Deps, orgId: string, kind: MoveKind, fileName: string | undefined | null, total: number) {
  if (!fileName) return null;
  const rows = await deps.db.select().from(dataMoves)
    .where(and(eq(dataMoves.orgId, orgId), eq(dataMoves.kind, "import"), eq(dataMoves.status, "stopped"), like(dataMoves.source, `${kind}:%`), eq(dataMoves.fileName, fileName.slice(0, 255)), eq(dataMoves.total, total)))
    .orderBy(desc(dataMoves.createdAt)).limit(1);
  const m = rows[0];
  if (!m || m.done >= m.total) return null;
  if (m.notifiedAt) {
    // Essential write: clears the email claim so the continued run can send its "finished" email.
    await deps.db.update(dataMoves).set({ notifiedAt: null }).where(eq(dataMoves.id, m.id));
    return { ...m, notifiedAt: null };
  }
  return m;
}

const fail = (e: unknown) => {
  if (e instanceof MoveFileError) throw new HttpError(422, "unreadable_file", e.message);
  throw e;
};

function readFile(kind: MoveKind, content: string): { contacts?: ContactIn[]; events?: EventIn[]; pages?: { title: string; body: string }[]; skipped: number } {
  try {
    if (kind === "contacts") { const r = readContacts(content); return { contacts: r.contacts.slice(0, MAX_ITEMS), skipped: r.skipped }; }
    if (kind === "calendar") { const r = parseIcsEvents(content); return { events: r.events.slice(0, MAX_ITEMS), skipped: r.skipped }; }
    if (kind === "docs") return { pages: readPages(content), skipped: 0 };
  } catch (e) { fail(e); }
  throw new HttpError(422, "validation_failed", "Unknown import type.");
}

/** Markdown pages from one .md file or a zip of them (the page title comes from the "# " line or the file name). */
export function readPages(content: string, fileName = "page.md"): { title: string; body: string }[] {
  const one = (name: string, md: string) => {
    const first = /^#\s+(.+)$/m.exec(md.slice(0, 500));
    return { title: (first?.[1] ?? pageTitle(name)).trim().slice(0, 200) || "Untitled", body: pageBody(md) };
  };
  if (content.startsWith(ZIP_PREFIX)) {
    let files: Record<string, Uint8Array>;
    try { files = unzipSync(base64Bytes(content.slice(ZIP_PREFIX.length)), { filter: (f) => /\.(md|markdown|txt)$/i.test(f.name) && !f.name.startsWith("__MACOSX") }); }
    catch { throw new MoveFileError("This zip file could not be read."); }
    const pages = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([n, b]) => one(n, strFromU8(b)));
    if (!pages.length) throw new MoveFileError("This zip has no Markdown pages in it.");
    return pages.slice(0, 500);
  }
  return [one(fileName, content.replace(/^\uFEFF/, ""))];
}

/** What a calendar, contacts or docs file would bring in: the count and the first 20. Writes nothing. */
export async function previewMove(deps: Deps, actor: SuiteActor, input: ImportInput) {
  assertWritable(actor);
  requireImportAdmin(actor);
  if (input.kind === "tasks") return { kind: "tasks" as const, ...(await previewImport(deps, actor, input)) };
  if (input.kind === "workspace") return { kind: "workspace" as const, ...summarizeWorkspace(readWorkspace(input.content)) };
  const f = input.kind === "docs" ? { pages: readPagesSafe(input.content, input.fileName), skipped: 0 } : readFile(input.kind, input.content);
  if (f.contacts) {
    const known = new Set<string>();
    for (let i = 0; i < f.contacts.length; i += 90) {
      const part = f.contacts.slice(i, i + 90).map((c) => c.email);
      for (const r of await deps.db.select({ email: contacts.email }).from(contacts).where(and(eq(contacts.orgId, actor.orgId), inIds(contacts.email, part)))) known.add(r.email);
    }
    return { kind: "contacts" as const, total: f.contacts.length, skipped: f.skipped, alreadyThere: known.size, rows: f.contacts.slice(0, 20) };
  }
  if (f.events) return { kind: "calendar" as const, total: f.events.length, skipped: f.skipped, rows: f.events.slice(0, 20).map((e) => ({ ...e, startsAt: e.startsAt.toISOString(), description: e.description.slice(0, 200) })) };
  return { kind: "docs" as const, total: f.pages!.length, skipped: 0, rows: f.pages!.slice(0, 20).map((p) => ({ title: p.title, words: p.body.split(/\s+/).filter(Boolean).length })) };
}

function readPagesSafe(content: string, fileName?: string) {
  try { return readPages(content, fileName); } catch (e) { return fail(e); }
}

async function budgetStop(deps: Deps) {
  const level = (await writeBudget(deps)).level;
  return level === "warn" || level === "shed";
}

/**
 * One step of an import: brings in up to 15 seconds of items and answers the run with its progress. Call again with
 * the run's id (moveId) while status is "stopped" and stopped is "time"; the web page does this on its own.
 */
export async function runMove(deps: Deps, actor: SuiteActor, input: ImportInput, keys: MoveKeys = {}) {
  const r = await runMoveStep(deps, actor, input, keys);
  // R43: a step that stopped part way keeps this request's input (once per run), so the scheduled pass can finish the
  // run if the page closes. The step's own answer is unchanged; a failed keep only means the run waits for its page.
  if (r.move.status === "stopped" && deps.importFiles) {
    const row = await deps.db.select().from(dataMoves).where(eq(dataMoves.id, r.move.id)).get();
    if (row && !row.fileKey && await keepImportInput(deps, row, input as unknown as Record<string, unknown>)) return { ...r, move: { ...r.move, background: true } };
  }
  return r;
}

/** One step, without keeping anything (the scheduled pass calls this with the kept input). */
export async function runMoveStep(deps: Deps, actor: SuiteActor, input: ImportInput, keys: MoveKeys = {}) {
  assertWritable(actor);
  requireImportAdmin(actor);
  // R53 (MB-239): a keyed retry carries on in the run its first attempt started (one read, only on a retry).
  const prior = await resume(deps, actor, input.moveId)
    ?? (keys.retry && keys.moveId ? (await deps.db.select().from(dataMoves).where(and(eq(dataMoves.id, keys.moveId), eq(dataMoves.orgId, actor.orgId), eq(dataMoves.kind, "import"))).get()) ?? null : null);
  if (input.kind === "tasks") return runTaskStep(deps, actor, input, prior, keys);
  if (input.kind === "workspace") return runWorkspaceStep(deps, actor, input, prior, keys);
  const started = Date.now();
  const f = input.kind === "docs" ? { pages: readPagesSafe(input.content, input.fileName), skipped: 0 } : readFile(input.kind, input.content);
  const items = (f.contacts ?? f.events ?? f.pages ?? []) as unknown[];
  const m = prior ?? await findPaused(deps, actor.orgId, input.kind, input.fileName, items.length) ?? await startRow(deps, actor, input.kind, input.kind === "calendar" ? "ics" : input.kind === "contacts" ? "vcard" : "markdown", input.fileName, items.length, keys.moveId);
  const kid = keys.moveId ? (prefix: string, key: string) => keyedItemId(prefix, m, key) : null; // R53
  const created = parseJson<Created>(m.created, {});
  let done = m.done;
  let stopped: "time" | "write_budget" | null = null;
  let already = 0;
  while (done < items.length) {
    if (await budgetStop(deps)) { stopped = "write_budget"; break; }
    if (done > m.done && Date.now() - started > STEP_MS) { stopped = "time"; break; }
    // R43: staging takes small steps (IMPORT_STEP_MAX_ITEMS), so a small file still exercises the background finish.
    // R43: a workspace named in IMPORT_STEP_CAP_ORGS takes one item steps (a live check on production).
    const cap = deps.config.importStepMaxItems ?? (deps.config.importStepCapOrgs?.includes(actor.orgId) ? 1 : undefined);
    if (cap && done - m.done >= cap) { stopped = "time"; break; }
    const part = items.slice(done, done + Math.min(input.kind === "docs" ? 10 : CHUNK, cap ?? CHUNK));
    if (input.kind === "contacts") {
      const r = await insertContacts(deps, actor, part as ContactIn[]);
      created.contacts = [...(created.contacts ?? []), ...r.ids];
      already += r.already;
    } else if (input.kind === "calendar") {
      created.meetings = [...(created.meetings ?? []), ...(await insertMeetings(deps, actor, part as EventIn[], kid ? part.map((_, i) => kid("mtg", `calendar:${done + i}`)) : undefined))];
    } else {
      for (const [i, p] of (part as { title: string; body: string }[]).entries()) {
        const d = await createDoc(deps, actor, { title: p.title, content: markdownToDoc(p.body) }, kid ? { id: kid("doc", `docs:${done + i}`), retry: keys.retry } : {});
        created.docs = [...(created.docs ?? []), d.id];
      }
    }
    done += part.length;
  }
  const status = done >= items.length ? "done" : "stopped";
  const move = await saveProgress(deps, m, { created, done, total: items.length, status, counts: { skipped: f.skipped, alreadyThere: already + (parseJson<Record<string, number>>(m.counts, {}).alreadyThere ?? 0) } });
  return { move, stopped: status === "done" ? null : stopped ?? "time" };
}

async function insertContacts(deps: Deps, actor: SuiteActor, list: ContactIn[]) {
  const known = new Set((await deps.db.select({ email: contacts.email }).from(contacts).where(and(eq(contacts.orgId, actor.orgId), inIds(contacts.email, list.map((c) => c.email))))).map((r) => r.email));
  const now = deps.now();
  const rows = list.filter((c) => !known.has(c.email)).map((c, i) => ({
    id: sortableId("con", now.getTime() + i), orgId: actor.orgId, name: c.name.slice(0, 200), email: c.email, phone: c.phone?.slice(0, 60) ?? null, title: c.title?.slice(0, 200) ?? null,
    notes: [c.notes, c.company ? `Company: ${c.company}` : ""].filter(Boolean).join("\n\n").slice(0, 20_000), source: "import" as const, ...createdBy(actor), createdAt: now, updatedAt: now,
  }));
  // Essential writes, at most 50 rows a statement batch (12 columns each stays under the bind limit per row insert).
  for (const r of rows) await deps.db.insert(contacts).values(r).onConflictDoNothing();
  return { ids: rows.map((r) => r.id), already: known.size };
}

async function insertMeetings(deps: Deps, actor: SuiteActor, list: EventIn[], keyed?: string[]) {
  const now = deps.now();
  const ids: string[] = [];
  for (const [i, e] of list.entries()) {
    const id = keyed?.[i] ?? sortableId("mtg", now.getTime() + i); // R53: a keyed run's ids are stable, so a retry adds nothing
    const past = !e.recurrence && e.startsAt.getTime() + e.durationMin * 60_000 < now.getTime();
    // Essential write: one meeting row. No invites are sent for imported events.
    await deps.db.insert(meetings).values({
      id, orgId: actor.orgId, title: e.title, room: `multies-${id.slice(4)}`, guestToken: randomToken(18).replace(/[^A-Za-z0-9]/g, "").slice(0, 24),
      startsAt: e.startsAt, durationMin: e.durationMin, status: past ? "ended" : "scheduled", invitees: JSON.stringify(e.invitees),
      recurrence: e.recurrence, recurrenceTz: e.recurrence ? "UTC" : null, ...createdBy(actor), createdAt: now, updatedAt: now,
    } as typeof meetings.$inferInsert).onConflictDoNothing();
    ids.push(id);
  }
  return ids;
}

async function runTaskStep(deps: Deps, actor: SuiteActor, input: ImportInput, prior: typeof dataMoves.$inferSelect | null, keys: MoveKeys = {}) {
  const projectId = input.projectId ?? prior?.projectId ?? null;
  const r = await runImport(deps, actor, { ...input, projectId }, { maxMs: STEP_MS, ...(keys.projectId ? { project: { id: keys.projectId, retry: keys.retry } } : {}) });
  const m = prior ?? await startRow(deps, actor, "tasks", r.source, input.fileName, r.total, keys.moveId);
  const created = parseJson<Created>(m.created, {});
  created.tasks = [...(created.tasks ?? []), ...r.createdTaskIds];
  created.statuses = [...(created.statuses ?? []), ...r.createdStatusIds];
  if (r.projectCreated && r.projectId) { created.projectCreated = true; created.projects = [...new Set([...(created.projects ?? []), r.projectId])]; }
  const status = r.stopped && r.left ? "stopped" : "done";
  const move = await saveProgress(deps, m, { created, done: r.total - r.left - r.skipped, total: r.total, status, projectId: r.projectId,
    counts: { comments: (parseJson<Record<string, number>>(m.counts, {}).comments ?? 0) + r.comments, skipped: r.skipped, alreadyThere: r.alreadyThere, unknownAssignees: r.unknownAssignees } });
  return { move, stopped: status === "done" ? null : r.stopped, result: r };
}

// ------------------------------------------------------------------ a whole workspace (a Multies export zip)

interface WorkspaceFile { projects: Map<string, string>; contacts: string | null; calendar: string | null; pages: { title: string; body: string }[] }

/** The parts of an export zip the importer reads: csv/tasks.csv split per project, contacts, calendar and docs. */
export function readWorkspace(content: string): WorkspaceFile {
  if (!content.startsWith(ZIP_PREFIX)) throw new HttpError(422, "unreadable_file", "Choose the .zip file a workspace export made.");
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(base64Bytes(content.slice(ZIP_PREFIX.length)), { filter: (f) => f.name === "csv/tasks.csv" || f.name === "contacts/contacts.vcf" || f.name === "calendar/meetings.ics" || /^docs\/.+\.md$/.test(f.name) }); }
  catch { throw new HttpError(422, "unreadable_file", "This zip file could not be read."); }
  if (!files["csv/tasks.csv"]) throw new HttpError(422, "unreadable_file", "This zip is not a workspace export (csv/tasks.csv is missing).");
  const text = strFromU8(files["csv/tasks.csv"]);
  const lines = splitCsvRecords(text);
  const header = lines[0] ?? "";
  const byProject = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const project = firstCells(line, 3)[2] || "Imported tasks";
    byProject.set(project, [...(byProject.get(project) ?? []), line]);
  }
  const projectsCsv = new Map([...byProject].map(([p, rows]) => [p, [header, ...rows].join("\r\n") + "\r\n"]));
  const pages = Object.entries(files).filter(([n]) => n.startsWith("docs/")).sort(([a], [b]) => a.localeCompare(b))
    .map(([n, b]) => { const md = strFromU8(b); return { title: (/^#\s+(.+)$/m.exec(md)?.[1] ?? pageTitle(n)).trim(), body: pageBody(md) }; });
  return { projects: projectsCsv, contacts: files["contacts/contacts.vcf"] ? strFromU8(files["contacts/contacts.vcf"]) : null, calendar: files["calendar/meetings.ics"] ? strFromU8(files["calendar/meetings.ics"]) : null, pages };
}

/** CSV records (a quoted cell may hold line breaks). */
export function splitCsvRecords(text: string) {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') q = !q;
    if (!q && (ch === "\n" || ch === "\r")) { if (ch === "\r" && text[i + 1] === "\n") i++; if (cur) out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function firstCells(line: string, n: number) {
  const cells: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length && cells.length < n; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; continue; }
    if (ch === "," && !q) { cells.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cells.length < n) cells.push(cur);
  return cells;
}

function summarizeWorkspace(w: WorkspaceFile) {
  const safeCount = (f: () => number) => { try { return f(); } catch { return 0; } };
  const events = safeCount(() => (w.calendar ? parseIcsEvents(w.calendar).events.length : 0));
  const people = safeCount(() => (w.contacts ? readContacts(w.contacts).contacts.length : 0));
  const tasksN = [...w.projects.values()].reduce((a, csv) => a + splitCsvRecords(csv).length - 1, 0);
  return { total: tasksN + events + people + w.pages.length, parts: { projects: w.projects.size, tasks: tasksN, meetings: events, contacts: people, docs: w.pages.length } };
}

/** One step of a whole workspace import: projects in order (each its own project), then contacts, calendar and docs. */
async function runWorkspaceStep(deps: Deps, actor: SuiteActor, input: ImportInput, prior: typeof dataMoves.$inferSelect | null, keys: MoveKeys = {}) {
  const w = readWorkspace(input.content);
  const sum = summarizeWorkspace(w);
  const m = prior ?? await findPaused(deps, actor.orgId, "workspace", input.fileName, sum.total) ?? await startRow(deps, actor, "workspace", "multies", input.fileName, sum.total, keys.moveId);
  const kid = keys.moveId ? (prefix: string, key: string) => keyedItemId(prefix, m, key) : null; // R53
  const created = parseJson<Created>(m.created, {});
  const counts = parseJson<Record<string, number>>(m.counts, {});
  const started = Date.now();
  const phase = counts.phase ?? 0; // 0..n-1 projects, then n contacts, n+1 calendar, n+2 docs
  const names = [...w.projects.keys()];
  let p = phase;
  let offset = counts.offset ?? 0;
  let stopped: string | null = null;
  const timeUp = () => Date.now() - started > STEP_MS;
  while (p < names.length + 3 && !stopped) {
    if (p > phase && timeUp()) { stopped = "time"; break; }
    if (p < names.length) {
      const name = names[p];
      const existingId = (created.projects ?? [])[p] ?? null;
      const r = await runImport(deps, actor, { fileName: `${name}.csv`, content: w.projects.get(name)!, projectId: existingId, projectName: name, mapping: { status: "Status", statusGroup: "Status group", id: "ID" } }, { maxMs: STEP_MS, ...(kid ? { project: { id: kid("prj", `project:${p}`), retry: keys.retry } } : {}) });
      created.tasks = [...(created.tasks ?? []), ...r.createdTaskIds];
      created.statuses = [...(created.statuses ?? []), ...r.createdStatusIds];
      if (r.projectId && !existingId) created.projects = [...(created.projects ?? []), r.projectId];
      if (r.projectCreated) created.projectCreated = true;
      if (r.stopped && r.left) { stopped = r.stopped; break; }
      p++; offset = 0; continue;
    }
    const k = p - names.length;
    const items: unknown[] = k === 0 ? (w.contacts ? readContacts(w.contacts).contacts : []) : k === 1 ? (w.calendar ? parseIcsEvents(w.calendar).events : []) : w.pages;
    while (offset < items.length) {
      if (timeUp() || await budgetStop(deps)) { stopped = "time"; break; }
      const part = items.slice(offset, offset + (k === 2 ? 10 : CHUNK));
      if (k === 0) created.contacts = [...(created.contacts ?? []), ...(await insertContacts(deps, actor, part as ContactIn[])).ids];
      else if (k === 1) created.meetings = [...(created.meetings ?? []), ...(await insertMeetings(deps, actor, part as EventIn[], kid ? part.map((_, i) => kid("mtg", `calendar:${offset + i}`)) : undefined))];
      else for (const [i, pg] of (part as { title: string; body: string }[]).entries()) created.docs = [...(created.docs ?? []), (await createDoc(deps, actor, { title: pg.title, content: markdownToDoc(pg.body) }, kid ? { id: kid("doc", `docs:${offset + i}`), retry: keys.retry } : {})).id];
      offset += part.length;
    }
    if (!stopped) { p++; offset = 0; }
  }
  const made = (created.tasks?.length ?? 0) + (created.contacts?.length ?? 0) + (created.meetings?.length ?? 0) + (created.docs?.length ?? 0);
  const status = stopped ? "stopped" : "done";
  const move = await saveProgress(deps, m, { created, done: Math.min(sum.total, made), total: sum.total, status, counts: { ...sum.parts, phase: p, offset } });
  return { move, stopped };
}

// ------------------------------------------------------------------ undo

/** Removes exactly what one import made: its tasks (with their comments), the statuses and projects it added, and its meetings, contacts and docs. */
export async function undoMove(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  requireImportAdmin(actor);
  const m = await moveRow(deps, actor.orgId, id);
  if (m.kind !== "import") throw new HttpError(422, "validation_failed", "Only an import can be undone.");
  if (m.status === "undone") return { move: presentMove(m), removed: 0 };
  if (m.fileKey) await dropKeptFile(deps, m); // R43: the kept upload goes with the run
  const c = parseJson<Created>(m.created, {});
  let removed = 0;
  const del = async (ids: string[] | undefined, table: typeof tasks | typeof meetings | typeof contacts | typeof docs) => {
    for (let i = 0; i < (ids ?? []).length; i += 90) {
      const part = ids!.slice(i, i + 90);
      // Essential writes: one delete per row; foreign keys remove comments, checklist items and field values.
      const gone = await deps.db.delete(table).where(and(eq(table.orgId, actor.orgId), inIds(table.id, part))).returning({ id: table.id });
      removed += gone.length;
    }
  };
  // Subtasks first, then their parents (a parent link is ON DELETE SET NULL elsewhere, so order only keeps it tidy).
  await del([...(c.tasks ?? [])].reverse(), tasks);
  await del(c.meetings, meetings);
  await del(c.contacts, contacts);
  await del(c.docs, docs);
  // R41: the messages a mail archive (.mbox) import stored, and the mailbox space they used.
  const freed = new Map<string, number>();
  for (let i = 0; i < (c.messages ?? []).length; i += 90) {
    const part = c.messages!.slice(i, i + 90);
    // Essential writes: one delete per message; attachments and search rows go with it by foreign key.
    const gone = await deps.db.delete(messages).where(and(eq(messages.orgId, actor.orgId), inIds(messages.id, part))).returning({ id: messages.id, mailboxId: messages.mailboxId, sizeBytes: messages.sizeBytes });
    removed += gone.length;
    for (const g of gone) freed.set(g.mailboxId, (freed.get(g.mailboxId) ?? 0) + (g.sizeBytes ?? 0));
  }
  // Essential write: one update per mailbox touched, so the storage meter drops by what was removed.
  for (const [mailboxId, bytes] of freed) if (bytes > 0) await deps.db.update(mailboxes).set({ usedBytes: sql`max(0, ${mailboxes.usedBytes} - ${bytes})` }).where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, actor.orgId)));
  // Statuses and projects it added, when nothing else now uses them.
  for (const sid of c.statuses ?? []) {
    const used = await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.statusId, sid))).limit(1).get();
    if (!used) await deps.db.delete(projectStatuses).where(and(eq(projectStatuses.orgId, actor.orgId), eq(projectStatuses.id, sid)));
  }
  if (c.statuses?.length) invalidateStatuses(deps, actor.orgId);
  for (const pid of c.projectCreated ? c.projects ?? [] : []) {
    const used = await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.projectId, pid))).limit(1).get();
    if (!used) await deps.db.delete(projects).where(and(eq(projects.orgId, actor.orgId), eq(projects.id, pid)));
  }
  const now = deps.now();
  await deps.db.update(dataMoves).set({ status: "undone", undoneAt: now, updatedAt: now }).where(eq(dataMoves.id, m.id));
  await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email || null, action: "data.import_undone", targetType: "data_move", targetId: m.id, metadata: { removed } });
  return { move: presentMove({ ...m, status: "undone", undoneAt: now }), removed };
}


// ------------------------------------------------------------------ R41: the done email and runs left behind

/** Minutes without a step before the scheduled pass treats a running import as left behind (the page closed). */
export const LEFT_BEHIND_MIN = 10;
/** At most this many runs per scheduled pass, so one pass stays small. */
export const NUDGE_LIMIT = 5;

const moveLabel = (source: string) => {
  const kind = source.split(":")[0];
  return kind === "mail" ? "mail" : kind === "tasks" ? "tasks" : kind === "calendar" ? "calendar" : kind === "contacts" ? "contacts" : kind === "docs" ? "docs" : "workspace";
};

/**
 * Sends the one email a run gets when it ends: "finished" when every item is in, "paused" when the scheduled pass
 * finds it left behind. The claim (notified_at set only where it is still empty) makes it once per run whoever calls.
 * The send itself goes through the job queue, so the request that finished the import does no mail work (free plan CPU)
 * and a failed send is retried there and logged; the history shows the result either way.
 */
export async function notifyMoveEnded(deps: Deps, m: typeof dataMoves.$inferSelect, why: "done" | "paused") {
  if (m.kind !== "import" || (!m.createdByEmail && !m.createdByUserId) || m.notifiedAt) return false;
  try {
    // Essential write: the claim, so two finishing calls never send two emails.
    const claimed = await deps.db.update(dataMoves).set({ notifiedAt: deps.now() }).where(and(eq(dataMoves.id, m.id), isNull(dataMoves.notifiedAt))).returning({ id: dataMoves.id });
    if (!claimed.length) return false;
    await enqueue(deps, "data-move.notify", { moveId: m.id, why }, { orgId: m.orgId, maxAttempts: 3 });
    return true;
  } catch (err) {
    deps.log?.warn("data_move.notify_failed", { moveId: m.id, error: err });
    return false;
  }
}

/** The email's words, from the run row (plain text; the system template adds the button). */
export function moveEmail(deps: Deps, m: typeof dataMoves.$inferSelect, why: "done" | "paused") {
  const p = presentMove(m);
  const label = moveLabel(m.source);
  const file = m.fileName ? ` from ${m.fileName}` : "";
  const c = p.counts as Record<string, number>;
  const lines: string[] = [];
  if (label === "mail") {
    lines.push(`${c.stored ?? 0} message${(c.stored ?? 0) === 1 ? "" : "s"} brought in.`);
    if (c.duplicates) lines.push(`${c.duplicates} were already in the mailbox, so they were skipped.`);
    if (c.unreadable) lines.push(`${c.unreadable} couldn't be read.`);
  } else {
    lines.push(`${p.created} item${p.created === 1 ? "" : "s"} brought in, ${p.done} of ${p.total} done.`);
    if (c.alreadyThere) lines.push(`${c.alreadyThere} were already there, so they were skipped.`);
    if (c.skipped) lines.push(`${c.skipped} couldn't be read.`);
  }
  const subject = why === "done" ? "Your import finished" : "Your import is paused";
  // R42: the words say what really happens. An import runs only while its page is open (the file stays on the
  // person's device), so nothing more comes in on its own; choosing the same file again carries on.
  const intro = why === "done"
    ? `Your ${label} import${file} has finished.`
    : label === "mail"
      ? `Your mail import${file} stopped part way, most likely because its page was closed. Imports run only while their page is open, so nothing more will come in on its own. To bring in the rest, open Import and export and choose the same file again. Messages already in the mailbox are skipped, so nothing is doubled.`
      : `Your ${label} import${file} is paused. Imports run only while their page is open, so nothing more will come in on its own. To bring in the rest, open Import and export and choose the same file again: it carries on from where it stopped, so nothing is doubled.`;
  const text = [intro, "", ...lines, "", "You can see it, or undo it, in your import history."].join("\n");
  return { subject, text, action: { label: "Open import history", url: `${deps.config.appUrl}/app/settings/import` } };
}

/**
 * Who the run's email goes to. R43b (found by the production proof): a run started with an API key records the key's
 * label ("api-key:mm_live_...") as created_by_email, so the done email went to a label, not a person. A value that is
 * not an email address falls back to the account email of the user who started the run (the key's owner).
 */
export async function moveRecipient(deps: Deps, m: typeof dataMoves.$inferSelect): Promise<string | null> {
  if (isAddress(m.createdByEmail)) return m.createdByEmail;
  if (!m.createdByUserId) return null;
  const u = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, m.createdByUserId)).get();
  return u?.email ?? null;
}

registerJob("data-move.notify", async (deps, payload) => {
  const p = payload as { moveId: string; why: "done" | "paused" };
  const m = await deps.db.select().from(dataMoves).where(eq(dataMoves.id, p.moveId)).get();
  if (!m) return;
  const to = await moveRecipient(deps, m);
  if (!to) { deps.log?.info("data_move.notify_skipped", { moveId: m.id, why: p.why, reason: "no_recipient" }); return; }
  // R43: a run undone after it finished (or paused) gets no email: the person already removed what it brought in.
  if (m.status === "undone") { deps.log?.info("data_move.notify_skipped", { moveId: m.id, why: p.why, reason: "undone" }); return; }
  const e = moveEmail(deps, m, p.why);
  const r = await sendSystemEmail(deps, { to, subject: e.subject, text: e.text, action: e.action, orgId: m.orgId, template: "data-move-done" });
  deps.log?.info("data_move.notified", { moveId: m.id, why: p.why, delivered: r.delivered, via: r.via });
});

/**
 * The scheduled pass (every cron tick): at most NUDGE_LIMIT imports left behind, read through
 * data_moves_status_step_idx. The file of an import lives in the person's browser and is never stored on the server
 * (each step sends its part), so the pass cannot run a step for them. Two shapes are left behind:
 *  - a mail archive import stays "running" between batches; after LEFT_BEHIND_MIN minutes with no batch the pass ends
 *    it as stopped (paused);
 *  - every other import (tasks, calendar, contacts, docs, workspace) is saved as "stopped" after each step, so a page
 *    closed between steps leaves a paused run. R42: the pass now finds those too (before, it looked only at running
 *    runs, so these never got their email).
 * Each gets the one "paused" email with the counts and the way to carry on (notified_at keeps it to one). A mail
 * import the person cancelled is stopped on purpose and gets no email. Idle cost: one indexed read that returns nothing.
 */
export async function nudgeLeftBehindMoves(deps: Deps) {
  const before = new Date(deps.now().getTime() - LEFT_BEHIND_MIN * 60_000);
  const rows = await deps.db.select().from(dataMoves)
    .where(and(inArray(dataMoves.status, ["running", "stopped"]), lt(dataMoves.lastStepAt, before), isNull(dataMoves.notifiedAt), eq(dataMoves.kind, "import"),
      isNull(dataMoves.fileKey), // R43: a kept run is finished by the scheduled pass, not paused
      or(eq(dataMoves.status, "running"), ne(dataMoves.source, "mail:mbox"))))
    .orderBy(dataMoves.lastStepAt).limit(NUDGE_LIMIT);
  let paused = 0;
  for (const m of rows) {
    const now = deps.now();
    if (m.status === "running") {
      // Essential write: the run ends as stopped (only if no step ran since the read).
      const r = await deps.db.update(dataMoves).set({ status: "stopped", updatedAt: now, finishedAt: now })
        .where(and(eq(dataMoves.id, m.id), eq(dataMoves.status, "running"), lt(dataMoves.lastStepAt, before))).returning({ id: dataMoves.id });
      if (!r.length) continue;
    }
    if (await notifyMoveEnded(deps, { ...m, status: "stopped" }, "paused")) paused++;
  }
  return { checked: rows.length, paused };
}
