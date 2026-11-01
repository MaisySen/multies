/**
 * R123: Sites. One site per workspace, pages built from typed blocks with a draft, a scheduled snapshot and the live
 * snapshot, versions, moderated comments (spam shield on the public side) and page view counts with no personal data.
 * Owners, admins and the site's editors build, publish and moderate; members see published pages and the drafts an editor
 * shared with them; nothing is read across workspaces (every query carries the workspace id).
 */
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { runBatch } from "../db";
import { forms, members, organizations, schedulingPages, siteComments, sitePageStats, sitePageVersions, sitePages, sites, users } from "../db/schema";
import { hmacSha256Hex, newId } from "../lib/crypto";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { IsolateCache } from "../lib/isolate-cache";
import { getBrand } from "../routes/branding";
import {
  BlockError, MAX_COMMENT, MAX_DESCRIPTION, MAX_PAGES, MAX_TITLE, MAX_VERSIONS, cleanBlocks, newBlock, pageSlugProblem, safeImageUrl, siteSlugProblem, slugify, statusOf,
  type Block, type CommentInfo, type CommentStatus, type PageDetail, type PageStatus, type PageSummary, type SiteInfo, type StatsOut, type VersionInfo,
} from "@/shared/sites";

type SiteRow = typeof sites.$inferSelect;
type PageRow = typeof sitePages.$inferSelect;
export interface Snapshot { title: string; blocks: Block[]; seoTitle: string; description: string; image: string }

const nowMs = (deps: Deps) => deps.now().getTime();
const appBase = (deps: Deps) => deps.config.appUrl.replace(/\/+$/, "");
export const siteUrl = (deps: Deps, slug: string) => `${appBase(deps)}/site/${slug}`;
export const pageUrl = (deps: Deps, site: { slug: string; homePageId: string | null }, p: { id: string; slug: string }) =>
  site.homePageId === p.id ? siteUrl(deps, site.slug) : `${siteUrl(deps, site.slug)}/${p.slug}`;
const parse = <T,>(s: string | null | undefined, fallback: T): T => { if (!s) return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } };
const isAdmin = (a: AuthContext) => a.role === "owner" || a.role === "admin";

/** vv8k is always out; SITES_EXCLUDE adds more (ids, slugs or names). */
export function isSitesExcluded(org: { id: string; slug?: string | null; name?: string | null }, extra = ""): boolean {
  const hay = [org.id, org.slug ?? "", org.name ?? ""].map((s) => s.toLowerCase());
  const words = ["vv8k", ...extra.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];
  return words.some((x) => hay.some((h) => h === x || h.includes(x)));
}
async function guard(deps: Deps, a: AuthContext) {
  const o = await deps.db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.id, a.orgId)).get();
  if (!o || isSitesExcluded(o, deps.config.sitesExclude ?? "")) throw forbidden("Sites are not available in this workspace.");
  return o;
}

export function canEditSite(a: AuthContext, site: Pick<SiteRow, "editors"> | null): boolean {
  if (isAdmin(a)) return true;
  return !!site && parse<string[]>(site.editors, []).includes(a.userId);
}
function needEdit(a: AuthContext, site: SiteRow) {
  if (!canEditSite(a, site)) throw forbidden("Only admins and site editors can change the site.");
}
const siteOf = (deps: Deps, orgId: string) => deps.db.select().from(sites).where(eq(sites.orgId, orgId)).get();
async function needSite(deps: Deps, a: AuthContext): Promise<SiteRow> {
  await guard(deps, a);
  const s = await siteOf(deps, a.orgId);
  if (!s) throw notFound("Site");
  return s;
}
async function pageOf(deps: Deps, a: AuthContext, id: string): Promise<PageRow> {
  const p = await deps.db.select().from(sitePages).where(and(eq(sitePages.id, id), eq(sitePages.orgId, a.orgId))).get();
  if (!p) throw notFound("Page");
  return p;
}

function siteInfo(deps: Deps, a: AuthContext, s: SiteRow): SiteInfo {
  return { id: s.id, slug: s.slug, name: s.name, description: s.description, commentsOn: s.commentsOn, editors: parse<string[]>(s.editors, []), homePageId: s.homePageId, url: siteUrl(deps, s.slug), canEdit: canEditSite(a, s) };
}

