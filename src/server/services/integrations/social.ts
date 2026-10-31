/**
 * R80C: post text and an image to one or more connected social accounts now or at a set time.
 * A post is one social_posts row plus one social_post_targets row per account; the cron pass (maintenance.ts)
 * claims due posts with a guarded update, so each goes out once. A post set for now goes out right after the
 * request answers. Each account keeps its own result, so one network turning a post down never hides the rest.
 */
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { directSocialLinks, socialMedia, socialPostTargets, socialPosts } from "../../db/schema";
import { newId, randomToken, toB64, fromB64 } from "../../lib/crypto";
import { inIds } from "../../lib/sql-chunks";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { audit } from "../audit";
import {
  SOCIAL_CAN_CHECK, SOCIAL_CAN_DELETE, type DeleteOutcome,
  SOCIAL_ERROR_COPY, SOCIAL_HEALTH_COPY, SOCIAL_IMAGE_MAX_BYTES, SOCIAL_MAX_AHEAD_DAYS, SOCIAL_NETWORKS, SOCIAL_TEXT_MAX,
  type PostStatus, type SocialPostView, type TargetStatus,
} from "@/shared/integrations";
import { appLabel, isAdmin, limitWrite, platform, platformUserId, statusOf, toHttp } from "./service";
import { IntegrationError, type Composio, type CpAccount } from "./composio";
import {
  canPublish, cleanCampaign, composerChecks, formatFit, NETWORK_RULES, pollProblem, SOCIAL_FORMATS, textFor,
  type PostExtras, type SocialFormat,
} from "@/shared/social-p2";

/** Due posts one cron pass takes; the rest wait for the next pass. */
export const SOCIAL_PASS_LIMIT = 10;
/** A post left "sending" this long (a pass that died) is taken again. */
const STUCK_MS = 15 * 60_000;
/** Images are dropped this long after their post is done. */
const MEDIA_TTL_MS = 7 * 86_400_000;

export interface CreatePostInput {
  text: string;
  image?: { contentType: string; dataB64: string } | null;
  targets: { accountId: string; target?: string | null; targetName?: string | null }[];
  /** ISO instant; missing or in the past means now. */
  runAt?: string | null;
  /** R117: composer v2. Images beyond the first make a carousel; an image can be a library image (kept media id). */
  images?: ({ contentType: string; dataB64: string } | { mediaId: string })[] | null;
  format?: SocialFormat | null;
  /** Per network text (key = network), inherits the main text when missing. */
  texts?: Record<string, string> | null;
  extras?: PostExtras | null;
  campaign?: string | null;
  evergreen?: boolean;
  /** send (owners and admins), draft (anyone) or submit (anyone: waits for approval). */
  mode?: "send" | "draft" | "submit";
}

/** R117: the id a TikTok or Threads account has in a post (our own sign in, not Connections). */
export const DIRECT_ACCOUNT = (p: "threads" | "tiktok") => `direct:${p}`;
const directOf = (accountId: string): "threads" | "tiktok" | null => (accountId === "direct:threads" ? "threads" : accountId === "direct:tiktok" ? "tiktok" : null);
/** Most images one post carries (a carousel). */
export const SOCIAL_MAX_IMAGES = 10;

export interface TargetProblem { accountId: string; code: string }

/** Checks one target against what its network needs. Pure, shared with tests. */
export function checkTarget(app: string, text: string, hasImage: boolean, target: string | null | undefined): string | null {
  const n = SOCIAL_NETWORKS[app];
  if (!n) return "not_supported";
  if (n.image === "required" && !hasImage) return "needs_image";
  if (text.length > n.maxChars) return "too_long";
  if (n.target && !(target ?? "").trim()) return "needs_target";
  return null;
}

function sniff(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

interface PreparedPost {
  text: string; format: SocialFormat; texts: Record<string, string> | null; extras: PostExtras | null; campaign: string | null; evergreen: boolean;
  runAt: Date; rows: { accountId: string; app: string; label: string; target: string | null; targetName: string | null }[];
  uploads: { id: string; token: string; contentType: string; bytes: Uint8Array }[]; mediaIds: string[];
}

function cleanTexts(main: string, texts: Record<string, string> | null | undefined): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(texts ?? {})) {
    if (!(k in NETWORK_RULES) || typeof v !== "string") continue;
    const t = v.trim();
    if (!t || t === main) continue;
    if (t.length > SOCIAL_TEXT_MAX) throw new HttpError(422, "too_long", "That post is too long.");
    out[k] = t;
  }
  return Object.keys(out).length ? out : null;
}

function cleanExtras(x: PostExtras | null | undefined, strict: boolean): PostExtras | null {
  if (!x) return null;
  const firstComment = (x.firstComment ?? "").trim().slice(0, 2000) || null;
  let poll = x.poll ?? null;
  if (poll) {
    poll = { question: (poll.question ?? "").trim(), options: (poll.options ?? []).map((o) => String(o).trim()).filter(Boolean), days: Number(poll.days) };
    const bad = pollProblem(poll);
    if (bad && strict) throw new HttpError(422, "bad_poll", bad);
  }
  const out: PostExtras = { ...(firstComment ? { firstComment } : {}), ...(poll ? { poll } : {}), ...(x.linkCard ? { linkCard: true } : {}) };
  return Object.keys(out).length ? out : null;
}

