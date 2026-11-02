/**
 * R24.5 Docs tree and backlinks.
 *
 * Tree: docs.parent_id and a fractional docs.position. A move writes one docs row (no siblings are
 * renumbered unless the gap between two neighbours is used up). A page can't go under itself or its own
 * descendants, and the tree is at most MAX_DEPTH deep. Deleting a page moves its children up to its parent.
 *
 * Backlinks: when a doc's body is saved, the links inside it (to /app/docs/<id>, a task or a project,
 * mention nodes and page links) are read from the Tiptap JSON and compared with the stored set in
 * doc_links; only the difference is written, so a save that changed no links writes no link rows. The
 * co-editing room keeps its own state and never writes here: the doc row (and so its links) is saved
 * by the leader's periodic snapshot through the normal update, which is when links are read.
 */
import { and, asc, desc, eq, isNull, max } from "drizzle-orm";
import type { Deps } from "../../context";
import { docLinks, docs, projects, tasks } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { cachedWriteBudget } from "../write-budget";
import { assertWritable, type SuiteActor } from "./common";
import { inIds } from "../../lib/sql-chunks";

export const MAX_DEPTH = 6;
export const MAX_TREE = 2000;
const MAX_LINKS = 200;

export type DocLinkType = "doc" | "task" | "project";
export interface DocLinkRef { type: DocLinkType; id: string }
interface PMNode { type?: string; text?: string; content?: PMNode[]; attrs?: Record<string, unknown>; marks?: { type?: string; attrs?: Record<string, unknown> }[] }

/** Hosts whose absolute links count as internal, besides relative /app/... links. */
export const APP_HOSTS = ["multies.si", "www.multies.si", "preview.multies.si"];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Reads an href into a doc, task or project reference, or null for an outside link. */
export function parseAppHref(href: string, hosts: string[] = APP_HOSTS): DocLinkRef | null {
  if (typeof href !== "string" || !href) return null;
  let url: URL;
  try {
    if (/^https?:\/\//i.test(href)) {
      url = new URL(href);
      if (!hosts.includes(url.hostname.toLowerCase())) return null;
    } else if (href.startsWith("/") && !href.startsWith("//")) url = new URL(href, "http://app.invalid");
    else return null;
  } catch { return null; }
  const p = url.pathname.replace(/\/+$/, "");
  let m = /^\/app\/docs\/([^/]+)$/.exec(p);
  if (m && ID.test(m[1])) return { type: "doc", id: m[1] };
  m = /^\/app\/tasks\/([^/]+)$/.exec(p);
  if (m && ID.test(m[1])) return { type: "task", id: m[1] };
  m = /^\/app\/projects\/([^/]+)$/.exec(p);
  if (m && ID.test(m[1])) return { type: "project", id: m[1] };
  if (p === "/app/tasks" || p === "/app/my-work") {
    const t = url.searchParams.get("task");
    if (t && ID.test(t)) return { type: "task", id: t };
    const pr = url.searchParams.get("project");
    if (pr && ID.test(pr)) return { type: "project", id: pr };
  }
  return null;
}

/** A mention or page link node: attrs.id plus a kind in attrs.type, attrs.kind or attrs.entity. */
function nodeRef(n: PMNode): DocLinkRef | null {
  if (n.type !== "mention" && n.type !== "pageLink" && n.type !== "docMention" && n.type !== "taskMention") return null;
  const a = n.attrs ?? {};
  const id = typeof a.id === "string" ? a.id : "";
  const kind = n.type === "docMention" ? "doc" : n.type === "taskMention" ? "task" : String(a.type ?? a.kind ?? a.entity ?? "");
  if (!ID.test(id) || (kind !== "doc" && kind !== "task" && kind !== "project")) return null;
  return { type: kind, id };
}

