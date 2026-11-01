/**
 * R103: the team link library and the web clipper. Lists are bounded (200 rows), reads use link_library_org_idx.
 * Anyone in the workspace (not read only) saves and tags links; the person who saved one, an owner or an admin removes it.
 */
import { and, desc, eq, isNull, like, or } from "drizzle-orm";
import type { Deps } from "../../context";
import { linkLibrary, docs } from "../../db/schema";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { assertWritable, sortableId, type SuiteActor } from "../suite/common";
import { createDoc } from "../suite/docs";
import { linkKey, normalizeTags, siteOf, withScheme } from "@/shared/docs-plus";
import { ClipError, checkClipUrl, fetchPublicPage } from "./url-guard";
import { extractReadable, type DocNode } from "./extract";
import { fakeWebFetch } from "./fake-web";

/** The network the clipper reads through (a pretend web in local end to end runs). */
const net = (deps: Deps) => (deps.config.docsPlusFakeWeb ? { fetch: fakeWebFetch } : deps);

export const LIST_LIMIT = 200;
export const CLIPS_PAGE_TITLE = "Web clips";
type Row = typeof linkLibrary.$inferSelect;
const isAdmin = (a: SuiteActor) => a.role === "owner" || a.role === "admin";

function tagsOf(raw: string): string[] { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((t) => typeof t === "string") : []; } catch { return []; } }

export function presentLink(r: Row, actor: SuiteActor) {
  return {
    id: r.id, url: r.url, title: r.title || r.site || r.url, description: r.description, site: r.site, tags: tagsOf(r.tags), note: r.note,
    docId: r.docId, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    canRemove: r.createdBy === actor.userId || isAdmin(actor),
  };
}
export type LinkOut = ReturnType<typeof presentLink>;

export async function listLinks(deps: Deps, actor: SuiteActor, q: { q?: string; tag?: string; clipped?: boolean } = {}) {
  const term = q.q?.trim().slice(0, 200);
  const tag = q.tag ? normalizeTags([q.tag])[0] : undefined;
  const rows = await deps.db.select().from(linkLibrary).where(and(
    eq(linkLibrary.orgId, actor.orgId), isNull(linkLibrary.deletedAt),
    term ? or(like(linkLibrary.title, `%${term}%`), like(linkLibrary.url, `%${term}%`), like(linkLibrary.description, `%${term}%`), like(linkLibrary.note, `%${term}%`)) : undefined,
    tag ? like(linkLibrary.tags, `%${JSON.stringify(tag)}%`) : undefined,
  )).orderBy(desc(linkLibrary.createdAt)).limit(LIST_LIMIT + 1);
  const list = rows.filter((r) => q.clipped === undefined || !!r.docId === q.clipped);
  return { links: list.slice(0, LIST_LIMIT).map((r) => presentLink(r, actor)), more: rows.length > LIST_LIMIT };
}

/** Tag counts over the newest 1000 links (bounded). */
export async function listTags(deps: Deps, orgId: string) {
  const rows = await deps.db.select({ tags: linkLibrary.tags }).from(linkLibrary).where(and(eq(linkLibrary.orgId, orgId), isNull(linkLibrary.deletedAt))).orderBy(desc(linkLibrary.createdAt)).limit(1000);
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of tagsOf(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 100).map(([tag, count]) => ({ tag, count }));
}

async function rowById(deps: Deps, orgId: string, id: string) {
  const r = await deps.db.select().from(linkLibrary).where(and(eq(linkLibrary.orgId, orgId), eq(linkLibrary.id, id), isNull(linkLibrary.deletedAt))).get();
  if (!r) throw notFound("Link");
  return r;
}

function cleanUrl(raw: string): { url: string; key: string } {
  const url = withScheme(String(raw ?? "").slice(0, 2000));
  const key = linkKey(url);
  if (!key) throw new HttpError(422, "invalid_url", "Enter a web address that starts with http or https.");
  return { url: key, key };
}

const clipErr = (e: unknown) => (e instanceof ClipError ? new HttpError(422, e.code, e.message) : e);

/** Reads the page's title and description for a new link. Never fails the save: an unreadable page keeps its address. */
async function preview(deps: Deps, url: string): Promise<{ title: string; description: string; site: string }> {
  const site = siteOf(url);
  try {
    checkClipUrl(url);
    const page = await fetchPublicPage(net(deps), url, { maxBytes: 600_000, timeoutMs: 6000 });
    const x = extractReadable(page.body, page.url, page.contentType);
    return { title: x.title.slice(0, 300), description: x.description.slice(0, 600), site: (x.siteName || site).slice(0, 120) };
  } catch { return { title: site, description: "", site }; }
}

export interface SaveLinkInput { url: string; title?: string; tags?: unknown; note?: string }

/** Saves a link; the same address saved again returns the existing row with the new tags merged in. */
export async function saveLink(deps: Deps, actor: SuiteActor, input: SaveLinkInput) {
  assertWritable(actor);
  const { url, key } = cleanUrl(input.url);
  const tags = normalizeTags(input.tags);
  const existing = await deps.db.select().from(linkLibrary).where(and(eq(linkLibrary.orgId, actor.orgId), eq(linkLibrary.urlKey, key))).get();
  const now = deps.now();
  if (existing && !existing.deletedAt) {
    const merged = normalizeTags([...tagsOf(existing.tags), ...tags]);
    await deps.db.update(linkLibrary).set({ tags: JSON.stringify(merged), note: input.note?.trim() ? input.note.trim().slice(0, 2000) : existing.note, updatedAt: now }).where(eq(linkLibrary.id, existing.id));
    return { link: presentLink(await rowById(deps, actor.orgId, existing.id), actor), existing: true };
  }
  const p = await preview(deps, url);
  const values = { url, urlKey: key, title: (input.title?.trim() || p.title).slice(0, 300), description: p.description, site: p.site, tags: JSON.stringify(tags), note: (input.note ?? "").trim().slice(0, 2000), docId: null, createdBy: actor.userId, createdAt: now, updatedAt: now, deletedAt: null };
  if (existing) {
    await deps.db.update(linkLibrary).set(values).where(eq(linkLibrary.id, existing.id));
    return { link: presentLink(await rowById(deps, actor.orgId, existing.id), actor), existing: false };
  }
  const id = sortableId("lnk", now.getTime());
  await deps.db.insert(linkLibrary).values({ id, orgId: actor.orgId, ...values });
  return { link: presentLink(await rowById(deps, actor.orgId, id), actor), existing: false };
}

