/**
 * R80C: the integration platform client (Composio, REST v3). Server only: the project key rides in a header on
 * calls from the Worker and is never returned, logged or put in a URL. Every call has a deadline; errors come back
 * as IntegrationError with our own code, and the platform's words stay in the server log.
 */
import type { Deps } from "../../context";

export class IntegrationError extends Error {
  constructor(public code: "not_configured" | "unavailable" | "rejected" | "not_found" | "bad_request", message: string, public status = 0) {
    super(message);
  }
}

export interface CpToolkit {
  slug: string;
  name: string;
  meta?: { logo?: string; description?: string; categories?: { id?: string; name?: string }[] };
  auth_schemes?: string[];
  composio_managed_auth_schemes?: string[];
  /** Only on the single toolkit read: one entry per way to sign in. */
  auth_config_details?: { mode?: string }[];
  no_auth?: boolean;
  deprecated?: unknown;
  is_local_toolkit?: boolean;
}

export interface CpAccount {
  id: string;
  status: string;
  toolkit?: { slug?: string };
  auth_config?: { id?: string };
  alias?: string | null;
  user_id?: string;
  created_at?: string;
}

export interface CpAuthConfig { id: string; toolkit?: { slug?: string }; is_composio_managed?: boolean; status?: string; auth_scheme?: string }

const DEADLINE_MS = 15_000;

