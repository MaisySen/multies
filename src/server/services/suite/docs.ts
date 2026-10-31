/** Simple rich text docs (Tiptap JSON) linked to projects, tasks, threads or contacts. */
import { and, desc, eq, isNull, like, or } from "drizzle-orm";
import type { Deps } from "../../context";
import { contacts, deals, docs, entityLinks, messages, projects, tasks } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, createdBy, recordWrite, sortableId, type SuiteActor } from "./common";
import { link, linked } from "./tasks";
import { liftChildren, placeNewDoc, syncDocLinks } from "./doc-tree";
import { boardTextOf, docKindOf } from "../../../shared/docs-visual"; // R89
import { markdownToDoc } from "./markdown-doc";
import { editorShape } from "./doc-editor-shape";
import { inIds } from "../../lib/sql-chunks";
import { snapshotBeforeEdit } from "./doc-versions-r39"; // R39: page history

export type LinkTarget = { type: "project" | "task" | "thread" | "contact" | "deal"; id: string };
interface PMNode { type?: string; text?: string; content?: PMNode[]; attrs?: Record<string, unknown> }

const BLOCKS = new Set(["paragraph", "heading", "listItem", "blockquote", "codeBlock", "taskItem", "tableCell", "tableHeader", "diagram"]); // R32: one line per table cell

/** Plain text of a ProseMirror document, one line per block. */
export function plainTextOf(node: PMNode): string {
  const out: string[] = [];
  const walk = (n: PMNode, line: string[]): void => {
    if (n.type === "text" && n.text) { line.push(n.text); return; }
    if (n.type === "whiteboard") { const s = boardTextOf(n.attrs?.scene); if (s) out.push(s); return; } // R89: words on a board
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
  return safeLinks(content as PMNode, 0);
}

/** Link marks keep http, https and mailto targets only; a javascript: or data: href is dropped. */
const SAFE_HREF = /^(https?:|mailto:|\/(?!\/)|#)/i;
/** Browsers ignore tabs, newlines and other control characters inside a URL scheme ("java\tscript:"). */
const withoutControls = (s: string) => [...s].filter((ch) => ch.charCodeAt(0) > 0x20).join("");
function safeLinks(node: PMNode, depth: number): PMNode {
  if (depth > 64) throw new HttpError(422, "validation_failed", "That doc is nested too deeply.");
  const n = node as PMNode & { marks?: { type: string; attrs?: Record<string, unknown> }[]; content?: PMNode[] };
  if (Array.isArray(n.marks)) {
    n.marks = n.marks.filter((m) => m.type !== "link" || (typeof m.attrs?.href === "string" && SAFE_HREF.test(withoutControls(m.attrs.href))));
  }
  if (Array.isArray(n.content)) n.content = n.content.filter((c) => !(c && c.type === "image" && !safeImageSrc(c.attrs?.src))).map((c) => safeLinks(c, depth + 1));
  return n;
}

/** R32: an image in a doc keeps an https source, our own upload path, or inline png/jpeg/gif/webp data; anything else is dropped. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;
export function safeImageSrc(src: unknown): boolean {
  if (typeof src !== "string" || src.length > 700_000) return false;
  const s = withoutControls(src);
  if (s.startsWith("/api/doc-images/")) return /^\/api\/doc-images\/[A-Za-z0-9_-]+$/.test(s);
  if (/^data:/i.test(s)) return DATA_IMAGE.test(s);
  try { return new URL(s).protocol === "https:"; } catch { return false; }
}

type DocRow = typeof docs.$inferSelect;
/** The list preview: body lines only (a first line that repeats the title is dropped), one per block. */
export function excerptOf(title: string, plain: string): string {
  const lines = plain.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines[0].toLowerCase() === title.trim().toLowerCase()) lines.shift();
  return lines.join("\n").slice(0, 200);
}
function presentDoc(d: DocRow, full = false) {
  return {
    id: d.id, title: d.title, kind: d.kind ?? "doc", projectId: d.projectId, parentId: d.parentId, position: d.position, excerpt: excerptOf(d.title, d.plainText),
    ...(full ? { content: JSON.parse(d.content) as PMNode, text: d.plainText } : {}),
    createdBy: { type: d.createdByType, id: d.createdById }, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(), version: d.version,
  };
}

export async function listDocs(deps: Deps, orgId: string, q: { q?: string; projectId?: string; linkedTo?: LinkTarget } = {}) {
  let ids: string[] | undefined;
  if (q.linkedTo) ids = await linked(deps, orgId, q.linkedTo.type, q.linkedTo.id, "doc");
  if (ids && !ids.length) return [];
  const rows = await deps.db.select().from(docs).where(and(eq(docs.orgId, orgId), isNull(docs.deletedAt),
    q.projectId ? eq(docs.projectId, q.projectId) : undefined, ids ? inIds(docs.id, ids) : undefined,
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

/** A link may only point at this workspace's own records: another workspace's id is a 404. */
async function assertLinkTargets(deps: Deps, orgId: string, targets: LinkTarget[]) {
  for (const l of targets) {
    const row = l.type === "project" ? await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, l.id))).get()
      : l.type === "task" ? await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.id, l.id))).get()
      : l.type === "contact" ? await deps.db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.id, l.id))).get()
      : l.type === "deal" ? await deps.db.select({ id: deals.id }).from(deals).where(and(eq(deals.orgId, orgId), eq(deals.id, l.id))).get()
      : await deps.db.select({ id: messages.id }).from(messages).where(and(eq(messages.orgId, orgId), eq(messages.threadId, l.id))).limit(1).get();
    if (!row) throw notFound(l.type === "thread" ? "Thread" : l.type[0].toUpperCase() + l.type.slice(1));
  }
}

