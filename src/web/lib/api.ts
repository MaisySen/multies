import { markReadOnly } from "./read-only";

/** Thin typed client for the Multies API. Cookies carry the session. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}

interface RequestOptions {
  /** Makes a POST safe to retry: the server replays the first response for the same key. */
  idempotencyKey?: string;
  /** Extra request headers (for example x-device-id for the free address limits). */
  headers?: Record<string, string>;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  let res: Response | undefined;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  if (opts.headers) Object.assign(headers, opts.headers);
  // With an idempotency key a dropped connection is retried once, without one it is not.
  const tries = opts.idempotencyKey ? 2 : 1;
  for (let i = 0; i < tries && !res; i++) {
    try {
      res = await fetch(`/api${path}`, {
        method,
        credentials: "same-origin",
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      if (i === tries - 1) throw new ApiError(0, "network", "Can't reach Multies. Check your connection.");
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  if (!res) throw new ApiError(0, "network", "Can't reach Multies. Check your connection.");
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const e = json?.error;
    if (res.status === 503 && e?.code === "read_only") markReadOnly();
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`, e?.details?.fields);
  }
  return json as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b: unknown = {}, o?: RequestOptions) => request<T>("POST", p, b, o),
  patch: <T>(p: string, b: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b: unknown) => request<T>("PUT", p, b),
  del: <T>(p: string, b?: unknown) => request<T>("DELETE", p, b),
};