/** Promotes a scheduled snapshot whose time has come (on read, so no timer is needed). Returns the fresh row. */
async function promoteDue(deps: Deps, p: PageRow): Promise<PageRow> {
  const now = nowMs(deps);
  if (!p.next || p.publishAt === null || p.publishAt > now) return p;
  const r = await deps.db.update(sitePages).set({ live: p.next, next: null, status: "published", publishedAt: p.publishAt, publishAt: null })
    .where(and(eq(sitePages.id, p.id), eq(sitePages.publishAt, p.publishAt))).returning({ id: sitePages.id });
  if (r.length) await deps.db.insert(sitePageVersions).values({ id: newId("spv"), orgId: p.orgId, pageId: p.id, kind: "published", snapshot: p.next, createdBy: p.updatedBy, createdAt: p.publishAt });
  return { ...p, live: p.next, next: null, status: "published", publishedAt: p.publishAt, publishAt: null };
}

function summary(deps: Deps, s: SiteRow, p: PageRow, waiting = 0): PageSummary {
  const status = statusOf({ status: p.status as PageStatus, publishAt: p.publishAt }, nowMs(deps));
  const live = status === "published" || !!p.live;
  return {
    id: p.id, slug: p.slug, title: p.title, status: p.live ? "published" : status, publishAt: p.next ? p.publishAt : null, publishedAt: p.publishedAt,
    hasUnpublished: p.hasUnpublished, views: p.views, membersCanView: p.membersCanView, isHome: s.homePageId === p.id, updatedAt: p.updatedAt,
    url: live ? pageUrl(deps, s, p) : null, waitingComments: waiting,
  };
}

// ------------------------------------------------------------------------------------------------ site

export async function getSite(deps: Deps, a: AuthContext) {
  const o = await guard(deps, a);
  const s = await siteOf(deps, a.orgId);
  return { site: s ? siteInfo(deps, a, s) : null, canStart: isAdmin(a), suggestedSlug: slugify(o.slug || o.name || "site", "site").slice(0, 40).padEnd(3, "0"), orgName: o.name ?? "" };
}

/** For the menu: does this workspace have a site, and could this person start one. One keyed read. */
export async function sitesInUse(deps: Deps, a: AuthContext) {
  const s = await deps.db.select({ id: sites.id, editors: sites.editors }).from(sites).where(eq(sites.orgId, a.orgId)).get();
  return { inUse: !!s, canStart: !s && isAdmin(a), canEdit: !!s && canEditSite(a, s) };
}

export async function startSite(deps: Deps, a: AuthContext, input: { name: string; slug: string }) {
  await guard(deps, a);
  if (!isAdmin(a)) throw forbidden("Only admins can start the site.");
  if (await siteOf(deps, a.orgId)) throw conflict("This workspace already has a site.");
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw badRequest("Give the site a name.");
  const slug = String(input.slug ?? "").trim().toLowerCase();
  const bad = siteSlugProblem(slug);
  if (bad) throw badRequest(bad);
  const now = nowMs(deps);
  const id = newId("site");
  const pageId = newId("spg");
  const blocks: Block[] = [{ ...newBlock("hero", "b1"), title: name } as Block, newBlock("text", "b2")];
  try {
    await deps.db.insert(sites).values({ id, orgId: a.orgId, slug, name, description: "", commentsOn: true, editors: "[]", homePageId: pageId, createdAt: now, updatedAt: now });
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? ""))) throw conflict("That site address is taken. Pick another.");
    throw e;
  }
  await deps.db.insert(sitePages).values({ id: pageId, orgId: a.orgId, siteId: id, slug: "home", title: "Home", draftBlocks: JSON.stringify(blocks), updatedBy: a.userId, createdAt: now, updatedAt: now });
  return getSite(deps, a);
}

