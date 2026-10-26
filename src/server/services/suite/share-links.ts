/**
 * R26 (MB-87): read only share links for a doc or a project board, so a team can send a client or a partner
 * a link without making them a guest. The token (32 random bytes, base64url) is shown once to the creator as
 * <appUrl>/s/<token>; only its SHA-256 is stored. Opening a link writes nothing (views are not counted).
 *
 * Who can make one: a workspace member or admin who can open the target (a doc or project in their own
 * workspace). Guests have no session here, agent keys and read only keys are refused, and an admin can turn
 * every link off with "Allow share links" (on by default; kept in the workspace's metadata JSON).
 *
 * What the public page shows: for a doc, its title and body rendered read only on the server (comments and
 * unknown marks dropped, mentions are plain names, links into the app become plain text so no ids leak); for
 * a board, its columns by status with each card's title, assignee initials, due date and labels. Never notes,
 * comments, files or custom fields.
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { agents, docs, organizations, projectStatuses, projects, shareLinks, tasks, users } from "../../db/schema";
import { newId, randomToken, sha256Hex } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { inChunks } from "../../lib/sql-chunks";
import type { SuiteActor } from "./common";

export type ShareKind = "doc" | "project_board";
export const SHARE_EXPIRY_DAYS = [7, 30] as const;
/** Cards shown on a shared board (top level tasks, newest work first within a column). */
export const SHARE_BOARD_MAX_CARDS = 500;

type Actor = SuiteActor & { scope?: "full" | "read"; agentId?: string | null; guest?: boolean };

const readMeta = (raw: string | null | undefined): Record<string, unknown> => {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
};

/** "Allow share links": on unless an admin turned it off. */
export async function shareLinksAllowed(deps: Deps, orgId: string): Promise<boolean> {
  const org = await deps.db.select({ metadata: organizations.metadata }).from(organizations).where(eq(organizations.id, orgId)).get();
  return readMeta(org?.metadata).shareLinks !== false;
}

/** Admins and owners only. One organizations row write when the value changes, none when it does not. */
export async function setShareLinksAllowed(deps: Deps, actor: Actor, allowed: boolean) {
  assertPerson(actor);
  if (actor.role !== "owner" && actor.role !== "admin") throw new HttpError(403, "forbidden", "Only workspace admins can do that.");
  const org = await deps.db.select({ metadata: organizations.metadata }).from(organizations).where(eq(organizations.id, actor.orgId)).get();
  if (!org) throw notFound("Workspace");
  const meta = readMeta(org.metadata);
  if ((meta.shareLinks !== false) === allowed) return { allowShareLinks: allowed };
  const next = { ...meta };
  if (allowed) delete next.shareLinks; else next.shareLinks = false;
  await deps.db.update(organizations).set({ metadata: JSON.stringify(next) }).where(eq(organizations.id, actor.orgId));
  return { allowShareLinks: allowed };
}

function assertPerson(actor: Actor) {
  if (actor.guest) throw new HttpError(403, "forbidden", "Guests can't share links.");
  if (actor.agentId) throw new HttpError(403, "agent_key_scope", "Agent keys can't make share links. Use a workspace key.");
}

function assertCanWrite(actor: Actor) {
  assertPerson(actor);
  if (actor.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
}

/** The target must be a live doc or project in the actor's own workspace; anything else is a 404. */
async function targetTitle(deps: Deps, orgId: string, kind: ShareKind, targetId: string): Promise<string> {
  if (kind === "doc") {
    const d = await deps.db.select({ title: docs.title }).from(docs).where(and(eq(docs.orgId, orgId), eq(docs.id, targetId), isNull(docs.deletedAt))).get();
    if (!d) throw notFound("Doc");
    return d.title;
  }
  const p = await deps.db.select({ name: projects.name }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, targetId), isNull(projects.deletedAt))).get();
  if (!p) throw notFound("Project");
  return p.name;
}

export function shareUrl(deps: Deps, token: string) {
  return `${deps.config.appUrl.replace(/\/+$/, "")}/s/${token}`;
}

