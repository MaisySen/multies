/**
 * R80C: a stand in for the integration platform, for unit tests and local end to end runs only. The node entry
 * uses it when COMPOSIO_BASE_URL is https://composio.mock AND APP_URL points at localhost; it is never wired into the
 * Workers entry. It keeps accounts in memory, finishes every connect at once (the hosted page sends the person
 * straight back to the callback), and answers the publishing tools with made up post ids. Text containing
 * "FAIL" (or a Reddit community named closed) is turned down by the network, so the per account error path can be tested.
 */
export const MOCK_COMPOSIO_HOST = "composio.mock";

interface MockAccount { id: string; user_id: string; status: string; toolkit: { slug: string }; auth_config: { id: string }; alias: string | null; created_at: string; data: Record<string, unknown> }

const TOOLKITS: Record<string, { auth_schemes: string[]; composio_managed_auth_schemes: string[] }> = {
  facebook: { auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] },
  instagram: { auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] },
  linkedin: { auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] },
  pinterest: { auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] },
  reddit: { auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] },
  gmail: { auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] },
  slack: { auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] },
  telegram: { auth_schemes: ["API_KEY"], composio_managed_auth_schemes: [] },
  twitter: { auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: [] },
  youtube: { auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] }, // R132: managed sign in, as on the platform
  google_business_profile: { auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: [] }, // R132: no managed sign in (held)
};

export interface MockComposioState {
  accounts: Map<string, MockAccount>;
  authConfigs: { id: string; toolkit: string; managed: boolean; scheme: string }[];
  executed: { slug: string; accountId: string; args: Record<string, unknown> }[];
  /** Raw network calls made through the platform's proxy (hotfix Oct 31). */
  proxied: { method: string; endpoint: string; accountId: string; body: Record<string, unknown>; headers: Record<string, string>; binary?: number }[];
  /** R117: Facebook turns first comments down. */
  commentRefused?: boolean;
  /** Calls seen, "METHOD /path", for tests. */
  calls: string[];
  /** Every request carried the key header. */
  keyMissing: number;
  /** Facebook answers the permalink read with an error (tests the fallback). */
  permalinkDown?: boolean;
  /** Post ids deleted on the network (by Multies or by the person there). */
  goneRemote?: Set<string>;
  /** SOCFIX: LinkedIn images registered so far. */
  liImages?: number;
  /** A network refuses to delete (tests the partial delete). */
  deleteRefused?: boolean;
  /** Facebook answers the post check with this error (a permission problem, not a deleted post). */
  fbGetError?: string;
  /** SOC1: how many Pages each Facebook login manages (acct.data.fbPages wins); 2 when unset. */
  fbPages?: number;
}

export function newMockState(): MockComposioState {
  return { accounts: new Map(), authConfigs: [], executed: [], proxied: [], calls: [], keyMissing: 0 };
}

/** One state per process for the local server; tests make their own. */
const shared = newMockState();
// SOC1: a local run can ask for a login with many Pages (e2e checks the picker's search and paging).
try { const n = Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.MOCK_FB_PAGES ?? ""); if (n > 0 && n <= 5000) shared.fbPages = n; } catch { /* not a node run */ }

/** SOC1: the mock's Facebook Pages: pg_100 and pg_200 first (older tests use them), then numbered ones. Page 4 can't post. */
export function mockFbPages(n: number) {
  const names = ["Acme Bakery", "Acme Bakery Melbourne", "Acme Bakery and Cafe Southbank Promenade Weekend Markets and Catering"];
  return Array.from({ length: n }, (_, i) => ({
    id: i < 2 ? `pg_${(i + 1) * 100}` : `pg_${1000 + i}`,
    name: names[i] ?? `Acme store ${String(i + 1).padStart(3, "0")}`,
    picture: { data: { url: `https://images.example.com/page-${i + 1}.png` } },
    tasks: i === 3 ? ["ANALYZE"] : i === 0 ? ["CREATE_CONTENT", "MANAGE"] : ["CREATE_CONTENT"],
  }));
}

export function mockComposioAllowed(env: { COMPOSIO_BASE_URL?: string; APP_URL?: string }) {
  try {
    return new URL(env.COMPOSIO_BASE_URL ?? "").hostname === MOCK_COMPOSIO_HOST && ["localhost", "127.0.0.1"].includes(new URL(env.APP_URL ?? "").hostname);
  } catch { return false; }
}

