/**
 * R122: the help center. Team side (signed in) manages settings, categories, published snapshots of docs, questions,
 * answers and feedback; the public side reads ONLY rows a workspace published, of a workspace whose help center is on.
 * Every public read goes through `centerBySlug` (on, by slug) and filters status "published" and org_id on each query.
 */
import { and, asc, desc, eq, gte, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { inIds } from "@/server/lib/sql-chunks";
import type { AuthContext, Deps } from "../context";
import {
  docs, hcAnswers, hcArticles, hcCategories, hcFeedback, hcQuestions, hcSettings, hcTerms, hcVotes, hdTickets, hdWebMessages, mailboxes, messages, organizations,
} from "../db/schema";
import { hmacSha256Hex, newId } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound, tooMany } from "../lib/errors";
import { IsolateCache } from "../lib/isolate-cache";
import { renderDocHtml } from "./suite/share-links";
import {
  HC_ANSWER_MAX, HC_AUTHOR_MAX, HC_CATEGORY_MAX, HC_COMMENT_MAX, HC_INTRO_MAX, HC_NAME_MAX, HC_PAGE_SIZE, HC_QUESTION_MAX, HC_SUMMARY_MAX, HC_TITLE_MAX,
  centerSlugProblem, cleanPost, freeSlug, looksLikeSpam, prefixEnd, queryTerms, redactForPublic, slugOk, slugify, stillPrivate, termsOf,
  type HelpCenterSettings, type PostStatus,
} from "@/shared/help-center";

type SettingsRow = typeof hcSettings.$inferSelect;
type ArticleRow = typeof hcArticles.$inferSelect;
type QuestionRow = typeof hcQuestions.$inferSelect;
const isAdmin = (a: Pick<AuthContext, "role">) => a.role === "owner" || a.role === "admin";
function needAdmin(a: AuthContext) { if (!isAdmin(a)) throw forbidden("Only owners and admins can change the help center."); }
const now = (deps: Deps) => deps.now().getTime();
const base = (deps: Deps) => deps.config.appUrl.replace(/\/+$/, "");
export const centerUrl = (deps: Deps, slug: string) => `${base(deps)}/help/${slug}`;

// ---------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------

function present(s: SettingsRow): HelpCenterSettings {
  return { on: s.on, slug: s.slug, name: s.name, intro: s.intro, qaOn: s.qaOn, moderate: s.moderate, suggestInChat: s.suggestInChat };
}
const bySlug = new IsolateCache<{ s: SettingsRow; orgName: string } | null>(30_000, 2_000);
function forget(slug: string) { bySlug.delete(slug); }

async function settingsRow(deps: Deps, orgId: string) {
  return deps.db.select().from(hcSettings).where(eq(hcSettings.orgId, orgId)).get();
}

export async function getCenter(deps: Deps, a: AuthContext) {
  const s = await settingsRow(deps, a.orgId);
  const org = await deps.db.select({ name: organizations.name, slug: organizations.slug }).from(organizations).where(eq(organizations.id, a.orgId)).get();
  if (!s) return { settings: null, suggestedSlug: slugify(org?.slug || org?.name || "help", "help"), orgName: org?.name ?? "", canEdit: isAdmin(a), counts: null, url: null };
  const count = async (q: unknown) => ((await (q as Promise<{ n: number } | undefined>))?.n ?? 0);
  const counts = {
    published: await count(deps.db.select({ n: sql<number>`count(*)` }).from(hcArticles).where(and(eq(hcArticles.orgId, a.orgId), eq(hcArticles.status, "published"))).get()),
    drafts: await count(deps.db.select({ n: sql<number>`count(*)` }).from(hcArticles).where(and(eq(hcArticles.orgId, a.orgId), eq(hcArticles.status, "draft"))).get()),
    waitingQuestions: await count(deps.db.select({ n: sql<number>`count(*)` }).from(hcQuestions).where(and(eq(hcQuestions.orgId, a.orgId), eq(hcQuestions.status, "pending"))).get()),
    waitingAnswers: await count(deps.db.select({ n: sql<number>`count(*)` }).from(hcAnswers).where(and(eq(hcAnswers.orgId, a.orgId), eq(hcAnswers.status, "pending"))).get()),
  };
  return { settings: present(s), suggestedSlug: s.slug, orgName: org?.name ?? "", canEdit: isAdmin(a), counts, url: centerUrl(deps, s.slug) };
}

export async function saveCenter(deps: Deps, a: AuthContext, patch: Partial<HelpCenterSettings>) {
  needAdmin(a);
  const cur = await settingsRow(deps, a.orgId);
  const slug = patch.slug !== undefined ? patch.slug.trim().toLowerCase() : cur?.slug;
  if (!slug) throw badRequest("Choose an address for your help center.");
  if (slug !== cur?.slug) {
    const problem = centerSlugProblem(slug);
    if (problem) throw badRequest(problem);
    const other = await deps.db.select({ orgId: hcSettings.orgId }).from(hcSettings).where(eq(hcSettings.slug, slug)).get();
    if (other && other.orgId !== a.orgId) throw conflict("That address is taken. Try another.");
  }
  const text = (v: string | undefined, max: number) => (v === undefined ? undefined : v.replace(/\s+/g, " ").trim().slice(0, max));
  const row = {
    on: patch.on ?? cur?.on ?? false, slug,
    name: text(patch.name, HC_NAME_MAX) ?? cur?.name ?? "", intro: text(patch.intro, HC_INTRO_MAX) ?? cur?.intro ?? "",
    qaOn: patch.qaOn ?? cur?.qaOn ?? true, moderate: patch.moderate ?? cur?.moderate ?? true, suggestInChat: patch.suggestInChat ?? cur?.suggestInChat ?? true,
    updatedAt: now(deps),
  };
  if (cur) await deps.db.update(hcSettings).set(row).where(eq(hcSettings.orgId, a.orgId));
  else await deps.db.insert(hcSettings).values({ orgId: a.orgId, ...row });
  if (cur?.slug) forget(cur.slug);
  forget(slug);
  return getCenter(deps, a);
}

async function needCenter(deps: Deps, orgId: string) {
  const s = await settingsRow(deps, orgId);
  if (!s) throw badRequest("Set up the help center first.");
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------------------------

export async function listCategories(deps: Deps, orgId: string) {
  const rows = await deps.db.select().from(hcCategories).where(eq(hcCategories.orgId, orgId)).orderBy(asc(hcCategories.position), asc(hcCategories.createdAt)).limit(200);
  const counts = await deps.db.select({ id: hcArticles.categoryId, n: sql<number>`count(*)` }).from(hcArticles)
    .where(and(eq(hcArticles.orgId, orgId), eq(hcArticles.status, "published"))).groupBy(hcArticles.categoryId);
  const n = new Map(counts.map((c) => [c.id, c.n]));
  return rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, description: c.description, position: c.position, articles: n.get(c.id) ?? 0 }));
}