export async function updateSite(deps: Deps, a: AuthContext, patch: { name?: string; slug?: string; description?: string; commentsOn?: boolean; editors?: string[]; homePageId?: string }) {
  const s = await needSite(deps, a);
  needEdit(a, s);
  const set: Partial<SiteRow> = { updatedAt: nowMs(deps) };
  if (patch.name !== undefined) { const n = patch.name.trim().slice(0, 80); if (!n) throw badRequest("Give the site a name."); set.name = n; }
  if (patch.description !== undefined) set.description = patch.description.trim().slice(0, MAX_DESCRIPTION);
  if (patch.commentsOn !== undefined) set.commentsOn = !!patch.commentsOn;
  if (patch.slug !== undefined && patch.slug !== s.slug) {
    if (!isAdmin(a)) throw forbidden("Only admins can change the site address.");
    const bad = siteSlugProblem(patch.slug);
    if (bad) throw badRequest(bad);
    set.slug = patch.slug;
  }
  if (patch.editors !== undefined) {
    if (!isAdmin(a)) throw forbidden("Only admins can choose site editors.");
    const ids = [...new Set(patch.editors.map(String))].slice(0, 50);
    const ok = ids.length ? await deps.db.select({ id: members.userId }).from(members).where(and(eq(members.organizationId, a.orgId), inArray(members.userId, ids))).all() : [];
    set.editors = JSON.stringify(ok.map((r) => r.id));
  }
  if (patch.homePageId !== undefined) { await pageOf(deps, a, patch.homePageId); set.homePageId = patch.homePageId; }
  try {
    await deps.db.update(sites).set(set).where(eq(sites.id, s.id));
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? ""))) throw conflict("That site address is taken. Pick another.");
    throw e;
  }
  forgetSite(s.slug);
  if (set.slug) forgetSite(set.slug);
  return getSite(deps, a);
}

/** Forms and booking pages this workspace can place on a page, and the people who can be editors. */
export async function linkables(deps: Deps, a: AuthContext) {
  await needSite(deps, a);
  const [f, b, m] = await Promise.all([
    deps.db.select({ slug: forms.slug, title: forms.name, enabled: forms.enabled }).from(forms).where(eq(forms.orgId, a.orgId)).orderBy(asc(forms.name)).limit(200).all(),
    deps.db.select({ slug: schedulingPages.slug, title: schedulingPages.title, enabled: schedulingPages.enabled }).from(schedulingPages).where(eq(schedulingPages.orgId, a.orgId)).limit(200).all(),
    deps.db.select({ id: users.id, name: users.name, email: users.email, role: members.role }).from(members).innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.organizationId, a.orgId), eq(members.kind, "human"))).limit(500).all(),
  ]);
  return { forms: f.filter((x) => x.enabled), booking: b.filter((x) => x.enabled), people: m.map((x) => ({ id: x.id, name: x.name || x.email, role: x.role })) };
}

// ------------------------------------------------------------------------------------------------ pages

export async function listPages(deps: Deps, a: AuthContext): Promise<{ pages: PageSummary[] }> {
  const s = await needSite(deps, a);
  const rows = await deps.db.select().from(sitePages).where(eq(sitePages.orgId, a.orgId)).orderBy(asc(sitePages.position), asc(sitePages.createdAt)).limit(MAX_PAGES).all();
  const fresh = await Promise.all(rows.map((p) => promoteDue(deps, p)));
  const edit = canEditSite(a, s);
  const visible = edit ? fresh : fresh.filter((p) => p.live || p.membersCanView);
  const waiting = edit && visible.length
    ? await deps.db.select({ id: siteComments.pageId, n: sql<number>`count(*)` }).from(siteComments).where(and(eq(siteComments.orgId, a.orgId), eq(siteComments.status, "pending"))).groupBy(siteComments.pageId).all()
    : [];
  const by = new Map(waiting.map((w) => [w.id, Number(w.n)]));
  return { pages: visible.map((p) => summary(deps, s, p, by.get(p.id) ?? 0)) };
}

function detail(deps: Deps, s: SiteRow, p: PageRow, a: AuthContext): PageDetail {
  const editor = canEditSite(a, s);
  // Members who were not given the draft see the live snapshot (read only), never the draft.
  const snap: Snapshot = editor || p.membersCanView
    ? { title: p.title, blocks: parse<Block[]>(p.draftBlocks, []), seoTitle: p.seoTitle, description: p.description, image: p.image }
    : parse<Snapshot>(p.live, { title: p.title, blocks: [], seoTitle: "", description: "", image: "" });
  return { ...summary(deps, s, p), title: snap.title, blocks: snap.blocks, seoTitle: snap.seoTitle, description: snap.description, image: snap.image, commentsOn: p.commentsOn };
}

