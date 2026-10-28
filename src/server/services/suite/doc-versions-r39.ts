/**
 * R39 page history for docs. A doc keeps earlier states of itself so a person (or an agent) can see what changed and
 * bring a page back. Rules:
 * - Before an edit, the page as it stood is saved as a version when a new editing session starts: the last save was
 *   10 minutes ago or more, or it was made by someone else (so an agent's edit after a person's always leaves the
 *   person's page one click away). Deferrable: a failed snapshot is reported and the edit still goes through.
 * - "Save version" names the current page; a named version is never pruned.
 * - A restore first saves the current page (reason "restore"), then writes the old title and content as a new doc
 *   version, so a restore can itself be undone. Essential writes.
 * - The newest 50 unnamed versions per doc are kept; older ones are deleted when a new one is added.
 * Visibility follows the doc: another workspace's ids are 404.
 */
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { changes, docVersions, docs } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import { actorOf, assertWritable, recordWrite, sortableId, type SuiteActor } from "./common";
import { diffCounts, diffLines, wordCount } from "@/shared/line-diff-r39";

export const SESSION_MS = 10 * 60_000;
export const KEEP_UNNAMED = 50;
export const VERSION_NAME_MAX = 80;

type DocRow = typeof docs.$inferSelect;
type VersionRow = typeof docVersions.$inferSelect;

export function presentVersion(v: VersionRow, full = false) {
  return {
    id: v.id, docId: v.docId, docVersion: v.docVersion, title: v.title, name: v.name, reason: v.reason,
    words: wordCount(v.plainText),
    author: { type: v.authorType, id: v.authorId, name: v.authorName },
    savedAt: v.savedAt.toISOString(), createdAt: v.createdAt.toISOString(),
    ...(full ? { content: JSON.parse(v.content) as unknown, text: v.plainText } : {}),
  };
}

async function liveDoc(deps: Deps, orgId: string, id: string) {
  const d = await deps.db.select().from(docs).where(and(eq(docs.id, id), eq(docs.orgId, orgId), isNull(docs.deletedAt))).get();
  if (!d) throw notFound("Doc");
  return d;
}

/** Who saved the doc last, from its change feed (one indexed row). */
async function lastEditor(deps: Deps, d: DocRow) {
  const c = await deps.db.select({ type: changes.actorType, id: changes.actorId, name: changes.actorName }).from(changes)
    .where(and(eq(changes.entityType, "doc"), eq(changes.entityId, d.id), isNotNull(changes.verb)))
    .orderBy(desc(changes.seq)).limit(1).get();
  return c?.type ? { type: c.type, id: c.id, name: c.name ?? "" } : { type: d.createdByType, id: d.createdById, name: "" };
}

async function insertVersion(deps: Deps, d: DocRow, by: { type: "member" | "agent" | "system"; id: string | null; name: string }, reason: "edit" | "restore", name: string | null, givenId?: string) {
  const now = deps.now();
  const id = givenId ?? sortableId("dver", now.getTime());
  await deps.db.insert(docVersions).values({
    id, orgId: d.orgId, docId: d.id, docVersion: d.version, title: d.title, content: d.content, plainText: d.plainText,
    authorType: by.type, authorId: by.id, authorName: by.name, reason, name, savedAt: d.updatedAt, createdAt: now,
  });
  if (!name) await prune(deps, d.id);
  return id;
}

/** Keeps the newest KEEP_UNNAMED unnamed versions of a doc. Runs only after an insert; deletes at most 20 rows a time. */
async function prune(deps: Deps, docId: string) {
  const old = await deps.db.select({ id: docVersions.id }).from(docVersions)
    .where(and(eq(docVersions.docId, docId), isNull(docVersions.name)))
    .orderBy(desc(docVersions.createdAt)).limit(20).offset(KEEP_UNNAMED);
  if (old.length) await deps.db.delete(docVersions).where(inIds(docVersions.id, old.map((r) => r.id))); // deferrable: housekeeping
}

/**
 * Called by updateDoc before it overwrites a doc's title or content. Saves the page as it stands when a new editing
 * session starts. Deferrable: errors are reported, never thrown, so history can't block an edit.
 */
export async function snapshotBeforeEdit(deps: Deps, actor: SuiteActor, d: DocRow) {
  try {
    const me = actorOf(actor);
    const prev = await lastEditor(deps, d);
    const sameEditor = prev.type === me.type && (prev.id ?? null) === (me.id ?? null);
    const fresh = deps.now().getTime() - d.updatedAt.getTime() < SESSION_MS;
    if (sameEditor && fresh) return null;
    if (d.version <= 1 && !d.plainText.trim() && d.title === "Untitled") return null; // a brand new empty page has nothing to keep
    const newest = await deps.db.select({ docVersion: docVersions.docVersion }).from(docVersions)
      .where(eq(docVersions.docId, d.id)).orderBy(desc(docVersions.createdAt)).limit(1).get();
    if (newest?.docVersion === d.version) return null; // this exact state is already kept
    return await insertVersion(deps, d, prev, "edit", null);
  } catch (err) {
    deps.reportError?.(err, { where: "snapshotBeforeEdit", doc: d.id });
    return null;
  }
}

