/**
 * R124: Blog with newsletter, inside Sites (BLOG_R124). A site's blog keeps each post's body in a doc (written in the
 * Docs editor) and publishes an escaped HTML snapshot of it, with tags, authors (public profiles), drafts, schedules and
 * unpublish. Subscribers live in one R109 audience list per blog (double opt in by a one time link), and "Email this post
 * to subscribers" makes an R109 newsletter on that list, so every Spam Act rule of R109 applies. Subscriber addresses are
 * never written to logs. Every query carries the workspace id; vv8k is out through the Sites guard.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { blogAuthors, blogImages, blogPosts, docs, members, organizations, siteBlogs, sitePages, sites, users } from "../db/schema";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { IsolateCache } from "../lib/isolate-cache";
import { createDoc } from "./suite/docs";
import { renderDocHtml } from "./suite/share-links";
import { canEditSite, forgetSite, isSitesExcluded, siteUrl, type PublicSite } from "./sites";
import { activeToolFeatures } from "./tools/features";
import { toolStateOrOff } from "./tools/automation";
import type { Block as MailBlock } from "@/shared/campaigns-r109";
import * as C from "./campaigns/r109";
import { slugify } from "@/shared/sites";
import {
  MAX_BIO, MAX_EXCERPT, MAX_POSTS, MAX_POST_TITLE, autoExcerpt, cleanTags, csvCell, docImageId, freePostSlug, isLive, postSlugProblem, postStatusOf,
  publicImage, readingMinutes, scheduleProblem, tagSlug,
  type AuthorInfo, type BlogInfo, type LiveMeta, type PostDetail, type PostSummary,
} from "@/shared/blog-r124";

type BlogRow = typeof siteBlogs.$inferSelect;
type PostRow = typeof blogPosts.$inferSelect;
type SiteRow = typeof sites.$inferSelect;

const nowMs = (deps: Deps) => deps.now().getTime();
const isAdmin = (a: Pick<AuthContext, "role">) => a.role === "owner" || a.role === "admin";
const parse = <T,>(s: string | null | undefined, fallback: T): T => { if (!s) return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } };
export const blogBase = (deps: Deps, siteSlug: string) => `${siteUrl(deps, siteSlug)}/blog`;

/** Whether R109 newsletters can run in this deployment for this workspace. */
async function newsletterOn(deps: Deps, orgId: string): Promise<boolean> {
  if (!deps.config.tools?.enabled || !activeToolFeatures(deps).includes("merge_plus_r109")) return false;
  try { await toolStateOrOff(deps, orgId); return true; } catch { return false; }
}

async function siteFor(deps: Deps, a: AuthContext): Promise<SiteRow> {
  const o = await deps.db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.id, a.orgId)).get();
  if (!o || isSitesExcluded(o, deps.config.sitesExclude ?? "")) throw forbidden("Sites are not available in this workspace.");
  const s = await deps.db.select().from(sites).where(eq(sites.orgId, a.orgId)).get();
  if (!s) throw notFound("Site");
  return s;
}
async function blogOf(deps: Deps, s: SiteRow): Promise<BlogRow | undefined> {
  return deps.db.select().from(siteBlogs).where(and(eq(siteBlogs.siteId, s.id), eq(siteBlogs.orgId, s.orgId))).get();
}
async function needBlog(deps: Deps, a: AuthContext) {
  const s = await siteFor(deps, a);
  const b = await blogOf(deps, s);
  if (!b) throw notFound("Blog");
  return { s, b };
}
function needEdit(a: AuthContext, s: SiteRow) { if (!canEditSite(a, s)) throw forbidden("Only admins and site editors can change the blog."); }
function needAdmin(a: AuthContext) { if (!isAdmin(a)) throw forbidden("Only admins can do this."); }
async function postOf(deps: Deps, a: AuthContext, s: SiteRow, id: string): Promise<PostRow> {
  const p = await deps.db.select().from(blogPosts).where(and(eq(blogPosts.id, id), eq(blogPosts.orgId, a.orgId), eq(blogPosts.siteId, s.id))).get();
  if (!p) throw notFound("Post");
  return p;
}

// ---------------------------------------------------------------- blog

async function listRow(deps: Deps, b: BlogRow): Promise<C.ListRow | null> {
  if (!b.listId) return null;
  return (await deps.db.get<C.ListRow>(sql`select * from audience_lists where org_id = ${b.orgId} and id = ${b.listId} and archived_at is null`)) ?? null;
}
async function listCounts(deps: Deps, l: C.ListRow) {
  const rows = await deps.db.all<{ status: string; n: number }>(sql`select status, count(*) as n from audience_members where list_id = ${l.id} group by status`);
  const m = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  return { subscribed: m.subscribed ?? 0, pending: m.pending ?? 0, unsubscribed: m.unsubscribed ?? 0 };
}
export function newsletterProblems(l: Pick<C.ListRow, "mailbox_id" | "sender_name" | "sender_address">): string[] {
  const out: string[] = [];
  if (!l.mailbox_id) out.push("Pick the mailbox that sends confirmations and posts.");
  if (!l.sender_name.trim()) out.push("Add the sender name.");
  if (l.sender_address.trim().length < 6) out.push("Add a contact address. The law asks for it in every email.");
  return out;
}

