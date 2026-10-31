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
  const where = ids ? and(eq(socialPosts.orgId, orgId), inIds(socialPosts.id, ids)) : eq(socialPosts.orgId, orgId);
  const posts = await deps.db.select().from(socialPosts).where(where).orderBy(desc(socialPosts.runAt)).limit(limit).all();
  if (!posts.length) return [];
  const pIds = posts.map((p) => p.id);
  const mIds = posts.map((p) => p.mediaId).filter((x): x is string => !!x);
  const [targets, media] = await Promise.all([
    deps.db.select().from(socialPostTargets).where(inIds(socialPostTargets.postId, pIds)).all(),
    mIds.length ? deps.db.select({ id: socialMedia.id, token: socialMedia.token }).from(socialMedia).where(inIds(socialMedia.id, mIds)).all() : Promise.resolve([]),
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
      accountId: t.accountId, app: t.app, label: t.label, target: t.target, targetName: t.targetName, status: t.status as TargetStatus,
      url: t.networkState === "removed" ? null : openableFacebookUrl(t.url), error: t.error,
      sentAt: t.sentAt ? t.sentAt.toISOString() : null,
      networkState: t.networkState ?? null, checkedAt: t.checkedAt ? t.checkedAt.toISOString() : null,
      canCheck: (SOCIAL_CAN_CHECK as readonly string[]).includes(t.app), canDelete: (SOCIAL_CAN_DELETE as readonly string[]).includes(t.app),
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

interface PublishCtx { cp: Composio; userId: string; accountId: string; text: string; imageUrl: string | null; image: { b64: string; type: string } | null; target: string | null; now?: Date }
interface PublishResult { status: "sent" | "failed" | "skipped"; url?: string | null; error?: string | null; remoteId?: string | null }

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
    const data = ctx.imageUrl
      ? await graph(ctx, "POST", `${page}/photos`, { url: ctx.imageUrl, caption: ctx.text, published: true, access_token: pageToken })
      : await graph(ctx, "POST", `${page}/feed`, { message: ctx.text, ...(link ? { link } : {}), published: true, access_token: pageToken });
    const id = dig(data, ["post_id", "id"]);
    return { status: "sent", url: id ? await facebookPermalink(ctx, ctx.target, id, pageToken) : null, remoteId: id };
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
      try { res = await PUBLISHERS[t.app]!({ cp, userId, accountId: t.accountId, text: post.text, imageUrl, image, target: t.target, now: deps.now() }); } catch (err) {
        const code = err instanceof PublishError ? err.code : (err instanceof HttpError && err.status === 404) ? "account_gone" : "unavailable";
        deps.log?.warn("social.publish_failed", { app: t.app, code, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        res = { status: "failed", error: err instanceof PublishError ? storedError(err) : code };
      }
    }
    await deps.db.update(socialPostTargets).set({ status: res.status, url: res.url ?? null, error: res.error ?? null, sentAt: res.status === "sent" ? deps.now() : null, remoteId: res.remoteId ?? null, networkState: res.status === "sent" ? "live" : null, checkedAt: res.status === "sent" ? deps.now() : null })
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
    await deps.db.delete(socialMedia).where(inIds(socialMedia.id, mIds));
    await deps.db.update(socialPosts).set({ mediaId: null }).where(inIds(socialPosts.mediaId, mIds));
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