export async function getPage(deps: Deps, a: AuthContext, id: string) {
  const s = await needSite(deps, a);
  const p = await promoteDue(deps, await pageOf(deps, a, id));
  if (!canEditSite(a, s) && !p.membersCanView && !p.live) throw forbidden("This page is a draft. Ask a site editor to share it with members.");
  const brand = await getBrand(deps.db, a.orgId);
  return { page: detail(deps, s, p, a), site: siteInfo(deps, a, s), look: { brandColor: brand.primary ?? brand.accent ?? null } };
}

export async function createPage(deps: Deps, a: AuthContext, input: { title: string; slug?: string }) {
  const s = await needSite(deps, a);
  needEdit(a, s);
  const title = String(input.title ?? "").trim().slice(0, MAX_TITLE);
  if (!title) throw badRequest("Give the page a title.");
  const n = (await deps.db.select({ n: sql<number>`count(*)` }).from(sitePages).where(eq(sitePages.orgId, a.orgId)).get())?.n ?? 0;
  if (n >= MAX_PAGES) throw badRequest(`A site can hold up to ${MAX_PAGES} pages.`);
  const slug = (input.slug ? String(input.slug).trim().toLowerCase() : slugify(title)).slice(0, 60);
  const bad = pageSlugProblem(slug);
  if (bad) throw badRequest(bad);
  const now = nowMs(deps);
  const id = newId("spg");
  try {
    await deps.db.insert(sitePages).values({ id, orgId: a.orgId, siteId: s.id, slug, title, draftBlocks: JSON.stringify([newBlock("heading", "b1"), newBlock("text", "b2")]), position: Number(n), updatedBy: a.userId, createdAt: now, updatedAt: now });
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? ""))) throw conflict("Another page already uses that address.");
    throw e;
  }
  return getPage(deps, a, id);
}

export interface PageSave { title?: string; slug?: string; blocks?: unknown; seoTitle?: string; description?: string; image?: string; membersCanView?: boolean; commentsOn?: boolean }

export async function savePage(deps: Deps, a: AuthContext, id: string, input: PageSave) {
  const s = await needSite(deps, a);
  needEdit(a, s);
  const p = await pageOf(deps, a, id);
  const set: Partial<PageRow> = { updatedAt: nowMs(deps), updatedBy: a.userId };
  let content = false;
  if (input.title !== undefined) { const t = input.title.trim().slice(0, MAX_TITLE); if (!t) throw badRequest("Give the page a title."); set.title = t; content = true; }
  if (input.slug !== undefined && input.slug !== p.slug) {
    const bad = pageSlugProblem(input.slug);
    if (bad) throw badRequest(bad);
    set.slug = input.slug;
  }
  if (input.blocks !== undefined) {
    try { set.draftBlocks = JSON.stringify(cleanBlocks(input.blocks)); } catch (e) { if (e instanceof BlockError) throw badRequest(e.message); throw e; }
    content = true;
  }
  if (input.seoTitle !== undefined) { set.seoTitle = input.seoTitle.trim().slice(0, 70); content = true; }
  if (input.description !== undefined) { set.description = input.description.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION); content = true; }
  if (input.image !== undefined) {
    const v = input.image.trim();
    if (v && !safeImageUrl(v)) throw badRequest("The share image needs an https:// address.");
    set.image = v ? safeImageUrl(v)! : ""; content = true;
  }
  if (input.membersCanView !== undefined) set.membersCanView = !!input.membersCanView;
  if (input.commentsOn !== undefined) set.commentsOn = !!input.commentsOn;
  if (content) set.hasUnpublished = true;
  try {
    await deps.db.update(sitePages).set(set).where(and(eq(sitePages.id, id), eq(sitePages.orgId, a.orgId)));
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? ""))) throw conflict("Another page already uses that address.");
    throw e;
  }
  if (content) await addVersion(deps, a, { ...p, ...set } as PageRow, "saved");
  forgetSite(s.slug);
  return getPage(deps, a, id);
}

const snapshotOf = (p: PageRow): Snapshot => ({ title: p.title, blocks: parse<Block[]>(p.draftBlocks, []), seoTitle: p.seoTitle, description: p.description, image: p.image });