/** Every distinct doc, task and project this body links to, in order of first appearance. */
export function extractDocLinks(body: unknown, hosts: string[] = APP_HOSTS): DocLinkRef[] {
  const seen = new Map<string, DocLinkRef>();
  const add = (r: DocLinkRef | null) => { if (r && seen.size < MAX_LINKS && !seen.has(`${r.type}:${r.id}`)) seen.set(`${r.type}:${r.id}`, r); };
  const walk = (n: PMNode, depth: number) => {
    if (!n || typeof n !== "object" || depth > 200) return;
    add(nodeRef(n));
    for (const m of n.marks ?? []) if (m?.type === "link" && typeof m.attrs?.href === "string") add(parseAppHref(m.attrs.href, hosts));
    if (Array.isArray(n.content)) for (const c of n.content) walk(c, depth + 1);
  };
  walk(body as PMNode, 0);
  return [...seen.values()];
}

const key = (r: DocLinkRef) => `${r.type}:${r.id}`;

/** Keeps only references to this workspace's own live records (another workspace's ids are dropped). */
async function ownRefs(deps: Deps, orgId: string, sourceId: string, refs: DocLinkRef[]): Promise<DocLinkRef[]> {
  const ids = (t: DocLinkType) => refs.filter((r) => r.type === t && !(t === "doc" && r.id === sourceId)).map((r) => r.id);
  const [d, t, p] = [ids("doc"), ids("task"), ids("project")];
  const ok = new Set<string>();
  if (d.length) for (const r of await deps.db.select({ id: docs.id }).from(docs).where(and(eq(docs.orgId, orgId), inIds(docs.id, d), isNull(docs.deletedAt)))) ok.add(`doc:${r.id}`);
  if (t.length) for (const r of await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, orgId), inIds(tasks.id, t)))) ok.add(`task:${r.id}`);
  if (p.length) for (const r of await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), inIds(projects.id, p)))) ok.add(`project:${r.id}`);
  return refs.filter((r) => ok.has(key(r)));
}

/**
 * Brings doc_links for one doc in step with its body, writing only what changed. When the daily write
 * budget reads shed the sync waits: the next save compares against the stored set again and catches up.
 */
export async function syncDocLinks(deps: Deps, orgId: string, docId: string, body: unknown): Promise<{ added: number; removed: number; skipped?: boolean }> {
  if (cachedWriteBudget()?.level === "shed") return { added: 0, removed: 0, skipped: true };
  const want = await ownRefs(deps, orgId, docId, extractDocLinks(body, hostsOf(deps)));
  const have = await deps.db.select({ type: docLinks.targetType, id: docLinks.targetId }).from(docLinks).where(eq(docLinks.sourceDocId, docId));
  const wantKeys = new Set(want.map(key));
  const haveKeys = new Set(have.map((h) => key(h as DocLinkRef)));
  const gone = have.filter((h) => !wantKeys.has(key(h as DocLinkRef)));
  const fresh = want.filter((w) => !haveKeys.has(key(w)));
  for (const g of gone) await deps.db.delete(docLinks).where(and(eq(docLinks.sourceDocId, docId), eq(docLinks.targetType, g.type), eq(docLinks.targetId, g.id)));
  if (fresh.length) await deps.db.insert(docLinks).values(fresh.map((f) => ({ orgId, sourceDocId: docId, targetType: f.type, targetId: f.id }))).onConflictDoNothing();
  return { added: fresh.length, removed: gone.length };
}

function hostsOf(deps: Deps): string[] {
  const out = [...APP_HOSTS];
  try { const h = new URL(deps.config.appUrl).hostname.toLowerCase(); if (!out.includes(h)) out.push(h); } catch { /* no app URL */ }
  return out;
}

// ---------------------------------------------------------------- tree

export interface TreeRow { id: string; title: string; parentId: string | null; position: number; projectId: string | null; updatedAt: Date; kind?: string | null }
export interface TreeNode { id: string; title: string; parentId: string | null; position: number; projectId: string | null; updatedAt: string; depth: number; children: TreeNode[]; /** R89: shown only when not a plain doc (F13b: tables and courses too, for Move to trash). */ kind?: "whiteboard" | "table" | "course" }

/** Who is reading: a workspace member or key (orgId), or a guest limited to one project. */
export interface DocViewer { orgId: string; projectId?: string }