async function blogInfo(deps: Deps, a: AuthContext, s: SiteRow, b: BlogRow): Promise<BlogInfo> {
  const base = blogBase(deps, s.slug);
  let newsletter: BlogInfo["newsletter"] = null;
  if (isAdmin(a) || canEditSite(a, s)) {
    const on = await newsletterOn(deps, a.orgId);
    const l = on ? await listRow(deps, b) : null;
    newsletter = l
      ? { available: true, listId: l.id, ready: newsletterProblems(l).length === 0, problems: newsletterProblems(l), mailboxId: l.mailbox_id, senderName: l.sender_name, senderAddress: l.sender_address, counts: await listCounts(deps, l) }
      : { available: on, listId: null, ready: false, problems: on ? ["Turn on the newsletter in blog settings."] : [], mailboxId: null, senderName: "", senderAddress: "", counts: { subscribed: 0, pending: 0, unsubscribed: 0 } };
  }
  return { siteId: s.id, title: b.title, description: b.description, subscribeOn: b.subscribeOn, url: base, rssUrl: `${base}/rss.xml`, rootDocId: b.rootDocId, newsletter };
}

export async function getBlog(deps: Deps, a: AuthContext) {
  const s = await siteFor(deps, a);
  const b = await blogOf(deps, s);
  const people = await deps.db.select({ id: users.id, name: users.name, email: users.email }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, a.orgId), eq(members.kind, "human"))).limit(500).all();
  return {
    blog: b ? await blogInfo(deps, a, s, b) : null,
    canStart: !b && isAdmin(a), canEdit: canEditSite(a, s), isAdmin: isAdmin(a), me: a.userId,
    people: canEditSite(a, s) ? people.map((p) => ({ id: p.id, name: p.name || p.email })) : [],
  };
}

/** Starts the blog (admins): a "Blog posts" page in Docs for the post bodies and, when newsletters run here, a subscriber list. */
export async function startBlog(deps: Deps, a: AuthContext, input: { title?: string; description?: string }) {
  needAdmin(a);
  const s = await siteFor(deps, a);
  if (await blogOf(deps, s)) throw conflict("This site already has a blog.");
  const clash = await deps.db.select({ id: sitePages.id }).from(sitePages).where(and(eq(sitePages.siteId, s.id), eq(sitePages.slug, "blog"))).get();
  if (clash) throw conflict("A page already uses the address blog. Give that page another address first.");
  const title = (input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "Blog";
  const root = await createDoc(deps, a, { title: "Blog posts", text: `The text of each post on ${s.name}'s blog. Write and publish them from Docs > Sites > Blog.` });
  let listId: string | null = null;
  if (await newsletterOn(deps, a.orgId)) {
    const l = await C.createList(deps, a, { name: `${s.name} blog subscribers`.slice(0, 120), description: "People who subscribed on the blog.", visibility: "workspace", doubleOptIn: true, signupOn: false, senderName: s.name });
    listId = l.id;
  }
  const t = nowMs(deps);
  await deps.db.insert(siteBlogs).values({ siteId: s.id, orgId: a.orgId, title, description: (input.description ?? "").trim().slice(0, 300), listId, rootDocId: (root as { id: string }).id, subscribeOn: true, createdBy: a.userId, createdAt: t, updatedAt: t });
  forgetBlog(s.slug);
  return getBlog(deps, a);
}

export interface BlogPatch { title?: string; description?: string; subscribeOn?: boolean; mailboxId?: string | null; senderName?: string; senderAddress?: string; newsletter?: boolean }
export async function updateBlog(deps: Deps, a: AuthContext, p: BlogPatch) {
  const { s, b } = await needBlog(deps, a);
  needEdit(a, s);
  const set: Partial<BlogRow> = { updatedAt: nowMs(deps) };
  if (p.title !== undefined) { const t = p.title.replace(/\s+/g, " ").trim().slice(0, 120); if (!t) throw badRequest("Give the blog a name."); set.title = t; }
  if (p.description !== undefined) set.description = p.description.replace(/\s+/g, " ").trim().slice(0, 300);
  if (p.subscribeOn !== undefined) set.subscribeOn = p.subscribeOn;
  const touchesList = p.mailboxId !== undefined || p.senderName !== undefined || p.senderAddress !== undefined || p.newsletter;
  if (touchesList) {
    needAdmin(a);
    if (!(await newsletterOn(deps, a.orgId))) throw badRequest("Newsletters are not on for this workspace.");
    let listId = b.listId && (await listRow(deps, b)) ? b.listId : null;
    if (!listId) { listId = (await C.createList(deps, a, { name: `${s.name} blog subscribers`.slice(0, 120), description: "People who subscribed on the blog.", visibility: "workspace", doubleOptIn: true, signupOn: false, senderName: s.name })).id; set.listId = listId; }
    const patch: Partial<C.ListInput> = { doubleOptIn: true };
    if (p.mailboxId !== undefined) patch.mailboxId = p.mailboxId;
    if (p.senderName !== undefined) patch.senderName = p.senderName.slice(0, 120);
    if (p.senderAddress !== undefined) patch.senderAddress = p.senderAddress.slice(0, 300);
    await C.updateList(deps, a, listId, patch);
  }
  await deps.db.update(siteBlogs).set(set).where(and(eq(siteBlogs.siteId, s.id), eq(siteBlogs.orgId, a.orgId)));
  forgetBlog(s.slug);
  return getBlog(deps, a);
}

// ---------------------------------------------------------------- authors

async function authorRows(deps: Deps, s: SiteRow) {
  return deps.db.select().from(blogAuthors).where(and(eq(blogAuthors.siteId, s.id), eq(blogAuthors.orgId, s.orgId))).limit(500).all();
}
/** The author's profile, made from the member's name the first time they are picked. Refuses people outside the workspace. */
async function ensureAuthor(deps: Deps, s: SiteRow, userId: string) {
  const have = await deps.db.select().from(blogAuthors).where(and(eq(blogAuthors.siteId, s.id), eq(blogAuthors.userId, userId))).get();
  if (have) return have;
  const u = await deps.db.select({ id: users.id, name: users.name, email: users.email }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, s.orgId), eq(members.userId, userId), eq(members.kind, "human"))).get();
  if (!u) throw badRequest("Pick an author from your team.");
  const name = (u.name || u.email.split("@")[0] || "Author").trim().slice(0, 80);
  const taken = (await authorRows(deps, s)).map((r) => r.slug);
  const slug = freePostSlug(slugify(name, "author"), taken);
  const t = nowMs(deps);
  await deps.db.insert(blogAuthors).values({ siteId: s.id, userId, orgId: s.orgId, slug, name, bio: "", photo: "", createdAt: t, updatedAt: t }).onConflictDoNothing();
  return (await deps.db.select().from(blogAuthors).where(and(eq(blogAuthors.siteId, s.id), eq(blogAuthors.userId, userId))).get())!;
}