export async function saveCategory(deps: Deps, a: AuthContext, input: { name?: string; description?: string; position?: number }, id?: string) {
  needAdmin(a);
  await needCenter(deps, a.orgId);
  const name = input.name?.replace(/\s+/g, " ").trim().slice(0, HC_CATEGORY_MAX);
  const description = input.description?.replace(/\s+/g, " ").trim().slice(0, 200);
  const t = now(deps);
  if (id) {
    const cur = await deps.db.select().from(hcCategories).where(and(eq(hcCategories.id, id), eq(hcCategories.orgId, a.orgId))).get();
    if (!cur) throw notFound("Category");
    if (name !== undefined && !name) throw badRequest("Give the category a name.");
    await deps.db.update(hcCategories).set({ ...(name ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(input.position !== undefined ? { position: input.position } : {}), updatedAt: t })
      .where(and(eq(hcCategories.id, id), eq(hcCategories.orgId, a.orgId)));
    return (await listCategories(deps, a.orgId)).find((c) => c.id === id)!;
  }
  if (!name) throw badRequest("Give the category a name.");
  const existing = await deps.db.select({ slug: hcCategories.slug, position: hcCategories.position }).from(hcCategories).where(eq(hcCategories.orgId, a.orgId)).limit(200);
  if (existing.length >= 50) throw badRequest("A help center can have 50 categories.");
  const nid = newId("hcc");
  const position = input.position ?? (existing.reduce((m, c) => Math.max(m, c.position), 0) + 1);
  await deps.db.insert(hcCategories).values({ id: nid, orgId: a.orgId, name, slug: freeSlug(slugify(name, "topic"), existing.map((c) => c.slug)), description: description ?? "", position, createdAt: t, updatedAt: t });
  return (await listCategories(deps, a.orgId)).find((c) => c.id === nid)!;
}

export async function deleteCategory(deps: Deps, a: AuthContext, id: string) {
  needAdmin(a);
  const cur = await deps.db.select({ id: hcCategories.id }).from(hcCategories).where(and(eq(hcCategories.id, id), eq(hcCategories.orgId, a.orgId))).get();
  if (!cur) throw notFound("Category");
  await deps.db.update(hcArticles).set({ categoryId: null }).where(and(eq(hcArticles.orgId, a.orgId), eq(hcArticles.categoryId, id)));
  await deps.db.update(hcQuestions).set({ categoryId: null }).where(and(eq(hcQuestions.orgId, a.orgId), eq(hcQuestions.categoryId, id)));
  await deps.db.delete(hcCategories).where(and(eq(hcCategories.id, id), eq(hcCategories.orgId, a.orgId)));
  return { ok: true };
}

async function categoryOk(deps: Deps, orgId: string, id: string | null | undefined) {
  if (!id) return null;
  const c = await deps.db.select({ id: hcCategories.id }).from(hcCategories).where(and(eq(hcCategories.id, id), eq(hcCategories.orgId, orgId))).get();
  if (!c) throw notFound("Category");
  return c.id;
}

// ---------------------------------------------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------------------------------------------

async function unindex(deps: Deps, orgId: string, itemId: string) {
  await deps.db.delete(hcTerms).where(and(eq(hcTerms.itemId, itemId), eq(hcTerms.orgId, orgId)));
}
async function index(deps: Deps, orgId: string, kind: "a" | "q", itemId: string, parts: { title: string; summary?: string; body?: string }) {
  await unindex(deps, orgId, itemId);
  const rows = termsOf(parts).map((t) => ({ orgId, term: t.term, kind, itemId, weight: t.weight }));
  for (let i = 0; i < rows.length; i += 15) await deps.db.insert(hcTerms).values(rows.slice(i, i + 15)).onConflictDoNothing();
}

// ---------------------------------------------------------------------------------------------------------------
// Articles (team)
// ---------------------------------------------------------------------------------------------------------------

function presentArticle(r: ArticleRow, docVersion?: number | null, docGone?: boolean) {
  return {
    id: r.id, slug: r.slug, title: r.title, summary: r.summary, categoryId: r.categoryId, docId: r.docId, status: r.status, position: r.position,
    helpfulYes: r.helpfulYes, helpfulNo: r.helpfulNo, views: r.views, publishedAt: r.publishedAt, updatedAt: r.updatedAt,
    docChanged: !!(r.docId && docVersion != null && r.docVersion != null && docVersion > r.docVersion), docGone: !!docGone,
  };
}

export async function listArticles(deps: Deps, a: AuthContext) {
  const rows = await deps.db.select().from(hcArticles).where(eq(hcArticles.orgId, a.orgId)).orderBy(asc(hcArticles.position), desc(hcArticles.updatedAt)).limit(500);
  const docIds = [...new Set(rows.map((r) => r.docId).filter((x): x is string => !!x))];
  const vers = docIds.length ? await deps.db.select({ id: docs.id, version: docs.version, deletedAt: docs.deletedAt }).from(docs).where(and(eq(docs.orgId, a.orgId), inIds(docs.id, docIds))) : [];
  const v = new Map(vers.map((d) => [d.id, d]));
  return rows.map((r) => { const d = r.docId ? v.get(r.docId) : undefined; return presentArticle(r, d?.version, !!r.docId && (!d || !!d.deletedAt)); });
}

async function articleRow(deps: Deps, orgId: string, id: string) {
  const r = await deps.db.select().from(hcArticles).where(and(eq(hcArticles.id, id), eq(hcArticles.orgId, orgId))).get();
  if (!r) throw notFound("Article");
  return r;
}

export async function getArticle(deps: Deps, a: AuthContext, id: string) {
  const r = await articleRow(deps, a.orgId, id);
  const d = r.docId ? await deps.db.select({ version: docs.version, deletedAt: docs.deletedAt }).from(docs).where(and(eq(docs.id, r.docId), eq(docs.orgId, a.orgId))).get() : undefined;
  return { ...presentArticle(r, d?.version, !!r.docId && (!d || !!d.deletedAt)), bodyHtml: r.bodyHtml, url: `${centerUrl(deps, (await needCenter(deps, a.orgId)).slug)}/a/${r.slug}` };
}

async function snapshotOfDoc(deps: Deps, orgId: string, docId: string) {
  const d = await deps.db.select().from(docs).where(and(eq(docs.id, docId), eq(docs.orgId, orgId), isNull(docs.deletedAt))).get();
  if (!d) throw notFound("Doc");
  let html: string;
  try { html = renderDocHtml(JSON.parse(d.content), base(deps)); } catch { html = ""; }
  return { title: d.title.trim() || "Untitled", html, text: d.plainText, version: d.version };
}

export interface PublishDocInput { docId: string; categoryId?: string | null; summary?: string; slug?: string; title?: string; status?: "draft" | "published" }
export async function publishDoc(deps: Deps, a: AuthContext, input: PublishDocInput) {
  needAdmin(a);
  await needCenter(deps, a.orgId);
  const snap = await snapshotOfDoc(deps, a.orgId, input.docId);
  const categoryId = await categoryOk(deps, a.orgId, input.categoryId);
  const dup = await deps.db.select({ id: hcArticles.id }).from(hcArticles).where(and(eq(hcArticles.orgId, a.orgId), eq(hcArticles.docId, input.docId))).get();
  if (dup) throw conflict("This doc is already in the help center. Open it there to update it.");
  const title = (input.title ?? snap.title).replace(/\s+/g, " ").trim().slice(0, HC_TITLE_MAX) || "Untitled";
  const taken = (await deps.db.select({ slug: hcArticles.slug }).from(hcArticles).where(eq(hcArticles.orgId, a.orgId)).limit(2000)).map((r) => r.slug);
  let slug = input.slug?.trim().toLowerCase();
  if (slug) { if (!slugOk(slug)) throw badRequest("Use lowercase letters, numbers and single hyphens in the address."); if (taken.includes(slug)) throw conflict("Another article uses that address."); }
  else slug = freeSlug(slugify(title, "article"), taken);
  const status = input.status ?? "published";
  const summary = (input.summary ?? "").replace(/\s+/g, " ").trim().slice(0, HC_SUMMARY_MAX) || snap.text.replace(/\s+/g, " ").trim().slice(0, 160);
  const t = now(deps);
  const id = newId("hca");
  const position = ((await deps.db.select({ m: sql<number>`max(${hcArticles.position})` }).from(hcArticles).where(eq(hcArticles.orgId, a.orgId)).get())?.m ?? 0) + 1;
  await deps.db.insert(hcArticles).values({
    id, orgId: a.orgId, categoryId, docId: input.docId, docVersion: snap.version, slug, title, summary, bodyHtml: snap.html, bodyText: snap.text.slice(0, 100_000),
    status, position, publishedAt: status === "published" ? t : null, createdBy: a.userId, updatedBy: a.userId, createdAt: t, updatedAt: t,
  });
  if (status === "published") await index(deps, a.orgId, "a", id, { title, summary, body: snap.text });
  return getArticle(deps, a, id);
}

export interface ArticlePatch { title?: string; summary?: string; categoryId?: string | null; slug?: string; status?: "draft" | "published"; position?: number }
export async function updateArticle(deps: Deps, a: AuthContext, id: string, p: ArticlePatch) {
  needAdmin(a);
  const r = await articleRow(deps, a.orgId, id);
  const set: Partial<ArticleRow> = { updatedAt: now(deps), updatedBy: a.userId };
  if (p.title !== undefined) { const t = p.title.replace(/\s+/g, " ").trim().slice(0, HC_TITLE_MAX); if (!t) throw badRequest("Give the article a title."); set.title = t; }
  if (p.summary !== undefined) set.summary = p.summary.replace(/\s+/g, " ").trim().slice(0, HC_SUMMARY_MAX);
  if (p.categoryId !== undefined) set.categoryId = await categoryOk(deps, a.orgId, p.categoryId);
  if (p.position !== undefined && Number.isFinite(p.position)) set.position = p.position;
  if (p.slug !== undefined && p.slug !== r.slug) {
    const s = p.slug.trim().toLowerCase();
    if (!slugOk(s)) throw badRequest("Use lowercase letters, numbers and single hyphens in the address.");
    const other = await deps.db.select({ id: hcArticles.id }).from(hcArticles).where(and(eq(hcArticles.orgId, a.orgId), eq(hcArticles.slug, s))).get();
    if (other) throw conflict("Another article uses that address.");
    set.slug = s;
  }
  if (p.status !== undefined && p.status !== r.status) { set.status = p.status; if (p.status === "published") set.publishedAt = now(deps); }
  await deps.db.update(hcArticles).set(set).where(and(eq(hcArticles.id, id), eq(hcArticles.orgId, a.orgId)));
  const next = await articleRow(deps, a.orgId, id);
  if (next.status === "published") await index(deps, a.orgId, "a", id, { title: next.title, summary: next.summary, body: next.bodyText });
  else await unindex(deps, a.orgId, id);
  return getArticle(deps, a, id);
}

/** Copies the doc as it is now into the public page (the only way a doc edit reaches visitors). */
export async function refreshArticle(deps: Deps, a: AuthContext, id: string) {
  needAdmin(a);
  const r = await articleRow(deps, a.orgId, id);
  if (!r.docId) throw badRequest("This article did not come from a doc.");
  const snap = await snapshotOfDoc(deps, a.orgId, r.docId);
  await deps.db.update(hcArticles).set({ bodyHtml: snap.html, bodyText: snap.text.slice(0, 100_000), docVersion: snap.version, updatedAt: now(deps), updatedBy: a.userId })
    .where(and(eq(hcArticles.id, id), eq(hcArticles.orgId, a.orgId)));
  if (r.status === "published") await index(deps, a.orgId, "a", id, { title: r.title, summary: r.summary, body: snap.text });
  return getArticle(deps, a, id);
}

export async function deleteArticle(deps: Deps, a: AuthContext, id: string) {
  needAdmin(a);
  await articleRow(deps, a.orgId, id);
  await unindex(deps, a.orgId, id);
  await deps.db.delete(hcVotes).where(and(eq(hcVotes.kind, "f"), eq(hcVotes.itemId, id), eq(hcVotes.orgId, a.orgId)));
  await deps.db.delete(hcArticles).where(and(eq(hcArticles.id, id), eq(hcArticles.orgId, a.orgId)));
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Questions and answers (team)
// ---------------------------------------------------------------------------------------------------------------

function presentQuestion(q: QuestionRow) {
  return {
    id: q.id, title: q.title, body: q.body, authorName: q.authorName, source: q.source, ticketId: q.ticketId, status: q.status, votes: q.votes,
    answerCount: q.answerCount, acceptedAnswerId: q.acceptedAnswerId, categoryId: q.categoryId, createdAt: q.createdAt, publishedAt: q.publishedAt,
  };
}

export async function listQuestions(deps: Deps, a: AuthContext, status?: PostStatus) {
  const rows = await deps.db.select().from(hcQuestions).where(and(eq(hcQuestions.orgId, a.orgId), status ? eq(hcQuestions.status, status) : undefined))
    .orderBy(desc(hcQuestions.createdAt)).limit(200);
  const ids = rows.map((r) => r.id);
  const waiting = ids.length ? await deps.db.select({ q: hcAnswers.questionId, n: sql<number>`count(*)` }).from(hcAnswers)
    .where(and(eq(hcAnswers.orgId, a.orgId), eq(hcAnswers.status, "pending"), inIds(hcAnswers.questionId, ids))).groupBy(hcAnswers.questionId) : [];
  const w = new Map(waiting.map((x) => [x.q, x.n]));
  return rows.map((r) => ({ ...presentQuestion(r), waitingAnswers: w.get(r.id) ?? 0 }));
}

async function questionRow(deps: Deps, orgId: string, id: string) {
  const q = await deps.db.select().from(hcQuestions).where(and(eq(hcQuestions.id, id), eq(hcQuestions.orgId, orgId))).get();
  if (!q) throw notFound("Question");
  return q;
}

export async function getQuestion(deps: Deps, a: AuthContext, id: string) {
  const q = await questionRow(deps, a.orgId, id);
  const answers = await deps.db.select().from(hcAnswers).where(and(eq(hcAnswers.questionId, id), eq(hcAnswers.orgId, a.orgId))).orderBy(asc(hcAnswers.createdAt)).limit(200);
  const s = await settingsRow(deps, a.orgId);
  return {
    ...presentQuestion(q), url: s ? `${centerUrl(deps, s.slug)}/q/${q.id}` : null,
    answers: answers.map((x) => ({ id: x.id, body: x.body, authorKind: x.authorKind, authorName: x.authorName, status: x.status, votes: x.votes, createdAt: x.createdAt, accepted: q.acceptedAnswerId === x.id })),
  };
}

async function recount(deps: Deps, orgId: string, qid: string) {
  const n = (await deps.db.select({ n: sql<number>`count(*)` }).from(hcAnswers).where(and(eq(hcAnswers.questionId, qid), eq(hcAnswers.orgId, orgId), eq(hcAnswers.status, "published"))).get())?.n ?? 0;
  await deps.db.update(hcQuestions).set({ answerCount: n }).where(and(eq(hcQuestions.id, qid), eq(hcQuestions.orgId, orgId)));
}

async function reindexQuestion(deps: Deps, orgId: string, qid: string) {
  const q = await questionRow(deps, orgId, qid);
  if (q.status !== "published") return unindex(deps, orgId, qid);
  const acc = q.acceptedAnswerId ? await deps.db.select({ body: hcAnswers.body }).from(hcAnswers).where(and(eq(hcAnswers.id, q.acceptedAnswerId), eq(hcAnswers.orgId, orgId), eq(hcAnswers.status, "published"))).get() : undefined;
  await index(deps, orgId, "q", qid, { title: q.title, summary: q.body, body: acc?.body });
}

export async function moderateQuestion(deps: Deps, a: AuthContext, id: string, p: { status?: PostStatus; categoryId?: string | null; title?: string; body?: string }) {
  needAdmin(a);
  const q = await questionRow(deps, a.orgId, id);
  const set: Partial<QuestionRow> = { updatedAt: now(deps) };
  if (p.status && p.status !== q.status) { set.status = p.status; if (p.status === "published" && !q.publishedAt) set.publishedAt = now(deps); }
  if (p.categoryId !== undefined) set.categoryId = await categoryOk(deps, a.orgId, p.categoryId);
  if (p.title !== undefined) { const t = cleanPost(p.title, HC_TITLE_MAX).replace(/\s+/g, " "); if (!t) throw badRequest("A question needs a title."); set.title = t; }
  if (p.body !== undefined) set.body = cleanPost(p.body, HC_QUESTION_MAX);
  await deps.db.update(hcQuestions).set(set).where(and(eq(hcQuestions.id, id), eq(hcQuestions.orgId, a.orgId)));
  await reindexQuestion(deps, a.orgId, id);
  return getQuestion(deps, a, id);
}

export async function deleteQuestion(deps: Deps, a: AuthContext, id: string) {
  needAdmin(a);
  await questionRow(deps, a.orgId, id);
  await unindex(deps, a.orgId, id);
  await deps.db.delete(hcQuestions).where(and(eq(hcQuestions.id, id), eq(hcQuestions.orgId, a.orgId)));
  return { ok: true };
}

/** A team answer is live at once (any team member may answer); it shows once its question is live. */
export async function teamAnswer(deps: Deps, a: AuthContext, qid: string, body: string) {
  await questionRow(deps, a.orgId, qid);
  const text = cleanPost(body, HC_ANSWER_MAX);
  if (text.length < 2) throw badRequest("Write an answer first.");
  const t = now(deps);
  await deps.db.insert(hcAnswers).values({ id: newId("hcn"), orgId: a.orgId, questionId: qid, body: text, authorKind: "team", authorUserId: a.userId, authorName: a.name.slice(0, HC_AUTHOR_MAX), status: "published", createdAt: t, updatedAt: t });
  await recount(deps, a.orgId, qid);
  return getQuestion(deps, a, qid);
}

export async function moderateAnswer(deps: Deps, a: AuthContext, id: string, status: PostStatus) {
  needAdmin(a);
  const x = await deps.db.select().from(hcAnswers).where(and(eq(hcAnswers.id, id), eq(hcAnswers.orgId, a.orgId))).get();
  if (!x) throw notFound("Answer");
  await deps.db.update(hcAnswers).set({ status, updatedAt: now(deps) }).where(and(eq(hcAnswers.id, id), eq(hcAnswers.orgId, a.orgId)));
  if (status !== "published") await deps.db.update(hcQuestions).set({ acceptedAnswerId: null }).where(and(eq(hcQuestions.id, x.questionId), eq(hcQuestions.orgId, a.orgId), eq(hcQuestions.acceptedAnswerId, id)));
  await recount(deps, a.orgId, x.questionId);
  await reindexQuestion(deps, a.orgId, x.questionId);
  return getQuestion(deps, a, x.questionId);
}

export async function acceptAnswer(deps: Deps, a: AuthContext, qid: string, answerId: string | null) {
  needAdmin(a);
  await questionRow(deps, a.orgId, qid);
  if (answerId) {
    const x = await deps.db.select({ status: hcAnswers.status }).from(hcAnswers).where(and(eq(hcAnswers.id, answerId), eq(hcAnswers.questionId, qid), eq(hcAnswers.orgId, a.orgId))).get();
    if (!x) throw notFound("Answer");
    if (x.status !== "published") throw badRequest("Approve the answer before you mark it as the best one.");
  }
  await deps.db.update(hcQuestions).set({ acceptedAnswerId: answerId, updatedAt: now(deps) }).where(and(eq(hcQuestions.id, qid), eq(hcQuestions.orgId, a.orgId)));
  await reindexQuestion(deps, a.orgId, qid);
  return getQuestion(deps, a, qid);
}

export async function listFeedback(deps: Deps, a: AuthContext) {
  const rows = await deps.db.select({ id: hcFeedback.id, helpful: hcFeedback.helpful, comment: hcFeedback.comment, createdAt: hcFeedback.createdAt, articleId: hcFeedback.articleId, title: hcArticles.title })
    .from(hcFeedback).innerJoin(hcArticles, eq(hcArticles.id, hcFeedback.articleId)).where(eq(hcFeedback.orgId, a.orgId)).orderBy(desc(hcFeedback.createdAt)).limit(100);
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// A solved ticket to a public answer
// ---------------------------------------------------------------------------------------------------------------

async function ticketParts(deps: Deps, a: AuthContext, ticketId: string) {
  const t = await deps.db.select().from(hdTickets).where(and(eq(hdTickets.id, ticketId), eq(hdTickets.orgId, a.orgId))).get();
  if (!t) throw notFound("Ticket");
  // Access follows the ticket (mailbox scope): the helpdesk service throws for a ticket this person cannot open.
  const { getTicket } = await import("./helpdesk");
  await getTicket(deps, a, ticketId);
  if (t.status !== "solved") throw badRequest("Solve the ticket first, then publish the answer.");
  const email = (t.requesterEmail ?? "").toLowerCase();
  let customer: string[] = [], team: string[] = [];
  const extraNames: string[] = [], extraEmails: string[] = [];
  if (t.kind === "mail") {
    // PRIV1b (P15): a thread can hold a personal mailbox's copy (References join it org wide). Its drafts, replies and
    // mail never become a public answer: team mailboxes only, and never a draft or trashed message.
    const rows = await deps.db.select({ from: messages.fromAddress, fromName: messages.fromName, folder: messages.folder, text: messages.text, date: messages.date }).from(messages)
      .innerJoin(mailboxes, and(eq(mailboxes.id, messages.mailboxId), eq(mailboxes.personal, false)))
      .where(and(eq(messages.orgId, a.orgId), eq(messages.threadId, t.refId), notInArray(messages.folder, ["drafts", "trash"]))).orderBy(asc(messages.date)).limit(60);
    for (const m of rows) {
      const isCustomer = m.folder !== "sent" && (!email || (m.from ?? "").toLowerCase() === email);
      (isCustomer ? customer : team).push(m.text ?? "");
      if (isCustomer) { if (m.fromName) extraNames.push(m.fromName); if (m.from) extraEmails.push(m.from); }
    }
  } else if (t.kind === "web") {
    const rows = await deps.db.select({ author: hdWebMessages.author, text: hdWebMessages.text }).from(hdWebMessages)
      .where(and(eq(hdWebMessages.ticketId, t.id), eq(hdWebMessages.orgId, a.orgId))).orderBy(asc(hdWebMessages.createdAt)).limit(200);
    // Internal notes, system lines and bot replies never leave: only the visitor's words and the team's replies.
    for (const m of rows) { if (m.author === "visitor") customer.push(m.text); else if (m.author === "agent") team.push(m.text); }
  } else throw badRequest("Only email and website chat tickets can become public answers for now.");
  customer = customer.filter((s) => s.trim()); team = team.filter((s) => s.trim());
  const bits = { names: [t.requesterName, ...extraNames].filter(Boolean), emails: [t.requesterEmail ?? "", ...extraEmails].filter(Boolean) };
  return { t, customer, team, bits };
}

export async function ticketPreview(deps: Deps, a: AuthContext, ticketId: string) {
  const { t, customer, team, bits } = await ticketParts(deps, a, ticketId);
  if (!team.length) throw badRequest("This ticket has no reply from the team to publish.");
  const title = redactForPublic(t.subject || "", bits);
  const question = redactForPublic(customer[0] ?? t.snippet ?? "", bits);
  const answer = redactForPublic(team[team.length - 1], bits);
  const removed = { emails: 0, phones: 0, names: 0, quoted: 0 };
  for (const r of [title, question, answer]) for (const k of Object.keys(removed) as (keyof typeof removed)[]) removed[k] += r.removed[k];
  const existing = await deps.db.select({ id: hcQuestions.id, status: hcQuestions.status }).from(hcQuestions).where(and(eq(hcQuestions.orgId, a.orgId), eq(hcQuestions.ticketId, ticketId))).get();
  return {
    ticketId, number: t.number, kind: t.kind, title: title.text.slice(0, HC_TITLE_MAX), question: question.text.slice(0, HC_QUESTION_MAX), answer: answer.text.slice(0, HC_ANSWER_MAX),
    removed, canPublish: isAdmin(a), alreadyPublished: existing ? { id: existing.id, status: existing.status } : null,
  };
}

export interface PublishTicketInput { ticketId: string; title: string; question: string; answer: string; categoryId?: string | null; keepPrivate?: boolean }
/** Admins publish at once; anyone else sends it to the moderation queue. Refuses text that still names the customer unless Keep is ticked. */
export async function publishTicket(deps: Deps, a: AuthContext, input: PublishTicketInput) {
  await needCenter(deps, a.orgId);
  const { bits } = await ticketParts(deps, a, input.ticketId);
  const title = cleanPost(input.title, HC_TITLE_MAX).replace(/\s+/g, " ");
  const body = cleanPost(input.question, HC_QUESTION_MAX);
  const answer = cleanPost(input.answer, HC_ANSWER_MAX);
  if (!title) throw badRequest("Give the question a title.");
  if (answer.length < 2) throw badRequest("The answer is empty.");
  if (!input.keepPrivate && [title, body, answer].some((s) => stillPrivate(s, bits))) {
    throw badRequest("The text still has the customer's name or email. Remove it, or tick Keep their details to publish it on purpose.");
  }
  const dup = await deps.db.select({ id: hcQuestions.id }).from(hcQuestions).where(and(eq(hcQuestions.orgId, a.orgId), eq(hcQuestions.ticketId, input.ticketId))).get();
  if (dup) throw conflict("This ticket is already in the help center.");
  const categoryId = await categoryOk(deps, a.orgId, input.categoryId);
  const t = now(deps);
  const qid = newId("hcq");
  const status: PostStatus = isAdmin(a) ? "published" : "pending";
  await deps.db.insert(hcQuestions).values({ id: qid, orgId: a.orgId, categoryId, title, body, authorName: "", source: "ticket", ticketId: input.ticketId, status, publishedAt: status === "published" ? t : null, createdAt: t, updatedAt: t });
  const aid = newId("hcn");
  await deps.db.insert(hcAnswers).values({ id: aid, orgId: a.orgId, questionId: qid, body: answer, authorKind: "team", authorUserId: a.userId, authorName: a.name.slice(0, HC_AUTHOR_MAX), status: "published", createdAt: t, updatedAt: t });
  await deps.db.update(hcQuestions).set({ acceptedAnswerId: aid, answerCount: 1 }).where(and(eq(hcQuestions.id, qid), eq(hcQuestions.orgId, a.orgId)));
  await reindexQuestion(deps, a.orgId, qid);
  return getQuestion(deps, a, qid);
}

// ---------------------------------------------------------------------------------------------------------------
// Public side. Every function takes a live center (centerBySlug) and reads published rows of that workspace only.
// ---------------------------------------------------------------------------------------------------------------

export interface LiveCenter { orgId: string; orgName: string; s: HelpCenterSettings }

export async function centerBySlug(deps: Deps, slug: string): Promise<LiveCenter | null> {
  if (!slugOk(slug)) return null;
  let hit = bySlug.get(slug);
  if (hit === undefined) {
    const s = await deps.db.select().from(hcSettings).where(eq(hcSettings.slug, slug)).get();
    const org = s ? await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, s.orgId)).get() : undefined;
    hit = s && org ? { s, orgName: org.name } : null;
    bySlug.set(slug, hit);
  }
  if (!hit || !hit.s.on) return null;
  return { orgId: hit.s.orgId, orgName: hit.orgName, s: present(hit.s) };
}

const pubArticle = (c: LiveCenter) => and(eq(hcArticles.orgId, c.orgId), eq(hcArticles.status, "published"));
const pubQuestion = (c: LiveCenter) => and(eq(hcQuestions.orgId, c.orgId), eq(hcQuestions.status, "published"));
const articleCard = (r: Pick<ArticleRow, "slug" | "title" | "summary" | "categoryId">) => ({ slug: r.slug, title: r.title, summary: r.summary, categoryId: r.categoryId });

export async function publicHome(deps: Deps, c: LiveCenter) {
  const cats = (await listCategories(deps, c.orgId)).filter((x) => x.articles > 0);
  const popular = await deps.db.select({ slug: hcArticles.slug, title: hcArticles.title, summary: hcArticles.summary, categoryId: hcArticles.categoryId }).from(hcArticles)
    .where(pubArticle(c)).orderBy(desc(hcArticles.views), asc(hcArticles.position)).limit(6);
  const questions = c.s.qaOn ? await deps.db.select({ id: hcQuestions.id, title: hcQuestions.title, votes: hcQuestions.votes, answerCount: hcQuestions.answerCount, accepted: hcQuestions.acceptedAnswerId })
    .from(hcQuestions).where(pubQuestion(c)).orderBy(desc(hcQuestions.publishedAt)).limit(5) : [];
  return { categories: cats, popular: popular.map(articleCard), questions };
}

export async function publicCategory(deps: Deps, c: LiveCenter, slug: string, page: number) {
  const cat = await deps.db.select().from(hcCategories).where(and(eq(hcCategories.orgId, c.orgId), eq(hcCategories.slug, slug))).get();
  if (!cat) return null;
  const rows = await deps.db.select({ slug: hcArticles.slug, title: hcArticles.title, summary: hcArticles.summary, categoryId: hcArticles.categoryId }).from(hcArticles)
    .where(and(pubArticle(c), eq(hcArticles.categoryId, cat.id))).orderBy(asc(hcArticles.position)).limit(HC_PAGE_SIZE + 1).offset((page - 1) * HC_PAGE_SIZE);
  if (!rows.length && page === 1) return null; // an empty category is not a public page
  return { category: { name: cat.name, slug: cat.slug, description: cat.description }, articles: rows.slice(0, HC_PAGE_SIZE).map(articleCard), more: rows.length > HC_PAGE_SIZE };
}

export async function publicArticle(deps: Deps, c: LiveCenter, slug: string) {
  const r = await deps.db.select().from(hcArticles).where(and(pubArticle(c), eq(hcArticles.slug, slug))).get();
  if (!r) return null;
  const cat = r.categoryId ? await deps.db.select({ name: hcCategories.name, slug: hcCategories.slug }).from(hcCategories).where(and(eq(hcCategories.id, r.categoryId), eq(hcCategories.orgId, c.orgId))).get() : undefined;
  const related = r.categoryId ? await deps.db.select({ slug: hcArticles.slug, title: hcArticles.title, summary: hcArticles.summary, categoryId: hcArticles.categoryId }).from(hcArticles)
    .where(and(pubArticle(c), eq(hcArticles.categoryId, r.categoryId))).orderBy(asc(hcArticles.position)).limit(6) : [];
  return {
    id: r.id, slug: r.slug, title: r.title, summary: r.summary, bodyHtml: r.bodyHtml, updatedAt: r.updatedAt, publishedAt: r.publishedAt,
    category: cat ?? null, related: related.filter((x) => x.slug !== r.slug).slice(0, 5).map(articleCard),
  };
}

export async function countView(deps: Deps, c: LiveCenter, articleId: string) {
  await deps.db.update(hcArticles).set({ views: sql`${hcArticles.views} + 1` }).where(and(eq(hcArticles.id, articleId), eq(hcArticles.orgId, c.orgId)));
}

export interface SearchHit { kind: "article" | "question"; title: string; path: string; snippet: string }
function snippet(text: string, terms: string[]) {
  const flat = text.replace(/\s+/g, " ").trim();
  const low = flat.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = Math.max(0, at - 60);
  return (start > 0 ? "..." : "") + flat.slice(start, start + 180) + (flat.length > start + 180 ? "..." : "");
}

export async function publicSearch(deps: Deps, c: LiveCenter, q: string, page: number): Promise<{ hits: SearchHit[]; more: boolean; terms: string[] }> {
  const terms = queryTerms(q);
  if (!terms.length) return { hits: [], more: false, terms };
  const range = (t: string) => sql`(${hcTerms.term} >= ${t} AND ${hcTerms.term} < ${prefixEnd(t)})`;
  const hits = sql.join(terms.map((t) => sql`MAX(CASE WHEN ${range(t)} THEN 1 ELSE 0 END)`), sql` + `);
  const rows = await deps.db.select({ kind: hcTerms.kind, itemId: hcTerms.itemId, hits: sql<number>`${hits}`, score: sql<number>`sum(${hcTerms.weight})` }).from(hcTerms)
    .where(and(eq(hcTerms.orgId, c.orgId), c.s.qaOn ? inArray(hcTerms.kind, ["a", "q"]) : eq(hcTerms.kind, "a"), or(...terms.map(range)) as SQL))
    .groupBy(hcTerms.kind, hcTerms.itemId).orderBy(desc(sql`${hits}`), desc(sql`sum(${hcTerms.weight})`)).limit(HC_PAGE_SIZE + 1).offset((page - 1) * HC_PAGE_SIZE);
  const page1 = rows.slice(0, HC_PAGE_SIZE);
  const aIds = page1.filter((r) => r.kind === "a").map((r) => r.itemId), qIds = page1.filter((r) => r.kind === "q").map((r) => r.itemId);
  const arts = aIds.length ? await deps.db.select({ id: hcArticles.id, slug: hcArticles.slug, title: hcArticles.title, summary: hcArticles.summary, text: hcArticles.bodyText }).from(hcArticles).where(and(pubArticle(c), inIds(hcArticles.id, aIds))) : [];
  const qs = qIds.length ? await deps.db.select({ id: hcQuestions.id, title: hcQuestions.title, body: hcQuestions.body }).from(hcQuestions).where(and(pubQuestion(c), inIds(hcQuestions.id, qIds))) : [];
  const am = new Map(arts.map((x) => [x.id, x])), qm = new Map(qs.map((x) => [x.id, x]));
  const out: SearchHit[] = [];
  for (const r of page1) {
    if (r.kind === "a") { const x = am.get(r.itemId); if (x) out.push({ kind: "article", title: x.title, path: `a/${x.slug}`, snippet: x.summary || snippet(x.text, terms) }); }
    else { const x = qm.get(r.itemId); if (x) out.push({ kind: "question", title: x.title, path: `q/${x.id}`, snippet: snippet(x.body, terms) }); }
  }
  return { hits: out, more: rows.length > HC_PAGE_SIZE, terms };
}

/** Up to 3 live articles for the website chat (before a visitor starts a chat). */
export async function suggestArticles(deps: Deps, orgId: string, q: string) {
  const s = await settingsRow(deps, orgId);
  if (!s?.on || !s.suggestInChat) return [];
  const c: LiveCenter = { orgId, orgName: "", s: { ...present(s), qaOn: false } };
  const r = await publicSearch(deps, c, q, 1);
  return r.hits.slice(0, 3).map((h) => ({ title: h.title, url: `${centerUrl(deps, s.slug)}/${h.path}` }));
}

export async function publicQuestions(deps: Deps, c: LiveCenter, sort: "top" | "new", page: number) {
  const rows = await deps.db.select({ id: hcQuestions.id, title: hcQuestions.title, votes: hcQuestions.votes, answerCount: hcQuestions.answerCount, accepted: hcQuestions.acceptedAnswerId, publishedAt: hcQuestions.publishedAt })
    .from(hcQuestions).where(pubQuestion(c)).orderBy(...(sort === "top" ? [desc(hcQuestions.votes), desc(hcQuestions.publishedAt)] : [desc(hcQuestions.publishedAt)]))
    .limit(HC_PAGE_SIZE + 1).offset((page - 1) * HC_PAGE_SIZE);
  return { questions: rows.slice(0, HC_PAGE_SIZE), more: rows.length > HC_PAGE_SIZE };
}

export async function publicQuestion(deps: Deps, c: LiveCenter, id: string) {
  if (!/^[a-z0-9_-]{4,64}$/i.test(id)) return null;
  const q = await deps.db.select().from(hcQuestions).where(and(pubQuestion(c), eq(hcQuestions.id, id))).get();
  if (!q) return null;
  const answers = await deps.db.select({ id: hcAnswers.id, body: hcAnswers.body, authorKind: hcAnswers.authorKind, authorName: hcAnswers.authorName, votes: hcAnswers.votes, createdAt: hcAnswers.createdAt })
    .from(hcAnswers).where(and(eq(hcAnswers.questionId, q.id), eq(hcAnswers.orgId, c.orgId), eq(hcAnswers.status, "published"))).orderBy(desc(hcAnswers.votes), asc(hcAnswers.createdAt)).limit(100);
  const sorted = [...answers.filter((x) => x.id === q.acceptedAnswerId), ...answers.filter((x) => x.id !== q.acceptedAnswerId)];
  return { id: q.id, title: q.title, body: q.body, authorName: q.authorName, votes: q.votes, publishedAt: q.publishedAt, acceptedAnswerId: q.acceptedAnswerId, answers: sorted };
}

export async function visitorOf(deps: Deps, orgId: string, ip: string, ua: string | undefined) {
  return (await hmacSha256Hex(deps.config.appSecret, `r122v:${orgId}:${ip}:${(ua ?? "").slice(0, 200)}`)).slice(0, 24);
}

const DAY = 86_400_000;
async function visitorPostsToday(deps: Deps, c: LiveCenter, visitor: string) {
  const since = now(deps) - DAY;
  const q = (await deps.db.select({ n: sql<number>`count(*)` }).from(hcQuestions).where(and(eq(hcQuestions.orgId, c.orgId), eq(hcQuestions.visitorHash, visitor), gte(hcQuestions.createdAt, since))).get())?.n ?? 0;
  const a = (await deps.db.select({ n: sql<number>`count(*)` }).from(hcAnswers).where(and(eq(hcAnswers.orgId, c.orgId), eq(hcAnswers.visitorHash, visitor), gte(hcAnswers.createdAt, since))).get())?.n ?? 0;
  return q + a;
}
async function queueFull(deps: Deps, c: LiveCenter) {
  const n = (await deps.db.select({ n: sql<number>`count(*)` }).from(hcQuestions).where(and(eq(hcQuestions.orgId, c.orgId), eq(hcQuestions.status, "pending"))).get())?.n ?? 0;
  return n >= 500;
}

export const VISITOR_POSTS_PER_DAY = 5;
/** A visitor's question: waits for the team unless the workspace turned moderation off (and it does not look like spam). */
export async function askQuestion(deps: Deps, c: LiveCenter, visitor: string, input: { title: unknown; body: unknown; name: unknown }) {
  if (!c.s.qaOn) throw notFound("Page");
  const title = cleanPost(input.title, HC_TITLE_MAX).replace(/\s+/g, " ");
  const body = cleanPost(input.body, HC_QUESTION_MAX);
  const name = cleanPost(input.name, HC_AUTHOR_MAX).replace(/\s+/g, " ");
  if (title.length < 8) throw badRequest("Write your question in a few more words.");
  if ((await visitorPostsToday(deps, c, visitor)) >= VISITOR_POSTS_PER_DAY || (await queueFull(deps, c))) throw tooMany("You have posted a lot today. Try again tomorrow.");
  const live = !c.s.moderate && !looksLikeSpam(`${title}\n${body}`);
  const t = now(deps);
  const id = newId("hcq");
  await deps.db.insert(hcQuestions).values({ id, orgId: c.orgId, title, body, authorName: name, source: "public", status: live ? "published" : "pending", visitorHash: visitor, publishedAt: live ? t : null, createdAt: t, updatedAt: t });
  if (live) await index(deps, c.orgId, "q", id, { title, summary: body });
  return { id, live };
}

export async function answerQuestion(deps: Deps, c: LiveCenter, visitor: string, qid: string, input: { body: unknown; name: unknown }) {
  if (!c.s.qaOn) throw notFound("Page");
  const q = await deps.db.select({ id: hcQuestions.id }).from(hcQuestions).where(and(pubQuestion(c), eq(hcQuestions.id, qid))).get();
  if (!q) throw notFound("Question");
  const body = cleanPost(input.body, HC_ANSWER_MAX);
  const name = cleanPost(input.name, HC_AUTHOR_MAX).replace(/\s+/g, " ");
  if (body.length < 10) throw badRequest("Write your answer in a few more words.");
  if ((await visitorPostsToday(deps, c, visitor)) >= VISITOR_POSTS_PER_DAY || (await queueFull(deps, c))) throw tooMany("You have posted a lot today. Try again tomorrow.");
  const live = !c.s.moderate && !looksLikeSpam(body);
  const t = now(deps);
  await deps.db.insert(hcAnswers).values({ id: newId("hcn"), orgId: c.orgId, questionId: qid, body, authorKind: "visitor", authorName: name, status: live ? "published" : "pending", visitorHash: visitor, createdAt: t, updatedAt: t });
  if (live) await recount(deps, c.orgId, qid);
  return { live };
}

/** One up vote per visitor per question or answer; a second vote changes nothing. */
export async function vote(deps: Deps, c: LiveCenter, visitor: string, kind: "q" | "a", id: string) {
  if (!c.s.qaOn) throw notFound("Page");
  let qid: string;
  if (kind === "q") {
    const q = await deps.db.select({ id: hcQuestions.id }).from(hcQuestions).where(and(pubQuestion(c), eq(hcQuestions.id, id))).get();
    if (!q) throw notFound("Question");
    qid = q.id;
  } else {
    const x = await deps.db.select({ q: hcAnswers.questionId }).from(hcAnswers).innerJoin(hcQuestions, eq(hcQuestions.id, hcAnswers.questionId))
      .where(and(eq(hcAnswers.id, id), eq(hcAnswers.orgId, c.orgId), eq(hcAnswers.status, "published"), eq(hcQuestions.status, "published"))).get();
    if (!x) throw notFound("Answer");
    qid = x.q;
  }
  const res = await deps.db.insert(hcVotes).values({ orgId: c.orgId, kind, itemId: id, voterHash: visitor, value: 1, createdAt: now(deps) }).onConflictDoNothing().returning({ k: hcVotes.kind });
  if (res.length) {
    if (kind === "q") await deps.db.update(hcQuestions).set({ votes: sql`${hcQuestions.votes} + 1` }).where(and(eq(hcQuestions.id, id), eq(hcQuestions.orgId, c.orgId)));
    else await deps.db.update(hcAnswers).set({ votes: sql`${hcAnswers.votes} + 1` }).where(and(eq(hcAnswers.id, id), eq(hcAnswers.orgId, c.orgId)));
  }
  return { questionId: qid, counted: res.length > 0 };
}

/** Was this helpful: counted once per visitor; a comment is kept for the team only. */
export async function articleFeedback(deps: Deps, c: LiveCenter, visitor: string, slug: string, helpful: boolean, comment: unknown) {
  const r = await deps.db.select({ id: hcArticles.id }).from(hcArticles).where(and(pubArticle(c), eq(hcArticles.slug, slug))).get();
  if (!r) throw notFound("Article");
  const res = await deps.db.insert(hcVotes).values({ orgId: c.orgId, kind: "f", itemId: r.id, voterHash: visitor, value: helpful ? 1 : -1, createdAt: now(deps) }).onConflictDoNothing().returning({ k: hcVotes.kind });
  if (!res.length) return { counted: false };
  await deps.db.update(hcArticles).set(helpful ? { helpfulYes: sql`${hcArticles.helpfulYes} + 1` } : { helpfulNo: sql`${hcArticles.helpfulNo} + 1` }).where(and(eq(hcArticles.id, r.id), eq(hcArticles.orgId, c.orgId)));
  const text = cleanPost(comment, HC_COMMENT_MAX);
  await deps.db.insert(hcFeedback).values({ id: newId("hcf"), orgId: c.orgId, articleId: r.id, helpful, comment: text || null, createdAt: now(deps) });
  return { counted: true };
}

export async function sitemap(deps: Deps, c: LiveCenter) {
  const arts = await deps.db.select({ slug: hcArticles.slug, updatedAt: hcArticles.updatedAt }).from(hcArticles).where(pubArticle(c)).orderBy(desc(hcArticles.updatedAt)).limit(2000);
  const qs = c.s.qaOn ? await deps.db.select({ id: hcQuestions.id, updatedAt: hcQuestions.updatedAt }).from(hcQuestions).where(pubQuestion(c)).orderBy(desc(hcQuestions.updatedAt)).limit(2000) : [];
  const cats = (await listCategories(deps, c.orgId)).filter((x) => x.articles > 0);
  return { arts, qs, cats };
}