let seq = 0;
const nid = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function execute(state: MockComposioState, slug: string, body: { connected_account_id?: string; user_id?: string; arguments?: Record<string, unknown> }) {
  const acct = state.accounts.get(body.connected_account_id ?? "");
  if (!acct || acct.user_id !== body.user_id) return json({ error: { message: "connected account not found" } }, 404);
  const args = body.arguments ?? {};
  state.executed.push({ slug, accountId: acct.id, args });
  const text = String(args.message ?? args.commentary ?? args.caption ?? args.text ?? args.description ?? args.title ?? "");
  if (/FAIL/.test(text) || /closed/i.test(String(args.subreddit ?? ""))) return json({ data: {}, successful: false, error: "The network turned this post down." });
  const ok = (data: Record<string, unknown>) => json({ data, successful: true, error: null });
  switch (slug) {
    case "FACEBOOK_GET_USER_PAGES": return ok({ response_data: { data: [{ id: "pg_100", name: "Acme Studio" }, { id: "pg_200", name: "Acme Shop" }] } });
    // SOCFIX: data.boards sets how many boards the account has (one by default, as before).
    case "PINTEREST_LIST_BOARDS": return acct.data.boardsFail ? json({ data: {}, successful: false, error: "Pinterest is down" }) : ok({ items: Array.from({ length: Number(acct.data.boards ?? 1) }, (_, i) => ({ id: `bd_${i + 1}`, name: i === 0 ? "Launch ideas" : `Board ${i + 1}` })) });
    case "LINKEDIN_GET_MY_INFO": return ok({ response_dict: { author_id: "urn:li:person:mock1", name: "Ada" } });
    case "INSTAGRAM_GET_USER_INFO": return ok({ id: "ig_1", username: "acme" });
    case "INSTAGRAM_CREATE_MEDIA_CONTAINER": return ok({ id: nid("ctr") });
    // SOCFIX: a carousel (data.noCarousel makes Instagram refuse it, so the post falls back to the first image).
    case "INSTAGRAM_CREATE_CAROUSEL_CONTAINER": return acct.data.noCarousel ? json({ data: {}, successful: false, error: "carousel refused" }) : Array.isArray(args.children) && args.children.length >= 2 ? ok({ id: nid("car") }) : json({ data: {}, successful: false, error: "needs 2 children" });
    case "INSTAGRAM_CREATE_POST": return ok({ id: nid("igp"), permalink: "https://www.instagram.com/p/mock/" });
    case "REDDIT_CREATE_REDDIT_POST": return ok({ json: { data: { url: "https://www.reddit.com/r/test/comments/mock/" } } });
    default:
      if (/CREATE|POST|PIN/.test(slug)) return ok({ id: nid("post") });
      return json({ error: { message: "unknown tool" } }, 404);
  }
}