type Row = typeof shareLinks.$inferSelect;
const isActive = (r: Pick<Row, "revokedAt" | "expiresAt">, now: Date) => !r.revokedAt && (!r.expiresAt || r.expiresAt.getTime() > now.getTime());
const present = (r: Row) => ({
  id: r.id, kind: r.kind, targetId: r.targetId, showWorkspaceName: r.showWorkspace, createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
});

export interface CreateShareInput { kind: ShareKind; targetId: string; expiresInDays?: 7 | 30 | null; showWorkspaceName?: boolean }

/** Makes a link. Writes one share_links row (plus its token index). The token is returned once and never stored. */
export async function createShareLink(deps: Deps, actor: Actor, input: CreateShareInput) {
  assertCanWrite(actor);
  await targetTitle(deps, actor.orgId, input.kind, input.targetId);
  if (!(await shareLinksAllowed(deps, actor.orgId))) throw new HttpError(403, "share_links_off", "An admin turned share links off for this workspace.");
  const token = randomToken(32);
  const now = deps.now();
  const row: Row = {
    id: newId("shl"), orgId: actor.orgId, kind: input.kind, targetId: input.targetId, tokenHash: await sha256Hex(token),
    showWorkspace: input.showWorkspaceName ?? true, createdBy: actor.userId || actor.email || "unknown", createdAt: now,
    expiresAt: input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * 86_400_000) : null, revokedAt: null,
  };
  await deps.db.insert(shareLinks).values(row);
  return { link: { ...present(row), url: shareUrl(deps, token) }, token };
}

/** Active links (not revoked, not expired), newest first; for one target when given. Reads only. */
export async function listShareLinks(deps: Deps, actor: Actor, q: { kind?: ShareKind; targetId?: string } = {}) {
  assertPerson(actor);
  if (q.targetId && q.kind) await targetTitle(deps, actor.orgId, q.kind, q.targetId);
  const where = [eq(shareLinks.orgId, actor.orgId), isNull(shareLinks.revokedAt)];
  if (q.kind) where.push(eq(shareLinks.kind, q.kind));
  if (q.targetId) where.push(eq(shareLinks.targetId, q.targetId));
  const rows = await deps.db.select().from(shareLinks).where(and(...where)).orderBy(desc(shareLinks.createdAt)).limit(200);
  const now = deps.now();
  return { links: rows.filter((r) => isActive(r, now)).map(present), allowShareLinks: await shareLinksAllowed(deps, actor.orgId) };
}

/** Revokes a link at once. One row update; revoking twice writes nothing. Another workspace's link is a 404. */
export async function revokeShareLink(deps: Deps, actor: Actor, id: string) {
  assertCanWrite(actor);
  const row = await deps.db.select().from(shareLinks).where(and(eq(shareLinks.orgId, actor.orgId), eq(shareLinks.id, id))).get();
  if (!row) throw notFound("Share link");
  if (!row.revokedAt) await deps.db.update(shareLinks).set({ revokedAt: deps.now() }).where(and(eq(shareLinks.orgId, actor.orgId), eq(shareLinks.id, id)));
  return { ok: true };
}

// ---------------------------------------------------------------- the public payload

