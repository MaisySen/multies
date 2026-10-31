/**
 * R117: Social P2a. Approvals (a member submits, an owner or admin approves, asks for changes or rejects), moving a
 * scheduled post, weekly time slots, the library, and evergreen posts that come back into free slots. Sending always
 * goes through the one publisher in social.ts (claim, then publish), so a post is never sent twice.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { members, socialLibrary, socialMedia, socialPostTargets, socialPosts, socialSlots } from "../../db/schema";
import { fromB64, newId, randomToken, toB64 } from "../../lib/crypto";
import { inIds } from "../../lib/sql-chunks";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { audit } from "../audit";
import { SOCIAL_IMAGE_MAX_BYTES, SOCIAL_MAX_AHEAD_DAYS, type SocialPostView } from "@/shared/integrations";
import {
  canApprove, cleanCampaign, EVERGREEN_RULES, freeSlots, LIBRARY_LIMITS, pickEvergreen,
  type LibraryItemView, type LibraryKind, type LibraryView, type SlotRule, type SlotView,
} from "@/shared/social-p2";
import { getPost, listPosts, parseIds, sendNow } from "./social";
import { limitWrite } from "./service";

async function notifyUser(deps: Deps, orgId: string, userId: string | null, type: string, postId: string, title: string) {
  if (!userId) return;
  const { notify } = await import("../suite/notify");
  await notify(deps, orgId, userId, { type, entityType: "social_post", entityId: postId, title });
}

const snip = (t: string) => (t.length > 60 ? `${t.slice(0, 57)}...` : t);

/* ---------------------------------------------------------------- approvals */

/** Posts waiting for approval, oldest first, for approvers; a member sees their own. */
export async function approvalQueue(deps: Deps, auth: AuthContext): Promise<SocialPostView[]> {
  const posts = await listPosts(deps, auth, { status: "review" });
  const mine = canApprove(auth.role) ? posts : posts.filter((p) => p.createdBy === auth.userId || p.submittedBy === auth.userId);
  return mine.sort((a, b) => Date.parse(a.updatedAt ?? a.createdAt) - Date.parse(b.updatedAt ?? b.createdAt));
}

async function decide(deps: Deps, auth: AuthContext, id: string, to: "scheduled" | "changes" | "rejected", note: string | null, ip?: string | null) {
  if (!canApprove(auth.role)) throw forbidden("Only owners and admins can approve posts.");
  limitWrite(auth.orgId);
  const clean = (note ?? "").trim().slice(0, 1000) || null;
  if (to !== "scheduled" && !clean) throw new HttpError(422, "note_needed", to === "changes" ? "Say what should change." : "Say why it is rejected.");
  const now = deps.now();
  const post = await deps.db.select().from(socialPosts).where(and(eq(socialPosts.id, id), eq(socialPosts.orgId, auth.orgId))).get();
  if (!post) throw notFound("Post");
  // An approved post keeps its time; one whose time has passed goes out now.
  const runAt = to === "scheduled" && post.runAt.getTime() < now.getTime() ? now : post.runAt;
  const r = await deps.db.update(socialPosts).set({ status: to, reviewNote: clean, reviewedBy: auth.userId, reviewedAt: now, updatedAt: now, runAt })
    .where(and(eq(socialPosts.id, id), eq(socialPosts.orgId, auth.orgId), eq(socialPosts.status, "review"))).returning({ id: socialPosts.id });
  if (!r.length) throw new HttpError(409, "not_waiting", "This post is no longer waiting for approval.");
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: to === "scheduled" ? "social.post_approved" : to === "changes" ? "social.post_changes_asked" : "social.post_rejected", targetType: "social_post", targetId: id, ip: ip ?? null });
  const author = post.submittedBy ?? post.createdBy;
  if (author && author !== auth.userId) {
    const title = to === "scheduled" ? `Approved: ${snip(post.text)}` : to === "changes" ? `Changes asked: ${snip(post.text)}` : `Rejected: ${snip(post.text)}`;
    await notifyUser(deps, auth.orgId, author, "social.post_decided", id, title).catch(() => undefined);
  }
  return { post: await getPost(deps, auth.orgId, id), sendNow: to === "scheduled" && runAt.getTime() <= now.getTime() };
}

