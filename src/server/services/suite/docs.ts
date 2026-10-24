/** Simple rich text docs (Tiptap JSON) linked to projects, tasks, threads or contacts. */
import { and, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import type { Deps } from "../../context";
import { docs, entityLinks } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, createdBy, recordWrite, sortableId, type SuiteActor } from "./common";
import { link, linked } from "./tasks";

export type LinkTarget = { type: "project" | "task" | "thread" | "contact" | "deal"; id: string };
interface PMNode { type?: string; text?: string; content?: PMNode[]; attrs?: Record<string, unknown> }

const BLOCKS = new Set(["paragraph", "heading", "listItem", "blockquote", "codeBlock", "taskItem"]);

/** Plain text of a ProseMirror document, one line per block. */
export function plainTextOf(node: PMNode): string {
  const out: string[] = [];
  const walk = (n: PMNode, line: string[]): void => {
    if (n.type === "text" && n.text) { line.push(n.text); return; }
    if (n.type === "hardBreak") { line.push("\n"); return; }
    if (n.content) {
      if (n.type && BLOCKS.has(n.type)) {
        const inner: string[] = [];
        for (const c of n.content) walk(c, inner);
        const s = inner.join("").trim();
        if (s) out.push(s);
      } else for (const c of n.content) walk(c, line);
    }
  };
  walk(node, []);
  return out.join("\n");
}

/** A document from plain text: one paragraph per line, "# " headings and "- " bullets. */
export function docFromText(text: string): PMNode {
  const content: PMNode[] = [];
  let bullets: PMNode[] = [];
  const flush = () => { if (bullets.length) { content.push({ type: "bulletList", content: bullets }); bullets = []; } };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b) { bullets.push({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: b[1] }] }] }); continue; }
    flush();
    if (h) content.push({ type: "heading", attrs: { level: h[1].length }, content: [{ type: "text", text: h[2] }] });
    else if (line.trim()) content.push({ type: "paragraph", content: [{ type: "text", text: line }] });
  }
  flush();
  return { type: "doc", content };
}

function validDoc(content: unknown): PMNode {
  if (!content || typeof content !== "object" || (content as PMNode).type !== "doc") throw new HttpError(422, "validation_failed", "content must be a Tiptap document (type: doc).");
  const s = JSON.stringify(content);
  if (s.length > 1_000_000) throw new HttpError(413, "too_large", "That doc is over 1 MB.");
  return content as PMNode;
}

type DocRow = typeof docs.$inferSelect;
function presentDoc(d: DocRow, full = false) {
  return {
    id: d.id, title: d.title, projectId: d.projectId, excerpt: d.plainText.slice(0, 200),
    ...(full ? { content: JSON.parse(d.content) as PMNode, text: d.plainText } : {}),
    createdBy: { type: d.createdByType, id: d.createdById }, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(), version: d.version,
  };
}

export async function listDocs(deps: Deps, orgId: string, q: { q?: string; projectId?: string; linkedTo?: LinkTarget } = {}) {
  let ids: string[] | undefined;
  if (q.linkedTo) ids = await linked(deps, orgId, q.linkedTo.type, q.linkedTo.id, "doc");
  if (ids && !ids.length) return [];
  const rows = await deps.db.select().from(docs).where(and(eq(docs.orgId, orgId), isNull(docs.deletedAt),
    q.projectId ? eq(docs.projectId, q.projectId) : undefined, ids ? inArray(docs.id, ids) : undefined,
    q.q ? or(like(docs.title, `%${q.q}%`), like(docs.plainText, `%${q.q}%`)) : undefined)).orderBy(desc(docs.updatedAt)).limit(200);
  return rows.map((d) => presentDoc(d));
}

async function docRow(deps: Deps, orgId: string, id: string) {
  const d = await deps.db.select().from(docs).where(and(eq(docs.id, id), eq(docs.orgId, orgId), isNull(docs.deletedAt))).get();
  if (!d) throw notFound("Doc");
  return d;
}