export async function listAuthors(deps: Deps, a: AuthContext): Promise<{ authors: AuthorInfo[] }> {
  const { s } = await needBlog(deps, a);
  const rows = await authorRows(deps, s);
  const posts = await deps.db.select({ authorId: blogPosts.authorId, n: sql<number>`count(*)` }).from(blogPosts).where(and(eq(blogPosts.siteId, s.id), eq(blogPosts.orgId, a.orgId))).groupBy(blogPosts.authorId).all();
  const n = new Map(posts.map((p) => [p.authorId, Number(p.n)]));
  const base = blogBase(deps, s.slug);
  return { authors: rows.map((r) => ({ userId: r.userId, slug: r.slug, name: r.name, bio: r.bio, photo: r.photo, url: `${base}/author/${r.slug}`, posts: n.get(r.userId) ?? 0 })).sort((x, y) => x.name.localeCompare(y.name)) };
}

export async function saveAuthor(deps: Deps, a: AuthContext, userId: string, p: { name?: string; bio?: string; photo?: string; slug?: string }) {
  const { s } = await needBlog(deps, a);
  if (!canEditSite(a, s) && userId !== a.userId) throw forbidden("Only admins and site editors can change other people's profiles.");
  if (!canEditSite(a, s)) throw forbidden("Only admins and site editors can change the blog.");
  const row = await ensureAuthor(deps, s, userId);
  const set: Partial<typeof blogAuthors.$inferInsert> = { updatedAt: nowMs(deps) };
  if (p.name !== undefined) { const v = p.name.replace(/\s+/g, " ").trim().slice(0, 80); if (!v) throw badRequest("Add a name."); set.name = v; }
  if (p.bio !== undefined) set.bio = p.bio.replace(/\r/g, "").trim().slice(0, MAX_BIO);
  if (p.photo !== undefined) { const v = p.photo.trim(); if (v && !publicImage(v, "x")) throw badRequest("Upload a photo or use an image link that starts with https://"); set.photo = v; }
  if (p.slug !== undefined && p.slug !== row.slug) {
    const v = p.slug.trim().toLowerCase(); const bad = postSlugProblem(v); if (bad) throw badRequest(bad);
    const other = await deps.db.select({ u: blogAuthors.userId }).from(blogAuthors).where(and(eq(blogAuthors.siteId, s.id), eq(blogAuthors.slug, v))).get();
    if (other) throw conflict("Another author uses that address.");
    set.slug = v;
  }
  await deps.db.update(blogAuthors).set(set).where(and(eq(blogAuthors.siteId, s.id), eq(blogAuthors.userId, userId)));
  const photo = set.photo ?? row.photo;
  await deps.db.delete(blogImages).where(and(eq(blogImages.siteId, s.id), eq(blogImages.owner, `author:${userId}`)));
  const pid = docImageId(photo);
  if (pid) await deps.db.insert(blogImages).values({ siteId: s.id, owner: `author:${userId}`, imageId: pid, orgId: s.orgId }).onConflictDoNothing();
  forgetBlog(s.slug);
  return listAuthors(deps, a);
}

// ---------------------------------------------------------------- posts

