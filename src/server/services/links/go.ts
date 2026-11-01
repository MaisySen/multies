/**
 * R87: team go links. go/<name> opens a doc, a task, a project or a web address; members of the workspace only.
 */
import { inIds } from "../../lib/sql-chunks";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { docs, goLinks, projects, tasks, users } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { GO_NAME_RE, type GoLinkInfo, type GoTargetKind } from "@/shared/links";
import { checkDestination } from "./core";
import { containsText } from "../../lib/like-search";

type Row = typeof goLinks.$inferSelect;
const canEdit = (auth: AuthContext, r: Pick<Row, "createdBy">) => auth.role !== "member" || r.createdBy === auth.userId;

function present(r: Row, auth: AuthContext, names: Map<string, string>): GoLinkInfo {
  return {
    id: r.id, name: r.name, targetKind: r.targetKind, targetId: r.targetId, url: r.url, label: r.label, description: r.description,
    href: r.targetKind === "url" ? r.url ?? "/app" : r.url ?? "/app", clicks: r.clicks, createdByName: r.createdBy ? names.get(r.createdBy) ?? null : null, canEdit: canEdit(auth, r),
  };
}

export async function listGo(deps: Deps, auth: AuthContext): Promise<GoLinkInfo[]> {
  const rows = await deps.db.select().from(goLinks).where(eq(goLinks.orgId, auth.orgId)).orderBy(asc(goLinks.name)).limit(1000);
  const ids = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))].slice(0, 90);
  const names = ids.length ? new Map((await deps.db.select({ id: users.id, name: users.name }).from(users).where(inIds(users.id, ids))).map((u) => [u.id, u.name])) : new Map<string, string>();
  return rows.map((r) => present(r, auth, names));
}

export interface GoInput { name: string; targetKind: GoTargetKind; targetId?: string | null; url?: string | null; description?: string | null }

/** Checks the target and returns what is stored: the address it opens and the label shown in lists. */
async function target(deps: Deps, auth: AuthContext, input: GoInput): Promise<{ targetKind: GoTargetKind; targetId: string | null; url: string; label: string | null }> {
  const kind = input.targetKind;
  if (kind === "url") return { targetKind: "url", targetId: null, url: checkDestination(String(input.url ?? ""), deps.config.appUrl), label: null };
  const id = String(input.targetId ?? "");
  if (!id) throw badRequest("Pick what the go link opens.");
  if (kind === "doc") {
    const d = await deps.db.select({ id: docs.id, title: docs.title }).from(docs).where(and(eq(docs.id, id), eq(docs.orgId, auth.orgId))).get();
    if (!d) throw notFound("Doc");
    return { targetKind: kind, targetId: d.id, url: `/app/docs/${d.id}`, label: d.title };
  }
  if (kind === "task") {
    const t = await deps.db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(and(eq(tasks.id, id), eq(tasks.orgId, auth.orgId), isNull(tasks.deletedAt))).get();
    if (!t) throw notFound("Task");
    return { targetKind: kind, targetId: t.id, url: `/app/tasks?task=${t.id}`, label: t.title };
  }
  if (kind === "project") {
    const p = await deps.db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.id, id), eq(projects.orgId, auth.orgId))).get();
    if (!p) throw notFound("Project");
    return { targetKind: kind, targetId: p.id, url: `/app/tasks?project=${p.id}`, label: p.name };
  }
  throw badRequest("Pick a doc, a task, a project or a web address.");
}

const checkName = (raw: string) => {
  const n = String(raw ?? "").trim().toLowerCase().replace(/^go\//, "");
  if (!GO_NAME_RE.test(n)) throw badRequest("Use letters, numbers, dots, _ or - for the name (up to 48).");
  return n;
};
const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? ""));

export async function createGo(deps: Deps, auth: AuthContext, input: GoInput): Promise<GoLinkInfo> {
  const name = checkName(input.name);
  const t = await target(deps, auth, input);
  const now = deps.now();
  const row = { id: newId("go"), orgId: auth.orgId, name, ...t, description: input.description?.trim().slice(0, 200) || null, clicks: 0, createdBy: auth.userId, createdAt: now, updatedAt: now };
  try { await deps.db.insert(goLinks).values(row); } catch (e) { if (isUnique(e)) throw conflict(`go/${name} already exists. Pick another name.`); throw e; }
  return present(row as Row, auth, new Map([[auth.userId, auth.name]]));
}

export async function updateGo(deps: Deps, auth: AuthContext, id: string, input: Partial<GoInput>): Promise<GoLinkInfo> {
  const r = await deps.db.select().from(goLinks).where(and(eq(goLinks.id, id), eq(goLinks.orgId, auth.orgId))).get();
  if (!r) throw notFound("Go link");
  if (!canEdit(auth, r)) throw forbidden("Only the person who made this go link or an admin can change it.");
  const set: Partial<typeof goLinks.$inferInsert> = { updatedAt: deps.now() };
  if (input.name !== undefined) set.name = checkName(input.name);
  if (input.targetKind !== undefined) Object.assign(set, await target(deps, auth, { name: r.name, targetKind: input.targetKind, targetId: input.targetId, url: input.url }));
  if (input.description !== undefined) set.description = input.description?.trim().slice(0, 200) || null;
  try { await deps.db.update(goLinks).set(set).where(eq(goLinks.id, r.id)); } catch (e) { if (isUnique(e)) throw conflict(`go/${set.name} already exists. Pick another name.`); throw e; }
  const after = await deps.db.select().from(goLinks).where(eq(goLinks.id, r.id)).get();
  return present(after!, auth, new Map());
}

export async function deleteGo(deps: Deps, auth: AuthContext, id: string): Promise<{ ok: true }> {
  const r = await deps.db.select().from(goLinks).where(and(eq(goLinks.id, id), eq(goLinks.orgId, auth.orgId))).get();
  if (!r) throw notFound("Go link");
  if (!canEdit(auth, r)) throw forbidden("Only the person who made this go link or an admin can remove it.");
  await deps.db.delete(goLinks).where(eq(goLinks.id, r.id));
  return { ok: true };
}

/** Opens go/<name> for a member: the address to go to, and one more open on the count. */
export async function openGo(deps: Deps, auth: AuthContext, rawName: string): Promise<{ href: string; name: string } | { href: null; name: string; suggestions: string[] }> {
  const name = String(rawName ?? "").trim().toLowerCase().replace(/^go\//, "");
  const r = GO_NAME_RE.test(name) ? await deps.db.select().from(goLinks).where(and(eq(goLinks.orgId, auth.orgId), eq(goLinks.name, name))).get() : undefined;
  if (!r) {
    const like = name.replace(/[%_]/g, "").slice(0, 20);
    const near = like ? await deps.db.select({ name: goLinks.name }).from(goLinks).where(and(eq(goLinks.orgId, auth.orgId), containsText(goLinks.name, like))).limit(5) : [];
    return { href: null, name, suggestions: near.map((n) => n.name) };
  }
  await deps.db.run(sql`update go_links set clicks = clicks + 1 where id = ${r.id}`);
  return { href: r.url ?? "/app", name: r.name };
}