export const approvePost = (deps: Deps, auth: AuthContext, id: string, ip?: string | null) => decide(deps, auth, id, "scheduled", null, ip);
export const askForChanges = (deps: Deps, auth: AuthContext, id: string, note: string, ip?: string | null) => decide(deps, auth, id, "changes", note, ip);
export const rejectPost = (deps: Deps, auth: AuthContext, id: string, note: string, ip?: string | null) => decide(deps, auth, id, "rejected", note, ip);

/** Tells the approvers a post is waiting (after a submit). */
export async function tellApprovers(deps: Deps, auth: AuthContext, post: SocialPostView) {
  if (post.status !== "review") return;
  const rows = await deps.db.select({ userId: members.userId, role: members.role }).from(members).where(and(eq(members.organizationId, auth.orgId), inArray(members.role, ["owner", "admin"]), eq(members.kind, "human"))).limit(20).all();
  await Promise.all(rows.filter((m) => m.userId !== auth.userId).map((m) => notifyUser(deps, auth.orgId, m.userId, "social.post_review", post.id, `Waiting for your approval: ${snip(post.text)}`).catch(() => undefined)));
}

/** A member discards their own draft; owners and admins any post that has not gone out. */
export async function discardPost(deps: Deps, auth: AuthContext, id: string, ip?: string | null) {
  const post = await deps.db.select().from(socialPosts).where(and(eq(socialPosts.id, id), eq(socialPosts.orgId, auth.orgId))).get();
  if (!post) throw notFound("Post");
  if (!["draft", "changes", "review", "rejected"].includes(post.status)) throw new HttpError(409, "not_draft", "Only a draft or a post waiting for approval can be discarded here.");
  if (!(post.createdBy === auth.userId || canApprove(auth.role))) throw forbidden("Only the person who wrote it, an owner or an admin can discard this post.");
  await deps.db.delete(socialPosts).where(and(eq(socialPosts.id, id), eq(socialPosts.status, post.status)));
  const media = [post.mediaId, ...parseIds(post.mediaIds)].filter((x): x is string => !!x);
  if (media.length) await deps.db.delete(socialMedia).where(and(inIds(socialMedia.id, media), eq(socialMedia.kept, false)));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "social.post_discarded", targetType: "social_post", targetId: id, ip: ip ?? null });
  return { discarded: true };
}

/* ---------------------------------------------------------------- move */

/** Moves a post that has not gone out to a new time (drag in the planner, with undo). */
export async function movePost(deps: Deps, auth: AuthContext, id: string, runAtIso: string, ip?: string | null): Promise<SocialPostView> {
  limitWrite(auth.orgId);
  const t = new Date(runAtIso);
  const now = deps.now();
  if (Number.isNaN(t.getTime())) throw new HttpError(422, "bad_time", "That time isn't valid.");
  if (t.getTime() < now.getTime() + 60_000) throw new HttpError(422, "too_soon", "Pick a time at least a minute from now.");
  if (t.getTime() > now.getTime() + SOCIAL_MAX_AHEAD_DAYS * 86_400_000) throw new HttpError(422, "too_far", `Posts can be set up to ${SOCIAL_MAX_AHEAD_DAYS} days ahead.`);
  const post = await deps.db.select().from(socialPosts).where(and(eq(socialPosts.id, id), eq(socialPosts.orgId, auth.orgId))).get();
  if (!post) throw notFound("Post");
  const own = ["draft", "changes"].includes(post.status) && post.createdBy === auth.userId;
  if (!own && !canApprove(auth.role)) throw forbidden("Only owners and admins can move scheduled posts.");
  if (!["scheduled", "draft", "changes", "review"].includes(post.status)) throw new HttpError(409, "not_movable", "This post has already gone out, so it can't move.");
  const r = await deps.db.update(socialPosts).set({ runAt: t, updatedAt: now }).where(and(eq(socialPosts.id, id), eq(socialPosts.status, post.status))).returning({ id: socialPosts.id });
  if (!r.length) throw new HttpError(409, "changed", "This post just changed. Refresh and try again.");
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "social.post_moved", targetType: "social_post", targetId: id, metadata: { from: post.runAt.toISOString(), to: t.toISOString() }, ip: ip ?? null });
  return getPost(deps, auth.orgId, id);
}