function summaryOf(deps: Deps, s: SiteRow, p: PostRow, names: Map<string, string>, docVersion: number | null | undefined): PostSummary {
  const now = nowMs(deps);
  const live = parse<LiveMeta | null>(p.live, null);
  const status = postStatusOf({ live, publishAt: p.publishAt }, now);
  const metaChanged = !!live && (live.title !== p.title || live.excerpt !== p.excerpt || live.cover !== p.cover || JSON.stringify(live.tags) !== p.tags || live.authorId !== p.authorId);
  const bodyChanged = !!live && docVersion != null && p.liveVersion != null && docVersion > p.liveVersion;
  return {
    id: p.id, docId: p.docId, slug: p.slug, title: p.title, excerpt: p.excerpt, cover: p.cover, tags: parse<string[]>(p.tags, []), authorId: p.authorId, authorName: p.authorId ? names.get(p.authorId) ?? "" : "",
    status, publishAt: p.publishAt, publishedAt: p.publishedAt, updatedAt: p.updatedAt, hasUnpublished: status !== "draft" && (metaChanged || bodyChanged), emailed: !!p.campaignId,
    url: `${blogBase(deps, s.slug)}/${p.slug}`,
  };
}
async function nameMap(deps: Deps, s: SiteRow) { return new Map((await authorRows(deps, s)).map((r) => [r.userId, r.name])); }

export interface PostQuery { q?: string; status?: string; tag?: string; author?: string }
export async function listPosts(deps: Deps, a: AuthContext, f: PostQuery = {}): Promise<{ posts: PostSummary[]; tags: string[]; total: number }> {
  const { s } = await needBlog(deps, a);
  const rows = await deps.db.select().from(blogPosts).where(and(eq(blogPosts.siteId, s.id), eq(blogPosts.orgId, a.orgId))).orderBy(desc(blogPosts.updatedAt)).limit(MAX_POSTS).all();
  const docIds = [...new Set(rows.map((r) => r.docId))];
  const vers = docIds.length ? await deps.db.select({ id: docs.id, version: docs.version }).from(docs).where(and(eq(docs.orgId, a.orgId), inArray(docs.id, docIds.slice(0, 90)))).all() : [];
  const v = new Map(vers.map((d) => [d.id, d.version]));
  const names = await nameMap(deps, s);
  const edit = canEditSite(a, s);
  let all = rows.map((r) => summaryOf(deps, s, r, names, v.get(r.docId)));
  if (!edit) all = all.filter((p) => p.status === "published");
  const tags = [...new Map(all.flatMap((p) => p.tags).map((t) => [tagSlug(t), t])).values()].sort((x, y) => x.localeCompare(y));
  const q = (f.q ?? "").trim().toLowerCase();
  const tag = f.tag ? tagSlug(f.tag) : "";
  const out = all.filter((p) => (!q || p.title.toLowerCase().includes(q) || p.excerpt.toLowerCase().includes(q))
    && (!f.status || p.status === f.status) && (!tag || p.tags.some((t) => tagSlug(t) === tag)) && (!f.author || p.authorId === f.author));
  return { posts: out, tags, total: all.length };
}

async function detailOf(deps: Deps, a: AuthContext, s: SiteRow, p: PostRow): Promise<PostDetail> {
  const d = await deps.db.select({ version: docs.version, text: docs.plainText }).from(docs).where(and(eq(docs.id, p.docId), eq(docs.orgId, a.orgId))).get();
  const sum = summaryOf(deps, s, p, await nameMap(deps, s), d?.version);
  let emailState: PostDetail["emailState"] = "none";
  if (p.campaignId) {
    const c = await deps.db.get<{ status: string }>(sql`select status from campaigns where id = ${p.campaignId} and org_id = ${a.orgId}`);
    emailState = c?.status === "scheduled" ? "scheduled" : c ? "sent" : "skipped";
  }
  return { ...sum, emailOnPublish: p.emailOnPublish, emailState, campaignId: p.campaignId, canEdit: canEditSite(a, s), canEmail: isAdmin(a), previewUrl: `/api/sites/blog/posts/${p.id}/preview`, readMins: readingMinutes(d?.text ?? "") };
}

export async function getPost(deps: Deps, a: AuthContext, id: string) {
  const { s } = await needBlog(deps, a);
  const p = await postOf(deps, a, s, id);
  const det = await detailOf(deps, a, s, p);
  if (!det.canEdit && det.status !== "published") throw notFound("Post");
  return det;
}

