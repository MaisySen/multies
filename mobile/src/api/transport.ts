import { Platform } from "react-native";
import { API_BASE } from "@/config";
import { applySetCookie, cookieHeader, type Jar } from "@/lib/cookies";
import { ApiError, NETWORK_ERROR, toApiError } from "./errors";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestOptions { idempotencyKey?: string; signal?: AbortSignal }

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

    const tries = opts.idempotencyKey || method === "GET" ? 2 : 1;
    let res: Response | undefined;
    for (let i = 0; i < tries && !res; i++) {
      try {
        res = await this.fetchImpl(`${this.base}/api${path}`, {
          method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
          credentials: "omit", signal: opts.signal,
        });
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
