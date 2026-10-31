/**
 * R84: workspace tags with colours. A task keeps its tag names in tasks.labels (JSON), so lists read no other table;
 * this table gives each name its colour and order. Renaming or removing a tag rewrites the tasks that carry it, at
 * most 500 at a time per request (a second call finishes a bigger workspace).
 */
import { and, asc, eq, isNull, like, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { tasks, workspaceTags } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { isHexColour } from "../../lib/input-checks";
import { assertWritable, recordWrite, sortableId, type SuiteActor } from "./common";

export const TAG_COLOURS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#9333ea", "#0891b2", "#db2777", "#64748b", "#ca8a04", "#4f46e5"];
const MAX_TAGS = 200;
const REWRITE_MAX = 500;

export interface Tag { id: string; name: string; color: string; position: number; count?: number }
const present = (r: typeof workspaceTags.$inferSelect): Tag => ({ id: r.id, name: r.name, color: r.color, position: r.position });
export const cleanTagName = (s: string) => s.trim().replace(/\s+/g, " ").slice(0, 40);

/** The workspace's tags in order. With counts, also how many live tasks carry each (one read of the labels column). */
export async function listTags(deps: Deps, orgId: string, opts: { counts?: boolean } = {}): Promise<Tag[]> {
  const rows = await deps.db.select().from(workspaceTags).where(eq(workspaceTags.orgId, orgId)).orderBy(asc(workspaceTags.position), asc(workspaceTags.name));
  const out = rows.map(present);
  if (!opts.counts) return out;
  const used = await deps.db.select({ labels: tasks.labels }).from(tasks).where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), sql`${tasks.labels} <> '[]'`));
  const n = new Map<string, number>();
  for (const r of used) for (const l of JSON.parse(r.labels) as string[]) n.set(l.toLowerCase(), (n.get(l.toLowerCase()) ?? 0) + 1);
  return out.map((t) => ({ ...t, count: n.get(t.name.toLowerCase()) ?? 0 }));
}

async function tagRow(deps: Deps, orgId: string, id: string) {
  const r = await deps.db.select().from(workspaceTags).where(and(eq(workspaceTags.orgId, orgId), eq(workspaceTags.id, id))).get();
  if (!r) throw notFound("Tag");
  return r;
}

export async function createTag(deps: Deps, actor: SuiteActor, input: { name: string; color?: string }) {
  assertWritable(actor);
  const name = cleanTagName(input.name);
  if (!name) throw new HttpError(422, "validation_failed", "Give the tag a name.");
  const all = await listTags(deps, actor.orgId);
  const same = all.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (same) return same; // making a tag that exists hands it back (two people typing the same tag)
  if (all.length >= MAX_TAGS) throw new HttpError(422, "too_many_tags", `A workspace can have up to ${MAX_TAGS} tags.`);
  const now = deps.now();
  const row = { id: sortableId("tag", now.getTime()), orgId: actor.orgId, name, color: isHexColour(input.color) ? input.color! : TAG_COLOURS[all.length % TAG_COLOURS.length],
    position: all.length ? Math.max(...all.map((t) => t.position)) + 1 : 0, createdAt: now, updatedAt: now };
  await deps.db.insert(workspaceTags).values(row);
  return present(row);
}

/** Rewrites one tag name on the tasks that carry it (a rename, or null to take it off). */
async function rewriteOnTasks(deps: Deps, orgId: string, from: string, to: string | null) {
  const needle = `%${JSON.stringify(from).slice(1, -1).replace(/[%_]/g, "")}%`;
  const rows = await deps.db.select({ id: tasks.id, labels: tasks.labels }).from(tasks)
    .where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), like(tasks.labels, needle))).limit(REWRITE_MAX);
  const now = deps.now();
  let changed = 0;
  for (const r of rows) {
    const before = JSON.parse(r.labels) as string[];
    if (!before.some((l) => l.toLowerCase() === from.toLowerCase())) continue;
    const after = [...new Set(before.flatMap((l) => (l.toLowerCase() === from.toLowerCase() ? (to ? [to] : []) : [l])))];
    await deps.db.update(tasks).set({ labels: JSON.stringify(after), updatedAt: now, version: sql`${tasks.version} + 1` }).where(eq(tasks.id, r.id));
    changed++;
  }
  return { changed, more: rows.length >= REWRITE_MAX };
}

export async function updateTag(deps: Deps, actor: SuiteActor, id: string, patch: { name?: string; color?: string; position?: number }) {
  assertWritable(actor);
  const t = await tagRow(deps, actor.orgId, id);
  const set: Partial<typeof workspaceTags.$inferInsert> = { updatedAt: deps.now() };
  let rename: string | null = null;
  if (patch.name !== undefined) {
    const name = cleanTagName(patch.name);
    if (!name) throw new HttpError(422, "validation_failed", "Give the tag a name.");
    if (name !== t.name) {
      const clash = (await listTags(deps, actor.orgId)).find((x) => x.id !== t.id && x.name.toLowerCase() === name.toLowerCase());
      if (clash) throw new HttpError(409, "tag_exists", `There is already a tag called ${clash.name}.`);
      set.name = name; rename = name;
    }
  }
  if (patch.color !== undefined) { if (!isHexColour(patch.color)) throw new HttpError(422, "validation_failed", "Pick a colour like #2563eb."); set.color = patch.color; }
  if (patch.position !== undefined) set.position = patch.position;
  await deps.db.update(workspaceTags).set(set).where(eq(workspaceTags.id, t.id));
  const tasksChanged = rename ? await rewriteOnTasks(deps, actor.orgId, t.name, rename) : { changed: 0, more: false };
  if (rename) await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "update", verb: "tag_renamed", data: { from: t.name, to: rename, tasks: tasksChanged.changed } });
  return { tag: present({ ...t, ...set } as typeof workspaceTags.$inferSelect), tasksChanged: tasksChanged.changed, more: tasksChanged.more };
}

export async function deleteTag(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const t = await tagRow(deps, actor.orgId, id);
  await deps.db.delete(workspaceTags).where(eq(workspaceTags.id, t.id));
  const r = await rewriteOnTasks(deps, actor.orgId, t.name, null);
  await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "delete", verb: "tag_deleted", data: { name: t.name, tasks: r.changed } });
  return { ok: true as const, tasksChanged: r.changed, more: r.more };
}
