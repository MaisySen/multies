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
};

export interface MockComposioState {
  accounts: Map<string, MockAccount>;
  authConfigs: { id: string; toolkit: string; managed: boolean; scheme: string }[];
  executed: { slug: string; accountId: string; args: Record<string, unknown> }[];
  /** Calls seen, "METHOD /path", for tests. */
  calls: string[];
  /** Every request carried the key header. */
  keyMissing: number;
}

export function newMockState(): MockComposioState {
  return { accounts: new Map(), authConfigs: [], executed: [], calls: [], keyMissing: 0 };
}

/** One state per process for the local server; tests make their own. */
const shared = newMockState();

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
    case "PINTEREST_LIST_BOARDS": return ok({ items: [{ id: "bd_1", name: "Launch ideas" }] });
    case "LINKEDIN_GET_MY_INFO": return ok({ response_dict: { author_id: "urn:li:person:mock1", name: "Ada" } });
    case "INSTAGRAM_GET_USER_INFO": return ok({ id: "ig_1", username: "acme" });
    case "INSTAGRAM_CREATE_MEDIA_CONTAINER": return ok({ id: nid("ctr") });
    case "INSTAGRAM_CREATE_POST": return ok({ id: nid("igp"), permalink: "https://www.instagram.com/p/mock/" });
    case "REDDIT_CREATE_REDDIT_POST": return ok({ json: { data: { url: "https://www.reddit.com/r/test/comments/mock/" } } });
    default:
      if (/CREATE|POST|PIN/.test(slug)) return ok({ id: nid("post") });
      return json({ error: { message: "unknown tool" } }, 404);
  }
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
    return t ? json({ slug: m[1], name: m[1], ...t }) : json({ error: "not found" }, 404);
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