export async function listDocVersions(deps: Deps, a: SuiteActor, docId: string, opts: { limit?: number } = {}) {
  const d = await liveDoc(deps, a.orgId, docId);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const rows = await deps.db.select().from(docVersions).where(and(eq(docVersions.orgId, a.orgId), eq(docVersions.docId, d.id)))
    .orderBy(desc(docVersions.createdAt)).limit(limit);
  const editor = await lastEditor(deps, d);
  return {
    doc: { id: d.id, title: d.title, version: d.version, words: wordCount(d.plainText), updatedAt: d.updatedAt.toISOString(), editedBy: editor },
    versions: rows.map((v) => presentVersion(v)),
    keep: { unnamed: KEEP_UNNAMED, named: "all" },
  };
}

async function versionRow(deps: Deps, a: SuiteActor, docId: string, versionId: string) {
  const v = await deps.db.select().from(docVersions).where(and(eq(docVersions.id, versionId), eq(docVersions.orgId, a.orgId), eq(docVersions.docId, docId))).get();
  if (!v) throw notFound("Version");
  return v;
}

/** One version with its content, plus what changed between it and the page now (lines added and removed to get here). */
export async function getDocVersion(deps: Deps, a: SuiteActor, docId: string, versionId: string, opts: { diff?: boolean } = {}) {
  const d = await liveDoc(deps, a.orgId, docId);
  const v = await versionRow(deps, a, d.id, versionId);
  const ops = diffLines(v.plainText, d.plainText);
  return {
    version: presentVersion(v, true),
    current: { version: d.version, title: d.title, updatedAt: d.updatedAt.toISOString() },
    sinceThen: { ...diffCounts(ops), titleChanged: v.title !== d.title },
    ...(opts.diff ? { diff: ops.length > 2000 ? ops.slice(0, 2000) : ops, truncated: ops.length > 2000 } : {}),
  };
}

const cleanName = (raw: unknown) => {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new HttpError(422, "validation_failed", "name must be text.");
  const n = raw.replace(/\s+/g, " ").trim();
  if (n.length > VERSION_NAME_MAX) throw new HttpError(422, "validation_failed", `A version name is at most ${VERSION_NAME_MAX} characters.`);
  return n || null;
};

/** Saves the page as it is now as a named version. Essential write: a person asked for it. */
export async function saveDocVersion(deps: Deps, a: SuiteActor, docId: string, input: { name?: string | null }, opts: { id?: string; retry?: boolean } = {}) {
  assertWritable(a);
  const d = await liveDoc(deps, a.orgId, docId);
  if (opts.id && opts.retry) { // R54 (MB-239): a retry under the same Idempotency-Key returns the version the first attempt saved (one read, only on a retry)
    const hit = await deps.db.select().from(docVersions).where(and(eq(docVersions.id, opts.id), eq(docVersions.orgId, a.orgId), eq(docVersions.docId, d.id))).get();
    if (hit) return { version: presentVersion(hit) };
  }
  const name = cleanName(input.name ?? "") ?? `Version ${d.version}`;
  const id = await insertVersion(deps, d, await lastEditor(deps, d), "edit", name, opts.id);
  await recordWrite(deps, a, { entityType: "doc", entityId: d.id, op: "update", version: d.version, verb: "version_saved", data: { versionId: id, name } });
  return { version: presentVersion(await versionRow(deps, a, d.id, id)) };
}

/** Names or renames a version (null clears the name, and the version can be pruned again). Essential write. */
export async function renameDocVersion(deps: Deps, a: SuiteActor, docId: string, versionId: string, input: { name: string | null }) {
  assertWritable(a);
  const d = await liveDoc(deps, a.orgId, docId);
  await versionRow(deps, a, d.id, versionId);
  await deps.db.update(docVersions).set({ name: cleanName(input.name) }).where(eq(docVersions.id, versionId));
  return { version: presentVersion(await versionRow(deps, a, d.id, versionId)) };
}

/**
 * Brings a version back: saves the page as it is now (reason "restore", so this can be undone), then writes the
 * version's title and content as the doc's next version. ifVersion makes it a 409 if the doc moved on since it was read.
 */
export async function restoreDocVersion(deps: Deps, a: SuiteActor, docId: string, versionId: string, opts: { ifVersion?: number } = {}) {
  assertWritable(a);
  const d = await liveDoc(deps, a.orgId, docId);
  const v = await versionRow(deps, a, d.id, versionId);
  const { updateDoc, versionConflict } = await import("./docs");
  if (opts.ifVersion !== undefined && opts.ifVersion !== d.version) throw versionConflict(d.version);
  const savedId = await insertVersion(deps, d, await lastEditor(deps, d), "restore", null); // essential: the way back
  const doc = await updateDoc(deps, a, d.id, { title: v.title, content: JSON.parse(v.content), version: d.version }, { history: false });
  await recordWrite(deps, a, { entityType: "doc", entityId: d.id, op: "update", version: doc.version, verb: "version_restored", data: { versionId: v.id, from: v.docVersion, savedAs: savedId } });
  return { doc, restoredFrom: presentVersion(v), savedCurrentAs: savedId };
}

/** Counts per doc, for tests and the operator view. */
export async function versionCount(deps: Deps, docId: string) {
  const r = await deps.db.select({ n: sql<number>`count(*)` }).from(docVersions).where(eq(docVersions.docId, docId)).get();
  return Number(r?.n ?? 0);
}