async function treeRows(deps: Deps, v: DocViewer): Promise<TreeRow[]> {
  return deps.db.select({ id: docs.id, title: docs.title, parentId: docs.parentId, position: docs.position, projectId: docs.projectId, updatedAt: docs.updatedAt, kind: docs.kind })
    .from(docs).where(and(eq(docs.orgId, v.orgId), isNull(docs.deletedAt), v.projectId ? eq(docs.projectId, v.projectId) : undefined))
    .orderBy(desc(docs.updatedAt)).limit(MAX_TREE);
}

const order = (a: { position: number; id: string }, b: { position: number; id: string }) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Nests rows; a page whose parent is gone or out of view sits at the top. */
export function buildTree(rows: TreeRow[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const r of rows) nodes.set(r.id, { id: r.id, title: r.title, parentId: r.parentId, position: r.position, projectId: r.projectId, updatedAt: new Date(r.updatedAt).toISOString(), depth: 1, children: [], ...(r.kind === "whiteboard" || r.kind === "table" || r.kind === "course" ? { kind: r.kind as "whiteboard" | "table" | "course" } : {}) });
  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const p = n.parentId ? nodes.get(n.parentId) : undefined;
    if (p && !createsLoop(nodes, n.id, p.id)) p.children.push(n); else roots.push(n);
  }
  const fix = (list: TreeNode[], depth: number) => { list.sort(order); for (const n of list) { n.depth = depth; fix(n.children, depth + 1); } };
  fix(roots, 1);
  return roots;
}

function createsLoop(nodes: Map<string, { parentId: string | null }>, id: string, parentId: string): boolean {
  let cur: string | null = parentId;
  for (let i = 0; cur && i <= MAX_TREE; i++) { if (cur === id) return true; cur = nodes.get(cur)?.parentId ?? null; }
  return false;
}

export async function getDocTree(deps: Deps, v: DocViewer) {
  const rows = await treeRows(deps, v);
  return { tree: buildTree(rows), count: rows.length, truncated: rows.length >= MAX_TREE, maxDepth: MAX_DEPTH };
}

/** Depth of a page from the top (a top level page is 1). */
function depthOf(map: Map<string, TreeRow>, id: string | null): number {
  let d = 0;
  for (let cur = id; cur && d <= MAX_TREE; cur = map.get(cur)?.parentId ?? null) d++;
  return d;
}

/** Height of a page's subtree (a page with no children is 1). */
function heightOf(rows: TreeRow[], id: string): number {
  const kids = new Map<string, string[]>();
  for (const r of rows) if (r.parentId) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r.id]);
  const h = (x: string, guard: number): number => guard > MAX_TREE ? 0 : 1 + Math.max(0, ...(kids.get(x) ?? []).map((k) => h(k, guard + 1)));
  return h(id, 0);
}

/** Checks a new parent for a page being created (pageId null) or moved, and returns where it would sit. */
async function checkParent(deps: Deps, orgId: string, parentId: string | null, pageId: string | null, rows?: TreeRow[]) {
  if (!parentId) return;
  const all = rows ?? await treeRows(deps, { orgId });
  const map = new Map(all.map((r) => [r.id, r]));
  if (!map.has(parentId)) throw notFound("Parent page");
  if (pageId && (parentId === pageId || createsLoop(map, pageId, parentId))) throw new HttpError(422, "cycle", "A page can't go inside itself or one of its own sub pages.");
  const height = pageId ? heightOf(all, pageId) : 1;
  if (depthOf(map, parentId) + height > MAX_DEPTH) throw new HttpError(422, "too_deep", `Pages nest at most ${MAX_DEPTH} levels deep.`);
}

/** For a new page: checks the parent and returns the position at the end of its siblings. */
export async function placeNewDoc(deps: Deps, orgId: string, parentId: string | null | undefined): Promise<{ parentId: string | null; position: number }> {
  const parent = parentId || null;
  await checkParent(deps, orgId, parent, null);
  const r = await deps.db.select({ m: max(docs.position) }).from(docs)
    .where(and(eq(docs.orgId, orgId), isNull(docs.deletedAt), parent ? eq(docs.parentId, parent) : isNull(docs.parentId))).get();
  return { parentId: parent, position: Math.floor(Number(r?.m ?? 0)) + 1 };
}