async function addVersion(deps: Deps, a: AuthContext, p: PageRow, kind: "saved" | "published", at = nowMs(deps)) {
  await deps.db.insert(sitePageVersions).values({ id: newId("spv"), orgId: a.orgId, pageId: p.id, kind, snapshot: JSON.stringify(snapshotOf(p)), createdBy: a.userId, createdAt: at });
  const old = await deps.db.select({ id: sitePageVersions.id }).from(sitePageVersions).where(eq(sitePageVersions.pageId, p.id)).orderBy(desc(sitePageVersions.createdAt)).limit(50).offset(MAX_VERSIONS).all();
  if (old.length) await deps.db.delete(sitePageVersions).where(inArray(sitePageVersions.id, old.map((o) => o.id)));
}

/** Publishes the draft now, or schedules it (at, in ms, in the future). The page stays as it is for visitors until then. */
export async function publishPage(deps: Deps, a: AuthContext, id: string, input: { at?: number | null }) {
  const s = await needSite(deps, a);
  needEdit(a, s);
  const p = await pageOf(deps, a, id);
  const snap = JSON.stringify(snapshotOf(p));
  const now = nowMs(deps);
  if (input.at !== undefined && input.at !== null) {
    const at = Number(input.at);
    if (!Number.isFinite(at) || at <= now + 30_000) throw badRequest("Pick a time in the future to schedule this page.");
    if (at > now + 366 * 86_400_000) throw badRequest("Pick a time within the next year.");
    await deps.db.update(sitePages).set({ next: snap, publishAt: at, status: p.live ? "published" : "scheduled", hasUnpublished: false, updatedAt: now, updatedBy: a.userId }).where(eq(sitePages.id, id));
  } else {
    await deps.db.update(sitePages).set({ live: snap, next: null, publishAt: null, status: "published", publishedAt: now, hasUnpublished: false, updatedAt: now, updatedBy: a.userId }).where(eq(sitePages.id, id));
    await addVersion(deps, a, p, "published", now);
  }
  forgetSite(s.slug);
  return getPage(deps, a, id);
}

export async function unpublishPage(deps: Deps, a: AuthContext, id: string) {
  const s = await needSite(deps, a);
  needEdit(a, s);
  await pageOf(deps, a, id);
  await deps.db.update(sitePages).set({ live: null, next: null, publishAt: null, status: "draft", hasUnpublished: true, updatedAt: nowMs(deps), updatedBy: a.userId }).where(and(eq(sitePages.id, id), eq(sitePages.orgId, a.orgId)));
  forgetSite(s.slug);
  return getPage(deps, a, id);
}

export async function deletePage(deps: Deps, a: AuthContext, id: string) {
  const s = await needSite(deps, a);
  needEdit(a, s);
  await pageOf(deps, a, id);
  if (s.homePageId === id) throw badRequest("Make another page the home page before deleting this one.");
  await deps.db.delete(sitePages).where(and(eq(sitePages.id, id), eq(sitePages.orgId, a.orgId)));
  forgetSite(s.slug);
  return { ok: true };
}

export async function listVersions(deps: Deps, a: AuthContext, id: string): Promise<{ versions: VersionInfo[] }> {
  const s = await needSite(deps, a);
  needEdit(a, s);
  await pageOf(deps, a, id);
  const rows = await deps.db.select({ id: sitePageVersions.id, kind: sitePageVersions.kind, snapshot: sitePageVersions.snapshot, at: sitePageVersions.createdAt, name: users.name, email: users.email })
    .from(sitePageVersions).leftJoin(users, eq(users.id, sitePageVersions.createdBy)).where(and(eq(sitePageVersions.pageId, id), eq(sitePageVersions.orgId, a.orgId)))
    .orderBy(desc(sitePageVersions.createdAt)).limit(MAX_VERSIONS).all();
  return { versions: rows.map((r) => { const snap = parse<Snapshot>(r.snapshot, { title: "", blocks: [], seoTitle: "", description: "", image: "" }); return { id: r.id, kind: r.kind, title: snap.title, byName: r.name || r.email || "Someone", createdAt: r.at, blocks: snap.blocks.length }; }) };
}

/** Copies a version into the draft (the live page is unchanged until someone publishes). */
export async function restoreVersion(deps: Deps, a: AuthContext, id: string, versionId: string) {
  const s = await needSite(deps, a);
  needEdit(a, s);
  const p = await pageOf(deps, a, id);
  const v = await deps.db.select().from(sitePageVersions).where(and(eq(sitePageVersions.id, versionId), eq(sitePageVersions.pageId, id), eq(sitePageVersions.orgId, a.orgId))).get();
  if (!v) throw notFound("Version");
  const snap = parse<Snapshot>(v.snapshot, { title: p.title, blocks: [], seoTitle: "", description: "", image: "" });
  return savePage(deps, a, id, { title: snap.title || p.title, blocks: snap.blocks, seoTitle: snap.seoTitle, description: snap.description, image: snap.image });
}