export async function createPost(deps: Deps, a: AuthContext, input: { title?: string }) {
  const { s, b } = await needBlog(deps, a);
  needEdit(a, s);
  const count = await deps.db.select({ n: sql<number>`count(*)` }).from(blogPosts).where(eq(blogPosts.siteId, s.id)).get();
  if (Number(count?.n ?? 0) >= MAX_POSTS) throw badRequest(`A blog can have up to ${MAX_POSTS} posts.`);
  const title = (input.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_POST_TITLE) || "Untitled post";
  let parentId: string | null = b.rootDocId;
  if (parentId) { const r = await deps.db.select({ id: docs.id }).from(docs).where(and(eq(docs.id, parentId), eq(docs.orgId, a.orgId), isNull(docs.deletedAt))).get(); if (!r) parentId = null; }
  const doc = await createDoc(deps, a, { title, text: "", parentId }) as { id: string };
  const taken = (await deps.db.select({ slug: blogPosts.slug }).from(blogPosts).where(eq(blogPosts.siteId, s.id)).limit(MAX_POSTS).all()).map((r) => r.slug);
  await ensureAuthor(deps, s, a.userId);
  const t = nowMs(deps);
  const id = `bp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await deps.db.insert(blogPosts).values({ id, orgId: a.orgId, siteId: s.id, docId: doc.id, slug: freePostSlug(title, taken), title, tags: "[]", authorId: a.userId, createdBy: a.userId, updatedBy: a.userId, createdAt: t, updatedAt: t });
  return getPost(deps, a, id);
}

export interface PostPatch { title?: string; slug?: string; excerpt?: string; cover?: string; tags?: string[]; authorId?: string | null; emailOnPublish?: boolean }
export async function savePost(deps: Deps, a: AuthContext, id: string, patch: PostPatch) {
  const { s } = await needBlog(deps, a);
  needEdit(a, s);
  const p = await postOf(deps, a, s, id);
  const set: Partial<PostRow> = { updatedAt: nowMs(deps), updatedBy: a.userId };
  if (patch.title !== undefined) { const v = patch.title.replace(/\s+/g, " ").trim().slice(0, MAX_POST_TITLE); if (!v) throw badRequest("Give the post a title."); set.title = v; }
  if (patch.slug !== undefined && patch.slug !== p.slug) {
    const v = patch.slug.trim().toLowerCase();
    const bad = postSlugProblem(v); if (bad) throw badRequest(bad);
    const other = await deps.db.select({ id: blogPosts.id }).from(blogPosts).where(and(eq(blogPosts.siteId, s.id), eq(blogPosts.slug, v))).get();
    if (other) throw conflict("Another post uses that address.");
    set.slug = v;
  }
  if (patch.excerpt !== undefined) set.excerpt = patch.excerpt.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT);
  if (patch.cover !== undefined) { const v = patch.cover.trim(); if (v && !publicImage(v, "x")) throw badRequest("Upload an image or use an image link that starts with https://"); set.cover = v; }
  if (patch.tags !== undefined) set.tags = JSON.stringify(cleanTags(patch.tags));
  if (patch.authorId !== undefined) { if (patch.authorId) await ensureAuthor(deps, s, patch.authorId); set.authorId = patch.authorId; }
  if (patch.emailOnPublish !== undefined) {
    if (patch.emailOnPublish && !isAdmin(a)) throw forbidden("Only admins can email a post to subscribers.");
    if (p.campaignId && patch.emailOnPublish === false && p.emailedAt) throw badRequest("This post was already emailed.");
    set.emailOnPublish = patch.emailOnPublish;
  }
  await deps.db.update(blogPosts).set(set).where(and(eq(blogPosts.id, id), eq(blogPosts.orgId, a.orgId)));
  // A renamed live post: the old address stops at once (forget the cache for both).
  if (set.slug) forgetBlog(s.slug);
  return getPost(deps, a, id);
}

/** The escaped HTML of a doc for the public page; uploaded doc images point at the blog's own image address. */
export function snapshotHtml(content: unknown, base: string, appUrl: string): { html: string; images: string[] } {
  const images: string[] = [];
  const walk = (n: unknown, depth = 0): unknown => {
    if (!n || typeof n !== "object" || depth > 40) return n;
    const node = n as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
    if (node.type === "image" && typeof node.attrs?.src === "string") {
      const id = docImageId(node.attrs.src);
      if (id) { images.push(id); return { ...node, attrs: { ...node.attrs, src: `https://blog-image.invalid/${id}` } }; }
    }
    return Array.isArray(node.content) ? { ...node, content: node.content.map((c) => walk(c, depth + 1)) } : node;
  };
  const html = renderDocHtml(walk(content), appUrl).split("https://blog-image.invalid/").join(`${base}/img/`);
  return { html, images: [...new Set(images)] };
}

async function snapshot(deps: Deps, a: AuthContext, s: SiteRow, p: PostRow) {
  const d = await deps.db.select().from(docs).where(and(eq(docs.id, p.docId), eq(docs.orgId, a.orgId), isNull(docs.deletedAt))).get();
  if (!d) throw badRequest("The text of this post was deleted in Docs. Restore it from the trash first.");
  let content: unknown = null;
  try { content = JSON.parse(d.content); } catch { content = null; }
  const { html, images } = snapshotHtml(content, blogBase(deps, s.slug), deps.config.appUrl);
  const text = d.plainText ?? "";
  const meta: LiveMeta = { title: p.title, excerpt: p.excerpt, cover: p.cover, tags: parse<string[]>(p.tags, []), authorId: p.authorId, readMins: readingMinutes(text), text: autoExcerpt(text, 600) };
  return { html, images, meta, version: d.version };
}