export interface PublicCard { title: string; assignee: string | null; due: string | null; labels: string[] }
export interface PublicColumn { name: string; color: string; cards: PublicCard[] }
export type PublicShare =
  | { kind: "doc"; workspace: string | null; title: string; html: string }
  | { kind: "project_board"; workspace: string | null; title: string; color: string; columns: PublicColumn[]; truncated: boolean };

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** What /s/<token> shows, or null when the token is unknown, revoked, expired, its target is gone or links are off. Reads only. */
export async function publicShare(deps: Deps, token: string): Promise<PublicShare | null> {
  if (!TOKEN_RE.test(token)) return null;
  const row = await deps.db.select().from(shareLinks).where(eq(shareLinks.tokenHash, await sha256Hex(token))).get();
  if (!row || !isActive(row, deps.now())) return null;
  const org = await deps.db.select({ name: organizations.name, metadata: organizations.metadata }).from(organizations).where(eq(organizations.id, row.orgId)).get();
  if (!org || readMeta(org.metadata).shareLinks === false) return null;
  const workspace = row.showWorkspace ? org.name : null;
  if (row.kind === "doc") {
    const d = await deps.db.select({ title: docs.title, content: docs.content }).from(docs).where(and(eq(docs.orgId, row.orgId), eq(docs.id, row.targetId), isNull(docs.deletedAt))).get();
    if (!d) return null;
    let content: unknown;
    try { content = JSON.parse(d.content); } catch { content = null; }
    return { kind: "doc", workspace, title: d.title, html: renderDocHtml(content, deps.config.appUrl) };
  }
  const p = await deps.db.select({ name: projects.name, color: projects.color }).from(projects).where(and(eq(projects.orgId, row.orgId), eq(projects.id, row.targetId), isNull(projects.deletedAt))).get();
  if (!p) return null;
  const statuses = await deps.db.select({ id: projectStatuses.id, name: projectStatuses.name, color: projectStatuses.color }).from(projectStatuses)
    .where(and(eq(projectStatuses.orgId, row.orgId), eq(projectStatuses.projectId, row.targetId), isNull(projectStatuses.deletedAt))).orderBy(asc(projectStatuses.position));
  const list = await deps.db.select({ statusId: tasks.statusId, title: tasks.title, assigneeType: tasks.assigneeType, assigneeId: tasks.assigneeId, dueAt: tasks.dueAt, labels: tasks.labels, triageState: tasks.triageState, parentId: tasks.parentId })
    .from(tasks).where(and(eq(tasks.orgId, row.orgId), eq(tasks.projectId, row.targetId), isNull(tasks.deletedAt), isNull(tasks.parentId)))
    .orderBy(asc(tasks.position)).limit(SHARE_BOARD_MAX_CARDS + 1);
  const truncated = list.length > SHARE_BOARD_MAX_CARDS;
  const shown = list.slice(0, SHARE_BOARD_MAX_CARDS).filter((t) => !t.triageState);
  const memberIds = [...new Set(shown.filter((t) => t.assigneeType === "member" && t.assigneeId).map((t) => t.assigneeId!))];
  const agentIds = [...new Set(shown.filter((t) => t.assigneeType === "agent" && t.assigneeId).map((t) => t.assigneeId!))];
  const names = new Map<string, string>();
  for (const u of await inChunks(memberIds, (ids) => deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)))) names.set(`member:${u.id}`, u.name);
  for (const a of await inChunks(agentIds, (ids) => deps.db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.orgId, row.orgId), inArray(agents.id, ids))))) names.set(`agent:${a.id}`, a.name);
  const columns: PublicColumn[] = statuses.map((s) => ({ name: s.name, color: s.color, cards: [] }));
  const byStatus = new Map(statuses.map((s, i) => [s.id, columns[i]]));
  for (const t of shown) {
    const col = byStatus.get(t.statusId);
    if (!col) continue;
    const who = t.assigneeType && t.assigneeId ? names.get(`${t.assigneeType}:${t.assigneeId}`) : undefined;
    col.cards.push({ title: t.title, assignee: who ? initials(who) : null, due: t.dueAt ? t.dueAt.toISOString().slice(0, 10) : null, labels: parseLabels(t.labels) });
  }
  return { kind: "project_board", workspace, title: p.name, color: p.color, columns, truncated };
}


export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

function parseLabels(raw: string): string[] {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10) : []; } catch { return []; }
}

// ---------------------------------------------------------------- the read only doc renderer

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface PMNode { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: { type?: string; attrs?: Record<string, unknown> }[]; content?: PMNode[] }

/** A link that leaves the app keeps its href; links into the app (relative, or to appUrl) become plain text. */
function externalHref(href: unknown, appUrl: string): string | null {
  if (typeof href !== "string") return null;
  let u: URL;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "mailto:") return null;
  try { if (u.origin === new URL(appUrl).origin) return null; } catch { /* no app url */ }
  return u.toString();
}

