import { Platform } from "react-native";
import { API_BASE } from "@/config";
import { applySetCookie, cookieHeader, type Jar } from "@/lib/cookies";
import { ApiError, NETWORK_ERROR, toApiError } from "./errors";
import { refreshOutcome, sessionExpiry, shouldRefreshEarly, singleFlight, verdictFor, type RefreshOutcome } from "@/lib/auth-keep";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Called with 0 to 1 as the request body goes up. Used for files sent from chat. */
  onUploadProgress?: (fraction: number) => void;
  /** Extra request headers, for example x-device-id on a free address claim. */
  headers?: Record<string, string>;
  /** R34: called with the status and headers of every answer, before errors are thrown (ETag reads). */
  onResponse?: (status: number, headers: { get(name: string): string | null }) => void;
}

/** The parts of a fetch Response the transport reads. */
type Answer = Pick<Response, "ok" | "status" | "text"> & { headers: { get(name: string): string | null } };

/** One request through XMLHttpRequest, which reports upload progress (fetch does not). */
export function xhrRequest(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  onProgress: (fraction: number) => void, Xhr: typeof XMLHttpRequest = XMLHttpRequest): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const x = new Xhr();
    x.open(init.method, url);
    for (const [k, v] of Object.entries(init.headers)) x.setRequestHeader(k, v);
    x.withCredentials = false;
    if (x.upload) x.upload.onprogress = (e: ProgressEvent) => { if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); };
    x.onload = () => {
      onProgress(1);
      const raw = x.getAllResponseHeaders() || "";
      const headers = {
        get: (name: string) => {
          const want = name.toLowerCase();
          const hits = raw.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(`${want}:`)).map((l) => l.slice(l.indexOf(":") + 1).trim());
          return hits.length ? hits.join(", ") : null;
        },
      };
      const body = typeof x.responseText === "string" ? x.responseText : "";
      resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, headers, text: async () => body });
    };
    x.onerror = () => reject(new TypeError("Network request failed"));
    x.ontimeout = x.onerror;
    if (init.signal) {
      if (init.signal.aborted) { reject(Object.assign(new Error("Aborted"), { name: "AbortError" })); return; }
      init.signal.addEventListener("abort", () => { x.abort(); reject(Object.assign(new Error("Aborted"), { name: "AbortError" })); });
    }
    onProgress(0);
    x.send(init.body ?? null);
  });
}

/** Everything the app asks the API goes through one of these: the live server or the sample workspace. */
export interface Transport {
  readonly kind: "live" | "sample";
  request<T>(method: Method, path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
}

/** What native file work (Tools uploads and downloads) needs from a signed in session. */
export interface FileAuth { base: string; headers: () => Record<string, string>; refresh: () => Promise<unknown> }

export interface JarStore {
  get(): Jar;
  set(jar: Jar): void;
}

/**
 * Talks to the Multies API with the session cookie. The app sends the API's own origin so the
 * server's CSRF check and Better Auth's trusted origins both accept it, the same as the web app.
 */
export class HttpTransport implements Transport {
  readonly kind = "live" as const;
  /** When the session cookie runs out (ms), as the last Set-Cookie said; null when unknown. */
  expiresAt: number | null = null;
  lastRefreshAt = 0;
  constructor(private jar: JarStore, private onUnauthorised: () => void = () => {}, private base = API_BASE, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  /**
   * R33: one session check in flight at a time. It renews the session cookie (the server slides
   * it forward) and says whether the session still exists.
   */
  readonly refresh: () => Promise<RefreshOutcome> = singleFlight(async () => {
    let outcome: RefreshOutcome;
    try { outcome = refreshOutcome({ body: await this.send<unknown>("GET", "/auth/get-session", undefined, {}) }); }
    catch (error) { outcome = refreshOutcome({ error }); }
    if (outcome === "ok") this.lastRefreshAt = Date.now();
    return outcome;
  });

  /** Renews the session before it runs out (called at launch and when the app comes back). */
  async refreshIfDue(now = Date.now()): Promise<RefreshOutcome | null> {
    if (!shouldRefreshEarly(this.expiresAt, this.lastRefreshAt, now)) return null;
    const outcome = await this.refresh();
    if (outcome === "gone") this.onUnauthorised();
    return outcome;
  }

  /** The server and the session headers for a request the phone makes itself (Tools files). */
  fileAuth(): FileAuth {
    return {
      base: this.base,
      headers: () => {
        const h: Record<string, string> = {};
        if (Platform.OS !== "web") h.origin = this.base;
        const cookie = cookieHeader(this.jar.get());
        if (cookie) h.cookie = cookie;
        return h;
      },
      refresh: () => this.refresh(),
    };
  }

  async request<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    try {
      return await this.send<T>(method, path, body, opts);
    } catch (err) {
      if (path.startsWith("/auth/")) throw err;
      const verdict = verdictFor(err);
      if (verdict === "keep") throw err;
      if (verdict === "signOut") { this.onUnauthorised(); throw err; }
      // A 401: renew once (shared with every other request waiting on it), then retry once.
      const outcome = await this.refresh();
      if (outcome === "gone") { this.onUnauthorised(); throw err; }
      if (outcome === "unknown") throw err; // no answer: keep the session, the caller shows cached data
      try {
        return await this.send<T>(method, path, body, opts);
      } catch (again) {
        if (verdictFor(again, true) === "signOut") this.onUnauthorised();
        throw again;
      }
    }
  }

  private async send<T>(method: Method, path: string, body: unknown, opts: RequestOptions): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (Platform.OS !== "web") headers.origin = this.base;
    const cookie = cookieHeader(this.jar.get());
    if (cookie) headers.cookie = cookie;
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    for (const [k, v] of Object.entries(opts.headers ?? {})) if (!(k.toLowerCase() in headers)) headers[k.toLowerCase()] = v;

    const tries = opts.idempotencyKey || method === "GET" ? 2 : 1;
    let res: Answer | undefined;
    const url = `${this.base}/api${path}`;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    for (let i = 0; i < tries && !res; i++) {
      try {
        res = opts.onUploadProgress
          ? await xhrRequest(url, { method, headers, body: payload, signal: opts.signal }, opts.onUploadProgress)
          : await this.fetchImpl(url, { method, headers, body: payload, credentials: "omit", signal: opts.signal });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        if (i === tries - 1) throw NETWORK_ERROR();
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (!res) throw NETWORK_ERROR();

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      this.jar.set(applySetCookie(this.jar.get(), setCookie));
      const exp = sessionExpiry(setCookie);
      if (exp !== null) this.expiresAt = exp;
      if (setCookie.includes("session_token=")) this.lastRefreshAt = Date.now(); // the server just renewed it
    }

    opts.onResponse?.(res.status, res.headers);
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      throw toApiError(res.status, json);
    }
    return json as T;
  }
}

export function isApiError(e: unknown): e is ApiError { return e instanceof ApiError; }