/** Reads, checks and shapes what a post will be. Drafts skip the account checks (they are checked on submit). */
async function preparePost(deps: Deps, auth: AuthContext, input: CreatePostInput, mode: "send" | "draft" | "submit", ownMedia: string[] = []): Promise<PreparedPost> {
  const text = input.text.trim();
  if (text.length > SOCIAL_TEXT_MAX) throw new HttpError(422, "too_long", "That post is too long.");
  const strict = mode !== "draft";
  const list = [...(input.image ? [input.image] : []), ...(input.images ?? [])];
  if (list.length > SOCIAL_MAX_IMAGES) throw new HttpError(422, "too_many_images", `A post can carry ${SOCIAL_MAX_IMAGES} images at most.`);
  if (!text && !list.length) throw new HttpError(422, "empty", "Write something to post.");
  if (strict && !input.targets.length) throw new HttpError(422, "no_targets", "Pick at least one account.");
  const uniqueIds = [...new Set(input.targets.map((t) => t.accountId))];
  if (uniqueIds.length !== input.targets.length || uniqueIds.length > 20) throw new HttpError(422, "bad_targets", "Pick each account once, 20 at most.");

  const uploads: PreparedPost["uploads"] = [];
  const mediaIds: string[] = [];
  const libIds = list.filter((m): m is { mediaId: string } => "mediaId" in m).map((m) => m.mediaId);
  const kept = libIds.length ? await deps.db.select({ id: socialMedia.id }).from(socialMedia).where(and(eq(socialMedia.orgId, auth.orgId), eq(socialMedia.kept, true), inIds(socialMedia.id, libIds))).all() : [];
  // A library image, or one this post already carries (editing a draft keeps its images).
  const keptSet = new Set([...kept.map((k) => k.id), ...ownMedia]);
  for (const m of list) {
    if ("mediaId" in m) {
      if (!keptSet.has(m.mediaId)) throw new HttpError(422, "bad_image", "That library image is no longer there. Pick another.");
      mediaIds.push(m.mediaId);
      continue;
    }
    let bytes: Uint8Array;
    try { bytes = fromB64(m.dataB64); } catch { throw new HttpError(422, "bad_image", "That image could not be read."); }
    if (bytes.length > SOCIAL_IMAGE_MAX_BYTES) throw new HttpError(422, "image_too_big", "Images can be up to 1 MB.");
    const contentType = sniff(bytes);
    if (!contentType) throw new HttpError(422, "bad_image", "Use a JPEG or PNG image.");
    const id = newId("sm");
    uploads.push({ id, token: randomToken(18), contentType, bytes });
    mediaIds.push(id);
  }
  const format: SocialFormat = input.format && (SOCIAL_FORMATS as readonly string[]).includes(input.format) ? input.format : mediaIds.length > 1 ? "carousel" : mediaIds.length ? "image" : "text";
  const texts = cleanTexts(text, input.texts);
  const extras = cleanExtras(input.extras, strict);

  const now = deps.now();
  let runAt = now;
  if (input.runAt) {
    const t = new Date(input.runAt);
    if (Number.isNaN(t.getTime())) throw new HttpError(422, "bad_time", "That time isn't valid.");
    if (t.getTime() > now.getTime() + SOCIAL_MAX_AHEAD_DAYS * 86_400_000) throw new HttpError(422, "too_far", `Posts can be set up to ${SOCIAL_MAX_AHEAD_DAYS} days ahead.`);
    if (t.getTime() > now.getTime()) runAt = t;
  }

  // Every account must belong to this workspace and be live: one platform read for all of them, one read for TikTok and Threads.
  const viaPlatform = input.targets.filter((t) => !directOf(t.accountId));
  const viaDirect = input.targets.filter((t) => directOf(t.accountId));
  let accounts: CpAccount[] = [];
  if (strict && viaPlatform.length) {
    const cp = platform(deps);
    try { accounts = await cp.accounts(platformUserId(cp, auth.orgId)); } catch (err) { return toHttp(err); }
    accounts = accounts.filter((a) => a.user_id === platformUserId(cp, auth.orgId));
  } else if (!strict && viaPlatform.length) {
    try { const cp = platform(deps); accounts = await cp.accounts(platformUserId(cp, auth.orgId)); } catch { accounts = []; }
  }
  const links = viaDirect.length ? await deps.db.select({ provider: directSocialLinks.provider, username: directSocialLinks.username, status: directSocialLinks.status }).from(directSocialLinks).where(eq(directSocialLinks.orgId, auth.orgId)).all() : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const problems: (TargetProblem & { text?: string })[] = [];
  const rows = input.targets.map((t) => {
    const direct = directOf(t.accountId);
    const link = direct ? links.find((l) => l.provider === direct) : undefined;
    const a = direct ? undefined : byId.get(t.accountId);
    const app = direct ?? a?.toolkit?.slug ?? "";
    const label = direct ? (link?.username ? `@${link.username}` : appLabel(direct)) : a?.alias?.trim() || appLabel(app);
    const row = { accountId: t.accountId, app, label, target: (t.target ?? "").trim() || null, targetName: (t.targetName ?? "").trim().slice(0, 200) || null };
    if (!strict) return row;
    const live = direct ? !!link && link.status !== "expired" : !!a && statusOf(a.status) === "active";
    if (!live || direct === "tiktok") { problems.push({ accountId: t.accountId, code: direct === "tiktok" ? "not_supported" : "account_gone" }); return row; }
    const legacy = checkTarget(app, textFor(text, texts, app), mediaIds.length > 0, t.target);
    if (legacy) { problems.push({ accountId: t.accountId, code: legacy }); return row; }
    const chk = composerChecks({ format, main: text, texts, images: mediaIds.map(() => ({ w: 1, h: 1 })), extras, accounts: [{ id: t.accountId, app, target: row.target, needsTarget: !!SOCIAL_NETWORKS[app]?.target }], scheduled: runAt > now })[0]!;
    if (chk.state === "out") problems.push({ accountId: t.accountId, code: "check", text: chk.notes[0] });
    return row;
  });
  if (problems.length) throw new HttpError(422, "target_problems", "Some accounts can't take this post.", { problems });
  return { text, format, texts, extras, campaign: cleanCampaign(input.campaign), evergreen: !!input.evergreen, runAt, rows, uploads, mediaIds };
}

async function writeUploads(deps: Deps, orgId: string, uploads: PreparedPost["uploads"]) {
  for (const u of uploads) await deps.db.insert(socialMedia).values({ id: u.id, orgId, token: u.token, contentType: u.contentType, sizeBytes: u.bytes.length, contentB64: toB64(u.bytes), createdAt: deps.now() });
}

const STATUS_FOR_MODE = { send: "scheduled", draft: "draft", submit: "review" } as const;

export async function createPost(deps: Deps, auth: AuthContext, input: CreatePostInput, opts: { ip?: string | null } = {}): Promise<SocialPostView> {
  const mode = input.mode ?? "send";
  if (mode === "send" && !canPublish(auth.role)) throw forbidden("Only owners and admins can post. Submit it for approval instead.");
  limitWrite(auth.orgId);
  const pp = await preparePost(deps, auth, input, mode);
  const now = deps.now();
  const postId = newId("sp");
  await writeUploads(deps, auth.orgId, pp.uploads);
  await deps.db.insert(socialPosts).values({
    id: postId, orgId: auth.orgId, createdBy: auth.userId, text: pp.text, mediaId: pp.mediaIds[0] ?? null, status: STATUS_FOR_MODE[mode], runAt: pp.runAt, createdAt: now, updatedAt: now,
    format: pp.format, texts: pp.texts ? JSON.stringify(pp.texts) : null, extras: pp.extras ? JSON.stringify(pp.extras) : null,
    mediaIds: pp.mediaIds.length > 1 ? JSON.stringify(pp.mediaIds.slice(1)) : null, campaign: pp.campaign, evergreen: pp.evergreen,
    submittedBy: mode === "submit" ? auth.userId : null,
  });
  const writes: Promise<unknown>[] = [];
  if (pp.rows.length) writes.push(deps.db.insert(socialPostTargets).values(pp.rows.map((r) => ({ postId, accountId: r.accountId, app: r.app, label: r.label, target: r.target, targetName: r.targetName, status: "pending" as const }))));
  const action = mode === "draft" ? "social.post_drafted" : mode === "submit" ? "social.post_submitted" : pp.runAt > now ? "social.post_scheduled" : "social.post_created";
  writes.push(audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action, targetType: "social_post", targetId: postId, metadata: { accounts: pp.rows.length, apps: [...new Set(pp.rows.map((r) => r.app))], image: pp.mediaIds.length > 0, images: pp.mediaIds.length, format: pp.format }, ip: opts.ip ?? null }));
  await Promise.all(writes);
  return getPost(deps, auth.orgId, postId);
}

/**
 * R117: changes a post that has not gone out (a draft, one sent back, one waiting, or a scheduled one). The mode says
 * where it goes next. The update is guarded by the status it was read with, so two people never both win.
 */
