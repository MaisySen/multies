/**
 * OPS1: operator notes on a workspace or a person (table operator_notes). Internal to Multies staff: only the console
 * routes read this table, never a workspace facing route, export, search index or MCP tool. Deleting is a soft delete
 * (deleted_at), so the platform audit row can still name the note. Who may pin or delete (the author, or an owner) is
 * the route layer's decision; these functions take the id.
 *
 * Lists use the console paging contract (see moderation.ts): pinned notes first, then newest (dir "desc") or oldest
 * ("asc") within each group, keyset on (pinned and created_at as one number, id).
 */
import { and, asc, desc, eq, gt, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { operatorNotes, organizations, users } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import { PAGE_MAX_LIMIT, type PageRequest, type Paged } from "./moderation";

export const NOTE_BODY_MAX = 4000;
export const NOTE_SORT_FIELDS = ["createdAt"] as const;
export type NoteSortField = (typeof NOTE_SORT_FIELDS)[number];
export type NoteTargetType = "workspace" | "user";

export interface OperatorNote {
  id: string;
  targetType: NoteTargetType;
  targetId: string;
  body: string;
  pinned: boolean;
  authorUserId: string | null;
  authorEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What the platform audit row keeps about a note (never the text). */
export interface NoteAuditState { id: string; targetType: NoteTargetType; targetId: string; pinned: boolean; length: number; deleted: boolean }

type Row = typeof operatorNotes.$inferSelect;

const toNote = (r: Row): OperatorNote => ({
  id: r.id, targetType: r.targetType, targetId: r.targetId, body: r.body, pinned: r.pinned,
  authorUserId: r.authorUserId, authorEmail: r.authorEmail, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});
const auditState = (r: Row): NoteAuditState => ({ id: r.id, targetType: r.targetType, targetId: r.targetId, pinned: r.pinned, length: r.body.length, deleted: !!r.deletedAt });

const TARGET_TYPES: readonly NoteTargetType[] = ["workspace", "user"];
function checkTarget(targetType: string, targetId: string) {
  if (!TARGET_TYPES.includes(targetType as NoteTargetType)) throw new HttpError(400, "bad_filter", "Notes are on a workspace or a person.");
  if (typeof targetId !== "string" || !targetId.trim() || targetId.length > 64) throw new HttpError(400, "bad_filter", "Say which workspace or person.");
}

/** The note's text, trimmed; 1 to NOTE_BODY_MAX characters. */
export function cleanNoteBody(body: unknown): string {
  const s = typeof body === "string" ? body.trim() : "";
  if (!s) throw new HttpError(422, "validation_failed", "Write the note first.");
  if (s.length > NOTE_BODY_MAX) throw new HttpError(422, "validation_failed", `Keep the note under ${NOTE_BODY_MAX.toLocaleString("en-AU")} characters.`);
  return s;
}

/**
 * The sort key: pinned notes in their own band ahead of the rest, then created_at. 2^45 ms is past the year 3000, so
 * the bands never overlap and the number stays exact.
 */
const BAND = 2 ** 45;
const sortKey = (dir: "asc" | "desc"): SQL<number> => dir === "desc"
  ? sql<number>`(${operatorNotes.pinned} * ${BAND} + ${operatorNotes.createdAt})`
  : sql<number>`((1 - ${operatorNotes.pinned}) * ${BAND} + ${operatorNotes.createdAt})`;
const keyOf = (r: Row, dir: "asc" | "desc") => (dir === "desc" ? (r.pinned ? 1 : 0) : (r.pinned ? 0 : 1)) * BAND + r.createdAt.getTime();

export interface ListNotesInput { targetType: NoteTargetType; targetId: string; page: PageRequest<NoteSortField> }

/** One page of the notes on a workspace or person: pinned first, then newest. Deleted notes are left out. */
export async function listNotes(deps: Deps, input: ListNotesInput): Promise<Paged<OperatorNote>> {
  checkTarget(input.targetType, input.targetId);
  const { page } = input;
  if (!(NOTE_SORT_FIELDS as readonly string[]).includes(page.sort.field)) {
    throw new HttpError(400, "bad_sort", `You can't sort notes by "${page.sort.field}". Use one of: ${NOTE_SORT_FIELDS.join(", ")}.`);
  }
  const dir = page.sort.dir === "asc" ? "asc" : "desc";
  const limit = Math.max(1, Math.min(Math.floor(page.limit) || 50, PAGE_MAX_LIMIT));
  const key = sortKey(dir);
  let after: SQL | undefined;
  if (page.cursor) {
    const v = Number(page.cursor.v);
    if (!Number.isFinite(v) || typeof page.cursor.id !== "string" || !page.cursor.id) throw new HttpError(400, "bad_cursor", "That page link is out of date. Start the list again.");
    const past = dir === "desc" ? lt : gt;
    const cmp = dir === "desc" ? sql`<` : sql`>`;
    after = or(sql`${key} ${cmp} ${v}`, and(sql`${key} = ${v}`, past(operatorNotes.id, page.cursor.id)));
  }
  const by = dir === "desc" ? desc : asc;
  const rows = await deps.db.select().from(operatorNotes)
    .where(and(eq(operatorNotes.targetType, input.targetType), eq(operatorNotes.targetId, input.targetId), isNull(operatorNotes.deletedAt), after))
    .orderBy(by(key), by(operatorNotes.id)).limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(toNote), next: rows.length > limit && last ? { v: keyOf(last, dir), id: last.id } : null };
}

/** One note (deleted ones included, so a route can tell "gone" from "never was"), or null. */
export async function getNote(deps: Deps, id: string): Promise<(OperatorNote & { deletedAt: string | null }) | null> {
  const r = await deps.db.select().from(operatorNotes).where(eq(operatorNotes.id, id)).get();
  return r ? { ...toNote(r), deletedAt: r.deletedAt?.toISOString() ?? null } : null;
}

async function live(deps: Deps, id: string): Promise<Row> {
  const r = await deps.db.select().from(operatorNotes).where(and(eq(operatorNotes.id, id), isNull(operatorNotes.deletedAt))).get();
  if (!r) throw new HttpError(404, "not_found", "Note not found.");
  return r;
}

export interface AddNoteInput {
  targetType: NoteTargetType;
  targetId: string;
  body: string;
  pinned?: boolean;
  author: { userId: string | null; email: string | null };
}
export interface NoteChange { note: OperatorNote; before: NoteAuditState | null; after: NoteAuditState }

/** Adds a note. The workspace or person must exist (404 otherwise). */
export async function addNote(deps: Deps, input: AddNoteInput): Promise<NoteChange> {
  checkTarget(input.targetType, input.targetId);
  const body = cleanNoteBody(input.body);
  const exists = input.targetType === "workspace"
    ? await deps.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, input.targetId)).get()
    : await deps.db.select({ id: users.id }).from(users).where(eq(users.id, input.targetId)).get();
  if (!exists) throw new HttpError(404, "not_found", input.targetType === "workspace" ? "Workspace not found." : "User not found.");
  const now = deps.now();
  const [row] = await deps.db.insert(operatorNotes).values({
    id: newId("onote"), targetType: input.targetType, targetId: input.targetId, body, pinned: !!input.pinned,
    authorUserId: input.author.userId, authorEmail: input.author.email, createdAt: now, updatedAt: now,
  }).returning();
  return { note: toNote(row!), before: null, after: auditState(row!) };
}

/** Pins or unpins a note. 404 for a missing or deleted note. */
export async function setNotePinned(deps: Deps, id: string, pinned: boolean): Promise<NoteChange> {
  const r = await live(deps, id);
  const [row] = await deps.db.update(operatorNotes).set({ pinned, updatedAt: deps.now() }).where(eq(operatorNotes.id, id)).returning();
  return { note: toNote(row!), before: auditState(r), after: auditState(row!) };
}

/** Soft deletes a note. 404 for a missing or already deleted note. */
export async function deleteNote(deps: Deps, id: string): Promise<{ before: NoteAuditState; after: NoteAuditState }> {
  const r = await live(deps, id);
  const now = deps.now();
  const [row] = await deps.db.update(operatorNotes).set({ deletedAt: now, updatedAt: now }).where(eq(operatorNotes.id, id)).returning();
  return { before: auditState(r), after: auditState(row!) };
}