async function writeImages(deps: Deps, s: SiteRow, postId: string, ids: string[]) {
  await deps.db.delete(blogImages).where(and(eq(blogImages.siteId, s.id), eq(blogImages.owner, postId)));
  for (const id of ids.slice(0, 200)) await deps.db.insert(blogImages).values({ siteId: s.id, owner: postId, imageId: id, orgId: s.orgId }).onConflictDoNothing();
}

export interface PublishResult { post: PostDetail; email: { status: "none" | "scheduled" | "sent" | "skipped"; message: string } }

/**
 * Publishes now, schedules (`at` in the future) or, for a live post, updates the live copy (the first publish date stays).
 * When the post asks for it (admins only), its email goes out once through an R109 newsletter at the publish time.
 */
export async function publishPost(deps: Deps, a: AuthContext, id: string, input: { at?: number | null }): Promise<PublishResult> {
  const { s, b } = await needBlog(deps, a);
  needEdit(a, s);
  const p = await postOf(deps, a, s, id);
  const now = nowMs(deps);
  const bad = scheduleProblem(input.at ?? null, now); if (bad) throw badRequest(bad);
  if (!p.title.trim()) throw badRequest("Give the post a title.");
  const wasLive = isLive({ live: p.live, publishAt: p.publishAt }, now);
  if (wasLive && input.at && input.at > now + 60_000) throw badRequest("This post is already live. Unpublish it first to schedule it again.");
  const snap = await snapshot(deps, a, s, p);
  if (!snap.meta.excerpt) snap.meta.excerpt = autoExcerpt(snap.meta.text ?? "");
  if (p.authorId) await ensureAuthor(deps, s, p.authorId).catch(() => undefined);
  const at = wasLive ? p.publishAt ?? now : input.at && input.at > now ? input.at : now;
  const publishedAt = wasLive ? p.publishedAt ?? now : at;
  await deps.db.update(blogPosts).set({ live: JSON.stringify(snap.meta), liveHtml: snap.html, liveVersion: snap.version, publishAt: at, publishedAt, updatedAt: now, updatedBy: a.userId })
    .where(and(eq(blogPosts.id, id), eq(blogPosts.orgId, a.orgId)));
  const coverId = docImageId(p.cover);
  await writeImages(deps, s, id, [...snap.images, ...(coverId ? [coverId] : [])]);
  forgetBlog(s.slug);
  let email: PublishResult["email"] = { status: "none", message: "" };
  if (p.emailOnPublish && !p.campaignId) email = await emailPost(deps, a, s, b, { ...p, publishAt: at, slug: p.slug }, snap.meta, at);
  else if (p.campaignId) email = { status: "skipped", message: "This post was already emailed, so subscribers don't get it again." };
  deps.log?.info("blog.published", { org: a.orgId, post: id, scheduled: at > now, email: email.status });
  return { post: await getPost(deps, a, id), email };
}