function renderText(n: PMNode, appUrl: string): string {
  let out = esc(n.text ?? "");
  for (const m of n.marks ?? []) {
    if (m.type === "bold") out = `<strong>${out}</strong>`;
    else if (m.type === "italic") out = `<em>${out}</em>`;
    else if (m.type === "strike") out = `<s>${out}</s>`;
    else if (m.type === "underline") out = `<u>${out}</u>`;
    else if (m.type === "code") out = `<code>${out}</code>`;
    else if (m.type === "link") { const href = externalHref(m.attrs?.href, appUrl); if (href) out = `<a href="${esc(href)}" rel="noopener noreferrer nofollow" target="_blank">${out}</a>`; }
    // Comment marks, highlights and anything else are dropped: only the text shows.
  }
  return out;
}

/**
 * Tiptap (ProseMirror) JSON to HTML, for the nodes the doc editor makes (StarterKit, task lists, R32 tables, images, callouts). Every text and
 * attribute is escaped; unknown nodes render only their children; mentions show the name alone.
 */
export function renderDocHtml(doc: unknown, appUrl: string, depth = 0): string {
  const n = doc as PMNode | null;
  if (!n || typeof n !== "object" || depth > 40) return "";
  const kids = () => (Array.isArray(n.content) ? n.content.map((c) => renderDocHtml(c, appUrl, depth + 1)).join("") : "");
  switch (n.type) {
    case "doc": return kids();
    case "text": return renderText(n, appUrl);
    case "paragraph": return `<p>${kids()}</p>`;
    case "heading": { const l = Math.min(Math.max(Number(n.attrs?.level) || 2, 1), 4); return `<h${l}>${kids()}</h${l}>`; }
    case "bulletList": return `<ul>${kids()}</ul>`;
    case "orderedList": { const s = Number(n.attrs?.start); return `<ol${Number.isInteger(s) && s > 1 ? ` start="${s}"` : ""}>${kids()}</ol>`; }
    case "listItem": return `<li>${kids()}</li>`;
    case "taskList": return `<ul class="tasks">${kids()}</ul>`;
    case "taskItem": return `<li class="${n.attrs?.checked ? "done" : "todo"}"><span class="box" aria-hidden="true"></span><div>${kids()}</div></li>`;
    case "blockquote": return `<blockquote>${kids()}</blockquote>`;
    case "codeBlock": return `<pre><code>${kids()}</code></pre>`;
    case "horizontalRule": return "<hr>";
    case "hardBreak": return "<br>";
    case "mention": { const label = n.attrs?.label ?? n.attrs?.name; return typeof label === "string" ? `@${esc(label)}` : ""; }
    // R32: tables, callouts and images. Only https and inline images render on a public page (uploads need a member session).
    case "table": return `<div class="table"><table>${kids()}</table></div>`;
    case "tableRow": return `<tr>${kids()}</tr>`;
    case "tableHeader": case "tableCell": {
      const tag = n.type === "tableHeader" ? "th" : "td";
      const cs = Number(n.attrs?.colspan), rs = Number(n.attrs?.rowspan);
      return `<${tag}${Number.isInteger(cs) && cs > 1 && cs < 100 ? ` colspan="${cs}"` : ""}${Number.isInteger(rs) && rs > 1 && rs < 1000 ? ` rowspan="${rs}"` : ""}>${kids()}</${tag}>`;
    }
    case "callout": { const v = ["info", "success", "warning", "danger"].includes(String(n.attrs?.variant)) ? String(n.attrs?.variant) : "info"; return `<div class="callout" data-callout="${v}" role="note">${kids()}</div>`; }
    case "image": {
      const src = typeof n.attrs?.src === "string" ? n.attrs.src : "";
      const ok = /^https:\/\//i.test(src) || /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(src);
      const alt = typeof n.attrs?.alt === "string" ? n.attrs.alt : "";
      if (!ok) return alt ? `<p class="img-missing">${esc(alt)}</p>` : "";
      const size = ["fit", "wide", "full"].includes(String(n.attrs?.size)) ? String(n.attrs?.size) : "fit";
      return `<img src="${esc(src)}" alt="${esc(alt)}" data-size="${size}" loading="lazy" referrerpolicy="no-referrer">`;
    }
    default: return kids();
  }
}
