/**
 * R93 feedback boards: ideas with votes, statuses and a roadmap, public at /fb/<slug> or for members only.
 * One vote per person per post (members by account, visitors by email), kept as vote_count on the post so lists sort
 * without counting. Merging a duplicate moves its votes over without counting anyone twice.
 */
import { and, asc, desc, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { inIds } from "../../lib/sql-chunks";
import type { Deps } from "../../context";
import { feedbackBoards, feedbackPosts, feedbackVotes, organizations } from "../../db/schema";
import { hmacSha256Hex, randomToken, sha256Hex, safeEqual } from "../../lib/crypto";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { containsAny, likePattern, textMatches } from "../../lib/like-search";
import { sortableId, type SuiteActor } from "../suite/common";
import { canManage, formsPlusOn, requireFormsPlus } from "./plus";
import { isEmail, normEmail, PUBLIC_STATUSES, ROADMAP_COLUMNS, SETTABLE_STATUSES, STATUS_LABELS, type PostStatus } from "@/shared/forms-plus";

type Board = typeof feedbackBoards.$inferSelect;
type Post = typeof feedbackPosts.$inferSelect;
export const PAGE = 50;

const slugOf = (name: string) => `${name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "feedback"}-${randomToken(6).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6)}`;

function presentBoard(b: Board, origin: string, counts?: { posts: number; pending: number }) {
  return {
    id: b.id, name: b.name, description: b.description, slug: b.slug, url: `${origin}/fb/${b.slug}`, isPublic: b.isPublic, allowIdeas: b.allowIdeas, moderate: b.moderate,
    createdBy: b.createdBy, archived: !!b.archivedAt, createdAt: b.createdAt.toISOString(), posts: counts?.posts ?? 0, pending: counts?.pending ?? 0,
  };
}

/** What anyone may see of a post: never an email or an IP hash. */
function presentPost(p: Post, opts: { voted?: boolean; member?: boolean } = {}) {
  return {
    id: p.id, boardId: p.boardId, title: p.title, body: p.body, status: p.status as PostStatus, statusLabel: STATUS_LABELS[p.status as PostStatus],
    author: p.authorName.split(" ")[0] || "Someone", votes: p.voteCount, mergedIntoId: p.mergedIntoId, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
    voted: !!opts.voted, ...(opts.member ? { authorName: p.authorName, authorEmail: p.authorEmail ?? null } : {}),
  };
}

async function boardRow(deps: Deps, orgId: string, id: string) {
  const b = await deps.db.select().from(feedbackBoards).where(and(eq(feedbackBoards.id, id), eq(feedbackBoards.orgId, orgId))).get();
  if (!b) throw notFound("Board");
  return b;
}

async function managedBoard(deps: Deps, actor: SuiteActor, id: string) {
  await requireFormsPlus(deps, actor.orgId);
  const b = await boardRow(deps, actor.orgId, id);
  if (!canManage(actor, b.createdBy)) throw forbidden("Only workspace admins and the person who made this board can change it.");
  return b;
}

export async function listBoards(deps: Deps, actor: SuiteActor) {
  await requireFormsPlus(deps, actor.orgId);
  const rows = await deps.db.select().from(feedbackBoards).where(and(eq(feedbackBoards.orgId, actor.orgId), isNull(feedbackBoards.archivedAt))).orderBy(desc(feedbackBoards.createdAt)).limit(100).all();
  const counts = rows.length ? await deps.db.select({ b: feedbackPosts.boardId, n: sql<number>`count(*)`, p: sql<number>`sum(case when ${feedbackPosts.status} = 'pending' then 1 else 0 end)` })
    .from(feedbackPosts).where(and(inIds(feedbackPosts.boardId, rows.map((r) => r.id)), ne(feedbackPosts.status, "merged"))).groupBy(feedbackPosts.boardId).all() : [];
  const by = new Map(counts.map((c) => [c.b, { posts: Number(c.n), pending: Number(c.p ?? 0) }]));
  return { boards: rows.map((b) => presentBoard(b, deps.config.appUrl, by.get(b.id))), canCreate: actor.role === "owner" || actor.role === "admin" };
}

export interface BoardInput { name?: string; description?: string; isPublic?: boolean; allowIdeas?: boolean; moderate?: boolean; archived?: boolean }

export async function saveBoard(deps: Deps, actor: SuiteActor, input: BoardInput, id?: string) {
  await requireFormsPlus(deps, actor.orgId);
  const now = deps.now();
  if (!id) {
    if (actor.role !== "owner" && actor.role !== "admin") throw forbidden("Only workspace admins can make a board.");
    const name = (input.name ?? "").trim().slice(0, 120);
    if (!name) throw new HttpError(422, "validation_failed", "Give the board a name.", { field: "name" });
    const row: Board = {
      id: sortableId("fbd", now.getTime()), orgId: actor.orgId, name, description: (input.description ?? "").trim().slice(0, 2000), slug: slugOf(name),
      isPublic: input.isPublic ?? true, allowIdeas: input.allowIdeas ?? true, moderate: input.moderate ?? true, createdBy: actor.userId, archivedAt: null, createdAt: now, updatedAt: now,
    };
    await deps.db.insert(feedbackBoards).values(row);
    return { board: presentBoard(row, deps.config.appUrl) };
  }
  const b = await managedBoard(deps, actor, id);
  const set: Partial<Board> = { updatedAt: now };
  if (input.name !== undefined) { const n = input.name.trim().slice(0, 120); if (!n) throw new HttpError(422, "validation_failed", "Give the board a name.", { field: "name" }); set.name = n; }
  if (input.description !== undefined) set.description = input.description.trim().slice(0, 2000);
  if (input.isPublic !== undefined) set.isPublic = input.isPublic;
  if (input.allowIdeas !== undefined) set.allowIdeas = input.allowIdeas;
  if (input.moderate !== undefined) set.moderate = input.moderate;
  if (input.archived !== undefined) set.archivedAt = input.archived ? now : null;
  await deps.db.update(feedbackBoards).set(set).where(eq(feedbackBoards.id, b.id));
  return { board: presentBoard({ ...b, ...set } as Board, deps.config.appUrl) };
}

export interface PostQuery { sort?: "top" | "new"; status?: string; q?: string; offset?: number }

async function queryPosts(deps: Deps, b: Board, q: PostQuery, statuses: PostStatus[]) {
  const status = q.status && statuses.includes(q.status as PostStatus) ? [q.status as PostStatus] : statuses;
  const query = (q.q ?? "").trim().slice(0, 100);
  const where = [eq(feedbackPosts.boardId, b.id), eq(feedbackPosts.orgId, b.orgId), inIds(feedbackPosts.status, status)];
  if (query) where.push(containsAny([feedbackPosts.title, feedbackPosts.body], query));
  const order = q.sort === "new" ? [desc(feedbackPosts.createdAt), desc(feedbackPosts.id)] : [desc(feedbackPosts.voteCount), desc(feedbackPosts.createdAt), desc(feedbackPosts.id)];
  const offset = Math.max(0, Math.min(10_000, Math.floor(q.offset ?? 0)));
  let rows = await deps.db.select().from(feedbackPosts).where(and(...where)).orderBy(...order).limit(PAGE + 1).offset(offset).all();
  if (query && !likePattern(query).complete) rows = rows.filter((r) => textMatches(`${r.title} ${r.body}`, query));
  return { rows: rows.slice(0, PAGE), more: rows.length > PAGE, offset };
}

/** Members' view in the app: every status but merged; managers also see who wrote each post. */
export async function boardDetail(deps: Deps, actor: SuiteActor, id: string, q: PostQuery) {
  await requireFormsPlus(deps, actor.orgId);
  const b = await boardRow(deps, actor.orgId, id);
  const manage = canManage(actor, b.createdBy);
  const statuses: PostStatus[] = manage ? ["pending", ...PUBLIC_STATUSES] : PUBLIC_STATUSES;
  const { rows, more, offset } = await queryPosts(deps, b, q, statuses);
  const mine = rows.length ? await deps.db.select({ p: feedbackVotes.postId }).from(feedbackVotes).where(and(eq(feedbackVotes.boardId, b.id), eq(feedbackVotes.voterKey, `u:${actor.userId}`), inIds(feedbackVotes.postId, rows.map((r) => r.id)))).all() : [];
  const voted = new Set(mine.map((m) => m.p));
  return { board: presentBoard(b, deps.config.appUrl), canManage: manage, posts: rows.map((r) => presentPost(r, { voted: voted.has(r.id), member: manage })), more, offset };
}

export async function roadmapOf(deps: Deps, b: Board) {
  const rows = await deps.db.select().from(feedbackPosts).where(and(eq(feedbackPosts.boardId, b.id), inIds(feedbackPosts.status, ROADMAP_COLUMNS))).orderBy(desc(feedbackPosts.voteCount), desc(feedbackPosts.updatedAt)).limit(150).all();
  return Object.fromEntries(ROADMAP_COLUMNS.map((s) => [s, rows.filter((r) => r.status === s).slice(0, 50).map((r) => presentPost(r))]));
}

export async function boardRoadmap(deps: Deps, actor: SuiteActor, id: string) {
  await requireFormsPlus(deps, actor.orgId);
  return { roadmap: await roadmapOf(deps, await boardRow(deps, actor.orgId, id)) };
}

// ---------------------------------------------------------------- posts and votes

export const voterKeyForEmail = async (deps: Deps, email: string) => `e:${(await hmacSha256Hex(deps.config.appSecret, `fbv:${normEmail(email)}`)).slice(0, 32)}`;
export const voterKeyForUser = (userId: string) => `u:${userId}`;

export interface Voter { key: string; name: string; email: string | null; userId: string | null }

/** Adds a vote once; a second vote by the same person is a no-op. Returns the vote and, for visitors, a token to take it back. */
export async function addVote(deps: Deps, b: Board, post: Post, voter: Voter, withToken: boolean) {
  if (post.boardId !== b.id) throw notFound("Post");
  if (post.status === "merged" || post.status === "pending") throw new HttpError(422, "validation_failed", "Votes are closed on this post.");
  const now = deps.now();
  const token = withToken ? randomToken(18).replace(/[^A-Za-z0-9]/g, "") : null;
  const id = sortableId("fbv", now.getTime());
  const ins = await deps.db.insert(feedbackVotes).values({
    id, orgId: b.orgId, boardId: b.id, postId: post.id, voterKey: voter.key, voterName: voter.name.slice(0, 120), voterEmail: voter.email, tokenHash: token ? await sha256Hex(token) : null, createdAt: now,
  }).onConflictDoNothing().returning({ id: feedbackVotes.id });
  if (ins.length) await deps.db.update(feedbackPosts).set({ voteCount: sql`${feedbackPosts.voteCount} + 1` }).where(eq(feedbackPosts.id, post.id));
  const cur = await deps.db.select({ n: feedbackPosts.voteCount }).from(feedbackPosts).where(eq(feedbackPosts.id, post.id)).get();
  return { voted: true, already: !ins.length, voteId: ins.length ? id : null, token: ins.length ? token : null, votes: Number(cur?.n ?? 0) };
}

async function removeVoteRow(deps: Deps, postId: string, voteId: string) {
  const del = await deps.db.delete(feedbackVotes).where(and(eq(feedbackVotes.id, voteId), eq(feedbackVotes.postId, postId))).returning({ id: feedbackVotes.id });
  if (del.length) await deps.db.update(feedbackPosts).set({ voteCount: sql`max(${feedbackPosts.voteCount} - 1, 0)` }).where(eq(feedbackPosts.id, postId));
  const cur = await deps.db.select({ n: feedbackPosts.voteCount }).from(feedbackPosts).where(eq(feedbackPosts.id, postId)).get();
  return { voted: false, votes: Number(cur?.n ?? 0) };
}

async function postRow(deps: Deps, orgId: string, id: string) {
  const p = await deps.db.select().from(feedbackPosts).where(and(eq(feedbackPosts.id, id), eq(feedbackPosts.orgId, orgId))).get();
  if (!p) throw notFound("Post");
  return p;
}

export async function memberVote(deps: Deps, actor: SuiteActor, postId: string, on: boolean) {
  await requireFormsPlus(deps, actor.orgId);
  const p = await postRow(deps, actor.orgId, postId);
  const b = await boardRow(deps, actor.orgId, p.boardId);
  const key = voterKeyForUser(actor.userId);
  if (on) return addVote(deps, b, p, { key, name: actor.name, email: actor.email || null, userId: actor.userId }, false);
  const v = await deps.db.select({ id: feedbackVotes.id }).from(feedbackVotes).where(and(eq(feedbackVotes.postId, p.id), eq(feedbackVotes.voterKey, key))).get();
  return v ? removeVoteRow(deps, p.id, v.id) : { voted: false, votes: p.voteCount };
}

export interface PostInput { title?: string; body?: string; status?: string; name?: string; email?: string }

function cleanPost(input: PostInput) {
  const title = (input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (title.length < 3) throw new HttpError(422, "validation_failed", "Give your idea a short title.", { field: "title" });
  return { title, body: (input.body ?? "").trim().slice(0, 5000) };
}

export async function memberPost(deps: Deps, actor: SuiteActor, boardId: string, input: PostInput) {
  await requireFormsPlus(deps, actor.orgId);
  const b = await boardRow(deps, actor.orgId, boardId);
  if (b.archivedAt) throw new HttpError(422, "validation_failed", "This board is archived.");
  const { title, body } = cleanPost(input);
  const now = deps.now();
  const row: Post = { id: sortableId("fbp", now.getTime()), orgId: b.orgId, boardId: b.id, title, body, status: "open", authorName: actor.name || actor.email, authorEmail: actor.email || null, authorUserId: actor.userId, voteCount: 0, mergedIntoId: null, ipHash: null, createdAt: now, updatedAt: now };
  await deps.db.insert(feedbackPosts).values(row);
  const v = await addVote(deps, b, row, { key: voterKeyForUser(actor.userId), name: row.authorName, email: row.authorEmail, userId: actor.userId }, false);
  return { post: presentPost({ ...row, voteCount: v.votes }, { voted: true }) };
}

export async function updatePost(deps: Deps, actor: SuiteActor, postId: string, input: PostInput) {
  await requireFormsPlus(deps, actor.orgId);
  const p = await postRow(deps, actor.orgId, postId);
  await managedBoard(deps, actor, p.boardId);
  if (p.status === "merged") throw new HttpError(422, "validation_failed", "This post was merged. Change the post it was merged into.");
  const set: Partial<Post> = { updatedAt: deps.now() };
  if (input.title !== undefined || input.body !== undefined) Object.assign(set, cleanPost({ title: input.title ?? p.title, body: input.body ?? p.body }));
  if (input.status !== undefined) {
    if (!SETTABLE_STATUSES.includes(input.status as PostStatus)) throw new HttpError(422, "validation_failed", "Pick a status from the list.", { field: "status" });
    set.status = input.status as PostStatus;
  }
  await deps.db.update(feedbackPosts).set(set).where(eq(feedbackPosts.id, p.id));
  return { post: presentPost({ ...p, ...set } as Post, { member: true }) };
}

export async function deletePost(deps: Deps, actor: SuiteActor, postId: string) {
  await requireFormsPlus(deps, actor.orgId);
  const p = await postRow(deps, actor.orgId, postId);
  await managedBoard(deps, actor, p.boardId);
  await deps.db.delete(feedbackPosts).where(eq(feedbackPosts.id, p.id));
  // Posts merged into it point nowhere now; show them as closed.
  await deps.db.update(feedbackPosts).set({ status: "closed", mergedIntoId: null }).where(and(eq(feedbackPosts.mergedIntoId, p.id), eq(feedbackPosts.orgId, actor.orgId)));
  return { ok: true };
}

/**
 * Merges a duplicate into another post on the same board: each vote moves over unless that person already voted
 * there, the count is taken again from the votes, and the duplicate becomes "Merged" with a link to the other post.
 */
export async function mergePosts(deps: Deps, actor: SuiteActor, fromId: string, intoId: string) {
  await requireFormsPlus(deps, actor.orgId);
  if (fromId === intoId) throw new HttpError(422, "validation_failed", "Pick a different post to merge into.");
  const from = await postRow(deps, actor.orgId, fromId);
  const into = await postRow(deps, actor.orgId, intoId);
  if (from.boardId !== into.boardId) throw new HttpError(422, "validation_failed", "Both posts must be on the same board.");
  await managedBoard(deps, actor, from.boardId);
  if (from.status === "merged" || into.status === "merged") throw new HttpError(422, "validation_failed", "One of these posts was already merged.");
  const now = deps.now();
  const votes = await deps.db.select().from(feedbackVotes).where(eq(feedbackVotes.postId, from.id)).orderBy(asc(feedbackVotes.createdAt)).limit(10_000).all();
  for (let i = 0; i < votes.length; i += 50) {
    const chunk = votes.slice(i, i + 50).map((v) => ({ ...v, id: `${v.id}m${into.id.slice(-6)}`, postId: into.id }));
    await deps.db.insert(feedbackVotes).values(chunk).onConflictDoNothing();
  }
  await deps.db.delete(feedbackVotes).where(eq(feedbackVotes.postId, from.id));
  const n = await deps.db.select({ n: sql<number>`count(*)` }).from(feedbackVotes).where(eq(feedbackVotes.postId, into.id)).get();
  await deps.db.update(feedbackPosts).set({ voteCount: Number(n?.n ?? 0), updatedAt: now }).where(eq(feedbackPosts.id, into.id));
  await deps.db.update(feedbackPosts).set({ status: "merged", mergedIntoId: into.id, voteCount: 0, updatedAt: now }).where(eq(feedbackPosts.id, from.id));
  // Anything merged into the duplicate now points at the post it went to.
  await deps.db.update(feedbackPosts).set({ mergedIntoId: into.id }).where(and(eq(feedbackPosts.mergedIntoId, from.id), eq(feedbackPosts.orgId, actor.orgId)));
  return { into: presentPost({ ...into, voteCount: Number(n?.n ?? 0) }, { member: true }), moved: votes.length };
}

export async function approvePost(deps: Deps, actor: SuiteActor, postId: string) {
  return updatePost(deps, actor, postId, { status: "open" });
}

// ---------------------------------------------------------------- public (/fb/<slug>)

export async function publicBoardRow(deps: Deps, slug: string) {
  const b = await deps.db.select().from(feedbackBoards).where(eq(feedbackBoards.slug, slug.toLowerCase().slice(0, 60))).get();
  if (!b || !b.isPublic || b.archivedAt || !(await formsPlusOn(deps, b.orgId))) throw notFound("Board");
  return b;
}

export async function publicBoard(deps: Deps, slug: string, q: PostQuery) {
  const b = await publicBoardRow(deps, slug);
  const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, b.orgId)).get();
  const { rows, more, offset } = await queryPosts(deps, b, q, PUBLIC_STATUSES);
  return {
    board: { name: b.name, description: b.description, slug: b.slug, allowIdeas: b.allowIdeas, moderate: b.moderate, workspace: org?.name ?? "" },
    posts: rows.map((r) => presentPost(r)), more, offset,
  };
}