// ------------------------------------------------------------------------------------------------ comments (team side)

export async function listComments(deps: Deps, a: AuthContext, status: CommentStatus): Promise<{ comments: CommentInfo[]; waiting: number }> {
  const s = await needSite(deps, a);
  needEdit(a, s);
  const rows = await deps.db.select({ c: siteComments, title: sitePages.title }).from(siteComments).innerJoin(sitePages, eq(sitePages.id, siteComments.pageId))
    .where(and(eq(siteComments.orgId, a.orgId), eq(siteComments.status, status))).orderBy(desc(siteComments.createdAt)).limit(200).all();
  const waiting = (await deps.db.select({ n: sql<number>`count(*)` }).from(siteComments).where(and(eq(siteComments.orgId, a.orgId), eq(siteComments.status, "pending"))).get())?.n ?? 0;
  return { comments: rows.map((r) => ({ id: r.c.id, pageId: r.c.pageId, pageTitle: r.title, name: r.c.name, body: r.c.body, status: r.c.status, createdAt: r.c.createdAt })), waiting: Number(waiting) };
}

export async function moderateComment(deps: Deps, a: AuthContext, id: string, status: CommentStatus | "delete") {
  const s = await needSite(deps, a);
  needEdit(a, s);
  const c = await deps.db.select({ id: siteComments.id }).from(siteComments).where(and(eq(siteComments.id, id), eq(siteComments.orgId, a.orgId))).get();
  if (!c) throw notFound("Comment");
  if (status === "delete") await deps.db.delete(siteComments).where(eq(siteComments.id, id));
  else await deps.db.update(siteComments).set({ status, moderatedBy: a.userId }).where(eq(siteComments.id, id));
  forgetSite(s.slug);
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ stats (team side)

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function siteStats(deps: Deps, a: AuthContext, days = 30): Promise<StatsOut> {
  await needSite(deps, a);
  const d = Math.min(Math.max(Math.floor(days) || 30, 1), 90);
  const since = dayOf(nowMs(deps) - (d - 1) * 86_400_000);
  const rows = await deps.db.select({ pageId: sitePageStats.pageId, day: sitePageStats.day, source: sitePageStats.source, device: sitePageStats.device, views: sitePageStats.views, title: sitePages.title })
    .from(sitePageStats).innerJoin(sitePages, eq(sitePages.id, sitePageStats.pageId)).where(and(eq(sitePageStats.orgId, a.orgId), gte(sitePageStats.day, since))).limit(20_000).all();
  return statsFrom(rows, since, d);
}

export function statsFrom(rows: { pageId: string; day: string; source: string; device: string; views: number; title: string }[], since: string, d: number): StatsOut {
  const byDay = new Map<string, number>(); const byPage = new Map<string, { title: string; views: number }>(); const bySrc = new Map<string, number>(); const byDev = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    total += r.views;
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.views);
    const p = byPage.get(r.pageId) ?? { title: r.title, views: 0 }; p.views += r.views; byPage.set(r.pageId, p);
    bySrc.set(r.source, (bySrc.get(r.source) ?? 0) + r.views);
    byDev.set(r.device, (byDev.get(r.device) ?? 0) + r.views);
  }
  const start = Date.parse(`${since}T00:00:00Z`);
  const dayList = Array.from({ length: d }, (_, i) => { const day = dayOf(start + i * 86_400_000); return { day, views: byDay.get(day) ?? 0 }; });
  const top = <K extends string>(m: Map<string, number>, key: K) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, v]) => ({ [key]: k, views: v }) as { [P in K]: string } & { views: number });
  return {
    days: dayList, total,
    pages: [...byPage.entries()].sort((x, y) => y[1].views - x[1].views).slice(0, 10).map(([id, p]) => ({ id, title: p.title, views: p.views })),
    sources: top(bySrc, "source"), devices: top(byDev, "device"),
  };
}

// ------------------------------------------------------------------------------------------------ public side