/* ---------------------------------------------------------------- time slots */

const MAX_SLOTS = 84;

export async function listSlots(deps: Deps, auth: AuthContext): Promise<SlotView[]> {
  const rows = await deps.db.select().from(socialSlots).where(eq(socialSlots.orgId, auth.orgId)).orderBy(asc(socialSlots.weekday), asc(socialSlots.minute)).limit(MAX_SLOTS).all();
  return rows.map((r) => ({ id: r.id, accountId: r.accountId, weekday: r.weekday, minute: r.minute, tz: r.tz }));
}

function validTz(tz: string) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }

/** Replaces the weekly slots (the dialog saves the whole set). Owners and admins. */
export async function saveSlots(deps: Deps, auth: AuthContext, slots: { accountId?: string | null; weekday: number; minute: number }[], tz: string): Promise<SlotView[]> {
  if (!canApprove(auth.role)) throw forbidden("Only owners and admins can change time slots.");
  limitWrite(auth.orgId);
  if (!validTz(tz)) throw new HttpError(422, "bad_tz", "That time zone isn't valid.");
  if (slots.length > MAX_SLOTS) throw new HttpError(422, "too_many", `Up to ${MAX_SLOTS} time slots.`);
  const seen = new Set<string>();
  const rows = slots.filter((s) => Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6 && Number.isInteger(s.minute) && s.minute >= 0 && s.minute < 1440)
    .filter((s) => { const k = `${s.accountId ?? "*"}|${s.weekday}|${s.minute}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((s) => ({ id: newId("ss"), orgId: auth.orgId, accountId: (s.accountId ?? "").slice(0, 120) || null, weekday: s.weekday, minute: s.minute, tz, createdAt: deps.now() }));
  await deps.db.delete(socialSlots).where(eq(socialSlots.orgId, auth.orgId));
  for (let i = 0; i < rows.length; i += 10) await deps.db.insert(socialSlots).values(rows.slice(i, i + 10));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "social.slots_saved", targetType: "social_slots", targetId: auth.orgId, metadata: { slots: rows.length } });
  return listSlots(deps, auth);
}

/** Busy times for the slot finder: posts from now on (two weeks), with their accounts. */
async function busyPosts(deps: Deps, orgId: string, from: Date, days: number) {
  const posts = await deps.db.select({ id: socialPosts.id, runAt: socialPosts.runAt, status: socialPosts.status, evergreenOf: socialPosts.evergreenOf }).from(socialPosts)
    .where(and(eq(socialPosts.orgId, orgId), sql`${socialPosts.runAt} >= ${from.getTime() - 86_400_000}`, sql`${socialPosts.runAt} < ${from.getTime() + days * 86_400_000}`))
    .orderBy(asc(socialPosts.runAt)).limit(300).all();
  const targets = posts.length ? await deps.db.select({ postId: socialPostTargets.postId, accountId: socialPostTargets.accountId }).from(socialPostTargets).where(inIds(socialPostTargets.postId, posts.map((p) => p.id))).all() : [];
  return posts.map((p) => ({ ...p, accountIds: targets.filter((t) => t.postId === p.id).map((t) => t.accountId) }));
}

/** The next free slots for the picked accounts. */
export async function nextSlots(deps: Deps, auth: AuthContext, accountIds: string[], limit = 5) {
  const rules = (await listSlots(deps, auth)) as SlotRule[];
  if (!rules.length) return { slots: [] as string[], hasSlots: false };
  const now = deps.now();
  const busy = await busyPosts(deps, auth.orgId, now, 15);
  return { slots: freeSlots(rules, busy, accountIds.slice(0, 20), now, { limit: Math.min(limit, 20) }).map((d) => d.toISOString()), hasSlots: true };
}

/* ---------------------------------------------------------------- library */

function itemView(deps: Deps, r: typeof socialLibrary.$inferSelect, tokens: Map<string, string>): LibraryItemView {
  const tok = r.mediaId ? tokens.get(r.mediaId) : undefined;
  return { id: r.id, kind: r.kind as LibraryKind, name: r.name, body: r.body, imageUrl: r.mediaId && tok ? `${deps.config.appUrl}/api/social/media/${r.mediaId}/${tok}` : null, campaign: r.campaign, sizeBytes: r.sizeBytes, createdAt: r.createdAt.toISOString(), ...(r.mediaId ? { mediaId: r.mediaId } : {}) } as LibraryItemView;
}

export async function listLibrary(deps: Deps, auth: AuthContext): Promise<LibraryView> {
  const rows = await deps.db.select().from(socialLibrary).where(eq(socialLibrary.orgId, auth.orgId)).orderBy(desc(socialLibrary.createdAt)).limit(LIBRARY_LIMITS.items).all();
  const mIds = rows.map((r) => r.mediaId).filter((x): x is string => !!x);
  const media = mIds.length ? await deps.db.select({ id: socialMedia.id, token: socialMedia.token }).from(socialMedia).where(inIds(socialMedia.id, mIds)).all() : [];
  const tokens = new Map(media.map((m) => [m.id, m.token]));
  return { items: rows.map((r) => itemView(deps, r, tokens)), usedBytes: rows.reduce((n, r) => n + (r.kind === "image" ? r.sizeBytes : 0), 0), limits: LIBRARY_LIMITS };
}

function sniff(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

export interface LibraryInput { kind: LibraryKind; name: string; body?: string | null; image?: { contentType: string; dataB64: string } | null; campaign?: string | null }

/** Anyone in the workspace adds to the library, within the free plan limits. */
export async function addLibraryItem(deps: Deps, auth: AuthContext, input: LibraryInput): Promise<LibraryItemView> {
  limitWrite(auth.orgId);
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new HttpError(422, "no_name", "Give it a name.");
  const usage = await deps.db.select({ n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(case when ${socialLibrary.kind} = 'image' then ${socialLibrary.sizeBytes} else 0 end), 0)` }).from(socialLibrary).where(eq(socialLibrary.orgId, auth.orgId)).get();
  if ((usage?.n ?? 0) >= LIBRARY_LIMITS.items) throw new HttpError(422, "library_full", `The library holds ${LIBRARY_LIMITS.items} items on the free plan. Remove some first.`);
  const now = deps.now();
  const id = newId("sl");
  let mediaId: string | null = null;
  let sizeBytes = 0;
  let body: string | null = null;
  if (input.kind === "image") {
    if (!input.image) throw new HttpError(422, "no_image", "Pick an image.");
    let bytes: Uint8Array;
    try { bytes = fromB64(input.image.dataB64); } catch { throw new HttpError(422, "bad_image", "That image could not be read."); }
    if (bytes.length > Math.min(SOCIAL_IMAGE_MAX_BYTES, LIBRARY_LIMITS.imageMax)) throw new HttpError(422, "image_too_big", "Images can be up to 1 MB.");
    const contentType = sniff(bytes);
    if (!contentType) throw new HttpError(422, "bad_image", "Use a JPEG or PNG image.");
    if ((usage?.bytes ?? 0) + bytes.length > LIBRARY_LIMITS.imageBytes) throw new HttpError(422, "library_full", "The library's 25 MB of images is full on the free plan. Remove some images first.");
    mediaId = newId("sm");
    sizeBytes = bytes.length;
    await deps.db.insert(socialMedia).values({ id: mediaId, orgId: auth.orgId, token: randomToken(18), contentType, sizeBytes, contentB64: toB64(bytes), createdAt: now, kept: true });
  } else {
    body = (input.body ?? "").trim().slice(0, LIBRARY_LIMITS.textMax);
    if (!body) throw new HttpError(422, "empty", input.kind === "hashtags" ? "Add some hashtags." : "Write the caption.");
    if (input.kind === "hashtags") body = body.split(/[\s,]+/).filter(Boolean).map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  }
  await deps.db.insert(socialLibrary).values({ id, orgId: auth.orgId, kind: input.kind, name, body, mediaId, campaign: cleanCampaign(input.campaign), sizeBytes, createdBy: auth.userId, createdAt: now });
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "social.library_added", targetType: "social_library", targetId: id, metadata: { kind: input.kind } });
  const row = await deps.db.select().from(socialLibrary).where(eq(socialLibrary.id, id)).get();
  const tokens = new Map<string, string>();
  if (mediaId) { const m = await deps.db.select({ token: socialMedia.token }).from(socialMedia).where(eq(socialMedia.id, mediaId)).get(); if (m) tokens.set(mediaId, m.token); }
  return itemView(deps, row!, tokens);
}