export async function updatePost(deps: Deps, auth: AuthContext, id: string, input: CreatePostInput, opts: { ip?: string | null } = {}): Promise<SocialPostView> {
  const mode = input.mode ?? "send";
  if (mode === "send" && !canPublish(auth.role)) throw forbidden("Only owners and admins can post. Submit it for approval instead.");
  limitWrite(auth.orgId);
  const post = await deps.db.select().from(socialPosts).where(and(eq(socialPosts.id, id), eq(socialPosts.orgId, auth.orgId))).get();
  if (!post) throw notFound("Post");
  const editable = ["draft", "changes", "review", "scheduled", "rejected"].includes(post.status);
  const mayEdit = ["draft", "changes"].includes(post.status) ? post.createdBy === auth.userId || canPublish(auth.role) : canPublish(auth.role);
  if (!editable) throw new HttpError(409, "not_editable", "This post has already gone out, so it can't be changed.");
  if (!mayEdit) throw forbidden("Only the person who wrote it, an owner or an admin can change this post.");
  const pp = await preparePost(deps, auth, input, mode, [post.mediaId, ...parseIds(post.mediaIds)].filter((x): x is string => !!x));
  const now = deps.now();
  await writeUploads(deps, auth.orgId, pp.uploads);
  const r = await deps.db.update(socialPosts).set({
    text: pp.text, mediaId: pp.mediaIds[0] ?? null, status: STATUS_FOR_MODE[mode], runAt: pp.runAt, updatedAt: now,
    format: pp.format, texts: pp.texts ? JSON.stringify(pp.texts) : null, extras: pp.extras ? JSON.stringify(pp.extras) : null,
    mediaIds: pp.mediaIds.length > 1 ? JSON.stringify(pp.mediaIds.slice(1)) : null, campaign: pp.campaign, evergreen: pp.evergreen,
    ...(mode === "submit" ? { submittedBy: auth.userId, reviewNote: null, reviewedBy: null, reviewedAt: null } : {}),
  }).where(and(eq(socialPosts.id, id), eq(socialPosts.status, post.status))).returning({ id: socialPosts.id });
  if (!r.length) throw new HttpError(409, "changed", "Someone changed this post at the same time. Open it again.");
  await deps.db.delete(socialPostTargets).where(eq(socialPostTargets.postId, id));
  if (pp.rows.length) await deps.db.insert(socialPostTargets).values(pp.rows.map((t) => ({ postId: id, accountId: t.accountId, app: t.app, label: t.label, target: t.target, targetName: t.targetName, status: "pending" as const })));
  // Images the post no longer uses go (library images are kept).
  const before = [post.mediaId, ...parseIds(post.mediaIds)].filter((x): x is string => !!x).filter((m) => !pp.mediaIds.includes(m));
  if (before.length) await deps.db.delete(socialMedia).where(and(inIds(socialMedia.id, before), eq(socialMedia.kept, false)));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: mode === "submit" ? "social.post_submitted" : "social.post_changed", targetType: "social_post", targetId: id, ip: opts.ip ?? null });
  return getPost(deps, auth.orgId, id);
}

export function parseIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
export function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function getPost(deps: Deps, orgId: string, id: string): Promise<SocialPostView> {
  const posts = await viewsFor(deps, orgId, [id]);
  if (!posts[0]) throw notFound("Post");
  return posts[0];
}

function mediaUrl(deps: Deps, m: { id: string; token: string } | undefined) {
  return m ? `${deps.config.appUrl}/api/social/media/${m.id}/${m.token}` : null;
}

async function viewsFor(deps: Deps, orgId: string, ids?: string[], limit = 50, opts: { all?: boolean; from?: Date; to?: Date; statuses?: string[] } = {}): Promise<SocialPostView[]> {
  const conds = [eq(socialPosts.orgId, orgId)];
  if (ids) conds.push(inIds(socialPosts.id, ids));
  // R117: drafts and posts waiting for approval only reach callers that ask for them (the phone app 1.10.6 never does).
  if (!ids && !opts.all) conds.push(sql`${socialPosts.status} not in ('draft','review','changes','rejected')`);
  if (opts.statuses?.length) conds.push(inArray(socialPosts.status, opts.statuses as PostStatus[]));
  if (opts.from) conds.push(sql`${socialPosts.runAt} >= ${opts.from.getTime()}`);
  if (opts.to) conds.push(sql`${socialPosts.runAt} < ${opts.to.getTime()}`);
  const posts = await deps.db.select().from(socialPosts).where(and(...conds)).orderBy(desc(socialPosts.runAt)).limit(limit).all();
  if (!posts.length) return [];
  const pIds = posts.map((p) => p.id);
  const mIds = [...new Set(posts.flatMap((p) => [p.mediaId, ...parseIds(p.mediaIds)]).filter((x): x is string => !!x))];
  const [targets, media] = await Promise.all([
    deps.db.select().from(socialPostTargets).where(inIds(socialPostTargets.postId, pIds)).all(),
    mIds.length ? deps.db.select({ id: socialMedia.id, token: socialMedia.token }).from(socialMedia).where(inIds(socialMedia.id, mIds)).all() : Promise.resolve([]),
  ]);
  const mById = new Map(media.map((m) => [m.id, m]));
  return posts.map((p) => {
    const all = [p.mediaId, ...parseIds(p.mediaIds)].filter((x): x is string => !!x);
    return {
      id: p.id,
      text: p.text,
      imageUrl: p.mediaId ? mediaUrl(deps, mById.get(p.mediaId)) : null,
      status: p.status as PostStatus,
      runAt: p.runAt.toISOString(),
      createdAt: p.createdAt.toISOString(),
      createdBy: p.createdBy,
      targets: targets.filter((t) => t.postId === p.id).map((t) => ({
        accountId: t.accountId, app: t.app, label: t.label, target: t.target, targetName: t.targetName, status: t.status as TargetStatus,
        url: t.networkState === "removed" ? null : openableFacebookUrl(t.url), error: t.error,
        sentAt: t.sentAt ? t.sentAt.toISOString() : null,
        networkState: t.networkState ?? null, checkedAt: t.checkedAt ? t.checkedAt.toISOString() : null,
        canCheck: (SOCIAL_CAN_CHECK as readonly string[]).includes(t.app), canDelete: (SOCIAL_CAN_DELETE as readonly string[]).includes(t.app),
        note: t.note ?? null,
      })),
      // R117 (all optional for older readers).
      format: (p.format as SocialFormat | null) ?? null,
      texts: parseJson<Record<string, string>>(p.texts),
      extras: parseJson<PostExtras>(p.extras),
      images: all.map((id) => ({ mediaId: id, url: mediaUrl(deps, mById.get(id)) })).filter((x): x is { mediaId: string; url: string } => !!x.url),
      campaign: p.campaign ?? null,
      evergreen: !!p.evergreen,
      evergreenOf: p.evergreenOf ?? null,
      submittedBy: p.submittedBy ?? null,
      reviewNote: p.reviewNote ?? null,
      reviewedBy: p.reviewedBy ?? null,
      reviewedAt: p.reviewedAt ? p.reviewedAt.toISOString() : null,
      updatedAt: p.updatedAt.toISOString(),
    };
  });
}

export interface ListOptions { all?: boolean; from?: string | null; to?: string | null; status?: string | null }

export async function listPosts(deps: Deps, auth: AuthContext, opts: ListOptions = {}): Promise<SocialPostView[]> {
  const from = opts.from ? new Date(opts.from) : undefined;
  const to = opts.to ? new Date(opts.to) : undefined;
  const ranged = !!(from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to.getTime() - from.getTime() <= 62 * 86_400_000);
  const statuses = opts.status ? opts.status.split(",").filter((x) => /^[a-z]{3,12}$/.test(x)).slice(0, 10) : undefined;
  return viewsFor(deps, auth.orgId, undefined, ranged ? 300 : 50, { all: !!opts.all || !!statuses?.length, from: ranged ? from : undefined, to: ranged ? to : undefined, statuses });
}

export async function cancelPost(deps: Deps, auth: AuthContext, id: string, ip?: string | null): Promise<SocialPostView> {
  if (!isAdmin(auth)) throw forbidden("Only owners and admins can change posts.");
  const r = await deps.db.update(socialPosts).set({ status: "canceled", updatedAt: deps.now() })
    .where(and(eq(socialPosts.id, id), eq(socialPosts.orgId, auth.orgId), eq(socialPosts.status, "scheduled"))).returning({ id: socialPosts.id });
  if (!r.length) throw new HttpError(409, "not_scheduled", "Only a post that hasn't gone out can be canceled.");
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "social.post_canceled", targetType: "social_post", targetId: id, ip: ip ?? null });
  return getPost(deps, auth.orgId, id);
}