export interface PublicSite { id: string; orgId: string; slug: string; name: string; description: string; commentsOn: boolean; homePageId: string | null; brandColor: string | null; logoUrl: string | null; nav: { id: string; slug: string; title: string }[] }
export interface PublicPage { id: string; slug: string; live: Snapshot | null; next: Snapshot | null; publishAt: number | null; publishedAt: number | null; commentsOn: boolean }

const localSites = new IsolateCache<PublicSite | null>(30_000, 1_000);
const localPages = new IsolateCache<PublicPage | null>(30_000, 5_000);
export function forgetSite(slug: string) { localSites.forgetPrefix(`${slug}`); localPages.forgetPrefix(`${slug}/`); }

export async function resolveSite(deps: Deps, slug: string): Promise<PublicSite | null> {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;
  const hit = localSites.get(slug);
  if (hit !== undefined) return hit;
  const s = await deps.db.select().from(sites).where(eq(sites.slug, slug)).get();
  let v: PublicSite | null = null;
  if (s) {
    const o = await deps.db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.id, s.orgId)).get();
    if (o && !isSitesExcluded(o, deps.config.sitesExclude ?? "")) {
      const [brand, pages] = await Promise.all([
        getBrand(deps.db, s.orgId),
        deps.db.select({ id: sitePages.id, slug: sitePages.slug, title: sitePages.title, live: sitePages.live, publishAt: sitePages.publishAt, next: sitePages.next }).from(sitePages)
          .where(eq(sitePages.siteId, s.id)).orderBy(asc(sitePages.position), asc(sitePages.createdAt)).limit(MAX_PAGES).all(),
      ]);
      const kind = brand.logos.mark_light ? "mark_light" : brand.logos.mark_dark ? "mark_dark" : null;
      const ver = kind ? brand.logos[kind] : null;
      const now = nowMs(deps);
      v = {
        id: s.id, orgId: s.orgId, slug: s.slug, name: s.name, description: s.description, commentsOn: s.commentsOn, homePageId: s.homePageId,
        brandColor: brand.primary ?? brand.accent ?? null, logoUrl: kind && ver ? `${appBase(deps)}/api/branding/logo/${s.orgId}/${kind}/${ver}` : null,
        nav: pages.filter((p) => p.live || (p.next && p.publishAt !== null && p.publishAt <= now)).slice(0, 8).map((p) => ({ id: p.id, slug: p.slug, title: parse<Snapshot | null>(p.live ?? p.next, null)?.title || p.title })),
      };
    }
  }
  localSites.set(slug, v);
  return v;
}

/** The page visitors may see now (null when it is a draft or scheduled for later). One keyed read, cached 30 s. */
export async function resolvePage(deps: Deps, site: PublicSite, pageSlug: string | null): Promise<{ id: string; slug: string; snap: Snapshot; commentsOn: boolean } | null> {
  const key = `${site.slug}/${pageSlug ?? ""}`;
  let v = localPages.get(key);
  if (v === undefined) {
    const where = pageSlug === null
      ? (site.homePageId ? and(eq(sitePages.siteId, site.id), eq(sitePages.id, site.homePageId)) : null)
      : (/^[a-z0-9-]{1,60}$/.test(pageSlug) ? and(eq(sitePages.siteId, site.id), eq(sitePages.slug, pageSlug)) : null);
    const p = where ? await deps.db.select().from(sitePages).where(where).get() : undefined;
    v = p ? { id: p.id, slug: p.slug, live: parse<Snapshot | null>(p.live, null), next: parse<Snapshot | null>(p.next, null), publishAt: p.publishAt, publishedAt: p.publishedAt, commentsOn: p.commentsOn } : null;
    localPages.set(key, v);
    if (p && p.next && p.publishAt !== null && p.publishAt <= nowMs(deps)) { await promoteDue(deps, p); forgetSite(site.slug); }
  }
  if (!v) return null;
  const now = nowMs(deps);
  const snap = v.next && v.publishAt !== null && v.publishAt <= now ? v.next : v.live;
  return snap ? { id: v.id, slug: v.slug, snap, commentsOn: v.commentsOn } : null;
}

export async function publicComments(deps: Deps, site: PublicSite, pageId: string) {
  return deps.db.select({ id: siteComments.id, name: siteComments.name, body: siteComments.body, at: siteComments.createdAt }).from(siteComments)
    .where(and(eq(siteComments.orgId, site.orgId), eq(siteComments.pageId, pageId), eq(siteComments.status, "approved"))).orderBy(asc(siteComments.createdAt)).limit(100).all();
}