export async function publicRoadmap(deps: Deps, slug: string) {
  return { roadmap: await roadmapOf(deps, await publicBoardRow(deps, slug)) };
}

export async function publicPost(deps: Deps, slug: string, postId: string) {
  const b = await publicBoardRow(deps, slug);
  const p = await deps.db.select().from(feedbackPosts).where(and(eq(feedbackPosts.id, postId), eq(feedbackPosts.boardId, b.id))).get();
  if (!p || p.status === "pending") throw notFound("Post");
  if (p.status === "merged" && p.mergedIntoId) {
    const into = await deps.db.select().from(feedbackPosts).where(and(eq(feedbackPosts.id, p.mergedIntoId), eq(feedbackPosts.boardId, b.id))).get();
    return { post: presentPost(p), mergedInto: into && into.status !== "pending" ? presentPost(into) : null };
  }
  return { post: presentPost(p), mergedInto: null };
}

function visitor(input: { name?: string; email?: string }) {
  const email = normEmail(input.email ?? "").slice(0, 200);
  if (!isEmail(email)) throw new HttpError(422, "validation_failed", "Enter your email so we count one vote per person. We never show it.", { field: "email" });
  return { email, name: (input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120) };
}

export async function publicVote(deps: Deps, slug: string, postId: string, input: { name?: string; email?: string }) {
  const b = await publicBoardRow(deps, slug);
  const p = await deps.db.select().from(feedbackPosts).where(and(eq(feedbackPosts.id, postId), eq(feedbackPosts.boardId, b.id))).get();
  if (!p || p.status === "pending") throw notFound("Post");
  const v = visitor(input);
  return addVote(deps, b, p, { key: await voterKeyForEmail(deps, v.email), name: v.name, email: v.email, userId: null }, true);
}

