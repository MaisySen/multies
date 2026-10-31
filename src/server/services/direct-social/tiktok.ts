/**
 * R83: TikTok, through our own app: Login Kit v2 (with PKCE), Content Posting (Direct Post, file upload) and the
 * video list. Scopes: user.info.basic, video.upload, video.publish, video.list. Access tokens last a day and are
 * refreshed with the refresh token (a year); disconnecting revokes the token at TikTok.
 * Direct Post follows TikTok's UX rules: the form reads creator_info first, shows the creator's nickname, offers only
 * the privacy levels creator_info allows (no default), and the interaction toggles it does not lock.
 */
import { and, desc, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { directSocialPublishes } from "../../db/schema";
import { newId, randomToken } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import type { TikTokCreatorInfo, TikTokPrivacy, TikTokPublishView, TikTokVideoView } from "../../../shared/direct-social";
import { TIKTOK_TITLE_MAX, TIKTOK_VIDEO_MAX_BYTES, TIKTOK_VIDEO_TYPES } from "../../../shared/direct-social";
import {
  accessToken, challengeHex, DirectError, getLink, makeState, markExpired, readState, redirectUri, refreshToken, saveLink,
  updateTokens, type LinkRow,
} from "./store";

export const TIKTOK_SCOPES = ["user.info.basic", "video.upload", "video.publish", "video.list"];

function cfg(deps: Deps) {
  const t = deps.config.direct.tiktok;
  if (!t) throw new HttpError(503, "not_configured", "TikTok isn't switched on here yet.");
  return t;
}

export async function tiktokStart(deps: Deps, auth: AuthContext) {
  const t = cfg(deps);
  const verifier = randomToken(48);
  const state = await makeState(deps, auth, "tiktok", verifier);
  const q = new URLSearchParams({
    client_key: t.clientKey, response_type: "code", scope: TIKTOK_SCOPES.join(","), redirect_uri: redirectUri(deps, "tiktok"), state,
    code_challenge: await challengeHex(verifier), code_challenge_method: "S256",
  });
  return `${t.authUrl}?${q}`;
}

interface TokenJson { access_token?: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number; open_id?: string; scope?: string; error?: string; error_description?: string }

async function tokenCall(deps: Deps, body: Record<string, string>): Promise<TokenJson> {
  const t = cfg(deps);
  const res = await deps.fetch(`${t.apiBase}/v2/oauth/token/`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
    body: new URLSearchParams({ client_key: t.clientKey, client_secret: t.clientSecret, ...body }), signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenJson;
  if (!res.ok || !json.access_token) {
    deps.log?.warn("tiktok.token_failed", { status: res.status, error: json.error ?? null });
    throw new DirectError(json.error === "invalid_grant" ? "expired" : "unavailable", json.error === "invalid_grant" ? "The sign in expired or was withdrawn. Connect TikTok again." : "TikTok didn't finish the sign in. Try again.", 400);
  }
  return json;
}

const inSec = (deps: Deps, s: number | undefined) => (s ? new Date(deps.now().getTime() + s * 1000) : null);

interface ApiEnvelope<T> { data?: T; error?: { code?: string; message?: string; log_id?: string } }

/** One call to TikTok's API with the link's token. A 401 refreshes once and retries. */
async function api<T>(deps: Deps, link: LinkRow, path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}, retried = false): Promise<T> {
  const t = cfg(deps);
  const token = await freshToken(deps, link);
  const url = `${t.apiBase}${path}${init.query ? `?${new URLSearchParams(init.query)}` : ""}`;
  const res = await deps.fetch(url, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json; charset=UTF-8" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  const code = json.error?.code ?? (res.ok ? "ok" : "unknown");
  if (res.status === 401 || code === "access_token_invalid") {
    if (!retried) { link.accessExpiresAt = new Date(0); return api<T>(deps, link, path, init, true); }
    await markExpired(deps, link.id);
    throw new DirectError("expired", "The TikTok sign in expired. Connect TikTok again.", 409);
  }
  if (code !== "ok" || !res.ok) {
    deps.log?.warn("tiktok.api_failed", { path, status: res.status, code });
    if (code === "spam_risk_too_many_posts" || code === "spam_risk_user_banned_from_posting" || code === "reached_active_user_cap") throw new DirectError("spam_risk", "TikTok limits how many posts an account can make a day. Try again tomorrow.", 429);
    if (res.status === 429 || code === "rate_limit_exceeded") throw new DirectError("rate_limited", "TikTok asked us to slow down. Try again in a few minutes.", 429);
    if (code === "scope_not_authorized") throw new DirectError("expired", "TikTok needs more permission. Connect TikTok again and allow every option.", 409);
    if (code === "privacy_level_option_mismatch" || code === "unaudited_client_can_only_post_to_private_accounts") throw new DirectError("privacy", code === "privacy_level_option_mismatch" ? "Pick one of the audiences TikTok offers." : "Until TikTok reviews this app, videos can only be posted as Only me, from a private account.", 400);
    throw new DirectError(res.status >= 500 ? "unavailable" : "rejected", res.status >= 500 ? "TikTok didn't answer. Try again in a moment." : "TikTok turned that down. Check the video and try again.", res.status >= 500 ? 502 : 400);
  }
  return json.data as T;
}

/** A token good for at least a minute, refreshed when it is not. */
async function freshToken(deps: Deps, link: LinkRow) {
  const left = link.accessExpiresAt ? link.accessExpiresAt.getTime() - deps.now().getTime() : Infinity;
  if (left > 60_000) return accessToken(deps, link);
  const rt = await refreshToken(deps, link);
  if (!rt) { await markExpired(deps, link.id); throw new DirectError("expired", "The TikTok sign in expired. Connect TikTok again.", 409); }
  let t: TokenJson;
  try { t = await tokenCall(deps, { grant_type: "refresh_token", refresh_token: rt }); } catch (err) {
    if (err instanceof DirectError && err.reason === "expired") await markExpired(deps, link.id);
    throw err;
  }
  const accessExpiresAt = inSec(deps, t.expires_in);
  await updateTokens(deps, link.id, { accessToken: t.access_token!, refreshToken: t.refresh_token ?? null, accessExpiresAt, refreshExpiresAt: inSec(deps, t.refresh_expires_in) });
  link.accessExpiresAt = accessExpiresAt;
  return t.access_token!;
}

interface UserInfo { user?: { open_id?: string; display_name?: string; avatar_url?: string } }
interface RawCreator {
  creator_avatar_url?: string; creator_username?: string; creator_nickname?: string; privacy_level_options?: string[];
  comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean; max_video_post_duration_sec?: number;
}

/** Finishes the sign in: state, code for tokens, then who the account is. */
export async function tiktokFinish(deps: Deps, auth: AuthContext, code: string, stateRaw: string) {
  const s = await readState(deps, auth, "tiktok", stateRaw);
  const t = await tokenCall(deps, { grant_type: "authorization_code", code, redirect_uri: redirectUri(deps, "tiktok"), code_verifier: s.v });
  if (!t.open_id) throw new DirectError("unavailable", "TikTok didn't say which account signed in. Try again.", 400);
  const granted = (t.scope ?? "").split(/[ ,]+/).filter(Boolean);
  // Use the token straight away for the profile, before anything is written.
  const peek = async <T>(path: string, init?: Parameters<typeof api>[3]) => {
    const res = await deps.fetch(`${cfg(deps).apiBase}${path}${init?.query ? `?${new URLSearchParams(init.query)}` : ""}`, {
      method: init?.method ?? "GET", headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json; charset=UTF-8" },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
    return res.ok && (j.error?.code ?? "ok") === "ok" ? j.data ?? null : null;
  };
  const [info, creator] = await Promise.all([
    peek<UserInfo>("/v2/user/info/", { query: { fields: "open_id,display_name,avatar_url" } }),
    granted.includes("video.publish") ? peek<RawCreator>("/v2/post/publish/creator_info/query/", { method: "POST", body: {} }) : Promise.resolve(null),
  ]);
  await saveLink(deps, auth, "tiktok", {
    providerUserId: t.open_id,
    username: creator?.creator_username ?? null,
    displayName: creator?.creator_nickname ?? info?.user?.display_name ?? null,
    avatarUrl: info?.user?.avatar_url ?? creator?.creator_avatar_url ?? null,
    accessToken: t.access_token!, refreshToken: t.refresh_token ?? null,
    accessExpiresAt: inSec(deps, t.expires_in), refreshExpiresAt: inSec(deps, t.refresh_expires_in), scopes: granted.join(","),
  });
  return { username: creator?.creator_username ?? info?.user?.display_name ?? null, missing: TIKTOK_SCOPES.filter((x) => !granted.includes(x)) };
}

async function linkOrThrow(deps: Deps, auth: AuthContext) {
  const link = await getLink(deps, auth.orgId, "tiktok");
  if (!link) throw new DirectError("not_connected", "Connect TikTok first.", 409);
  return link;
}

const PRIVACY: TikTokPrivacy[] = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];

export async function creatorInfo(deps: Deps, auth: AuthContext): Promise<TikTokCreatorInfo> {
  const link = await linkOrThrow(deps, auth);
  const c = await api<RawCreator>(deps, link, "/v2/post/publish/creator_info/query/", { method: "POST", body: {} });
  return {
    nickname: c.creator_nickname ?? link.displayName ?? "",
    username: c.creator_username ?? link.username ?? "",
    avatarUrl: c.creator_avatar_url ?? link.avatarUrl ?? null,
    privacyOptions: (c.privacy_level_options ?? []).filter((p): p is TikTokPrivacy => PRIVACY.includes(p as TikTokPrivacy)),
    commentDisabled: !!c.comment_disabled, duetDisabled: !!c.duet_disabled, stitchDisabled: !!c.stitch_disabled,
    maxDurationSec: c.max_video_post_duration_sec ?? 600,
  };
}

interface RawVideo { id?: string; title?: string; video_description?: string; cover_image_url?: string; share_url?: string; create_time?: number; duration?: number; view_count?: number; like_count?: number }

export async function listVideos(deps: Deps, auth: AuthContext): Promise<TikTokVideoView[]> {
  const link = await linkOrThrow(deps, auth);
  const d = await api<{ videos?: RawVideo[] }>(deps, link, "/v2/video/list/", {
    method: "POST", query: { fields: "id,title,video_description,cover_image_url,share_url,create_time,duration,view_count,like_count" }, body: { max_count: 20 },
  });
  return (d?.videos ?? []).filter((v) => v.id).map((v) => ({
    id: String(v.id), title: v.title || v.video_description || "", coverUrl: v.cover_image_url ?? null, shareUrl: v.share_url ?? null,
    createdAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : null, durationSec: v.duration ?? null,
    views: v.view_count ?? null, likes: v.like_count ?? null,
  }));
}

export interface PostInput {
  title: string;
  privacy: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** Commercial content disclosure: promoting yourself (brand_organic) and or a third party (brand_content). */
  yourBrand: boolean;
  brandedContent: boolean;
  consent: boolean;
  file: { bytes: Uint8Array<ArrayBuffer>; type: string };
}

/** Direct Post with a file upload: init, then one PUT of the whole file. TikTok then processes it on its side. */
export async function postVideo(deps: Deps, auth: AuthContext, input: PostInput): Promise<TikTokPublishView> {
  const link = await linkOrThrow(deps, auth);
  if (!input.consent) throw new DirectError("consent", "Agree to TikTok's music terms first.", 400);
  if (!(TIKTOK_VIDEO_TYPES as readonly string[]).includes(input.file.type)) throw new HttpError(400, "bad_file", "Pick an MP4, MOV or WebM video.");
  const size = input.file.bytes.byteLength;
  if (!size) throw new HttpError(400, "bad_file", "That video file is empty.");
  if (size > TIKTOK_VIDEO_MAX_BYTES) throw new HttpError(413, "too_big", "That video is over 50 MB. Pick a shorter one.");
  // TikTok's rules: read creator_info right before posting and only send a level it offers.
  const info = await creatorInfo(deps, auth);
  const privacy = input.privacy as TikTokPrivacy;
  if (!info.privacyOptions.includes(privacy)) throw new DirectError("privacy", "Pick one of the audiences TikTok offers.", 400);
  if (input.brandedContent && privacy === "SELF_ONLY") throw new DirectError("branded_private", "Branded content can't be private. Pick another audience.", 400);
  const title = input.title.slice(0, TIKTOK_TITLE_MAX);
  const init = await api<{ publish_id?: string; upload_url?: string }>(deps, link, "/v2/post/publish/video/init/", {
    method: "POST",
    body: {
      post_info: {
        title, privacy_level: privacy,
        disable_comment: info.commentDisabled || !input.allowComment,
        disable_duet: info.duetDisabled || !input.allowDuet,
        disable_stitch: info.stitchDisabled || !input.allowStitch,
        brand_content_toggle: input.brandedContent, brand_organic_toggle: input.yourBrand,
      },
      source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 },
    },
  });
  if (!init?.publish_id || !init.upload_url) throw new DirectError("unavailable", "TikTok didn't start the upload. Try again.");
  const put = await deps.fetch(init.upload_url, {
    method: "PUT", headers: { "content-type": input.file.type, "content-length": String(size), "content-range": `bytes 0-${size - 1}/${size}` },
    body: input.file.bytes, signal: AbortSignal.timeout(120_000),
  });
  const now = deps.now();
  const row = { id: newId("dsp"), orgId: auth.orgId, provider: "tiktok", publishId: init.publish_id, title, status: put.ok ? "processing" as const : "failed" as const, error: put.ok ? null : "upload_failed", createdBy: auth.userId, createdAt: now, updatedAt: now };
  await deps.db.insert(directSocialPublishes).values(row);
  if (!put.ok) {
    deps.log?.warn("tiktok.upload_failed", { status: put.status });
    throw new DirectError("unavailable", "The upload to TikTok didn't finish. Try again.");
  }
  return publishView(row);
}

function publishView(r: { id: string; publishId: string; title: string | null; status: TikTokPublishView["status"]; error: string | null; createdAt: Date }): TikTokPublishView {
  return { id: r.id, publishId: r.publishId, title: r.title, status: r.status, error: r.error, createdAt: r.createdAt.toISOString() };
}

const STATUS_MAP: Record<string, TikTokPublishView["status"]> = {
  PROCESSING_UPLOAD: "processing", PROCESSING_DOWNLOAD: "processing", SEND_TO_USER_INBOX: "processing", PUBLISH_COMPLETE: "published", FAILED: "failed",
};

/** Recent posts from this workspace, each brought up to date with TikTok's status while it is still processing. */
export async function listPublishes(deps: Deps, auth: AuthContext): Promise<TikTokPublishView[]> {
  const rows = await deps.db.select().from(directSocialPublishes).where(and(eq(directSocialPublishes.orgId, auth.orgId), eq(directSocialPublishes.provider, "tiktok")))
    .orderBy(desc(directSocialPublishes.createdAt)).limit(10).all();
  const pending = rows.filter((r) => r.status === "processing" && deps.now().getTime() - r.createdAt.getTime() < 24 * 3600_000).slice(0, 3);
  if (pending.length) {
    const link = await getLink(deps, auth.orgId, "tiktok");
    if (link) {
      await Promise.all(pending.map(async (r) => {
        try {
          const d = await api<{ status?: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>(deps, link, "/v2/post/publish/status/fetch/", { method: "POST", body: { publish_id: r.publishId } });
          const status = STATUS_MAP[d?.status ?? ""] ?? r.status;
          if (status !== r.status) {
            const postId = d?.publicaly_available_post_id?.[0] != null ? String(d.publicaly_available_post_id[0]) : null;
            await setPublishStatus(deps, r.publishId, status, { error: d?.fail_reason ?? null, postId });
            r.status = status; r.error = d?.fail_reason ?? null;
          }
        } catch { /* keep the stored status; the webhook may still settle it */ }
      }));
    }
  }
  return rows.map(publishView);
}

export async function setPublishStatus(deps: Deps, publishId: string, status: TikTokPublishView["status"], extra: { error?: string | null; postId?: string | null } = {}) {
  await deps.db.update(directSocialPublishes).set({ status, updatedAt: deps.now(), ...(extra.error !== undefined ? { error: extra.error } : {}), ...(extra.postId ? { postId: extra.postId } : {}) })
    .where(and(eq(directSocialPublishes.provider, "tiktok"), eq(directSocialPublishes.publishId, publishId)));
}

/** Revokes the token at TikTok (best effort; the link goes either way). */
export async function revokeTikTok(deps: Deps, link: LinkRow) {
  const t = deps.config.direct.tiktok;
  if (!t) return false;
  try {
    const token = await accessToken(deps, link);
    const res = await deps.fetch(`${t.apiBase}/v2/oauth/revoke/`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_key: t.clientKey, client_secret: t.clientSecret, token }), signal: AbortSignal.timeout(8_000),
    });
    return res.ok;
  } catch { return false; }
}