/** The post's email through R109: a newsletter on the blog's list, scheduled at the publish time. Never twice. */
async function emailPost(deps: Deps, a: AuthContext, s: SiteRow, b: BlogRow, p: PostRow, meta: LiveMeta, at: number): Promise<PublishResult["email"]> {
  if (!isAdmin(a)) return { status: "skipped", message: "Only admins can email a post, so no email went out." };
  if (!(await newsletterOn(deps, a.orgId))) return { status: "skipped", message: "Newsletters are not on for this workspace, so no email went out." };
  const l = await listRow(deps, b);
  if (!l) return { status: "skipped", message: "Set up the newsletter in blog settings first. No email went out." };
  const problems = newsletterProblems(l);
  if (problems.length) return { status: "skipped", message: `No email went out. ${problems.join(" ")}` };
  const counts = await listCounts(deps, l);
  if (!counts.subscribed) return { status: "skipped", message: "Nobody has confirmed a subscription yet, so no email went out." };
  const url = `${blogBase(deps, s.slug)}/${p.slug}`;
  const cover = publicImage(meta.cover, blogBase(deps, s.slug));
  const blocks: MailBlock[] = [
    ...(cover && /^https:\/\//i.test(cover) ? [{ type: "image" as const, url: cover, alt: "" }] : []),
    { type: "heading", text: meta.title.slice(0, 200) },
    { type: "text", text: (meta.excerpt || meta.text || "").slice(0, 2000) },
    // A button needs an https link; a local test address goes in the text instead.
    ...(/^https:\/\//i.test(url) ? [{ type: "button" as const, label: "Read the post", url }] : [{ type: "text" as const, text: `Read the post: ${url}` }]),
  ];
  const c = await C.createCampaign(deps, a, { listId: l.id, name: `Blog: ${meta.title}`.slice(0, 120) });
  const cid = (c as { id?: string; campaign?: { id: string } }).campaign?.id ?? (c as { id: string }).id;
  try {
    await C.updateCampaign(deps, a, cid, { subject: meta.title.slice(0, 200), preheader: meta.excerpt.slice(0, 200), blocks, mailboxId: l.mailbox_id });
    await C.scheduleCampaign(deps, a, cid, at > nowMs(deps) + 5_000 ? new Date(at).toISOString() : null);
  } catch (err) {
    await C.deleteCampaign(deps, a, cid).catch(() => undefined);
    const msg = err instanceof HttpError ? err.message : "The email could not be queued.";
    deps.log?.warn("blog.email_failed", { org: a.orgId, post: p.id, code: err instanceof HttpError ? err.code : "error" });
    return { status: "skipped", message: `No email went out. ${msg}` };
  }
  await deps.db.update(blogPosts).set({ campaignId: cid, emailedAt: nowMs(deps) }).where(and(eq(blogPosts.id, p.id), eq(blogPosts.orgId, a.orgId)));
  return at > nowMs(deps) + 5_000
    ? { status: "scheduled", message: `The email goes to ${counts.subscribed} subscriber${counts.subscribed === 1 ? "" : "s"} when the post goes live.` }
    : { status: "sent", message: `Sending to ${counts.subscribed} subscriber${counts.subscribed === 1 ? "" : "s"} now.` };
}

export async function unpublishPost(deps: Deps, a: AuthContext, id: string) {
  const { s } = await needBlog(deps, a);
  needEdit(a, s);
  const p = await postOf(deps, a, s, id);
  if (p.campaignId) {
    const c = await deps.db.get<{ status: string }>(sql`select status from campaigns where id = ${p.campaignId} and org_id = ${a.orgId}`);
    if (c?.status === "scheduled") {
      try { await C.unscheduleCampaign(deps, a, p.campaignId); await C.deleteCampaign(deps, a, p.campaignId); } catch { /* an admin can stop it in Campaigns */ }
      await deps.db.update(blogPosts).set({ campaignId: null, emailedAt: null }).where(eq(blogPosts.id, id));
    }
  }
  await deps.db.update(blogPosts).set({ live: null, liveHtml: null, liveVersion: null, publishAt: null, publishedAt: null, updatedAt: nowMs(deps), updatedBy: a.userId })
    .where(and(eq(blogPosts.id, id), eq(blogPosts.orgId, a.orgId)));
  await writeImages(deps, s, id, []);
  forgetBlog(s.slug);
  return getPost(deps, a, id);
}

/** Deletes the post from the blog. Its text stays in Docs (and its trash), so nothing written is lost. */
export async function deletePost(deps: Deps, a: AuthContext, id: string) {
  const { s } = await needBlog(deps, a);
  needEdit(a, s);
  const p = await postOf(deps, a, s, id);
  if (p.live) await unpublishPost(deps, a, id);
  await deps.db.delete(blogPosts).where(and(eq(blogPosts.id, id), eq(blogPosts.orgId, a.orgId)));
  forgetBlog(s.slug);
  return { ok: true };
}

/** The post as it will look, from the current doc (signed in; never indexed). */
export async function previewPost(deps: Deps, a: AuthContext, id: string) {
  const { s, b } = await needBlog(deps, a);
  needEdit(a, s);
  const p = await postOf(deps, a, s, id);
  const snap = await snapshot(deps, a, s, p);
  const authors = await authorRows(deps, s);
  return { s, b, p, snap, author: authors.find((x) => x.userId === p.authorId) ?? null };
}

// ---------------------------------------------------------------- subscribers (admins)

async function needList(deps: Deps, a: AuthContext) {
  needAdmin(a);
  const { b } = await needBlog(deps, a);
  const l = await listRow(deps, b);
  if (!l) throw notFound("Subscriber list");
  return l;
}
export async function subscribers(deps: Deps, a: AuthContext, q: { search?: string; status?: string; offset?: number }) {
  const l = await needList(deps, a);
  const r = await C.listMembers(deps, a, l.id, q);
  return { counts: await listCounts(deps, l), more: r.more, subscribers: r.members.map((m) => ({ id: m.id, email: m.email, status: m.status, source: m.consentSource, at: m.consentAt })) };
}
export async function removeSubscriber(deps: Deps, a: AuthContext, memberId: string) {
  const l = await needList(deps, a);
  await C.removeMember(deps, a, l.id, memberId);
  return { ok: true };
}
export async function subscribersCsv(deps: Deps, a: AuthContext): Promise<string> {
  const l = await needList(deps, a);
  const rows = await deps.db.all<C.MemberRow>(sql`select * from audience_members where list_id = ${l.id} and org_id = ${a.orgId} order by created_at limit 20000`);
  const head = ["Email", "Status", "Consent source", "Consent time", "Confirmed", "Unsubscribed"].map(csvCell).join(",");
  const iso = (n: number | null) => (n ? new Date(n).toISOString() : "");
  return [head, ...rows.map((m) => [m.email, m.status, m.consent_source, iso(m.consent_at), iso(m.confirmed_at), iso(m.unsubscribed_at)].map(csvCell).join(","))].join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- public side (signed out)

export interface PublicPost { id: string; slug: string; title: string; excerpt: string; cover: string; tags: string[]; authorId: string | null; readMins: number; publishedAt: number; publishAt: number }
export interface PublicBlog {
  siteId: string; title: string; description: string; subscribe: { ok: boolean; senderName: string }; listId: string | null;
  posts: PublicPost[]; authors: { userId: string; slug: string; name: string; bio: string; photo: string }[];
}

const blogCache = new IsolateCache<PublicBlog | null>(30_000, 1_000);
const postCache = new IsolateCache<{ html: string; meta: LiveMeta; id: string; publishAt: number } | null>(30_000, 2_000);
export function forgetBlog(siteSlug: string) { blogCache.forgetPrefix(siteSlug); postCache.forgetPrefix(`${siteSlug}/`); forgetSite(siteSlug); }

/** The blog and its live posts (meta only, no HTML), bounded and cached 30 s per isolate. Scheduled posts show once due. */
export async function resolveBlog(deps: Deps, site: PublicSite): Promise<PublicBlog | null> {
  let v = blogCache.get(site.slug);
  if (v === undefined) {
    const b = await deps.db.select().from(siteBlogs).where(eq(siteBlogs.siteId, site.id)).get();
    v = null;
    if (b) {
      const [rows, authors, l] = await Promise.all([
        deps.db.select({ id: blogPosts.id, slug: blogPosts.slug, live: blogPosts.live, publishAt: blogPosts.publishAt, publishedAt: blogPosts.publishedAt }).from(blogPosts)
          .where(and(eq(blogPosts.siteId, site.id), sql`${blogPosts.live} is not null`)).orderBy(desc(blogPosts.publishedAt)).limit(MAX_POSTS).all(),
        deps.db.select().from(blogAuthors).where(eq(blogAuthors.siteId, site.id)).limit(500).all(),
        listRow(deps, b),
      ]);
      const posts: PublicPost[] = [];
      for (const r of rows) {
        const m = parse<LiveMeta | null>(r.live, null);
        if (!m || r.publishAt === null) continue;
        posts.push({ id: r.id, slug: r.slug, title: m.title, excerpt: m.excerpt, cover: m.cover, tags: m.tags ?? [], authorId: m.authorId, readMins: m.readMins || 1, publishedAt: r.publishedAt ?? r.publishAt, publishAt: r.publishAt });
      }
      const ok = !!b.subscribeOn && !!l && newsletterProblems(l).length === 0 && (await newsletterOn(deps, site.orgId));
      v = { siteId: site.id, title: b.title, description: b.description, subscribe: { ok, senderName: l?.sender_name ?? site.name }, listId: ok ? l!.id : null, posts,
        authors: authors.map((x) => ({ userId: x.userId, slug: x.slug, name: x.name, bio: x.bio, photo: x.photo })) };
    }
    blogCache.set(site.slug, v);
  }
  if (!v) return null;
  const now = nowMs(deps);
  return { ...v, posts: v.posts.filter((p) => p.publishAt <= now).sort((x, y) => y.publishedAt - x.publishedAt) };
}

/** One live post's HTML (one keyed read, cached 30 s). */
export async function resolvePost(deps: Deps, site: PublicSite, slug: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const key = `${site.slug}/${slug}`;
  let v = postCache.get(key);
  if (v === undefined) {
    const r = await deps.db.select({ id: blogPosts.id, live: blogPosts.live, liveHtml: blogPosts.liveHtml, publishAt: blogPosts.publishAt }).from(blogPosts)
      .where(and(eq(blogPosts.siteId, site.id), eq(blogPosts.slug, slug))).get();
    const meta = parse<LiveMeta | null>(r?.live, null);
    v = r && meta && r.publishAt !== null ? { id: r.id, html: r.liveHtml ?? "", meta, publishAt: r.publishAt } : null;
    postCache.set(key, v);
  }
  return v && v.publishAt <= nowMs(deps) ? v : null;
}

/** Whether an uploaded image may be shown publicly on this site (a live post or an author photo uses it). */
export async function publicImageOk(deps: Deps, site: PublicSite, imageId: string) {
  if (!/^dim_[A-Za-z0-9]{6,40}$/.test(imageId)) return false;
  const r = await deps.db.select({ owner: blogImages.owner }).from(blogImages).where(and(eq(blogImages.siteId, site.id), eq(blogImages.imageId, imageId))).limit(1).get();
  return !!r;
}

/** A visitor's subscription: one confirm link by email through R109 (double opt in). The answer never says whether the address was already on the list. */
export async function subscribe(deps: Deps, site: PublicSite, email: string) {
  const blog = await resolveBlog(deps, site);
  if (!blog || !blog.subscribe.ok || !blog.listId) throw new HttpError(404, "not_found", "Subscriptions are closed on this blog.");
  const l = await deps.db.get<C.ListRow>(sql`select * from audience_lists where id = ${blog.listId} and org_id = ${site.orgId} and archived_at is null`);
  if (!l) throw new HttpError(404, "not_found", "Subscriptions are closed on this blog.");
  // The blog list always confirms by email, whatever the list setting says.
  const r = await C.signupSubmit(deps, { ...l, double_opt_in: 1 }, { email, name: "" }, `Blog subscribe box (${site.name})`.slice(0, 200));
  deps.log?.info("blog.subscribe", { org: site.orgId, site: site.id, result: r.status });
  return { ok: true };
}

