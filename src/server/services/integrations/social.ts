/**
 * R80C: post text and an image to one or more connected social accounts now or at a set time.
 * A post is one social_posts row plus one social_post_targets row per account; the cron pass (maintenance.ts)
 * claims due posts with a guarded update, so each goes out once. A post set for now goes out right after the
 * request answers. Each account keeps its own result, so one network turning a post down never hides the rest.
 */
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { socialMedia, socialPostTargets, socialPosts } from "../../db/schema";
import { newId, randomToken, toB64, fromB64 } from "../../lib/crypto";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { audit } from "../audit";
import {
  SOCIAL_IMAGE_MAX_BYTES, SOCIAL_MAX_AHEAD_DAYS, SOCIAL_NETWORKS, SOCIAL_TEXT_MAX,
  type PostStatus, type SocialPostView, type TargetStatus,
} from "@/shared/integrations";
import { appLabel, isAdmin, limitWrite, platform, platformUserId, statusOf, toHttp } from "./service";
import type { Composio } from "./composio";

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
}

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

export async function createPost(deps: Deps, auth: AuthContext, input: CreatePostInput, opts: { ip?: string | null } = {}): Promise<SocialPostView> {
  if (!isAdmin(auth)) throw forbidden("Only owners and admins can post.");
  const cp = platform(deps);
  limitWrite(auth.orgId);
  const text = input.text.trim();
  if (!text) throw new HttpError(422, "empty", "Write something to post.");
  if (text.length > SOCIAL_TEXT_MAX) throw new HttpError(422, "too_long", "That post is too long.");
  if (!input.targets.length) throw new HttpError(422, "no_targets", "Pick at least one account.");
  const uniqueIds = [...new Set(input.targets.map((t) => t.accountId))];
  if (uniqueIds.length !== input.targets.length || uniqueIds.length > 20) throw new HttpError(422, "bad_targets", "Pick each account once, 20 at most.");

  let bytes: Uint8Array | null = null;
  let contentType: string | null = null;
  if (input.image) {
    try { bytes = fromB64(input.image.dataB64); } catch { throw new HttpError(422, "bad_image", "That image could not be read."); }
    if (bytes.length > SOCIAL_IMAGE_MAX_BYTES) throw new HttpError(422, "image_too_big", "Images can be up to 1 MB.");
    contentType = sniff(bytes);
    if (!contentType) throw new HttpError(422, "bad_image", "Use a JPEG or PNG image.");
  }

  const now = deps.now();
  let runAt = now;
  if (input.runAt) {
    const t = new Date(input.runAt);
    if (Number.isNaN(t.getTime())) throw new HttpError(422, "bad_time", "That time isn't valid.");
    if (t.getTime() > now.getTime() + SOCIAL_MAX_AHEAD_DAYS * 86_400_000) throw new HttpError(422, "too_far", `Posts can be set up to ${SOCIAL_MAX_AHEAD_DAYS} days ahead.`);
    if (t.getTime() > now.getTime()) runAt = t;
  }

  // Every account must belong to this workspace and be live: one platform read for all of them.
  let accounts;
  try { accounts = await cp.accounts(platformUserId(cp, auth.orgId)); } catch (err) { return toHttp(err); }
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const problems: TargetProblem[] = [];
  const rows = input.targets.map((t) => {
    const a = byId.get(t.accountId);
    const app = a?.toolkit?.slug ?? "";
    const code = !a || a.user_id !== platformUserId(cp, auth.orgId) || statusOf(a.status) !== "active" ? "account_gone" : checkTarget(app, text, !!bytes, t.target);
    if (code) problems.push({ accountId: t.accountId, code });
    return { accountId: t.accountId, app, label: a?.alias?.trim() || appLabel(app), target: (t.target ?? "").trim() || null, targetName: (t.targetName ?? "").trim().slice(0, 200) || null };
  });
  if (problems.length) throw new HttpError(422, "target_problems", "Some accounts can't take this post.", { problems });

  const postId = newId("sp");
  let mediaId: string | null = null;
  const writes: Promise<unknown>[] = [];
  if (bytes && contentType) {
    mediaId = newId("sm");
    await deps.db.insert(socialMedia).values({ id: mediaId, orgId: auth.orgId, token: randomToken(18), contentType, sizeBytes: bytes.length, contentB64: toB64(bytes), createdAt: now });
  }
  await deps.db.insert(socialPosts).values({ id: postId, orgId: auth.orgId, createdBy: auth.userId, text, mediaId, status: "scheduled", runAt, createdAt: now, updatedAt: now });
  writes.push(deps.db.insert(socialPostTargets).values(rows.map((r) => ({ postId, accountId: r.accountId, app: r.app, label: r.label, target: r.target, targetName: r.targetName, status: "pending" as const }))));
  writes.push(audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: runAt > now ? "social.post_scheduled" : "social.post_created", targetType: "social_post", targetId: postId, metadata: { accounts: rows.length, apps: [...new Set(rows.map((r) => r.app))], image: !!mediaId }, ip: opts.ip ?? null }));
  await Promise.all(writes);
  return getPost(deps, auth.orgId, postId);
}