/** The platform's proxy: answers Facebook Graph and LinkedIn calls the way the networks do (shape checked 31 Oct 2026). */
function proxy(state: MockComposioState, body: { connected_account_id?: string; user_id?: string; endpoint?: string; method?: string; body?: Record<string, unknown>; parameters?: { name: string; value: string; type: string }[]; binary_body?: { base64?: string; content_type?: string } }) {
  const acct = state.accounts.get(body.connected_account_id ?? "");
  if (!acct || acct.user_id !== body.user_id) return json({ error: { message: "connected account not found" } }, 404);
  const endpoint = String(body.endpoint ?? "");
  const method = String(body.method ?? "GET");
  const args = body.body ?? {};
  const headers = Object.fromEntries((body.parameters ?? []).filter((p) => p.type === "header").map((p) => [p.name, p.value]));
  state.proxied.push({ method, endpoint, accountId: acct.id, body: args, headers, ...(body.binary_body?.base64 ? { binary: body.binary_body.base64.length } : {}) });
  const net = (status: number, data: unknown, h: Record<string, string> = {}) => json({ data, status, headers: h });
  const text = String(args.message ?? args.caption ?? args.commentary ?? "");
  const u = new URL(endpoint);
  if (u.hostname === "graph.facebook.com") {
    // SA1: who the signed in profile is (data.who picks another person, for two different accounts).
    if (method === "GET" && /\/me$/.test(u.pathname)) return net(200, { id: String(acct.data.fbId ?? "fbu_1"), name: String(acct.data.name ?? "Ada Lovelace"), picture: { data: { url: "https://images.example.com/ada.png" } } });
    if (method === "GET" && u.pathname.endsWith("/me/permissions")) return net(200, { data: acct.data.noPostPerm ? [{ permission: "pages_show_list", status: "granted" }] : [{ permission: "pages_show_list", status: "granted" }, { permission: "pages_manage_posts", status: "granted" }] });
    if (method === "GET" && u.pathname.endsWith("/me/accounts")) {
      // SOC1: paged as Graph does (limit, after cursor, paging.next only when there is more).
      const all = mockFbPages(Number(acct.data.fbPages ?? state.fbPages ?? 2));
      const limit = Math.min(100, Number(u.searchParams.get("limit") ?? 25) || 25);
      const start = Number(u.searchParams.get("after") ?? 0) || 0;
      const fields = (u.searchParams.get("fields") ?? "id").split(",");
      const slice = all.slice(start, start + limit).map((p) => ({ id: p.id, ...(fields.includes("name") ? { name: p.name } : {}), ...(fields.some((f) => f.startsWith("picture")) ? { picture: p.picture } : {}), ...(fields.includes("tasks") ? { tasks: p.tasks } : {}), ...(fields.includes("access_token") ? { access_token: "mock-page-token" } : {}) }));
      const more = start + limit < all.length;
      return net(200, { data: slice, paging: { cursors: { before: String(start), after: String(start + slice.length) }, ...(more ? { next: `https://graph.facebook.com/v21.0/me/accounts?after=${start + slice.length}` } : {}) } });
    }
    if (method === "GET" && u.searchParams.get("fields") === "access_token") return net(200, u.pathname.endsWith("/pg_noadmin") ? { id: "pg_noadmin" } : { id: "pg", access_token: "mock-page-token" });
    const gone = state.goneRemote ?? (state.goneRemote = new Set());
    const objId = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    if ((method === "GET" && u.searchParams.get("fields") === "id") || method === "DELETE") {
      if (u.searchParams.get("access_token") !== "mock-page-token") return net(403, { error: { message: "(#200) Requires the Page token", code: 200 } });
      if (method === "GET" && state.fbGetError) return net(400, { error: { message: state.fbGetError, code: 100 } });
      if (gone.has(objId)) return net(400, { error: { message: "(#10) Object does not exist, cannot be loaded due to missing permission or reviewable feature, or does not support this operation.", code: 10 } });
      if (method === "GET") return net(200, { id: objId });
      if (state.deleteRefused) return net(500, { error: { message: "An unexpected error has occurred.", code: 2 } });
      gone.add(objId);
      return net(200, { success: true });
    }
    if (method === "GET" && u.searchParams.get("fields") === "permalink_url") {
      if (state.permalinkDown || u.searchParams.get("access_token") !== "mock-page-token") return net(400, { error: { message: "Unsupported get request.", code: 100 } });
      return net(200, { id: decodeURIComponent(u.pathname.split("/").pop() ?? ""), permalink_url: `https://www.facebook.com/61500000000001/posts/${encodeURIComponent(decodeURIComponent(u.pathname.split("/").pop() ?? ""))}` });
    }
    // R117: a first comment under a post.
    if (method === "POST" && /\/comments$/.test(u.pathname)) return state.commentRefused ? net(400, { error: { message: "(#200) Comments are turned off for this post.", code: 200 } }) : net(200, { id: nid("cm") });
    if (/EXPIRED/.test(text)) return net(400, { error: { message: "Error validating access token: Session has expired.", type: "OAuthException", code: 190 } });
    if (/FAIL/.test(text)) return net(400, { error: { message: "The network turned this post down.", type: "OAuthException", code: 100 } });
    if (args.access_token !== "mock-page-token") return net(403, { error: { message: "(#200) Unpublished posts must be posted to a page as the page itself.", code: 200 } });
    if (method === "POST" && /\/photos$/.test(u.pathname)) return net(200, { id: nid("ph"), post_id: nid("pg_post") });
    if (method === "POST" && /\/feed$/.test(u.pathname)) return net(200, { id: nid("pg_post") });
    return net(404, { error: { message: "Unknown path", code: 803 } });
  }
  // R132: YouTube (channel, comment threads, a reply) and Pinterest (account read). acct.data.expired = signed out;
  // acct.data.noChannel = a Google account with no channel; a reply containing FAIL is turned down.
  if (u.hostname === "www.googleapis.com" && u.pathname.startsWith("/youtube/v3/")) {
    if (acct.data.expired) return net(401, { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } });
    if (u.pathname.endsWith("/channels")) return net(200, { items: acct.data.noChannel ? [] : [{ id: "UCmock1" }] });
    if (u.pathname.endsWith("/commentThreads")) return net(200, { items: [
      { id: "yt_th_1", snippet: { videoId: "vid1", topLevelComment: { id: "yt_c_1", snippet: { videoId: "vid1", textOriginal: "Loved this video, when is part two?", authorDisplayName: "Mia Chen", authorChannelId: { value: "UCfan1" }, publishedAt: "2026-11-01T09:00:00Z" } } } },
      { id: "yt_th_2", snippet: { videoId: "vid1", topLevelComment: { id: "yt_c_2", snippet: { videoId: "vid1", textOriginal: "Thanks everyone!", authorDisplayName: "Acme", authorChannelId: { value: "UCmock1" }, publishedAt: "2026-11-01T09:05:00Z" } } } },
    ] });
    if (u.pathname.endsWith("/comments") && method === "POST") {
      const t = String((args.snippet as { textOriginal?: unknown } | undefined)?.textOriginal ?? "");
      return /FAIL/.test(t) ? net(403, { error: { code: 403, message: "The comment cannot be created.", errors: [{ reason: "forbidden" }] } }) : net(200, { id: nid("yt_r") });
    }
    return net(404, { error: { code: 404, message: "Not found" } });
  }
  if (u.hostname === "api.pinterest.com") return acct.data.expired ? net(401, { code: 2, message: "Authentication failed." }) : net(200, { username: "acme", account_type: "BUSINESS" });
  // SOCFIX: LinkedIn image bytes go to the upload address LinkedIn gave (data.noUpload makes it refuse).
  if (u.hostname === "www.linkedin.com" && u.pathname.startsWith("/dms-uploads/") && method === "PUT") return acct.data.noUpload ? net(400, { message: "upload refused" }) : body.binary_body?.base64 ? net(201, "") : net(400, { message: "no bytes" });
  if (u.hostname === "api.linkedin.com") {
    if (u.pathname === "/rest/images" && u.searchParams.get("action") === "initializeUpload" && method === "POST") {
      const n = (state.liImages = (state.liImages ?? 0) + 1);
      return net(200, { value: { uploadUrlExpiresAt: Date.now() + 86_400_000, uploadUrl: `https://www.linkedin.com/dms-uploads/sp/v2/mock${n}`, image: `urn:li:image:mock${n}` } });
    }
    if (u.pathname === "/v2/userinfo") return acct.data.expired ? net(401, { status: 401, code: "REVOKED_ACCESS_TOKEN", message: "The token used in the request has been revoked by the user" }) : net(200, { sub: String(acct.data.sub ?? "mock1"), name: String(acct.data.name ?? "Ada"), picture: acct.data.picture ?? undefined });
    // SOC1: company Pages the member administers (acct.data.orgs lists organization ids).
    if (u.pathname === "/rest/organizationAcls" && method === "GET") {
      const orgs = Array.isArray(acct.data.orgs) ? (acct.data.orgs as unknown[]).map(String) : [];
      return net(200, { elements: orgs.map((id) => ({ organization: `urn:li:organization:${id}`, role: "ADMINISTRATOR", state: "APPROVED" })) });
    }
    if (u.pathname.startsWith("/rest/organizations/") && method === "GET") return net(200, { id: Number(u.pathname.split("/").pop()), localizedName: `Acme company ${u.pathname.split("/").pop()}` });
    if (u.pathname.startsWith("/rest/posts/") && method === "DELETE") {
      const urn = decodeURIComponent(u.pathname.slice("/rest/posts/".length));
      const gone = state.goneRemote ?? (state.goneRemote = new Set());
      if (gone.has(urn)) return net(404, { status: 404, message: "Not found" });
      gone.add(urn);
      return net(204, "");
    }
    if (u.pathname.startsWith("/rest/posts/") && method === "GET") return net(403, { status: 403, message: "Not enough permissions to access: partnerApiPostsExternal.GET" });
    if (u.pathname === "/rest/posts" && method === "POST") {
      // Only a recent version is live, as on LinkedIn: anything a year old is retired.
      if (!/^20\d{4}$/.test(headers["LinkedIn-Version"] ?? "") || headers["LinkedIn-Version"]! < "202501") return net(426, { status: 426, code: "NONEXISTENT_VERSION", message: `Requested version ${headers["LinkedIn-Version"]}01 is not active` });
      if (/EXPIRED/.test(text)) return net(401, { status: 401, code: "REVOKED_ACCESS_TOKEN", message: "The token used in the request has been revoked by the user" });
      if (/FAIL/.test(text)) return net(422, { status: 422, message: "The network turned this post down." });
      const content = args.content as { media?: { id?: string }; multiImage?: { images?: { id?: string }[] } } | undefined;
      const ids = content?.media ? [content.media.id] : content?.multiImage ? (content.multiImage.images ?? []).map((i) => i.id) : [];
      if (ids.some((id) => !/^urn:li:image:/.test(String(id))) || (content?.multiImage && ids.length < 2)) return net(422, { status: 422, message: "Bad image content" });
      return net(201, "", { "x-restli-id": `urn:li:share:${Date.now()}` });
    }
  }
  return net(404, { message: "not found" });
}