export interface MoveInput { parentId?: string | null; beforeId?: string; afterId?: string; position?: number }

/** The smallest gap kept between neighbours before siblings are renumbered. */
const MIN_GAP = 1e-9;

/** Moves a page: one docs row, unless the neighbours have no room left between them. */
export async function moveDoc(deps: Deps, actor: SuiteActor, id: string, input: MoveInput) {
  assertWritable(actor);
  const rows = await treeRows(deps, { orgId: actor.orgId });
  const map = new Map(rows.map((r) => [r.id, r]));
  const doc = map.get(id);
  if (!doc) throw notFound("Doc");
  const ref = input.beforeId ?? input.afterId;
  const refRow = ref ? map.get(ref) : undefined;
  if (ref && (!refRow || ref === id)) throw notFound("Sibling page");
  let parent = input.parentId !== undefined ? input.parentId || null : doc.parentId;
  const refParent = refRow?.parentId && map.has(refRow.parentId) ? refRow.parentId : null;
  if (refRow && input.parentId !== undefined && refParent !== parent) throw new HttpError(422, "validation_failed", "beforeId or afterId must be a page under the same parent.");
  if (refRow) parent = refParent;
  if (parent && !map.has(parent)) throw notFound("Parent page");
  await checkParent(deps, actor.orgId, parent, id, rows);
  if (!parent && heightOf(rows, id) > MAX_DEPTH) throw new HttpError(422, "too_deep", `Pages nest at most ${MAX_DEPTH} levels deep.`);

  const effParent = (r: TreeRow) => (r.parentId && map.has(r.parentId) ? r.parentId : null);
  const siblings = rows.filter((r) => effParent(r) === parent && r.id !== id).sort(order);
  let at = siblings.length; // index the page takes among its siblings
  let pos: number;
  if (input.position !== undefined && !ref) {
    pos = input.position;
  } else if (input.beforeId) {
    at = siblings.findIndex((s) => s.id === input.beforeId);
    const prev = siblings[at - 1];
    pos = prev ? (prev.position + refRow!.position) / 2 : refRow!.position - 1;
  } else if (input.afterId) {
    at = siblings.findIndex((s) => s.id === input.afterId) + 1;
    const next = siblings[at];
    pos = next ? (refRow!.position + next.position) / 2 : refRow!.position + 1;
  } else {
    const last = siblings[siblings.length - 1];
    pos = last ? Math.floor(last.position) + 1 : 1;
  }
  const prev = siblings[at - 1];
  const next = siblings[at];
  const cramped = (input.beforeId || input.afterId) && ((prev && pos - prev.position < MIN_GAP) || (next && next.position - pos < MIN_GAP));
  let renumbered = 0;
  if (cramped) {
    // No room left between the neighbours: space every sibling out again, in order, with the page in its place.
    const ordered = [...siblings.slice(0, at), doc, ...siblings.slice(at)];
    for (let i = 0; i < ordered.length; i++) {
      const want = i + 1;
      if (ordered[i].id === id) { pos = want; continue; }
      if (ordered[i].position !== want) { await deps.db.update(docs).set({ position: want }).where(eq(docs.id, ordered[i].id)); renumbered++; }
    }
  }
  if (!Number.isFinite(pos)) throw new HttpError(422, "validation_failed", "position must be a number.");
  await deps.db.update(docs).set({ parentId: parent, position: pos }).where(and(eq(docs.id, id), eq(docs.orgId, actor.orgId)));
  return { doc: { id, title: doc.title, parentId: parent, position: pos, depth: depthOf(map, parent) + 1 }, renumbered };
}