export async function getPost(deps: Deps, orgId: string, id: string): Promise<SocialPostView> {
  const posts = await viewsFor(deps, orgId, [id]);
  if (!posts[0]) throw notFound("Post");
  return posts[0];
}

function mediaUrl(deps: Deps, m: { id: string; token: string } | undefined) {
  return m ? `${deps.config.appUrl}/api/social/media/${m.id}/${m.token}` : null;
}

async function viewsFor(deps: Deps, orgId: string, ids?: string[], limit = 50): Promise<SocialPostView[]> {
  const where = ids ? and(eq(socialPosts.orgId, orgId), inArray(socialPosts.id, ids)) : eq(socialPosts.orgId, orgId);
  const posts = await deps.db.select().from(socialPosts).where(where).orderBy(desc(socialPosts.runAt)).limit(limit).all();
  if (!posts.length) return [];
  const pIds = posts.map((p) => p.id);
  const mIds = posts.map((p) => p.mediaId).filter((x): x is string => !!x);
  const [targets, media] = await Promise.all([
    deps.db.select().from(socialPostTargets).where(inArray(socialPostTargets.postId, pIds)).all(),
    mIds.length ? deps.db.select({ id: socialMedia.id, token: socialMedia.token }).from(socialMedia).where(inArray(socialMedia.id, mIds)).all() : Promise.resolve([]),
  ]);
  const mById = new Map(media.map((m) => [m.id, m]));
  return posts.map((p) => ({
    id: p.id,
    text: p.text,
    imageUrl: p.mediaId ? mediaUrl(deps, mById.get(p.mediaId)) : null,
    status: p.status as PostStatus,
    runAt: p.runAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
    createdBy: p.createdBy,
    targets: targets.filter((t) => t.postId === p.id).map((t) => ({
      accountId: t.accountId, app: t.app, label: t.label, target: t.target, targetName: t.targetName, status: t.status as TargetStatus, url: t.url, error: t.error,
      sentAt: t.sentAt ? t.sentAt.toISOString() : null,
    })),
  }));
}

export async function listPosts(deps: Deps, auth: AuthContext): Promise<SocialPostView[]> {
  return viewsFor(deps, auth.orgId, undefined, 50);
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

/* ---------------------------------------------------------------- publishing */

interface PublishCtx { cp: Composio; userId: string; accountId: string; text: string; imageUrl: string | null; image: { b64: string; type: string } | null; target: string | null }
interface PublishResult { status: "sent" | "failed" | "skipped"; url?: string | null; error?: string | null }

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
  if (!r.ok) throw new PublishError("rejected", r.error ?? "rejected");
  return r.data;
}

class PublishError extends Error { constructor(public code: string, detail: string) { super(detail); } }

