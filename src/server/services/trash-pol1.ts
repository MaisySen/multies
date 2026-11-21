/**
 * POL1 (MB-313): tables and courses go to the trash instead of being lost, and come back with Restore or Undo.
 * Behind POLISH_POL1 (config polishPol1). A trashed doc is the existing soft delete (docs.deleted_at), so rows, lessons,
 * learners, progress and certificates stay where they are and a restore brings everything back. Rules:
 * - a table: owners, admins and the person who made it (the same people who choose who edits it);
 * - a course: owners and admins only;
 * - read only keys and guests never. Restore is open for 30 days, to the same people.
 * Flag off: nothing here is reachable and the generic docs delete behaves as before.
 */
import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { inIds } from "@/server/lib/sql-chunks";
import type { Deps } from "../context";
import { docCourses, docTables, docs } from "../db/schema";
import { forbidden, HttpError, notFound } from "../lib/errors";
import { deleteDoc } from "./suite/docs";
import { assertWritable, recordWrite, type SuiteActor } from "./suite/common";
import { assertTablesOn } from "./tables-r125";
import { assertCoursesOn } from "./courses-r129";
import { canTrash, type TrashKind } from "./trash-rules-pol1";
import { featureOn } from "./console/flags"; // OPS1 feature flags

export { canTrash, type TrashKind };

export const TRASH_DAYS = 30;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = 86_400_000;

// OPS1 feature flags: for the actor's workspace.
export function assertPolishOn(deps: Deps, orgId: string) {
  if (!featureOn(deps, "polishPol1", orgId)) throw notFound("Page");
}

const isAdmin = (a: SuiteActor) => a.role === "owner" || a.role === "admin";
async function ownerOf(deps: Deps, orgId: string, kind: TrashKind, docId: string): Promise<string | null> {
  if (kind === "table") {
    const m = await deps.db.select({ createdBy: docTables.createdBy }).from(docTables).where(and(eq(docTables.docId, docId), eq(docTables.orgId, orgId))).get();
    return m?.createdBy ?? null;
  }
  const m = await deps.db.select({ createdBy: docCourses.createdBy }).from(docCourses).where(and(eq(docCourses.docId, docId), eq(docCourses.orgId, orgId))).get();
  return m?.createdBy ?? null;
}

async function assertKindOn(deps: Deps, orgId: string, kind: TrashKind) {
  if (kind === "table") await assertTablesOn(deps, orgId);
  else await assertCoursesOn(deps, orgId);
}

const label = (kind: TrashKind) => (kind === "table" ? "Table" : "Course");
const refuse = (kind: TrashKind) => forbidden(kind === "table"
  ? "Only admins and the person who made this table can move it to the trash."
  : "Only owners and admins can move a course to the trash.");

/** Move a table or a course to the trash. */
export async function trashDoc(deps: Deps, actor: SuiteActor, kind: TrashKind, docId: string) {
  assertPolishOn(deps, actor.orgId);
  await assertKindOn(deps, actor.orgId, kind);
  assertWritable(actor);
  if (!ID.test(docId)) throw notFound(label(kind));
  const d = await deps.db.select({ id: docs.id, kind: docs.kind, deletedAt: docs.deletedAt }).from(docs).where(and(eq(docs.id, docId), eq(docs.orgId, actor.orgId))).get();
  if (!d || d.kind !== kind || d.deletedAt) throw notFound(label(kind));
  if (!canTrash(actor, kind, await ownerOf(deps, actor.orgId, kind, docId))) throw refuse(kind);
  await deleteDoc(deps, actor, docId);
  return { ok: true, restoreDays: TRASH_DAYS };
}

/** The generic docs delete, while the flag is on: a table or a course follows the trash rules above. */
export async function guardDocDelete(deps: Deps, actor: SuiteActor, docId: string) {
  if (!featureOn(deps, "polishPol1", actor.orgId) || !ID.test(docId)) return; // OPS1: per workspace flag
  const d = await deps.db.select({ kind: docs.kind }).from(docs).where(and(eq(docs.id, docId), eq(docs.orgId, actor.orgId))).get();
  if (!d || (d.kind !== "table" && d.kind !== "course")) return;
  if (!canTrash(actor, d.kind, await ownerOf(deps, actor.orgId, d.kind, docId))) throw refuse(d.kind);
}

/** Bring a trashed table or course back (within 30 days). */
export async function restoreDoc(deps: Deps, actor: SuiteActor, docId: string) {
  assertPolishOn(deps, actor.orgId);
  assertWritable(actor);
  if (!ID.test(docId)) throw notFound("Page");
  const d = await deps.db.select({ id: docs.id, kind: docs.kind, title: docs.title, deletedAt: docs.deletedAt, version: docs.version }).from(docs).where(and(eq(docs.id, docId), eq(docs.orgId, actor.orgId), isNotNull(docs.deletedAt))).get();
  if (!d || (d.kind !== "table" && d.kind !== "course")) throw notFound("Page");
  await assertKindOn(deps, actor.orgId, d.kind);
  if (!canTrash(actor, d.kind, await ownerOf(deps, actor.orgId, d.kind, docId))) throw refuse(d.kind);
  if (d.deletedAt && deps.now().getTime() - d.deletedAt.getTime() > TRASH_DAYS * DAY) throw new HttpError(410, "gone", "This was deleted more than 30 days ago and can't be restored.");
  await deps.db.update(docs).set({ deletedAt: null, updatedAt: deps.now(), version: d.version + 1 }).where(and(eq(docs.id, docId), eq(docs.orgId, actor.orgId)));
  await recordWrite(deps, actor, { entityType: "doc", entityId: docId, op: "update", version: d.version + 1, verb: "restored", data: { title: d.title, kind: d.kind } });
  return { ok: true, id: docId, kind: d.kind, title: d.title };
}

/** The trash: tables and courses deleted in the last 30 days that this person may restore. Read only when opened. */
export async function listTrash(deps: Deps, actor: SuiteActor) {
  assertPolishOn(deps, actor.orgId);
  if (actor.scope === "read") return { items: [], days: TRASH_DAYS };
  const since = new Date(deps.now().getTime() - TRASH_DAYS * DAY);
  const rows = await deps.db.select({ id: docs.id, title: docs.title, kind: docs.kind, deletedAt: docs.deletedAt }).from(docs)
    .where(and(eq(docs.orgId, actor.orgId), inArray(docs.kind, ["table", "course"]), isNotNull(docs.deletedAt), gte(docs.deletedAt, since)))
    .orderBy(desc(docs.deletedAt)).limit(100);
  const tableIds = rows.filter((r) => r.kind === "table").map((r) => r.id);
  const owners = new Map<string, string | null>();
  if (tableIds.length && !isAdmin(actor)) {
    const m = await deps.db.select({ docId: docTables.docId, createdBy: docTables.createdBy }).from(docTables).where(and(eq(docTables.orgId, actor.orgId), inIds(docTables.docId, tableIds)));
    for (const x of m) owners.set(x.docId, x.createdBy);
  }
  const on = { table: featureOn(deps, "tablesR125", actor.orgId), course: featureOn(deps, "coursesR129", actor.orgId) }; // OPS1: per workspace flags
  const items = rows
    .filter((r) => (r.kind === "table" || r.kind === "course") && on[r.kind] && canTrash(actor, r.kind, owners.get(r.id)))
    .slice(0, 50)
    .map((r) => ({ id: r.id, title: r.title || "Untitled", kind: r.kind as TrashKind, deletedAt: r.deletedAt!.toISOString() }));
  return { items, days: TRASH_DAYS };
}