export const COMMENTS_PER_DAY = 5;
export const MAX_WAITING = 500;

/** A visitor's comment: always waits for moderation. The shield check is done by the route before this. */
export async function postComment(deps: Deps, site: PublicSite, pageId: string, input: { name: string; body: string; ip: string; ua?: string }) {
  if (!site.commentsOn) throw new HttpError(403, "forbidden", "Comments are off on this site.");
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const body = String(input.body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!name) throw badRequest("Add your name.");
  if (!body) throw badRequest("Write a comment first.");
  if (body.length > MAX_COMMENT) throw badRequest(`Keep comments under ${MAX_COMMENT.toLocaleString("en")} characters.`);
  const now = nowMs(deps);
  const senderKey = (await hmacSha256Hex(deps.config.appSecret || "dev-secret", `r123c:${site.orgId}:${dayOf(now)}:${input.ip}:${(input.ua ?? "").slice(0, 200)}`)).slice(0, 24);
  const [mine, waiting] = await Promise.all([
    deps.db.select({ n: sql<number>`count(*)` }).from(siteComments).where(and(eq(siteComments.senderKey, senderKey), gte(siteComments.createdAt, now - 86_400_000))).get(),
    deps.db.select({ n: sql<number>`count(*)` }).from(siteComments).where(and(eq(siteComments.orgId, site.orgId), eq(siteComments.status, "pending"))).get(),
  ]);
  if (Number(mine?.n ?? 0) >= COMMENTS_PER_DAY) throw new HttpError(429, "rate_limited", "You have posted the most comments allowed today. Try again tomorrow.");
  if (Number(waiting?.n ?? 0) >= MAX_WAITING) throw new HttpError(429, "rate_limited", "Comments are paused while the team catches up. Try again later.");
  await deps.db.insert(siteComments).values({ id: newId("scm"), orgId: site.orgId, pageId, name, body, status: "pending", senderKey, createdAt: now });
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ view counts

const pendingViews = new Map<string, { orgId: string; pageId: string; day: string; source: string; device: string; n: number }>();
const pageBumps = new Map<string, number>();
let flushTimer: Promise<void> | null = null;

/** Counts one view (no address, no visitor id, no cookie): page, day, source site and device type only. */
export function queueView(deps: Deps, v: { orgId: string; pageId: string; source: string; device: string }): Promise<void> {
  const day = dayOf(nowMs(deps));
  const source = (v.source || "Direct").slice(0, 80);
  const id = `${v.pageId}:${day}:${source}:${v.device}`;
  const cur = pendingViews.get(id);
  if (cur) cur.n++; else if (pendingViews.size < 2_000) pendingViews.set(id, { orgId: v.orgId, pageId: v.pageId, day, source, device: v.device, n: 1 });
  pageBumps.set(v.pageId, (pageBumps.get(v.pageId) ?? 0) + 1);
  if (!flushTimer) {
    const wait = deps.config.links?.flushMs ?? 4_000;
    flushTimer = (wait > 0 ? new Promise<void>((r) => setTimeout(r, wait)) : Promise.resolve()).then(() => flushViews(deps)).finally(() => { flushTimer = null; });
  }
  return flushTimer;
}

export async function flushViews(deps: Deps): Promise<void> {
  if (!pendingViews.size && !pageBumps.size) return;
  const rows = [...pendingViews.entries()]; pendingViews.clear();
  const bumps = [...pageBumps.entries()]; pageBumps.clear();
  const stmts: PromiseLike<unknown>[] = rows.map(([id, r]) => deps.db.run(sql`insert into site_page_stats (id, org_id, page_id, day, source, device, views) values (${id}, ${r.orgId}, ${r.pageId}, ${r.day}, ${r.source}, ${r.device}, ${r.n}) on conflict(id) do update set views = views + ${r.n}`));
  for (const [id, n] of bumps) stmts.push(deps.db.run(sql`update site_pages set views = views + ${n} where id = ${id}`));
  try { await runBatch(deps.db, stmts); } catch (e) { (deps.log ?? console).error?.("[sites] view flush failed", { error: String((e as Error)?.message ?? e), rows: rows.length }); }
}
export const pendingViewCount = () => pendingViews.size;
// keep imports used by type only checks quiet
void lt;