export async function updateLibraryItem(deps: Deps, auth: AuthContext, id: string, input: { name?: string; body?: string | null; campaign?: string | null }) {
  limitWrite(auth.orgId);
  const row = await deps.db.select().from(socialLibrary).where(and(eq(socialLibrary.id, id), eq(socialLibrary.orgId, auth.orgId))).get();
  if (!row) throw notFound("Library item");
  const name = input.name !== undefined ? input.name.replace(/\s+/g, " ").trim().slice(0, 80) : row.name;
  if (!name) throw new HttpError(422, "no_name", "Give it a name.");
  const body = row.kind === "image" ? null : input.body !== undefined ? (input.body ?? "").trim().slice(0, LIBRARY_LIMITS.textMax) : row.body;
  if (row.kind !== "image" && !body) throw new HttpError(422, "empty", "It can't be empty.");
  await deps.db.update(socialLibrary).set({ name, body, campaign: input.campaign !== undefined ? cleanCampaign(input.campaign) : row.campaign }).where(eq(socialLibrary.id, id));
  return (await listLibrary(deps, auth)).items.find((i) => i.id === id)!;
}

/** Removes a library item. Its image stays while a post that has not gone out still uses it. */
export async function removeLibraryItem(deps: Deps, auth: AuthContext, id: string) {
  limitWrite(auth.orgId);
  const row = await deps.db.select().from(socialLibrary).where(and(eq(socialLibrary.id, id), eq(socialLibrary.orgId, auth.orgId))).get();
  if (!row) throw notFound("Library item");
  if (row.createdBy !== auth.userId && !canApprove(auth.role)) throw forbidden("Only the person who added it, an owner or an admin can remove it.");
  await deps.db.delete(socialLibrary).where(eq(socialLibrary.id, id));
  if (row.mediaId) {
    const used = await deps.db.select({ id: socialPosts.id }).from(socialPosts)
      .where(and(eq(socialPosts.orgId, auth.orgId), sql`(${socialPosts.mediaId} = ${row.mediaId} or instr(coalesce(${socialPosts.mediaIds}, ''), ${row.mediaId}) > 0)`, sql`(${socialPosts.evergreen} = 1 or ${socialPosts.status} in ('scheduled','sending','draft','review','changes'))`)).limit(1).all();
    // Still used: hand the image to the post (the normal cleanup takes it a week after the post is done).
    if (used.length) await deps.db.update(socialMedia).set({ kept: false }).where(eq(socialMedia.id, row.mediaId));
    else await deps.db.delete(socialMedia).where(eq(socialMedia.id, row.mediaId));
  }
  return { removed: true };
}

