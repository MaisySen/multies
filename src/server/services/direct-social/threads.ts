/**
 * R83: Threads, through our own app. Sign in at threads.net (threads_basic, threads_content_publish), swap the short
 * token for a long lived one (60 days) and refresh it when it is past a day old and within 10 days of its end.
 * Posts are text or one image (the image is served from our own public media link, like Social posts).
 * Threads has no token revoke call: disconnecting removes our copy, and the person can also remove the app in Threads.
 */
import type { AuthContext, Deps } from "../../context";
import { socialMedia } from "../../db/schema";
import { hmacSha256Hex, newId, randomToken, safeEqual } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import type { ThreadsPostView } from "../../../shared/direct-social";
import { THREADS_TEXT_MAX } from "../../../shared/direct-social";
import { SOCIAL_IMAGE_MAX_BYTES, SOCIAL_IMAGE_TYPES } from "../../../shared/integrations";
import {
  accessToken, deleteByProviderUser, DirectError, getLink, makeState, markExpired, readState, redirectUri, saveLink, updateTokens, type LinkRow,
} from "./store";

export const THREADS_SCOPES = ["threads_basic", "threads_content_publish"];
const V = "v1.0";

function cfg(deps: Deps) {
  const t = deps.config.direct.threads;
  if (!t) throw new HttpError(503, "not_configured", "Threads isn't switched on here yet.");
  return t;
}

export async function threadsStart(deps: Deps, auth: AuthContext, nonce?: string) {
  const t = cfg(deps);
  const state = await makeState(deps, auth, "threads", randomToken(8), nonce);
  const q = new URLSearchParams({ client_id: t.appId, redirect_uri: redirectUri(deps, "threads"), scope: THREADS_SCOPES.join(","), response_type: "code", state });
  if (new URL(t.authUrl).hostname === "threads.mock") return `${redirectUri(deps, "threads")}?${new URLSearchParams({ code: "mock-code", state })}`;
  return `${t.authUrl}?${q}`;
}

interface GraphError { error?: { message?: string; code?: number; type?: string; error_subcode?: number } }

async function graph<T>(deps: Deps, url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; json: T & GraphError }> {
  const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const json = (await res.json().catch(() => ({}))) as T & GraphError;
  return { ok: res.ok && !json.error, status: res.status, json };
}

const inSec = (deps: Deps, s: number | undefined) => (s ? new Date(deps.now().getTime() + s * 1000) : null);