export const PUBLISHERS: Record<string, (ctx: PublishCtx) => Promise<PublishResult>> = {
  async facebook(ctx) {
    const data = ctx.imageUrl
      ? await run(ctx, "FACEBOOK_CREATE_PHOTO_POST", { page_id: ctx.target, url: ctx.imageUrl, message: ctx.text, published: true })
      : await run(ctx, "FACEBOOK_CREATE_POST", { page_id: ctx.target, message: ctx.text, published: true });
    const id = dig(data, ["post_id", "id"]);
    return { status: "sent", url: id ? `https://www.facebook.com/${id}` : null };
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
    const me = await run(ctx, "LINKEDIN_GET_MY_INFO", {});
    const raw = dig(me, ["author_id", "sub"]);
    if (!raw) throw new PublishError("rejected", "no author");
    const author = raw.startsWith("urn:") ? raw : `urn:li:person:${raw}`;
    const data = await run(ctx, "LINKEDIN_CREATE_LINKED_IN_POST", { author, commentary: ctx.text, visibility: "PUBLIC", lifecycleState: "PUBLISHED" });
    const id = dig(data, ["id", "post_id", "x-restli-id"]);
    return { status: "sent", url: id ? `https://www.linkedin.com/feed/update/${id}` : null };
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
  const cp = platform(deps);
  const [targets, media] = await Promise.all([
    deps.db.select().from(socialPostTargets).where(eq(socialPostTargets.postId, postId)).all(),
    post.mediaId ? deps.db.select().from(socialMedia).where(eq(socialMedia.id, post.mediaId)).get() : Promise.resolve(undefined),
  ]);
  const userId = platformUserId(cp, post.orgId);
  const imageUrl = media ? mediaUrl(deps, media) : null;
  const image = media ? { b64: media.contentB64, type: media.contentType } : null;
  // Accounts post one after another per post (networks rate limit by account), different accounts in parallel.
  await Promise.all(targets.filter((t) => t.status === "pending").map(async (t) => {
    let res: PublishResult;
    const pre = checkTarget(t.app, post.text, !!media, t.target);
    if (pre) res = { status: pre === "not_supported" ? "skipped" : "failed", error: pre };
    else {
      try { res = await PUBLISHERS[t.app]!({ cp, userId, accountId: t.accountId, text: post.text, imageUrl, image, target: t.target }); } catch (err) {
        const code = err instanceof PublishError ? err.code : (err instanceof HttpError && err.status === 404) ? "account_gone" : "unavailable";
        deps.log?.warn("social.publish_failed", { app: t.app, code, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        res = { status: "failed", error: code };
      }
    }
    await deps.db.update(socialPostTargets).set({ status: res.status, url: res.url ?? null, error: res.error ?? null, sentAt: res.status === "sent" ? deps.now() : null })
      .where(and(eq(socialPostTargets.postId, postId), eq(socialPostTargets.accountId, t.accountId)));
  }));
  const after = await deps.db.select({ status: socialPostTargets.status }).from(socialPostTargets).where(eq(socialPostTargets.postId, postId)).all();
  const sent = after.filter((t) => t.status === "sent").length;
  const status: PostStatus = sent === after.length ? "done" : sent > 0 ? "partial" : "failed";
  await deps.db.update(socialPosts).set({ status, updatedAt: deps.now(), attempts: sql`${socialPosts.attempts} + 1` }).where(eq(socialPosts.id, postId));
  return status;
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
  const old = await deps.db.select({ mediaId: socialPosts.mediaId }).from(socialPosts)
    .where(and(scope, inArray(socialPosts.status, ["done", "partial", "failed", "canceled"]), lt(socialPosts.updatedAt, new Date(now.getTime() - MEDIA_TTL_MS)), sql`${socialPosts.mediaId} is not null`)).limit(50).all();
  const mIds = old.map((o) => o.mediaId!).filter(Boolean);
  if (mIds.length) {
    await deps.db.delete(socialMedia).where(inArray(socialMedia.id, mIds));
    await deps.db.update(socialPosts).set({ mediaId: null }).where(inArray(socialPosts.mediaId, mIds));
  }
  return { mediaPruned: mIds.length };
}

/** The public image a network fetches while posting. */
export async function readMedia(deps: Deps, id: string, token: string) {
  if (!/^[\w-]{1,64}$/.test(id) || !/^[\w-]{8,64}$/.test(token)) return null;
  const m = await deps.db.select().from(socialMedia).where(eq(socialMedia.id, id)).get();
  if (!m || m.token !== token) return null;
  return { bytes: fromB64(m.contentB64), contentType: m.contentType };
}

