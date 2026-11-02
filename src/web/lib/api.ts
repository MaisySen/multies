import { markReadOnly, markWorkspaceBudget } from "./read-only";
import { workspaceTabs } from "./workspace-tabs-r58"; // R58 (MB-245)

/** Thin typed client for the Multies API. Cookies carry the session. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>, public details?: unknown) {
    super(message);
  }
}

/** R40 (MB-205): the one plain message for a server that did not answer properly. */
export const UNREACHABLE_MESSAGE = "Couldn't reach Multies. Trying again.";

/**
 * R40 (MB-200, MB-205): true when the call failed because Multies could not be reached
 * (no connection, a dropped request, or a 5xx with no proper answer), not because the
 * request itself was wrong. These are worth retrying and never mean "signed out".
 */
/** Codes that mean "the server did not finish"; app answers with their own code (write_budget, resend_failed) keep their own words. */
const TRANSIENT_CODES = new Set(["network", "unreachable", "internal", "d1_busy", "busy", "idempotency_in_progress"]);

export function isTransientError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return err instanceof TypeError; // fetch throws TypeError offline
  if (err.code === "read_only") return false; // the app's own read only answer has its own banner
  return TRANSIENT_CODES.has(err.code) || err.status === 0 || err.status === 408 || (err.status === 502 && err.code === "error") || err.status === 504;
}

/** Message for any error: transient failures get the one plain line, never a status code. */
export function errorMessage(err: unknown, fallback = "Something went wrong. Try again."): string {
  if (isTransientError(err)) return UNREACHABLE_MESSAGE;
  return err instanceof ApiError && err.message ? err.message : fallback;
}

interface RequestOptions {
  /** Makes a POST safe to retry: the server replays the first response for the same key. */
  idempotencyKey?: string;
  /** Extra request headers (for example x-device-id for the free address limits). */
  headers?: Record<string, string>;
}

/** T1G (T1-8): how long one read may take before it is given up (not retried here; the query retries it once). */
export const READ_TIMEOUT = { ms: 30_000 };

/** R40: backoff between automatic retries of a GET (or a keyed write). Tests may shorten it. */
export const retryDelays = { ms: [300, 900] as number[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A new Idempotency-Key for one user action. Reuse it when the same action is retried. */
export function newIdempotencyKey(prefix = "web"): string {
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${rnd}`;
}

/**
 * R45 (MB-203): public/boot.js starts the account, config and My Work reads from the page before any app code runs.
 * The first GET of the same path takes that answer (once, and only within 30 s of the page loading); later reads fetch.
 */
const EARLY_MS = 30_000;
export function takeEarlyRead(path: string, now = Date.now()): Promise<Response> | null {
  const box = (globalThis as { __mmEarly?: Record<string, { at: number; res: Promise<Response> } | undefined> }).__mmEarly;
  const hit = box?.[path];
  if (!box || !hit) return null;
  delete box[path];
  return now - hit.at <= EARLY_MS ? hit.res : null;
}

async function once<T>(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<T> {
  let res: Response;
  let text: string;
  // T1G (T1-8): a read that never answers is given up after READ_TIMEOUT, so a page shows Retry instead of waiting forever.
  const ctl = method === "GET" && typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), READ_TIMEOUT.ms) : null;
  try {
    try {
      const early = method === "GET" && !Object.keys(headers).length ? takeEarlyRead(path) : null;
      res = early ? await early : await fetch(`/api${path}`, {
        method,
        credentials: "same-origin",
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      text = await res.text();
    } catch {
      if (ctl?.signal.aborted) throw new ApiError(0, "timeout", UNREACHABLE_MESSAGE);
      throw new ApiError(0, "network", UNREACHABLE_MESSAGE);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const e = json?.error;
    if (res.status === 503 && e?.code === "read_only") markReadOnly();
    if (res.status === 429 && e?.code === "workspace_budget") markWorkspaceBudget();
    // An empty or non JSON 5xx is the platform, not Multies: one plain message, no status code.
    if (!e && res.status >= 500) throw new ApiError(res.status, "unreachable", UNREACHABLE_MESSAGE);
    if (!e) throw new ApiError(res.status, "error", res.status >= 500 ? UNREACHABLE_MESSAGE : "Something went wrong. Try again.");
    const code: string = e.code ?? "error";
    throw new ApiError(res.status, code, TRANSIENT_CODES.has(code) ? UNREACHABLE_MESSAGE : (e.message ?? "Something went wrong. Try again."), e.details?.fields, e.details);
  }
  return json as T;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  // R58 (MB-245): a tab behind a workspace switch made in another tab sends no write; the banner offers Reload.
  const blocked = workspaceTabs()?.blockWrite(method, path);
  if (blocked) throw new ApiError(409, "workspace_switched", blocked);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  if (opts.headers) Object.assign(headers, opts.headers);
  // R40 (MB-199/200): GETs and keyed writes are safe to repeat, so a dropped request or an
  // empty 5xx is retried with a short backoff. Unkeyed writes are never repeated here.
  const safe = method === "GET" || !!opts.idempotencyKey;
  const delays = safe ? retryDelays.ms : [];
  for (let i = 0; ; i++) {
    try {
      return await once<T>(method, path, body, headers);
    } catch (err) {
      if (i >= delays.length || !isTransientError(err) || (err as ApiError).code === "timeout") throw err;
      await sleep(delays[i]!);
    }
  }
}

/**
 * R40 (MB-201): one key per user action. The same create (same path and body) reuses its key until it succeeds,
 * so pressing Retry after "Couldn't reach Multies" can never make a second project, task or invite.
 */
const actionKeys = new Map<string, { key: string; at: number }>();
const ACTION_KEY_MS = 10 * 60_000;
async function postOnce<T>(path: string, body: unknown = {}, opts: RequestOptions = {}): Promise<T> {
  const sig = `${path}\n${JSON.stringify(body)}`;
  let entry = actionKeys.get(sig);
  if (!entry || Date.now() - entry.at > ACTION_KEY_MS) {
    entry = { key: newIdempotencyKey(), at: Date.now() };
    actionKeys.set(sig, entry);
  }
  const out = await request<T>("POST", path, body, { ...opts, idempotencyKey: entry.key });
  actionKeys.delete(sig);
  return out;
}

export const api = {
  /** POST for creates: sends an Idempotency-Key and reuses it when the same action is retried. */
  create: <T>(p: string, b: unknown = {}, o?: RequestOptions) => postOnce<T>(p, b, o),
  get: <T>(p: string, opts?: RequestOptions) => request<T>("GET", p, undefined, opts),
  post: <T>(p: string, b: unknown = {}, o?: RequestOptions) => request<T>("POST", p, b, o),
  patch: <T>(p: string, b: unknown, o?: RequestOptions) => request<T>("PATCH", p, b, o),
  put: <T>(p: string, b: unknown) => request<T>("PUT", p, b),
  del: <T>(p: string, b?: unknown) => request<T>("DELETE", p, b),
};