/* ---------------------------------------------------------------- evergreen */

/**
 * The hourly evergreen pass. For each workspace with evergreen posts and time slots: find free slots in the next
 * 48 hours, and fill each with a copy of the right evergreen post (pickEvergreen), at most EVERGREEN_RULES.perWeek
 * copies a week per workspace. Copies are normal scheduled posts, sent by the same publisher.
 */
export async function runEvergreen(deps: Deps, opts: { now?: Date; orgId?: string } = {}) {
  const now = opts.now ?? deps.now();
  const scope = opts.orgId ? eq(socialPosts.orgId, opts.orgId) : undefined;
  const sources = await deps.db.select({ id: socialPosts.id, orgId: socialPosts.orgId }).from(socialPosts)
    .where(and(scope, eq(socialPosts.evergreen, true), inArray(socialPosts.status, ["done", "partial"]), sql`${socialPosts.evergreenOf} is null`)).limit(200).all();
  if (!sources.length) return { made: 0 };
  const orgs = [...new Set(sources.map((s) => s.orgId))].slice(0, 20);
  let made = 0;
  for (const orgId of orgs) {
    const rules = (await deps.db.select().from(socialSlots).where(eq(socialSlots.orgId, orgId)).limit(84).all()) as SlotRule[];
    if (!rules.length) continue;
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const recent = await deps.db.select({ id: socialPosts.id, evergreenOf: socialPosts.evergreenOf, runAt: socialPosts.runAt }).from(socialPosts)
      .where(and(eq(socialPosts.orgId, orgId), sql`${socialPosts.evergreenOf} is not null`, sql`${socialPosts.createdAt} >= ${weekAgo.getTime()}`)).limit(50).all();
    let budget = EVERGREEN_RULES.perWeek - recent.length;
    if (budget <= 0) continue;
    const ids = sources.filter((s) => s.orgId === orgId).map((s) => s.id);
    const [srcRows, srcTargets, copies] = await Promise.all([
      deps.db.select().from(socialPosts).where(inIds(socialPosts.id, ids)).all(),
      deps.db.select().from(socialPostTargets).where(inIds(socialPostTargets.postId, ids)).all(),
      deps.db.select({ evergreenOf: socialPosts.evergreenOf, runAt: socialPosts.runAt }).from(socialPosts).where(and(eq(socialPosts.orgId, orgId), inIds(socialPosts.evergreenOf, ids))).all(),
    ]);
    const busy = await busyPosts(deps, orgId, now, 3);
    const lastAll = [...busy].reverse();
    const cands = srcRows.map((p) => {
      const mine = copies.filter((c) => c.evergreenOf === p.id).map((c) => c.runAt.getTime());
      const last = Math.max(p.runAt.getTime(), ...mine);
      return { id: p.id, accountIds: srcTargets.filter((t) => t.postId === p.id && t.status === "sent").map((t) => t.accountId), uses: mine.length, lastUsedAt: new Date(last) };
    }).filter((c) => c.accountIds.length);
    const slots = freeSlots(rules, busy, [], now, { days: EVERGREEN_RULES.lookAheadHours / 24, limit: 6, leadMs: 30 * 60_000 });
    for (const at of slots) {
      if (budget <= 0) break;
      const before = lastAll.filter((b) => b.runAt.getTime() < at.getTime())[0];
      const lastSourceId = before ? (before.evergreenOf ?? before.id) : null;
      const pick = pickEvergreen(cands, { now: at, lastSourceId, slotAccountId: null });
      if (!pick) continue;
      const src = srcRows.find((s) => s.id === pick.id)!;
      const copyId = newId("sp");
      await deps.db.insert(socialPosts).values({
        id: copyId, orgId, createdBy: src.createdBy, text: src.text, mediaId: src.mediaId, status: "scheduled", runAt: at, createdAt: now, updatedAt: now,
        format: src.format, texts: src.texts, extras: src.extras, mediaIds: src.mediaIds, campaign: src.campaign, evergreen: false, evergreenOf: src.id,
      });
      await deps.db.insert(socialPostTargets).values(srcTargets.filter((t) => t.postId === src.id && t.status === "sent").map((t) => ({ postId: copyId, accountId: t.accountId, app: t.app, label: t.label, target: t.target, targetName: t.targetName, status: "pending" as const })));
      busy.push({ id: copyId, runAt: at, status: "scheduled", evergreenOf: src.id, accountIds: pick.accountIds });
      lastAll.unshift({ id: copyId, runAt: at, status: "scheduled", evergreenOf: src.id, accountIds: pick.accountIds });
      lastAll.sort((a, b) => b.runAt.getTime() - a.runAt.getTime());
      pick.uses += 1; pick.lastUsedAt = at;
      budget -= 1; made += 1;
    }
  }
  return { made };
}

export { sendNow };