/** Before a page is deleted: its children move up to its parent. Returns how many moved. */
export async function liftChildren(deps: Deps, orgId: string, id: string): Promise<number> {
  const d = await deps.db.select({ parentId: docs.parentId }).from(docs).where(and(eq(docs.id, id), eq(docs.orgId, orgId))).get();
  if (!d) return 0;
  const kids = await deps.db.select({ id: docs.id }).from(docs).where(and(eq(docs.orgId, orgId), eq(docs.parentId, id), isNull(docs.deletedAt)));
  if (!kids.length) return 0;
  await deps.db.update(docs).set({ parentId: d.parentId }).where(and(eq(docs.orgId, orgId), eq(docs.parentId, id), isNull(docs.deletedAt)));
  return kids.length;
}

// ---------------------------------------------------------------- backlinks

const BLOCKS = new Set(["paragraph", "heading", "listItem", "blockquote", "codeBlock", "taskItem", "tableCell"]);

function textOf(n: PMNode): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "mention" || n.type === "pageLink") return String(n.attrs?.label ?? n.attrs?.title ?? "");
  return (n.content ?? []).map(textOf).join("");
}

/** The text of the block that holds the link to target, cut to about 160 characters. */
export function snippetFor(body: unknown, target: DocLinkRef, fallback = ""): string {
  let found = "";
  const hit = (n: PMNode): boolean => {
    const r = nodeRef(n);
    if (r && r.type === target.type && r.id === target.id) return true;
    for (const m of n.marks ?? []) if (m?.type === "link" && typeof m.attrs?.href === "string") { const p = parseAppHref(m.attrs.href); if (p && p.type === target.type && p.id === target.id) return true; }
    return (n.content ?? []).some(hit);
  };
  const walk = (n: PMNode, depth: number) => {
    if (found || !n || typeof n !== "object" || depth > 200) return;
    if (n.type && BLOCKS.has(n.type) && !(n.content ?? []).some((c) => c.type && BLOCKS.has(c.type)) && hit(n)) { found = textOf(n); return; }
    for (const c of n.content ?? []) walk(c, depth + 1);
  };
  walk(body as PMNode, 0);
  const s = (found || fallback).replace(/\s+/g, " ").trim();
  return s.length > 160 ? `${s.slice(0, 157).trimEnd()}...` : s;
}

/** Docs that link to a doc, task or project, newest first, within what the viewer can open. */
export async function getBacklinks(deps: Deps, v: DocViewer, target: DocLinkRef) {
  if (target.type === "doc") {
    const d = await deps.db.select({ id: docs.id, projectId: docs.projectId }).from(docs).where(and(eq(docs.id, target.id), eq(docs.orgId, v.orgId), isNull(docs.deletedAt))).get();
    if (!d || (v.projectId && d.projectId !== v.projectId)) throw notFound("Doc");
  } else if (target.type === "task") {
    const t = await deps.db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(and(eq(tasks.id, target.id), eq(tasks.orgId, v.orgId))).get();
    if (!t || (v.projectId && t.projectId !== v.projectId)) throw notFound("Task");
  } else {
    const p = await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, target.id), eq(projects.orgId, v.orgId))).get();
    if (!p || (v.projectId && p.id !== v.projectId)) throw notFound("Project");
  }
  const rows = await deps.db.select({ id: docs.id, title: docs.title, content: docs.content, plainText: docs.plainText, projectId: docs.projectId, parentId: docs.parentId, updatedAt: docs.updatedAt })
    .from(docLinks).innerJoin(docs, eq(docs.id, docLinks.sourceDocId))
    .where(and(eq(docLinks.targetType, target.type), eq(docLinks.targetId, target.id), eq(docLinks.orgId, v.orgId), eq(docs.orgId, v.orgId), isNull(docs.deletedAt), v.projectId ? eq(docs.projectId, v.projectId) : undefined))
    .orderBy(desc(docs.updatedAt), asc(docs.id)).limit(100);
  return {
    backlinks: rows.map((r) => {
      let body: unknown = null;
      try { body = JSON.parse(r.content); } catch { /* a broken body gives the plain text */ }
      return { id: r.id, title: r.title, snippet: snippetFor(body, target, r.plainText), projectId: r.projectId, updatedAt: r.updatedAt.toISOString() };
    }),
  };
}