export async function createDoc(deps: Deps, actor: SuiteActor, input: { title: string; content?: unknown; text?: string; projectId?: string | null; links?: LinkTarget[]; parentId?: string | null }, opts: { id?: string; retry?: boolean } = {}) {
  assertWritable(actor);
  if (opts.id && opts.retry && await deps.db.select({ id: docs.id }).from(docs).where(and(eq(docs.id, opts.id), eq(docs.orgId, actor.orgId))).get()) return getDoc(deps, actor.orgId, opts.id); // R52 (MB-239): a retry under the same Idempotency-Key returns what the first attempt made
  const body = input.content !== undefined ? validDoc(input.content) : editorShape(docFromText(input.text ?? "")); // R29: as the editor holds it
  await assertLinkTargets(deps, actor.orgId, [...(input.links ?? []), ...(input.projectId ? [{ type: "project" as const, id: input.projectId }] : [])]);
  const place = await placeNewDoc(deps, actor.orgId, input.parentId); // R24: tree position
  const now = deps.now();
  const id = opts.id ?? sortableId("doc", now.getTime()); // R51 (MB-239): the same id on an Idempotency-Key retry
  await deps.db.insert(docs).values({ id, orgId: actor.orgId, title: input.title.trim() || "Untitled", content: JSON.stringify(body), plainText: plainTextOf(body), kind: docKindOf(body), projectId: input.projectId ?? null, ...place, ...createdBy(actor), createdAt: now, updatedAt: now });
  await syncDocLinks(deps, actor.orgId, id, body); // R24: backlinks
  for (const l of [...(input.links ?? []), ...(input.projectId ? [{ type: "project" as const, id: input.projectId }] : [])]) await link(deps, actor.orgId, { type: "doc", id }, l);
  await recordWrite(deps, actor, { entityType: "doc", entityId: id, op: "create", verb: "created", data: { title: input.title }, event: "doc.created", eventData: { id, title: input.title } });
  for (const l of input.links ?? []) if (l.type === "task" || l.type === "contact") await recordWrite(deps, actor, { entityType: l.type, entityId: l.id, op: "update", verb: "doc_linked", data: { docId: id, title: input.title } });
  return getDoc(deps, actor.orgId, id);
}

