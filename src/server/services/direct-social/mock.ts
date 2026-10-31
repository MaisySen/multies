/**
 * R83: a stand in for TikTok's and Threads' APIs, for unit tests and local end to end runs only. The node entry
 * uses it when TIKTOK_API_BASE is https://tiktok.mock (or THREADS_API_BASE is https://threads.mock) AND APP_URL
 * points at localhost; it is never wired into the Workers entry. The sign in start skips the consent page and comes
 * straight back with a code. A title or text containing "FAIL" is turned down by the network.
 */
export const MOCK_TIKTOK_HOST = "tiktok.mock";
export const MOCK_THREADS_HOST = "threads.mock";

export interface MockDirectState {
  calls: string[];
  /** Tokens TikTok still honours (revoke removes one). */
  tiktokTokens: Set<string>;
  publishes: Map<string, { title: string; privacy: string; uploaded: number; status: string }>;
  videos: { id: string; title: string; create_time: number }[];
  threadsPosts: { id: string; text: string; media_type: string; timestamp: string }[];
  /** The next TikTok access token answers 401 once (to test the refresh). */
  expireNextTikTok: boolean;
  privacyOptions: string[];
  verifier?: string;
  containers: Map<string, { text: string; media_type: string }>;
}

export function newMockDirectState(): MockDirectState {
  return { calls: [], tiktokTokens: new Set(), publishes: new Map(), videos: [], threadsPosts: [], containers: new Map(), expireNextTikTok: false, privacyOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"] };
}

export function mockDirectAllowed(env: Record<string, string | undefined>) {
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(env.APP_URL ?? "");
  const host = (v?: string) => { try { return v ? new URL(v).hostname : ""; } catch { return ""; } };
  return local && (host(env.TIKTOK_API_BASE) === MOCK_TIKTOK_HOST || host(env.THREADS_API_BASE) === MOCK_THREADS_HOST);
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = <T>(data: T) => json({ data, error: { code: "ok", message: "", log_id: "mock" } });
let seq = 0;

async function bodyText(init?: RequestInit) {
  const b = init?.body;
  if (b == null) return "";
  if (typeof b === "string") return b;
  if (b instanceof URLSearchParams) return b.toString();
  if (b instanceof Uint8Array) return `[${b.byteLength} bytes]`;
  return "";
}

export function mockDirectFetch(next: typeof fetch, state: MockDirectState = globalMock): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== MOCK_TIKTOK_HOST && url.hostname !== MOCK_THREADS_HOST) return next(input as RequestInfo, init);
    const method = (init?.method ?? "GET").toUpperCase();
    state.calls.push(`${method} ${url.hostname}${url.pathname}`);
    const raw = await bodyText(init);
    const auth = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (url.hostname === MOCK_TIKTOK_HOST) {
      const p = url.pathname;
      if (p === "/v2/oauth/token/") {
        const f = new URLSearchParams(raw);
        if (!f.get("client_key") || !f.get("client_secret")) return json({ error: "invalid_client" }, 401);
        if (f.get("grant_type") === "authorization_code") {
          if (f.get("code") === "bad") return json({ error: "invalid_grant", error_description: "bad code" }, 400);
          state.verifier = f.get("code_verifier") ?? undefined;
        } else if (f.get("grant_type") === "refresh_token") {
          if (f.get("refresh_token") !== "tt-refresh") return json({ error: "invalid_grant" }, 400);
        } else if (f.get("grant_type") !== "client_credentials") return json({ error: "unsupported_grant_type" }, 400);
        const tok = `tt-access-${++seq}`;
        state.tiktokTokens.add(tok);
        return json({ access_token: tok, refresh_token: "tt-refresh", expires_in: 86400, refresh_expires_in: 31536000, open_id: "oid_mock_creator", scope: "user.info.basic,video.upload,video.publish,video.list", token_type: "Bearer" });
      }
      if (p === "/v2/oauth/revoke/") { state.tiktokTokens.delete(new URLSearchParams(raw).get("token") ?? ""); return json({}); }
      if (p.startsWith("/upload/")) {
        const pub = state.publishes.get(p.slice(8));
        if (!pub) return json({ error: "not found" }, 404);
        pub.uploaded = (init?.body as Uint8Array | undefined)?.byteLength ?? 0;
        pub.status = "PUBLISH_COMPLETE";
        state.videos.unshift({ id: `7${Date.now()}${++seq}`, title: pub.title, create_time: Math.floor(Date.now() / 1000) });
        return new Response(null, { status: 201 });
      }
      if (!state.tiktokTokens.has(auth)) return json({ error: { code: "access_token_invalid", message: "invalid" } }, 401);
      if (state.expireNextTikTok) { state.expireNextTikTok = false; state.tiktokTokens.delete(auth); return json({ error: { code: "access_token_invalid", message: "expired" } }, 401); }
      if (p === "/v2/user/info/") return ok({ user: { open_id: "oid_mock_creator", display_name: "Multies Demo", avatar_url: null } });
      if (p === "/v2/post/publish/creator_info/query/") {
        return ok({ creator_avatar_url: null, creator_username: "multiesdemo", creator_nickname: "Multies Demo", privacy_level_options: state.privacyOptions, comment_disabled: false, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 600 });
      }
      if (p === "/v2/post/publish/video/init/") {
        const b = JSON.parse(raw || "{}") as { post_info?: { title?: string; privacy_level?: string }; source_info?: { video_size?: number } };
        if ((b.post_info?.title ?? "").includes("FAIL")) return json({ error: { code: "invalid_params", message: "rejected" } }, 400);
        if (!state.privacyOptions.includes(b.post_info?.privacy_level ?? "")) return json({ error: { code: "privacy_level_option_mismatch", message: "" } }, 400);
        const id = `v_pub_file~v2-1.${++seq}`;
        state.publishes.set(id, { title: b.post_info?.title ?? "", privacy: b.post_info?.privacy_level ?? "", uploaded: 0, status: "PROCESSING_UPLOAD" });
        return ok({ publish_id: id, upload_url: `https://${MOCK_TIKTOK_HOST}/upload/${id}` });
      }
      if (p === "/v2/post/publish/status/fetch/") {
        const b = JSON.parse(raw || "{}") as { publish_id?: string };
        const pub = state.publishes.get(b.publish_id ?? "");
        return ok({ status: pub?.status ?? "FAILED", fail_reason: pub ? undefined : "not_found", publicaly_available_post_id: [] });
      }
      if (p === "/v2/video/list/") {
        return ok({ videos: state.videos.map((v) => ({ id: v.id, title: v.title, cover_image_url: null, share_url: `https://www.tiktok.com/@multiesdemo/video/${v.id}`, create_time: v.create_time, duration: 7, view_count: 0, like_count: 0 })), cursor: 0, has_more: false });
      }
      return json({ error: { code: "not_found", message: p } }, 404);
    }
    // Threads
    const p = url.pathname;
    const q = url.searchParams;
    const form = new URLSearchParams(raw);
    if (p === "/oauth/access_token") return form.get("code") === "bad" ? json({ error: { message: "bad code", code: 100 } }, 400) : json({ access_token: "th-short", user_id: "th_user_mock" });
    if (p === "/access_token") return json({ access_token: "th-long", token_type: "bearer", expires_in: 5184000 });
    if (p === "/refresh_access_token") return json({ access_token: "th-long-2", token_type: "bearer", expires_in: 5184000 });
    const tok = q.get("access_token") ?? form.get("access_token") ?? "";
    if (!tok.startsWith("th-")) return json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400);
    if (p === "/v1.0/me") return json({ id: "th_user_mock", username: "multies.demo", name: "Multies Demo", threads_profile_picture_url: null, threads_biography: "Work and mail in one place" });
    if (p === "/v1.0/me/threads") return json({ data: state.threadsPosts.map((t) => ({ ...t, permalink: `https://www.threads.net/@multies.demo/post/${t.id}` })) });
    if (/^\/v1\.0\/[^/]+\/threads$/.test(p) && method === "POST") {
      if ((form.get("text") ?? "").includes("FAIL")) return json({ error: { message: "rejected", code: 100 } }, 400);
      const cid = `cont_${++seq}`;
      state.containers.set(cid, { text: form.get("text") ?? "", media_type: form.get("media_type") ?? "TEXT" });
      return json({ id: cid });
    }
    if (/^\/v1\.0\/[^/]+\/threads_publish$/.test(p)) {
      const id = `th_post_${++seq}`;
      const c = state.containers.get(form.get("creation_id") ?? "");
      state.threadsPosts.unshift({ id, text: c?.text ?? "", media_type: c?.media_type ?? "TEXT", timestamp: new Date().toISOString() });
      return json({ id });
    }
    if (/^\/v1\.0\/cont_\d+$/.test(p)) return json({ status: "FINISHED", id: p.split("/").pop() });
    if (/^\/v1\.0\/th_post_\d+$/.test(p)) return json({ permalink: `https://www.threads.net/@multies.demo/post/${p.split("/").pop()}`, id: p.split("/").pop() });
    return json({ error: { message: `no mock for ${p}`, code: 100 } }, 404);
  }) as typeof fetch;
}

const globalMock = newMockDirectState();