export async function updateLink(deps: Deps, actor: SuiteActor, id: string, patch: { title?: string; tags?: unknown; note?: string }) {
  assertWritable(actor);
  const r = await rowById(deps, actor.orgId, id);
  await deps.db.update(linkLibrary).set({
    title: patch.title !== undefined ? patch.title.trim().slice(0, 300) || r.site || r.url : r.title,
    tags: patch.tags !== undefined ? JSON.stringify(normalizeTags(patch.tags)) : r.tags,
    note: patch.note !== undefined ? patch.note.trim().slice(0, 2000) : r.note,
    updatedAt: deps.now(),
  }).where(eq(linkLibrary.id, r.id));
  return presentLink(await rowById(deps, actor.orgId, id), actor);
}

export async function removeLink(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const r = await rowById(deps, actor.orgId, id);
  if (r.createdBy !== actor.userId && !isAdmin(actor)) throw forbidden("Only the person who saved this link, an owner or an admin can remove it.");
  await deps.db.update(linkLibrary).set({ deletedAt: deps.now() }).where(eq(linkLibrary.id, r.id));
  return { ok: true };
}

/** The "Web clips" page at the top of the docs tree, made on first use. */
async function clipsPage(deps: Deps, actor: SuiteActor): Promise<string> {
  const found = await deps.db.select({ id: docs.id }).from(docs).where(and(eq(docs.orgId, actor.orgId), eq(docs.title, CLIPS_PAGE_TITLE), isNull(docs.parentId), isNull(docs.deletedAt))).limit(1).get();
  if (found) return found.id;
  const d = await createDoc(deps, actor, { title: CLIPS_PAGE_TITLE, text: "Pages saved from the web. Save more from Docs, Link library." });
  return d.id;
}

const dateLabel = (d: Date) => d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export interface ClipInput { url: string; parentId?: string | null; tags?: unknown; title?: string }

/** Saves a public page as a clean doc in a collection (a page of the docs tree) and keeps it in the link library. */
export async function clipPage(deps: Deps, actor: SuiteActor, input: ClipInput) {
  assertWritable(actor);
  const { url, key } = cleanUrl(input.url);
  let page;
  try { page = await fetchPublicPage(net(deps), url); } catch (e) { throw clipErr(e); }
  const x = extractReadable(page.body, page.url, page.contentType);
  if (x.words < 15) throw new HttpError(422, "no_text", "We could not find readable text on that page. Save it as a link instead.");
  let parentId = input.parentId ?? null;
  if (parentId) {
    const p = await deps.db.select({ id: docs.id }).from(docs).where(and(eq(docs.orgId, actor.orgId), eq(docs.id, parentId), isNull(docs.deletedAt))).get();
    if (!p) throw notFound("Page");
  } else parentId = await clipsPage(deps, actor);
  const now = deps.now();
  const source: DocNode = { type: "paragraph", content: [
    { type: "text", text: "Saved from ", marks: [{ type: "italic" }] },
    { type: "text", text: x.siteName || siteOf(page.url), marks: [{ type: "italic" }, { type: "link", attrs: { href: page.url } }] },
    { type: "text", text: ` on ${dateLabel(now)}${x.byline ? `. By ${x.byline}` : ""}.`, marks: [{ type: "italic" }] },
  ] };
  const title = (input.title?.trim() || x.title || siteOf(page.url)).slice(0, 300);
  const body: DocNode = { type: "doc", content: [source, ...(x.content.content ?? [])] };
  let json = JSON.stringify(body);
  while (json.length > 900_000 && (body.content?.length ?? 0) > 2) { body.content!.splice(Math.floor(body.content!.length * 0.8)); json = JSON.stringify(body); }
  const doc = await createDoc(deps, actor, { title, content: body, parentId });
  const tags = normalizeTags(input.tags);
  const existing = await deps.db.select().from(linkLibrary).where(and(eq(linkLibrary.orgId, actor.orgId), eq(linkLibrary.urlKey, key))).get();
  const values = { url, urlKey: key, title, description: x.description, site: (x.siteName || siteOf(page.url)).slice(0, 120), docId: doc.id, updatedAt: now, deletedAt: null };
  let id: string;
  if (existing) {
    id = existing.id;
    await deps.db.update(linkLibrary).set({ ...values, tags: JSON.stringify(normalizeTags([...(existing.deletedAt ? [] : tagsOf(existing.tags)), ...tags])) }).where(eq(linkLibrary.id, id));
  } else {
    id = sortableId("lnk", now.getTime());
    await deps.db.insert(linkLibrary).values({ id, orgId: actor.orgId, ...values, tags: JSON.stringify(tags), note: "", createdBy: actor.userId, createdAt: now });
  }
  return { doc: { id: doc.id, title: doc.title, parentId }, link: presentLink(await rowById(deps, actor.orgId, id), actor), words: x.words };
}