export async function updateDoc(deps: Deps, actor: SuiteActor, id: string, patch: { title?: string; content?: unknown; text?: string; version?: number; ifVersion?: number; links?: LinkTarget[] }, opts: { history?: boolean } = {}) {
  assertWritable(actor);
  const d = await docRow(deps, actor.orgId, id);
  const expected = patch.version ?? patch.ifVersion; // R28: ifVersion is the API's name for it
  if (expected !== undefined && expected !== d.version) throw versionConflict(d.version);
  // MB-58: plain text replaces the body too, with the same rules as create (# headings, - bullets).
  const body = patch.content !== undefined ? validDoc(patch.content) : patch.text !== undefined ? editorShape(docFromText(patch.text)) : undefined;
  await assertLinkTargets(deps, actor.orgId, patch.links ?? []);
  // R39: page history. A new editing session saves the page as it stood first (deferrable, never fails the edit).
  const changesPage = body !== undefined || (patch.title !== undefined && (patch.title.trim() || "Untitled") !== d.title);
  if (changesPage && opts.history !== false) await snapshotBeforeEdit(deps, actor, d);
  const written = await deps.db.update(docs).set({
    ...(patch.title !== undefined ? { title: patch.title.trim() || "Untitled" } : {}),
    ...(body ? { content: JSON.stringify(body), plainText: plainTextOf(body), kind: docKindOf(body) } : {}),
    updatedAt: deps.now(), version: d.version + 1,
  }).where(and(eq(docs.id, id), eq(docs.version, d.version))).returning({ id: docs.id }); // R28: no lost update between the read and this write
  if (!written.length) throw versionConflict((await docRow(deps, actor.orgId, id)).version);
  if (body) await syncDocLinks(deps, actor.orgId, id, body); // R24: only changed links are written
  for (const l of patch.links ?? []) await link(deps, actor.orgId, { type: "doc", id }, l);
  await recordWrite(deps, actor, { entityType: "doc", entityId: id, op: "update", version: d.version + 1, verb: "edited", data: {}, event: "doc.updated", eventData: { id, title: patch.title ?? d.title, version: d.version + 1 } });
  return getDoc(deps, actor.orgId, id);
}

/** R28: a stale write answers 409 with the doc's current version, so a client can re-read and retry. */
export const versionConflict = (currentVersion: number) =>
  new HttpError(409, "version_conflict", "This doc changed since you opened it. Reload to see the latest.", { currentVersion });

/**
 * For agents: add to the end of a doc without rewriting it. Plain text keeps the create rules
 * (# headings, - bullets); markdown (R28) also takes numbered and task lists, quotes, code,
 * bold, italic and links. ifVersion makes the append fail with 409 if the doc changed since it was read.
 */
export async function appendToDoc(deps: Deps, actor: SuiteActor, id: string, text: string, opts: { markdown?: boolean; ifVersion?: number } = {}) {
  assertWritable(actor);
  const d = await docRow(deps, actor.orgId, id);
  if (opts.ifVersion !== undefined && opts.ifVersion !== d.version) throw versionConflict(d.version);
  const cur = JSON.parse(d.content) as PMNode;
  const keep = [...(cur.content ?? [])];
  while (keep.length && keep[keep.length - 1].type === "paragraph" && !keep[keep.length - 1].content?.length) keep.pop(); // an empty last line
  const add = (opts.markdown ? markdownToDoc(text) : docFromText(text)).content ?? [];
  // The version just read guards the write too: another write in between is a 409, not a lost edit.
  // R29: written in the editor's own shape (attributes filled, a closing empty paragraph), so opening the doc changes nothing.
  return updateDoc(deps, actor, id, { content: editorShape({ ...cur, content: [...keep, ...add] }), version: d.version });
}

export async function deleteDoc(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const d = await docRow(deps, actor.orgId, id);
  await liftChildren(deps, actor.orgId, id); // R24: sub pages move up to this page's parent
  await deps.db.update(docs).set({ deletedAt: deps.now(), updatedAt: deps.now() }).where(eq(docs.id, id));
  await recordWrite(deps, actor, { entityType: "doc", entityId: id, op: "delete", verb: "deleted", event: "doc.deleted", eventData: { id, object: "doc", title: d.title } }); // R51 (MB-239)
  return { ok: true };
}