export async function getDoc(deps: Deps, orgId: string, id: string) {
  const d = await docRow(deps, orgId, id);
  const links = await deps.db.select().from(entityLinks).where(and(eq(entityLinks.orgId, orgId), or(and(eq(entityLinks.fromType, "doc"), eq(entityLinks.fromId, id)), and(eq(entityLinks.toType, "doc"), eq(entityLinks.toId, id)))));
  return { ...presentDoc(d, true), links: links.map((l) => (l.fromType === "doc" ? { type: l.toType, id: l.toId } : { type: l.fromType, id: l.fromId })) };
}

export async function createDoc(deps: Deps, actor: SuiteActor, input: { title: string; content?: unknown; text?: string; projectId?: string | null; links?: LinkTarget[] }) {
  assertWritable(actor);
  const body = input.content !== undefined ? validDoc(input.content) : docFromText(input.text ?? "");
  const now = deps.now();
  const id = sortableId("doc", now.getTime());
  await deps.db.insert(docs).values({ id, orgId: actor.orgId, title: input.title.trim() || "Untitled", content: JSON.stringify(body), plainText: plainTextOf(body), projectId: input.projectId ?? null, ...createdBy(actor), createdAt: now, updatedAt: now });
  for (const l of [...(input.links ?? []), ...(input.projectId ? [{ type: "project" as const, id: input.projectId }] : [])]) await link(deps, actor.orgId, { type: "doc", id }, l);
  await recordWrite(deps, actor, { entityType: "doc", entityId: id, op: "create", verb: "created", data: { title: input.title }, event: "doc.created", eventData: { id, title: input.title } });
  for (const l of input.links ?? []) if (l.type === "task" || l.type === "contact") await recordWrite(deps, actor, { entityType: l.type, entityId: l.id, op: "update", verb: "doc_linked", data: { docId: id, title: input.title } });
  return getDoc(deps, actor.orgId, id);
}

export async function updateDoc(deps: Deps, actor: SuiteActor, id: string, patch: { title?: string; content?: unknown; version?: number; links?: LinkTarget[] }) {
  assertWritable(actor);
  const d = await docRow(deps, actor.orgId, id);
  if (patch.version !== undefined && patch.version !== d.version) throw new HttpError(409, "version_conflict", "This doc changed since you opened it. Reload to see the latest.");
  const body = patch.content !== undefined ? validDoc(patch.content) : undefined;
  await deps.db.update(docs).set({
    ...(patch.title !== undefined ? { title: patch.title.trim() || "Untitled" } : {}),
    ...(body ? { content: JSON.stringify(body), plainText: plainTextOf(body) } : {}),
    updatedAt: deps.now(), version: d.version + 1,
  }).where(eq(docs.id, id));
  for (const l of patch.links ?? []) await link(deps, actor.orgId, { type: "doc", id }, l);
  await recordWrite(deps, actor, { entityType: "doc", entityId: id, op: "update", version: d.version + 1, verb: "edited", data: {}, event: "doc.updated", eventData: { id, title: patch.title ?? d.title, version: d.version + 1 } });
  return getDoc(deps, actor.orgId, id);
}

/** For agents: add text to the end of a doc without rewriting it. */
export async function appendToDoc(deps: Deps, actor: SuiteActor, id: string, text: string) {
  const d = await docRow(deps, actor.orgId, id);
  const cur = JSON.parse(d.content) as PMNode;
  const add = docFromText(text).content ?? [];
  return updateDoc(deps, actor, id, { content: { ...cur, content: [...(cur.content ?? []), ...add] } });
}

export async function deleteDoc(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  await docRow(deps, actor.orgId, id);
  await deps.db.update(docs).set({ deletedAt: deps.now(), updatedAt: deps.now() }).where(eq(docs.id, id));
  await recordWrite(deps, actor, { entityType: "doc", entityId: id, op: "delete", verb: "deleted" });
  return { ok: true };
}