/** Sends the accounts that failed again, now. */
export async function retryPost(deps: Deps, auth: AuthContext, id: string): Promise<SocialPostView> {
  if (!isAdmin(auth)) throw forbidden("Only owners and admins can change posts.");
  limitWrite(auth.orgId);
  const now = deps.now();
  const r = await deps.db.update(socialPosts).set({ status: "scheduled", runAt: now, updatedAt: now })
    .where(and(eq(socialPosts.id, id), eq(socialPosts.orgId, auth.orgId), inArray(socialPosts.status, ["failed", "partial"]))).returning({ id: socialPosts.id });
  if (!r.length) throw new HttpError(409, "nothing_to_retry", "There is nothing to send again on this post.");
  await deps.db.update(socialPostTargets).set({ status: "pending", error: null }).where(and(eq(socialPostTargets.postId, id), eq(socialPostTargets.status, "failed")));
  return getPost(deps, auth.orgId, id);
}

/* ---------------------------------------------------------------- network state and delete (Oct 31) */

/** A post is asked about again at most this often. */
export const SYNC_EVERY_MS = 5 * 60_000;
/** Only posts sent this recently are asked about. */
export const SYNC_WINDOW_MS = 30 * 86_400_000;
/** Most posts one sync call asks about (the posts on screen). */
export const SYNC_MAX_POSTS = 20;

/** The network's id for a sent post: stored since Oct 31, worked out from the address for older posts. */
export function remoteIdOf(t: { app: string; remoteId?: string | null; url: string | null; target: string | null }): string | null {
  if (t.remoteId) return t.remoteId;
  const url = t.url ?? "";
  if (t.app === "facebook") {
    const under = url.match(/facebook\.com\/(\d+_\d+)\/?$/);
    if (under) return under[1]!;
    const posts = url.match(/facebook\.com\/(\d+)\/posts\/(\d+)\/?$/);
    if (posts) return t.target ? `${t.target}_${posts[2]}` : posts[2]!;
    return null;
  }
  if (t.app === "linkedin") return url.match(/feed\/update\/(urn:li:(?:share|ugcPost|activity):\d+)/)?.[1] ?? null;
  return null;
}

/** Facebook says this for an id that is gone (and, sadly, for one it will not show; we only ask with the Page's own token). */
function facebookGone(err: unknown): boolean {
  return err instanceof PublishError && /does not exist|has been deleted/i.test(err.message);
}

async function pageToken(ctx: PublishCtx, page: string, cache: Map<string, Promise<string | null>>): Promise<string | null> {
  const key = `${ctx.accountId}:${page}`;
  if (!cache.has(key)) cache.set(key, graph(ctx, "GET", `${encodeURIComponent(page)}?fields=access_token`).then((r) => str((r as { access_token?: unknown }).access_token)).catch(() => null));
  return cache.get(key)!;
}

/**
 * Asks each network whether the posts on screen are still up (Facebook only: LinkedIn does not let us read posts
 * back). At most once per post per 5 minutes, only posts sent in the last 30 days. Answers the posts as they now read.
 */
export async function syncPosts(deps: Deps, auth: AuthContext, ids: string[]): Promise<SocialPostView[]> {
  const wanted = [...new Set(ids)].slice(0, SYNC_MAX_POSTS);
  if (!wanted.length) return [];
  const posts = await deps.db.select({ id: socialPosts.id }).from(socialPosts).where(and(eq(socialPosts.orgId, auth.orgId), inIds(socialPosts.id, wanted))).all();
  const own = posts.map((p) => p.id);
  if (!own.length) return [];
  const now = deps.now();
  const targets = await deps.db.select().from(socialPostTargets).where(inIds(socialPostTargets.postId, own)).all();
  const due = targets.filter((t) => t.status === "sent" && t.networkState !== "removed" && (SOCIAL_CAN_CHECK as readonly string[]).includes(t.app)
    && t.sentAt && now.getTime() - t.sentAt.getTime() <= SYNC_WINDOW_MS && (!t.checkedAt || now.getTime() - t.checkedAt.getTime() >= SYNC_EVERY_MS));
  if (due.length && deps.config.integrations.composio) {
    const cp = platform(deps);
    const userId = platformUserId(cp, auth.orgId);
    const tokens = new Map<string, Promise<string | null>>();
    await Promise.all(due.map(async (t) => {
      const remoteId = remoteIdOf(t);
      let state: "live" | "removed" | null = null;
      if (remoteId && t.target) {
        const ctx: PublishCtx = { cp, userId, accountId: t.accountId, text: "", imageUrl: null, image: null, target: t.target, now };
        const pt = await pageToken(ctx, t.target, tokens);
        if (pt) {
          try { await graph(ctx, "GET", `${encodeURIComponent(remoteId)}?fields=id&access_token=${encodeURIComponent(pt)}`); state = "live"; } catch (err) {
            if (facebookGone(err)) state = "removed";
            else deps.log?.warn("social.sync_failed", { app: t.app, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
          }
        }
      }
      // Asked either way, so a network that will not answer is not asked again for 5 minutes.
      await deps.db.update(socialPostTargets).set({ checkedAt: now, ...(state ? { networkState: state } : {}), ...(remoteId && !t.remoteId ? { remoteId } : {}) })
        .where(and(eq(socialPostTargets.postId, t.postId), eq(socialPostTargets.accountId, t.accountId)));
    }));
  }
  return viewsFor(deps, auth.orgId, own, SYNC_MAX_POSTS);
}

/** Deletes one sent post on its network. */
async function deleteOnNetwork(ctx: PublishCtx, app: string, remoteId: string, tokens: Map<string, Promise<string | null>>): Promise<DeleteOutcome> {
  if (app === "facebook") {
    if (!ctx.target) return "failed";
    const pt = await pageToken(ctx, ctx.target, tokens);
    if (!pt) return "failed";
    try { await graph(ctx, "DELETE", `${encodeURIComponent(remoteId)}?access_token=${encodeURIComponent(pt)}`); return "deleted"; } catch (err) {
      return facebookGone(err) ? "already_gone" : "failed";
    }
  }
  if (app === "linkedin") {
    const versions = linkedinVersions(ctx.now ?? new Date());
    for (const version of versions) {
      const r = await proxy(ctx, { endpoint: `https://api.linkedin.com/rest/posts/${encodeURIComponent(remoteId)}`, method: "DELETE", headers: { "LinkedIn-Version": version, "X-Restli-Protocol-Version": "2.0.0", "X-RestLi-Method": "DELETE" } });
      if (r.status < 300) return "deleted";
      if (r.status === 404 || r.status === 410) return "already_gone";
      if (r.status !== 426) return "failed";
    }
    return "failed";
  }
  return "not_supported";
}

export interface DeleteResult { deleted: boolean; results: { accountId: string; app: string; outcome: DeleteOutcome }[]; post: SocialPostView | null }

/**
 * Deletes a post from Multies and, where the network allows it, from the network too. If a network will not delete
 * it, the post stays in the list (marked removed where it went) so nothing is lost and the person can try again.
 */
export async function deletePost(deps: Deps, auth: AuthContext, id: string, ip?: string | null): Promise<DeleteResult> {
  if (!isAdmin(auth)) throw forbidden("Only owners and admins can delete posts.");
  limitWrite(auth.orgId);
  const post = await deps.db.select().from(socialPosts).where(and(eq(socialPosts.id, id), eq(socialPosts.orgId, auth.orgId))).get();
  if (!post) throw notFound("Post");
  if (post.status === "sending") throw new HttpError(409, "sending", "This post is going out right now. Try again in a minute.");
  const targets = await deps.db.select().from(socialPostTargets).where(eq(socialPostTargets.postId, id)).all();
  const now = deps.now();
  const tokens = new Map<string, Promise<string | null>>();
  const cp = deps.config.integrations.composio ? platform(deps) : null;
  const userId = cp ? platformUserId(cp, auth.orgId) : "";
  // An account disconnected since posting can't delete there any more: the post stays on that network and leaves Multies.
  let connected: Set<string> | null = null;
  if (cp) { try { connected = new Set((await cp.accounts(userId)).map((a) => a.id)); } catch { connected = null; } }
  const results = await Promise.all(targets.map(async (t) => {
    let outcome: DeleteOutcome;
    if (t.status !== "sent") outcome = "not_sent";
    else if (t.networkState === "removed") outcome = "already_gone";
    else if (!(SOCIAL_CAN_DELETE as readonly string[]).includes(t.app)) outcome = "not_supported";
    else if (connected && !connected.has(t.accountId)) outcome = "not_supported";
    else {
      const remoteId = remoteIdOf(t);
      if (!remoteId || !cp) outcome = "failed";
      else {
        try { outcome = await deleteOnNetwork({ cp, userId, accountId: t.accountId, text: "", imageUrl: null, image: null, target: t.target, now }, t.app, remoteId, tokens); } catch (err) {
          deps.log?.warn("social.delete_failed", { app: t.app, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
          outcome = "failed";
        }
      }
      if (outcome === "deleted" || outcome === "already_gone") {
        await deps.db.update(socialPostTargets).set({ networkState: "removed", checkedAt: now })
          .where(and(eq(socialPostTargets.postId, id), eq(socialPostTargets.accountId, t.accountId)));
      }
    }
    return { accountId: t.accountId, app: t.app, outcome };
  }));
  const failed = results.some((r) => r.outcome === "failed");
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: failed ? "social.post_delete_partial" : "social.post_deleted", targetType: "social_post", targetId: id, ip: ip ?? null });
  if (failed) return { deleted: false, results, post: await getPost(deps, auth.orgId, id) };
  await deps.db.delete(socialPosts).where(and(eq(socialPosts.id, id), eq(socialPosts.orgId, auth.orgId)));
  return { deleted: true, results, post: null };
}

/* ---------------------------------------------------------------- publishing */

interface PublishCtx {
  cp: Composio; userId: string; accountId: string; text: string; imageUrl: string | null; image: { b64: string; type: string } | null; target: string | null; now?: Date;
  /** R117: every image of a carousel (the first is imageUrl), and the post's extras. */
  imageUrls?: string[]; extras?: PostExtras | null;
}
interface PublishResult { status: "sent" | "failed" | "skipped"; url?: string | null; error?: string | null; remoteId?: string | null; note?: string | null }

function str(v: unknown): string | null { return typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null; }

/** Finds a value anywhere in a tool's answer (the platform nests answers differently per network). */
export function dig(data: unknown, keys: string[], depth = 0): string | null {
  if (!data || typeof data !== "object" || depth > 4) return null;
  const o = data as Record<string, unknown>;
  for (const k of keys) { const v = str(o[k]); if (v) return v; }
  for (const v of Object.values(o)) { const found = dig(v, keys, depth + 1); if (found) return found; }
  return null;
}

async function run(ctx: PublishCtx, slug: string, args: Record<string, unknown>) {
  const r = await ctx.cp.execute(slug, ctx.accountId, ctx.userId, args);
  if (!r.ok) throw new PublishError("rejected", platformDetail(r.error) ?? "rejected");
  return r.data;
}

/** The platform passes the network's answer as a JSON string; keep only the network's own message. */
export function platformDetail(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { message?: unknown; error?: { message?: unknown } | string };
    const m = typeof j.error === "object" ? j.error?.message : typeof j.error === "string" ? j.error : j.message;
    return cleanDetail(m) ?? cleanDetail(raw);
  } catch { return cleanDetail(raw); }
}

/** What goes in the target's error column: our code, and for a plain refusal the network's own words after a colon. */
export function storedError(err: PublishError): string {
  return err.code === "rejected" && err.message && err.message !== "rejected" ? `rejected:${err.message}` : err.code;
}

export class PublishError extends Error { constructor(public code: string, detail: string) { super(detail); } }

/* Hotfix Oct 31: direct calls to Facebook and LinkedIn through the platform's signed proxy. */

const GRAPH = "https://graph.facebook.com/v21.0";

export function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[.,;:!?)\]]+$/, "") : null;
}