export async function publicUnvote(deps: Deps, slug: string, postId: string, voteId: string, token: string) {
  const b = await publicBoardRow(deps, slug);
  const v = await deps.db.select().from(feedbackVotes).where(and(eq(feedbackVotes.id, voteId), eq(feedbackVotes.boardId, b.id), eq(feedbackVotes.postId, postId))).get();
  if (!v || !v.tokenHash || !token || !safeEqual(v.tokenHash, await sha256Hex(token))) throw notFound("Vote");
  return removeVoteRow(deps, postId, v.id);
}

/** A visitor's idea. With approval on it waits (status pending) and only the board's admins see it. */
export async function publicIdea(deps: Deps, slug: string, input: PostInput, ip: string) {
  const b = await publicBoardRow(deps, slug);
  if (!b.allowIdeas) throw forbidden("This board doesn't take new ideas.");
  const { title, body } = cleanPost(input);
  const v = visitor(input);
  const ipHash = (await hmacSha256Hex(deps.config.appSecret, `fb:${ip}`)).slice(0, 32);
  const since = new Date(deps.now().getTime() - 10 * 60_000);
  const recent = await deps.db.select({ n: sql<number>`count(*)` }).from(feedbackPosts).where(and(eq(feedbackPosts.boardId, b.id), eq(feedbackPosts.ipHash, ipHash), gte(feedbackPosts.createdAt, since))).get();
  if (Number(recent?.n ?? 0) >= 5) throw new HttpError(429, "rate_limited", "That's a lot of ideas. Please try again in a few minutes.");
  const now = deps.now();
  const row: Post = { id: sortableId("fbp", now.getTime()), orgId: b.orgId, boardId: b.id, title, body, status: b.moderate ? "pending" : "open", authorName: v.name, authorEmail: v.email, authorUserId: null, voteCount: 0, mergedIntoId: null, ipHash, createdAt: now, updatedAt: now };
  await deps.db.insert(feedbackPosts).values(row);
  if (row.status === "pending") {
    await deps.db.insert(feedbackVotes).values({ id: sortableId("fbv", now.getTime()), orgId: b.orgId, boardId: b.id, postId: row.id, voterKey: await voterKeyForEmail(deps, v.email), voterName: v.name, voterEmail: v.email, tokenHash: null, createdAt: now });
    await deps.db.update(feedbackPosts).set({ voteCount: 1 }).where(eq(feedbackPosts.id, row.id));
    return { post: null, pending: true };
  }
  const vote = await addVote(deps, b, row, { key: await voterKeyForEmail(deps, v.email), name: v.name, email: v.email, userId: null }, true);
  return { post: presentPost({ ...row, voteCount: vote.votes }, { voted: true }), pending: false, voteId: vote.voteId, token: vote.token };
}