export function composioFrom(deps: Deps) {
  const cfg = deps.config.integrations.composio;
  if (!cfg) throw new IntegrationError("not_configured", "Connections are not switched on here.", 503);
  const base = `${cfg.baseUrl}/api/v3`;

  async function call<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEADLINE_MS);
    let res: Response;
    try {
      res = await deps.fetch(url.toString(), {
        method,
        headers: { "x-api-key": cfg!.apiKey, accept: "application/json", ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      deps.log?.warn("integrations.fetch_failed", { path, error: err instanceof Error ? err.message : String(err) });
      throw new IntegrationError("unavailable", "The connections service did not answer. Try again in a moment.", 503);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      // The platform's own words go to the log (never to the browser): they can name internal ids.
      deps.log?.warn("integrations.http_error", { path, status: res.status, body: text.slice(0, 300) });
      if (res.status === 404) throw new IntegrationError("not_found", "Not found.", 404);
      if (res.status === 400 || res.status === 422) throw new IntegrationError("bad_request", "The connections service refused that request.", res.status);
      if (res.status === 401 || res.status === 403) throw new IntegrationError("not_configured", "Connections are not set up correctly here.", 503);
      throw new IntegrationError("unavailable", "The connections service had a problem. Try again in a moment.", 503);
    }
    return json as T;
  }

  return {
    userPrefix: cfg.userPrefix,
    async toolkits(): Promise<CpToolkit[]> {
      const out: CpToolkit[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await call<{ items?: CpToolkit[]; next_cursor?: string | null }>("GET", "/toolkits", { query: { limit: 1000, cursor }, timeoutMs: 25_000 });
        out.push(...(r.items ?? []));
        cursor = r.next_cursor ?? undefined;
        if (!cursor || !r.items?.length) break;
      }
      return out;
    },
    async toolkit(slug: string): Promise<CpToolkit> {
      return call<CpToolkit>("GET", `/toolkits/${encodeURIComponent(slug)}`);
    },
    async authConfigs(toolkit: string): Promise<CpAuthConfig[]> {
      const r = await call<{ items?: CpAuthConfig[] }>("GET", "/auth_configs", { query: { toolkit_slug: toolkit, limit: 50 } });
      return r.items ?? [];
    },
    async createAuthConfig(toolkit: string, kind: { managed: true } | { scheme: string }, name: string): Promise<string> {
      const authConfig = "managed" in kind ? { type: "use_composio_managed_auth", name } : { type: "use_custom_auth", authScheme: kind.scheme, name };
      const r = await call<{ auth_config?: { id?: string } }>("POST", "/auth_configs", { body: { toolkit: { slug: toolkit }, auth_config: authConfig } });
      if (!r.auth_config?.id) throw new IntegrationError("unavailable", "Could not prepare that app.", 503);
      return r.auth_config.id;
    },
    async accounts(userId: string): Promise<CpAccount[]> {
      const out: CpAccount[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await call<{ items?: CpAccount[]; next_cursor?: string | null }>("GET", "/connected_accounts", { query: { user_ids: userId, limit: 100, cursor } });
        out.push(...(r.items ?? []));
        cursor = r.next_cursor ?? undefined;
        if (!cursor || !r.items?.length) break;
      }
      return out;
    },
    async account(id: string): Promise<CpAccount> {
      return call<CpAccount>("GET", `/connected_accounts/${encodeURIComponent(id)}`);
    },
    async link(authConfigId: string, userId: string, callbackUrl: string): Promise<{ redirectUrl: string; accountId: string }> {
      const r = await call<{ redirect_url?: string; connected_account_id?: string }>("POST", "/connected_accounts/link", {
        body: { auth_config_id: authConfigId, user_id: userId, callback_url: callbackUrl },
      });
      if (!r.redirect_url || !r.connected_account_id) throw new IntegrationError("unavailable", "Could not start the connection.", 503);
      return { redirectUrl: r.redirect_url, accountId: r.connected_account_id };
    },
    async refresh(id: string, callbackUrl: string): Promise<{ redirectUrl: string | null }> {
      const r = await call<{ redirect_url?: string | null }>("POST", `/connected_accounts/${encodeURIComponent(id)}/refresh`, { body: { redirect_url: callbackUrl } });
      return { redirectUrl: r.redirect_url ?? null };
    },
    async remove(id: string): Promise<void> {
      await call<unknown>("DELETE", `/connected_accounts/${encodeURIComponent(id)}`);
    },
    async execute(slug: string, accountId: string, userId: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown>; error: string | null }> {
      const r = await call<{ data?: Record<string, unknown>; successful?: boolean; error?: string | null }>("POST", `/tools/execute/${encodeURIComponent(slug)}`, {
        body: { connected_account_id: accountId, user_id: userId, arguments: args }, timeoutMs: 30_000,
      });
      return { ok: r.successful !== false && !r.error, data: r.data ?? {}, error: r.error ?? null };
    },
    /**
     * Hotfix Oct 31: a raw call to the network's own API, signed by the platform with the connected account's
     * sign in. Used where the platform's ready made tools fall behind the network (a retired API version, a
     * person token where a page token is needed). Answers the network's own status, body and headers.
     */
    async proxy(accountId: string, userId: string, req: { endpoint: string; method: "GET" | "POST" | "PUT" | "DELETE"; body?: Record<string, unknown>; headers?: Record<string, string>; /** SOCFIX: raw bytes (an image upload). */ binaryBody?: { base64: string; contentType?: string } }): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
      const parameters = Object.entries(req.headers ?? {}).map(([name, value]) => ({ name, value, type: "header" }));
      const binary = req.binaryBody ? { binary_body: { base64: req.binaryBody.base64, ...(req.binaryBody.contentType ? { content_type: req.binaryBody.contentType } : {}) } } : {};
      const r = await call<{ data?: unknown; status?: number; headers?: Record<string, string> }>("POST", "/tools/execute/proxy", {
        body: { connected_account_id: accountId, user_id: userId, endpoint: req.endpoint, method: req.method, ...(req.body ? { body: req.body } : {}), ...binary, ...(parameters.length ? { parameters } : {}) },
        timeoutMs: 30_000,
      });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = String(v);
      return { status: typeof r.status === "number" ? r.status : 200, data: r.data ?? null, headers };
    },
  };
}

export type Composio = ReturnType<typeof composioFrom>;