export async function threadsFinish(deps: Deps, auth: AuthContext, code: string, stateRaw: string, nonce?: string | null) {
  const t = cfg(deps);
  await readState(deps, auth, "threads", stateRaw, nonce);
  const short = await graph<{ access_token?: string; user_id?: string | number }>(deps, `${t.apiBase}/oauth/access_token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: t.appId, client_secret: t.appSecret, grant_type: "authorization_code", redirect_uri: redirectUri(deps, "threads"), code: code.replace(/#_$/, "") }),
  });
  if (!short.ok || !short.json.access_token) {
    deps.log?.warn("threads.token_failed", { status: short.status, code: short.json.error?.code ?? null });
    throw new DirectError("unavailable", "Threads didn't finish the sign in. Try again.", 400);
  }
  const long = await graph<{ access_token?: string; expires_in?: number }>(deps, `${t.apiBase}/access_token?${new URLSearchParams({ grant_type: "th_exchange_token", client_secret: t.appSecret, access_token: short.json.access_token })}`);
  const token = long.ok && long.json.access_token ? long.json.access_token : short.json.access_token;
  const expires = long.ok && long.json.access_token ? inSec(deps, long.json.expires_in ?? 60 * 86400) : inSec(deps, 3600);
  const me = await graph<{ id?: string; username?: string; name?: string; threads_profile_picture_url?: string }>(deps, `${t.apiBase}/${V}/me?${new URLSearchParams({ fields: "id,username,name,threads_profile_picture_url", access_token: token })}`);
  const userId = String(me.json.id ?? short.json.user_id ?? "");
  if (!userId) throw new DirectError("unavailable", "Threads didn't say which account signed in. Try again.", 400);
  await saveLink(deps, auth, "threads", {
    providerUserId: userId, username: me.json.username ?? null, displayName: me.json.name ?? me.json.username ?? null, avatarUrl: me.json.threads_profile_picture_url ?? null,
    accessToken: token, refreshToken: null, accessExpiresAt: expires, refreshExpiresAt: null, scopes: THREADS_SCOPES.join(","),
  });
  return { username: me.json.username ?? null };
}

async function linkOrThrow(deps: Deps, auth: AuthContext) {
  const link = await getLink(deps, auth.orgId, "threads");
  if (!link) throw new DirectError("not_connected", "Connect Threads first.", 409);
  if (link.accessExpiresAt && link.accessExpiresAt.getTime() <= deps.now().getTime()) {
    await markExpired(deps, link.id);
    throw new DirectError("expired", "The Threads sign in expired. Connect Threads again.", 409);
  }
  return link;
}

/** A long lived token is refreshed once it is a day old and has under 10 days left (Threads allows a refresh after 24 h). */
async function token(deps: Deps, link: LinkRow) {
  const t = cfg(deps);
  const tok = await accessToken(deps, link);
  const left = link.accessExpiresAt ? link.accessExpiresAt.getTime() - deps.now().getTime() : Infinity;
  const age = deps.now().getTime() - link.updatedAt.getTime();
  if (left < 10 * 86400_000 && age > 86400_000) {
    const r = await graph<{ access_token?: string; expires_in?: number }>(deps, `${t.apiBase}/refresh_access_token?${new URLSearchParams({ grant_type: "th_refresh_token", access_token: tok })}`);
    if (r.ok && r.json.access_token) {
      await updateTokens(deps, link.id, { accessToken: r.json.access_token, accessExpiresAt: inSec(deps, r.json.expires_in ?? 60 * 86400) });
      return r.json.access_token;
    }
  }
  return tok;
}

function fail(deps: Deps, what: string, r: { status: number; json: GraphError }): never {
  deps.log?.warn("threads.api_failed", { what, status: r.status, code: r.json.error?.code ?? null });
  if (r.json.error?.code === 190) throw new DirectError("expired", "The Threads sign in expired. Connect Threads again.", 409);
  if (r.status === 429 || r.json.error?.code === 4 || r.json.error?.code === 17) throw new DirectError("rate_limited", "Threads asked us to slow down. Try again in a few minutes.", 429);
  if (r.status >= 500) throw new DirectError("unavailable", "Threads didn't answer. Try again in a moment.");
  throw new DirectError("rejected", "Threads turned that down. Check the text and the image, then try again.", 400);
}

export async function threadsProfile(deps: Deps, auth: AuthContext) {
  const link = await linkOrThrow(deps, auth);
  const t = cfg(deps);
  const tok = await token(deps, link);
  const [me, posts] = await Promise.all([
    graph<{ id?: string; username?: string; name?: string; threads_profile_picture_url?: string; threads_biography?: string }>(deps, `${t.apiBase}/${V}/me?${new URLSearchParams({ fields: "id,username,name,threads_profile_picture_url,threads_biography", access_token: tok })}`),
    graph<{ data?: { id: string; text?: string; permalink?: string; media_type?: string; media_url?: string; timestamp?: string }[] }>(deps, `${t.apiBase}/${V}/me/threads?${new URLSearchParams({ fields: "id,text,permalink,media_type,media_url,timestamp", limit: "10", access_token: tok })}`),
  ]);
  if (!me.ok) fail(deps, "me", me);
  const list: ThreadsPostView[] = (posts.ok ? posts.json.data ?? [] : []).map((p) => ({
    id: String(p.id), text: p.text ?? null, permalink: p.permalink ?? null, mediaType: p.media_type ?? null, mediaUrl: p.media_url ?? null, createdAt: p.timestamp ? new Date(p.timestamp).toISOString() : null,
  }));
  return {
    profile: { id: String(me.json.id ?? link.providerUserId), username: me.json.username ?? link.username, name: me.json.name ?? link.displayName, avatarUrl: me.json.threads_profile_picture_url ?? link.avatarUrl, bio: me.json.threads_biography ?? null },
    posts: list,
  };
}

export interface ThreadsPostInput { text: string; /** R117: an image already served from our media link (scheduled posts). */ imageUrl?: string | null; image?: { bytes: Uint8Array<ArrayBuffer>; type: string } | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Creates a container, waits for an image to be ready (a few seconds at most), publishes, then reads the link. */
export async function threadsPost(deps: Deps, auth: AuthContext, input: ThreadsPostInput, opts: { pollMs?: number } = {}) {
  const link = await linkOrThrow(deps, auth);
  const t = cfg(deps);
  const text = input.text.trim();
  if (!text && !input.image && !input.imageUrl) throw new HttpError(400, "empty", "Write something or add an image.");
  if ([...text].length > THREADS_TEXT_MAX) throw new HttpError(400, "too_long", `Threads allows ${THREADS_TEXT_MAX} characters.`);
  let imageUrl: string | null = input.imageUrl ?? null;
  if (input.image && !imageUrl) {
    if (!(SOCIAL_IMAGE_TYPES as readonly string[]).includes(input.image.type)) throw new HttpError(400, "bad_file", "Pick a JPG or PNG image.");
    if (input.image.bytes.byteLength > SOCIAL_IMAGE_MAX_BYTES) throw new HttpError(413, "too_big", "That image is over 1 MB.");
    const id = newId("sm"); const tokenStr = randomToken(18);
    let bin = ""; const b = input.image.bytes; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
    await deps.db.insert(socialMedia).values({ id, orgId: auth.orgId, token: tokenStr, contentType: input.image.type, sizeBytes: b.byteLength, contentB64: btoa(bin), createdAt: deps.now() });
    imageUrl = `${deps.config.appUrl}/api/social/media/${id}/${tokenStr}`;
  }
  const tok = await token(deps, link);
  const uid = encodeURIComponent(link.providerUserId);
  const body = new URLSearchParams({ media_type: imageUrl ? "IMAGE" : "TEXT", ...(text ? { text } : {}), ...(imageUrl ? { image_url: imageUrl } : {}), access_token: tok });
  const made = await graph<{ id?: string }>(deps, `${t.apiBase}/${V}/${uid}/threads`, { method: "POST", body });
  if (!made.ok || !made.json.id) fail(deps, "create", made);
  if (imageUrl) {
    const poll = opts.pollMs ?? 2000;
    for (let i = 0; i < 8; i++) {
      const st = await graph<{ status?: string }>(deps, `${t.apiBase}/${V}/${made.json.id}?${new URLSearchParams({ fields: "status", access_token: tok })}`);
      if (st.json.status === "FINISHED" || st.json.status === "PUBLISHED") break;
      if (st.json.status === "ERROR" || st.json.status === "EXPIRED") throw new DirectError("rejected", "Threads couldn't use that image. Try another one.", 400);
      await sleep(poll);
    }
  }
  const pub = await graph<{ id?: string }>(deps, `${t.apiBase}/${V}/${uid}/threads_publish`, { method: "POST", body: new URLSearchParams({ creation_id: made.json.id!, access_token: tok }) });
  if (!pub.ok || !pub.json.id) fail(deps, "publish", pub);
  const pl = await graph<{ permalink?: string }>(deps, `${t.apiBase}/${V}/${pub.json.id}?${new URLSearchParams({ fields: "permalink", access_token: tok })}`);
  return { id: String(pub.json.id), permalink: pl.json.permalink ?? null };
}

/* ------------------------------------------------------------ uninstall and delete callbacks (signed_request) */

function b64urlDecode(s: string) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
}

/** Checks a signed_request with the app secret. Returns its payload, or null when the signature does not match. */
export async function verifySignedRequest(signed: string, secret: string): Promise<{ user_id?: string; algorithm?: string; issued_at?: number } | null> {
  const [sig, payload] = signed.split(".", 2);
  if (!sig || !payload) return null;
  let raw: string;
  try { raw = b64urlDecode(sig); } catch { return null; }
  const got = [...raw].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const want = await hmacSha256Hex(secret, payload);
  if (!safeEqual(got, want)) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(b64urlDecode(payload), (c) => c.charCodeAt(0)))) as { user_id?: string; algorithm?: string; issued_at?: number };
    if (data.algorithm && data.algorithm.toUpperCase() !== "HMAC-SHA256") return null;
    return data;
  } catch { return null; }
}

/**
 * Threads uninstall and data deletion callbacks POST signed_request to /delete-account. A valid one removes every
 * workspace's link to that Threads account and answers with a confirmation code and a status link (the format the
 * deletion callback wants). A bad signature answers 400.
 */
export async function handleThreadsCallback(deps: Deps, signed: string) {
  const t = deps.config.direct.threads;
  if (!t) return { status: 404 as const };
  const data = await verifySignedRequest(signed, t.appSecret);
  if (!data?.user_id) return { status: 400 as const };
  const removed = await deleteByProviderUser(deps, "threads", String(data.user_id));
  const code = `th${randomToken(9).replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}`;
  deps.log?.info("threads.deauthorized", { links: removed.length });
  return { status: 200 as const, body: { url: `${deps.config.appUrl}/delete-account?code=${code}`, confirmation_code: code }, removed: removed.length };
}

/** R118: views and interactions of one Threads post, for Social analytics (null when Threads is not linked). */
export async function threadsInsights(deps: Deps, orgId: string, mediaId: string): Promise<{ reach: number | null; engagement: number | null; clicks: null } | null> {
  const t = deps.config.direct.threads;
  if (!t) return null;
  const { getLink } = await import("./store");
  const link = await getLink(deps, orgId, "threads");
  if (!link || link.status === "expired") return null;
  const tok = await token(deps, link);
  const r = await graph<{ data?: { name?: string; values?: { value?: number }[]; total_value?: { value?: number } }[] }>(deps, `${t.apiBase}/${encodeURIComponent(mediaId)}/insights?metric=views,likes,replies,reposts,quotes&access_token=${encodeURIComponent(tok)}`);
  if (!r.ok) return null;
  const v = (name: string) => { const m = (r.json.data ?? []).find((x) => x.name === name); const n = m?.values?.[0]?.value ?? m?.total_value?.value; return typeof n === "number" ? n : null; };
  const parts = ["likes", "replies", "reposts", "quotes"].map(v);
  return { reach: v("views"), engagement: parts.every((x) => x == null) ? null : parts.reduce<number>((a, b) => a + (b ?? 0), 0), clicks: null };
}
