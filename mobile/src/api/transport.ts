import { Platform } from "react-native";
import { API_BASE } from "@/config";
import { applySetCookie, cookieHeader, type Jar } from "@/lib/cookies";
import { ApiError, NETWORK_ERROR, toApiError } from "./errors";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Called with 0 to 1 as the request body goes up. Used for files sent from chat. */
  onUploadProgress?: (fraction: number) => void;
  /** Extra request headers, for example x-device-id on a free address claim. */
  headers?: Record<string, string>;
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
  constructor(private jar: JarStore, private onUnauthorised: () => void = () => {}, private base = API_BASE, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  async request<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
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
    if (setCookie) this.jar.set(applySetCookie(this.jar.get(), setCookie));

    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const err = toApiError(res.status, json);
      if (res.status === 401 && !path.startsWith("/auth/")) this.onUnauthorised();
      throw err;
    }
    return json as T;
  }
}

export function isApiError(e: unknown): e is ApiError { return e instanceof ApiError; }