/** LinkedIn reads ( ) [ ] { } < > @ | ~ _ * # \ as markup in commentary; a plain post escapes them. */
export function linkedinText(text: string): string {
  return text.replace(/[\\()[\]{}<>@|~_*#]/g, (c) => `\\${c}`);
}

/** The network's own words, short and without anything that looks like a key or a long id. */
export function cleanDetail(msg: unknown): string | null {
  if (typeof msg !== "string" || !msg.trim()) return null;
  return msg.replace(/[A-Za-z0-9_-]{32,}/g, "…").replace(/\s+/g, " ").trim().slice(0, 180);
}

/** Facebook Graph error codes to our own. https://developers.facebook.com/docs/graph-api/guides/error-handling */
export function facebookError(status: number, err: { message?: string; code?: number; error_subcode?: number } | undefined): PublishError {
  const code = err?.code ?? 0;
  const detail = cleanDetail(err?.message) ?? `HTTP ${status}`;
  if (code === 190 || code === 102 || code === 463 || code === 467) return new PublishError("reconnect", detail);
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80001 || status === 429) return new PublishError("rate_limited", detail);
  if (code === 506) return new PublishError("duplicate", detail);
  if (code === 324 || code === 1366046 || /image|photo/i.test(err?.message ?? "") && code === 100) return new PublishError("bad_image", detail);
  if (code === 10 || (code >= 200 && code <= 299)) return new PublishError(/admin|as the page|page itself|sufficient administrative/i.test(err?.message ?? "") ? "not_page_admin" : "no_permission", detail);
  if (status >= 500 || code === 1 || code === 2) return new PublishError("unavailable", detail);
  return new PublishError("rejected", detail);
}

export function linkedinError(status: number, body: { message?: string; code?: string; serviceErrorCode?: number } | null): PublishError {
  const detail = cleanDetail(body?.message) ?? `HTTP ${status}`;
  const code = body?.code ?? "";
  if (status === 401 || /REVOKED|EXPIRED|INVALID_ACCESS_TOKEN/i.test(code)) return new PublishError("reconnect", detail);
  if (status === 403) return new PublishError("no_permission", detail);
  if (status === 429) return new PublishError("rate_limited", detail);
  if (/duplicate/i.test(body?.message ?? "") || /DUPLICATE/.test(code)) return new PublishError("duplicate", detail);
  if (status === 426) return new PublishError("network_changed", detail);
  if (status >= 500) return new PublishError("unavailable", detail);
  return new PublishError("rejected", detail);
}

async function proxy(ctx: PublishCtx, req: Parameters<Composio["proxy"]>[2]) {
  try { return await ctx.cp.proxy(ctx.accountId, ctx.userId, req); } catch (err) {
    if (err instanceof IntegrationError && err.code === "not_found") throw new PublishError("account_gone", err.message);
    throw new PublishError("unavailable", err instanceof Error ? err.message : String(err));
  }
}

async function graph(ctx: PublishCtx, method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>) {
  const r = await proxy(ctx, { endpoint: `${GRAPH}/${path}`, method, body });
  const data = (r.data ?? {}) as { error?: { message?: string; code?: number; error_subcode?: number } };
  if (r.status >= 400 || data.error) throw facebookError(r.status, data.error);
  return data as Record<string, unknown>;
}

/** facebook.com/<page>_<post> opens "This isn't available" in the Facebook app; this is the address that opens. */
export function facebookFallbackUrl(pageId: string, postId: string): string {
  const i = postId.indexOf("_");
  const page = i > 0 ? postId.slice(0, i) : pageId;
  const post = i > 0 ? postId.slice(i + 1) : postId;
  return `https://www.facebook.com/${encodeURIComponent(page)}/posts/${encodeURIComponent(post)}`;
}

/** Rewrites a stored facebook.com/<digits>_<digits> address (posts made before Oct 31) to one that opens. */
export function openableFacebookUrl(url: string | null): string | null {
  if (!url) return url;
  const m = url.match(/^https?:\/\/(?:www\.|m\.)?facebook\.com\/(\d+)_(\d+)\/?$/i);
  return m ? `https://www.facebook.com/${m[1]}/posts/${m[2]}` : url;
}

/** Asks Facebook for the post's own permalink; if that fails, builds /<page>/posts/<id>. Never the underscore form. */
export async function facebookPermalink(ctx: PublishCtx, pageId: string, postId: string, pageToken: string): Promise<string> {
  try {
    const r = await graph(ctx, "GET", `${encodeURIComponent(postId)}?fields=permalink_url&access_token=${encodeURIComponent(pageToken)}`);
    const link = str((r as { permalink_url?: unknown }).permalink_url);
    if (link && /^https:\/\/(?:www\.)?facebook\.com\//i.test(link)) return openableFacebookUrl(link) ?? link;
  } catch { /* fall back below */ }
  return facebookFallbackUrl(pageId, postId);
}

/** LinkedIn API versions to try, newest first: last month, the month before, this month. */
export function linkedinVersions(now: Date): string[] {
  const v = (back: number) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
  return [v(1), v(2), v(0)];
}

async function linkedinCall(ctx: PublishCtx, method: "GET" | "POST", endpoint: string, body?: Record<string, unknown>) {
  const versions = endpoint.includes("/rest/") ? linkedinVersions(ctx.now ?? new Date()) : [null];
  let last: PublishError | null = null;
  for (const version of versions) {
    const headers: Record<string, string> = version ? { "LinkedIn-Version": version, "X-Restli-Protocol-Version": "2.0.0" } : {};
    const r = await proxy(ctx, { endpoint, method, body, headers });
    if (r.status < 400) return r;
    last = linkedinError(r.status, (r.data ?? null) as never);
    if (!(r.status === 426 && version)) throw last;
  }
  throw last ?? new PublishError("unavailable", "no answer");
}


/** R117: LinkedIn's poll content for the Posts API (question up to 140, 2 to 4 options up to 30, a set duration). */
export function linkedinPoll(p: { question: string; options: string[]; days: number }) {
  const duration = p.days <= 1 ? "ONE_DAY" : p.days <= 3 ? "THREE_DAYS" : p.days <= 7 ? "SEVEN_DAYS" : "FOURTEEN_DAYS";
  return { question: p.question.trim().slice(0, 140), options: p.options.map((o) => o.trim()).filter(Boolean).slice(0, 4).map((text) => ({ text: text.slice(0, 30) })), settings: { duration } };
}

export const PUBLISHERS: Record<string, (ctx: PublishCtx) => Promise<PublishResult>> = {
  async facebook(ctx) {
    // Hotfix Oct 31: a Page post must be made with the Page's own token. The platform's ready made tools post with
    // the person's token, which Facebook refuses, so we ask for the Page token and call the Graph API directly.
    if (!ctx.target) throw new PublishError("needs_target", "no page");
    const page = encodeURIComponent(ctx.target);
    const tok = await graph(ctx, "GET", `${page}?fields=access_token`);
    const pageToken = str((tok as { access_token?: unknown }).access_token);
    if (!pageToken) throw new PublishError("not_page_admin", "no page token");
    const link = firstUrl(ctx.text);
    const urls = (ctx.imageUrls?.length ? ctx.imageUrls : ctx.imageUrl ? [ctx.imageUrl] : []).slice(0, NETWORK_RULES.facebook!.maxImages);
    let data: Record<string, unknown>;
    if (urls.length > 1) {
      // R117: a carousel is a multi photo Page post: each photo uploaded unpublished, then one feed post with all of them.
      const photoIds: string[] = [];
      for (const url of urls) {
        const ph = await graph(ctx, "POST", `${page}/photos`, { url, published: false, access_token: pageToken });
        const pid = dig(ph, ["id"]);
        if (!pid) throw new PublishError("bad_image", "photo not taken");
        photoIds.push(pid);
      }
      data = await graph(ctx, "POST", `${page}/feed`, { message: ctx.text, attached_media: photoIds.map((media_fbid) => ({ media_fbid })), published: true, access_token: pageToken });
    } else if (urls.length === 1) {
      data = await graph(ctx, "POST", `${page}/photos`, { url: urls[0], caption: ctx.text, published: true, access_token: pageToken });
    } else {
      data = await graph(ctx, "POST", `${page}/feed`, { message: ctx.text, ...(link && ctx.extras?.linkCard !== false ? { link } : {}), published: true, access_token: pageToken });
    }
    const id = dig(data, ["post_id", "id"]);
    let note: string | null = null;
    const comment = ctx.extras?.firstComment?.trim();
    if (id && comment) {
      // The post is up either way; a first comment that does not go is a note, never a failed post.
      try { await graph(ctx, "POST", `${encodeURIComponent(id)}/comments`, { message: comment, access_token: pageToken }); } catch (err) {
        note = `First comment didn't go: ${err instanceof PublishError ? (SOCIAL_ERROR_COPY[err.code] ?? err.message) : "the network did not answer"}`;
      }
    }
    return { status: "sent", url: id ? await facebookPermalink(ctx, ctx.target, id, pageToken) : null, remoteId: id, note };
  },
  async instagram(ctx) {
    if (!ctx.imageUrl) return { status: "skipped", error: "needs_image" };
    const me = await run(ctx, "INSTAGRAM_GET_USER_INFO", {});
    const igId = dig(me, ["id"]);
    if (!igId) throw new PublishError("rejected", "no account id");
    const container = await run(ctx, "INSTAGRAM_CREATE_MEDIA_CONTAINER", { ig_user_id: igId, image_url: ctx.imageUrl, caption: ctx.text, content_type: "photo" });
    const creationId = dig(container, ["id", "creation_id", "container_id"]);
    if (!creationId) throw new PublishError("rejected", "no container");
    const post = await run(ctx, "INSTAGRAM_CREATE_POST", { ig_user_id: igId, creation_id: creationId });
    return { status: "sent", url: dig(post, ["permalink"]) };
  },
  async linkedin(ctx) {
    // Hotfix Oct 31: the platform's ready made LinkedIn tool asks for an API version LinkedIn has retired, so we call
    // LinkedIn's Posts API directly with a current version (and step back a month at a time if one is not live).
    const me = await linkedinCall(ctx, "GET", "https://api.linkedin.com/v2/userinfo");
    const raw = dig(me.data, ["sub"]);
    if (!raw) throw new PublishError("reconnect", "no author");
    const author = raw.startsWith("urn:") ? raw : `urn:li:person:${raw}`;
    const r = await linkedinCall(ctx, "POST", "https://api.linkedin.com/rest/posts", {
      author, commentary: linkedinText(ctx.text), visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
      ...(ctx.extras?.poll ? { content: { poll: linkedinPoll(ctx.extras.poll) } } : {}),
    });
    const id = r.headers["x-restli-id"] ?? r.headers["x-linkedin-id"] ?? dig(r.data, ["id"]);
    return { status: "sent", url: id ? `https://www.linkedin.com/feed/update/${id}` : null, remoteId: id };
  },
  async pinterest(ctx) {
    if (!ctx.image) return { status: "skipped", error: "needs_image" };
    const data = await run(ctx, "PINTEREST_CREATE_PIN", {
      board_id: ctx.target, description: ctx.text.slice(0, 800), title: ctx.text.split("\n")[0]!.slice(0, 100),
      media_source: { source_type: "image_base64", content_type: ctx.image.type, data: ctx.image.b64 },
    });
    const id = dig(data, ["id"]);
    return { status: "sent", url: id ? `https://www.pinterest.com/pin/${id}/` : null };
  },
  async reddit(ctx) {
    const [first, ...rest] = ctx.text.split("\n");
    const data = await run(ctx, "REDDIT_CREATE_REDDIT_POST", {
      subreddit: (ctx.target ?? "").replace(/^\/?r\//i, ""), title: first!.slice(0, 300), kind: "self", text: rest.join("\n").trim() || first, flair_id: "",
    });
    return { status: "sent", url: dig(data, ["url", "permalink"]) };
  },
  async twitter(ctx) {
    const data = await run(ctx, "TWITTER_CREATION_OF_A_POST", { text: ctx.text });
    const id = dig(data, ["id"]);
    return { status: "sent", url: id ? `https://x.com/i/web/status/${id}` : null };
  },
  async threads(ctx) {
    const data = await run(ctx, "THREADS_CREATE_AND_SHARE_POST", ctx.imageUrl ? { text: ctx.text, media_type: "IMAGE", image_url: ctx.imageUrl } : { text: ctx.text, media_type: "TEXT" });
    return { status: "sent", url: dig(data, ["permalink"]) };
  },
};

/** Sends one claimed post to every target still pending, then settles the post's status. */
export async function publishPost(deps: Deps, postId: string): Promise<PostStatus> {
  const post = await deps.db.select().from(socialPosts).where(eq(socialPosts.id, postId)).get();
  if (!post || post.status !== "sending") return (post?.status ?? "failed") as PostStatus;
  const allIds = [post.mediaId, ...parseIds(post.mediaIds)].filter((x): x is string => !!x);
  const [targets, mediaRows] = await Promise.all([
    deps.db.select().from(socialPostTargets).where(eq(socialPostTargets.postId, postId)).all(),
    allIds.length ? deps.db.select().from(socialMedia).where(inIds(socialMedia.id, allIds)).all() : Promise.resolve([]),
  ]);
  const ordered = allIds.map((id) => mediaRows.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
  const media = ordered[0];
  const imageUrls = ordered.map((m) => mediaUrl(deps, m)!).filter(Boolean);
  const pending = targets.filter((t) => t.status === "pending");
  const needsPlatform = pending.some((t) => !directOf(t.accountId));
  const cp = needsPlatform ? platform(deps) : (null as unknown as Composio);
  const userId = needsPlatform ? platformUserId(cp, post.orgId) : "";
  const imageUrl = media ? mediaUrl(deps, media) : null;
  const image = media ? { b64: media.contentB64, type: media.contentType } : null;
  const texts = parseJson<Record<string, string>>(post.texts);
  const extras = parseJson<PostExtras>(post.extras);
  const format = (post.format as SocialFormat | null) ?? (allIds.length > 1 ? "carousel" : allIds.length ? "image" : "text");
  // Accounts post one after another per post (networks rate limit by account), different accounts in parallel.
  await Promise.all(pending.map(async (t) => {
    let res: PublishResult;
    const text = textFor(post.text, texts, t.app);
    const fit = formatFit(t.app, format);
    // A network that takes the text only gets no image; one that takes one image gets the first.
    const takesImages = fit.fit !== "changed" || !fit.how.startsWith("Text only");
    const maxImages = NETWORK_RULES[t.app]?.maxImages ?? 1;
    const pre = checkTarget(t.app, text, !!media && takesImages, t.target);
    if (pre && !(pre === "needs_image" && fit.fit === "no")) res = { status: pre === "not_supported" ? "skipped" : "failed", error: pre };
    else if (fit.fit === "no") res = { status: "failed", error: "not_supported" };
    else {
      try {
        const direct = directOf(t.accountId);
        if (direct === "threads") {
          const { threadsPost } = await import("../direct-social/threads");
          const r = await threadsPost(deps, { orgId: post.orgId, userId: post.createdBy ?? "", role: "owner" } as AuthContext, { text, imageUrl: takesImages ? imageUrl : null });
          res = { status: "sent", url: r.permalink, remoteId: r.id };
        } else if (direct) {
          res = { status: "skipped", error: "not_supported" };
        } else {
          res = await PUBLISHERS[t.app]!({
            cp, userId, accountId: t.accountId, text, imageUrl: takesImages ? imageUrl : null, image: takesImages ? image : null, target: t.target, now: deps.now(),
            imageUrls: takesImages ? imageUrls.slice(0, Math.max(1, maxImages)) : [], extras,
          });
        }
      } catch (err) {
        const code = err instanceof PublishError ? err.code : (err instanceof HttpError && err.status === 404) ? "account_gone" : (err instanceof HttpError && err.code === "not_connected") ? "account_gone" : "unavailable";
        deps.log?.warn("social.publish_failed", { app: t.app, code, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        res = { status: "failed", error: err instanceof PublishError ? storedError(err) : code };
      }
    }
    await deps.db.update(socialPostTargets).set({ status: res.status, url: res.url ?? null, error: res.error ?? null, sentAt: res.status === "sent" ? deps.now() : null, remoteId: res.remoteId ?? null, networkState: res.status === "sent" ? "live" : null, checkedAt: res.status === "sent" ? deps.now() : null, note: res.note ?? null })
      .where(and(eq(socialPostTargets.postId, postId), eq(socialPostTargets.accountId, t.accountId), eq(socialPostTargets.status, "pending")));
  }));
  const after = await deps.db.select({ status: socialPostTargets.status }).from(socialPostTargets).where(eq(socialPostTargets.postId, postId)).all();
  const sent = after.filter((t) => t.status === "sent").length;
  const status: PostStatus = sent === after.length && after.length > 0 ? "done" : sent > 0 ? "partial" : "failed";
  await deps.db.update(socialPosts).set({ status, updatedAt: deps.now(), attempts: sql`${socialPosts.attempts} + 1` }).where(and(eq(socialPosts.id, postId), eq(socialPosts.status, "sending")));
  if (status !== "done") await notifyFailed(deps, post, status).catch(() => undefined);
  return status;
}

/** R117: nothing silent. A scheduled post that did not fully go tells the person who made it (in app). */
async function notifyFailed(deps: Deps, post: { id: string; orgId: string; createdBy: string | null; text: string }, status: PostStatus) {
  if (!post.createdBy) return;
  const { notify } = await import("../suite/notify");
  const snippet = post.text.length > 60 ? `${post.text.slice(0, 57)}...` : post.text;
  await notify(deps, post.orgId, post.createdBy, { type: "social.post_failed", entityType: "social_post", entityId: post.id, title: `${status === "partial" ? "Posted to some accounts only" : "Not posted"}: ${snippet}. Open Posts to see why and try again.` });
}

/** Claims a post for sending (exactly once: the update is guarded by its status). */
async function claim(deps: Deps, id: string, from: "scheduled" | "sending"): Promise<boolean> {
  const r = await deps.db.update(socialPosts).set({ status: "sending", updatedAt: deps.now() })
    .where(and(eq(socialPosts.id, id), eq(socialPosts.status, from))).returning({ id: socialPosts.id });
  return r.length > 0;
}

/** Sends a post set for now, right after the request that made it. */
export async function sendNow(deps: Deps, postId: string): Promise<void> {
  if (await claim(deps, postId, "scheduled")) await publishPost(deps, postId);
}

/** The cron pass: due posts (and posts stuck mid send), then old images. Reads first; an idle pass writes nothing. */
export async function runDueSocialPosts(deps: Deps, opts: { now?: Date; orgId?: string } = {}) {
  const now = opts.now ?? deps.now();
  if (!deps.config.integrations.composio) return { sent: 0 };
  const scope = opts.orgId ? eq(socialPosts.orgId, opts.orgId) : undefined;
  const due = await deps.db.select({ id: socialPosts.id, status: socialPosts.status }).from(socialPosts)
    .where(and(scope, sql`((${socialPosts.status} = 'scheduled' and ${socialPosts.runAt} <= ${now.getTime()}) or (${socialPosts.status} = 'sending' and ${socialPosts.updatedAt} <= ${now.getTime() - STUCK_MS}))`))
    .orderBy(asc(socialPosts.runAt)).limit(SOCIAL_PASS_LIMIT).all();
  let sent = 0;
  for (const p of due) {
    if (!(await claim(deps, p.id, p.status as "scheduled" | "sending"))) continue;
    await publishPost(deps, p.id);
    sent++;
  }
  return { sent };
}

/** Images of posts that are done (or canceled) more than a week ago. */
export async function pruneSocialMedia(deps: Deps, opts: { now?: Date; orgId?: string } = {}) {
  const now = opts.now ?? deps.now();
  const scope = opts.orgId ? eq(socialPosts.orgId, opts.orgId) : undefined;
  // R117: evergreen posts keep their images (they come back), and library images are kept (kept = 1).
  const old = await deps.db.select({ id: socialPosts.id, mediaId: socialPosts.mediaId, mediaIds: socialPosts.mediaIds }).from(socialPosts)
    .where(and(scope, inArray(socialPosts.status, ["done", "partial", "failed", "canceled", "rejected"]), eq(socialPosts.evergreen, false), lt(socialPosts.updatedAt, new Date(now.getTime() - MEDIA_TTL_MS)), sql`${socialPosts.mediaId} is not null`)).limit(50).all();
  const candidates = [...new Set(old.flatMap((o) => [o.mediaId, ...parseIds(o.mediaIds)]).filter((x): x is string => !!x))];
  // An evergreen copy shares its source's images, so an image still used by a live or evergreen post stays.
  const inUse = candidates.length ? await deps.db.select({ mediaId: socialPosts.mediaId }).from(socialPosts)
    .where(and(inIds(socialPosts.mediaId, candidates), sql`(${socialPosts.evergreen} = 1 or ${socialPosts.status} in ('scheduled','sending','draft','review','changes'))`)).all() : [];
  const busy = new Set(inUse.map((u) => u.mediaId));
  const mIds = candidates.filter((id) => !busy.has(id));
  if (mIds.length) await deps.db.delete(socialMedia).where(and(inIds(socialMedia.id, mIds), eq(socialMedia.kept, false)));
  if (old.length) await deps.db.update(socialPosts).set({ mediaId: null, mediaIds: null }).where(inIds(socialPosts.id, old.map((o) => o.id)));
  return { mediaPruned: mIds.length };
}

/** The public image a network fetches while posting. */
export async function readMedia(deps: Deps, id: string, token: string) {
  if (!/^[\w-]{1,64}$/.test(id) || !/^[\w-]{8,64}$/.test(token)) return null;
  const m = await deps.db.select().from(socialMedia).where(eq(socialMedia.id, id)).get();
  if (!m || m.token !== token) return null;
  return { bytes: fromB64(m.contentB64), contentType: m.contentType };
}

/* ------------------------------------------------------------- account health (Oct 31) */

export interface AccountHealthView { accountId: string; app: string; ok: boolean; code: string | null; text: string | null }

const HEALTH_TTL_MS = 5 * 60_000;
const healthCache = new Map<string, { at: number; rows: AccountHealthView[] }>();

/** Facebook: the sign in works, posting is allowed, and at least one Page lets this profile create content. */
async function facebookHealth(ctx: PublishCtx): Promise<string | null> {
  const perms = await graph(ctx, "GET", "me/permissions");
  const granted = new Set(((perms.data as { permission?: string; status?: string }[] | undefined) ?? []).filter((p) => p.status === "granted").map((p) => p.permission));
  if (!granted.has("pages_manage_posts") || !granted.has("pages_show_list")) return "no_permission";
  const pages = await graph(ctx, "GET", "me/accounts?fields=id,tasks&limit=100");
  const list = (pages.data as { id?: string; tasks?: string[] }[] | undefined) ?? [];
  if (!list.some((p) => !p.tasks || p.tasks.includes("CREATE_CONTENT") || p.tasks.includes("MANAGE"))) return "not_page_admin";
  return null;
}

/** LinkedIn: the sign in works and it allows posting as the member. */
async function linkedinHealth(ctx: PublishCtx, scope: string | null): Promise<string | null> {
  await linkedinCall(ctx, "GET", "https://api.linkedin.com/v2/userinfo");
  if (scope && !/w_member_social/.test(scope)) return "no_permission";
  return null;
}

/**
 * Checks every social account of the workspace without posting anything: the sign in still works, posting is allowed,
 * and (Facebook) a Page can be posted to. Answers are kept 5 minutes per workspace; fresh=true asks again.
 */
export async function accountHealth(deps: Deps, auth: AuthContext, opts: { fresh?: boolean } = {}): Promise<AccountHealthView[]> {
  const hit = healthCache.get(auth.orgId);
  const now = deps.now().getTime();
  // A fresh check is still held back 30 seconds, so a page that asks often does not hammer the networks.
  if (hit && now - hit.at < (opts.fresh ? 30_000 : HEALTH_TTL_MS)) return hit.rows;
  const cp = platform(deps);
  const userId = platformUserId(cp, auth.orgId);
  let accounts: CpAccount[];
  try { accounts = await cp.accounts(userId); } catch (err) { return toHttp(err); }
  const social = accounts.filter((a) => (a.user_id === undefined || a.user_id === userId) && (a.toolkit?.slug ?? "") in SOCIAL_NETWORKS);
  const rows = await Promise.all(social.map(async (a): Promise<AccountHealthView> => {
    const app = a.toolkit?.slug ?? "";
    let code: string | null = null;
    const st = (a.status ?? "").toUpperCase();
    if (st && st !== "ACTIVE") code = st === "INITIATED" || st === "INITIALIZING" ? "not_finished" : "reconnect";
    else {
      const ctx: PublishCtx = { cp, userId, accountId: a.id, text: "", imageUrl: null, image: null, target: null, now: deps.now() };
      try {
        if (app === "facebook") code = await facebookHealth(ctx);
        else if (app === "linkedin") {
          const raw = a as unknown as { state?: { val?: { scope?: unknown; scopes?: unknown } } };
          const sc = raw.state?.val?.scope ?? raw.state?.val?.scopes;
          code = await linkedinHealth(ctx, typeof sc === "string" ? sc : Array.isArray(sc) ? sc.join(",") : null);
        }
      } catch (err) {
        code = err instanceof PublishError ? (err.code === "rejected" || err.code === "network_changed" ? "check_failed" : err.code) : "check_failed";
        deps.log?.warn("social.health_failed", { app, code, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      }
    }
    // A network that did not answer is not the person's problem to fix: show it as fine, posting will say if not.
    if (code === "unavailable" || code === "rate_limited") code = null;
    return { accountId: a.id, app, ok: !code, code, text: code ? (SOCIAL_HEALTH_COPY[code] ?? SOCIAL_ERROR_COPY[code] ?? null) : null };
  }));
  healthCache.set(auth.orgId, { at: now, rows });
  return rows;
}