export function handleMockComposio(state: MockComposioState, req: { method: string; url: URL; headers: Headers; body: unknown }): Response {
  const { method, url } = req;
  const path = url.pathname.replace(/^\/api\/v3/, "");
  state.calls.push(`${method} ${path}`);
  if (!req.headers.get("x-api-key")) { state.keyMissing++; return json({ error: "no key" }, 401); }
  const body = (req.body ?? {}) as Record<string, unknown>;
  let m: RegExpMatchArray | null;
  if (method === "GET" && (m = path.match(/^\/toolkits\/([\w-]+)$/))) {
    const t = TOOLKITS[m[1]!];
    // Shaped like the live single toolkit read (checked 31 Oct 2026): no auth_schemes field, the ways to sign in
    // come as composio_managed_auth_schemes and auth_config_details[].mode.
    return t ? json({ slug: m[1], name: m[1], composio_managed_auth_schemes: t.composio_managed_auth_schemes, auth_config_details: t.auth_schemes.map((mode) => ({ mode })) }) : json({ error: "not found" }, 404);
  }
  if (method === "GET" && path === "/auth_configs") {
    const slug = url.searchParams.get("toolkit_slug");
    return json({ items: state.authConfigs.filter((c) => c.toolkit === slug).map((c) => ({ id: c.id, toolkit: { slug: c.toolkit }, is_composio_managed: c.managed, auth_scheme: c.scheme, status: "ENABLED" })) });
  }
  if (method === "POST" && path === "/auth_configs") {
    const slug = String((body.toolkit as { slug?: string })?.slug ?? "");
    const ac = body.auth_config as { type?: string; authScheme?: string };
    const managed = ac?.type === "use_composio_managed_auth";
    const id = nid("ac");
    state.authConfigs.push({ id, toolkit: slug, managed, scheme: managed ? "OAUTH2" : String(ac?.authScheme ?? "") });
    return json({ toolkit: { slug }, auth_config: { id } }, 201);
  }
  if (method === "POST" && path === "/connected_accounts/link") {
    const ac = state.authConfigs.find((c) => c.id === body.auth_config_id);
    if (!ac) return json({ error: "no auth config" }, 400);
    const id = nid("ca");
    // The hosted page is skipped: the account is live at once and the link goes straight back.
    state.accounts.set(id, { id, user_id: String(body.user_id), status: "ACTIVE", toolkit: { slug: ac.toolkit }, auth_config: { id: ac.id }, alias: null, created_at: new Date().toISOString(), data: { access_token: "mock-secret-token" } });
    const back = new URL(String(body.callback_url));
    back.searchParams.set("status", "success");
    back.searchParams.set("connected_account_id", id);
    return json({ link_token: "lk_mock", redirect_url: back.toString(), connected_account_id: id });
  }
  if (method === "GET" && path === "/connected_accounts") {
    const users = (url.searchParams.get("user_ids") ?? "").split(",");
    return json({ items: [...state.accounts.values()].filter((a) => users.includes(a.user_id)), next_cursor: null });
  }
  if ((m = path.match(/^\/connected_accounts\/([\w-]+)(\/refresh)?$/))) {
    const a = state.accounts.get(m[1]!);
    if (!a) return json({ error: "not found" }, 404);
    if (method === "GET" && !m[2]) return json(a);
    if (method === "DELETE" && !m[2]) { state.accounts.delete(a.id); return json({ success: true }); }
    if (method === "POST" && m[2]) {
      a.status = "ACTIVE";
      const back = new URL(String(body.redirect_url));
      back.searchParams.set("status", "success");
      back.searchParams.set("connected_account_id", a.id);
      return json({ id: a.id, status: "INITIATED", redirect_url: back.toString() });
    }
  }
  if (method === "POST" && path === "/tools/execute/proxy") return proxy(state, body as never);
  if (method === "POST" && (m = path.match(/^\/tools\/execute\/([\w]+)$/))) return execute(state, m[1]!, body as never);
  return json({ error: "not found" }, 404);
}

/** Wraps fetch: calls to the stand in host are answered here, everything else goes on. */
export function mockComposioFetch(real: typeof fetch, state: MockComposioState = shared): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.hostname !== MOCK_COMPOSIO_HOST) return real(input, init);
    const raw = init?.body;
    let body: unknown;
    try { body = typeof raw === "string" && raw ? JSON.parse(raw) : null; } catch { body = null; }
    return handleMockComposio(state, { method: (init?.method ?? "GET").toUpperCase(), url, headers: new Headers(init?.headers), body });
  }) as typeof fetch;
}
