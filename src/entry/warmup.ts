/*
 * R42 (MB-199, cold start): the free plan stops a request at 10 ms of CPU, and the first request a new isolate
 * serves used to cost 30 to 60 ms. Profiling the bundle (scripts/cold) showed no module initialisation at all in
 * that request (every module already starts with the script): the cost was the JavaScript engine compiling the
 * request path (routing, middleware, the session lookup, the query builder, the route) the first time it ran.
 * One signed in request run beforehand cut the next cold request from about 37 ms to about 5 ms locally.
 *
 * So at script startup, which has its own much larger allowance, a throwaway copy of the app answers a few signed
 * in GETs from a canned fixture (scripts/cold/record-fixture.mjs records it from a local demo workspace). The code
 * the engine compiles is shared with the real app; nothing else is: the copy has its own config and a fake
 * database that only replays the fixture, so no real data is read or written and no I/O happens.
 *
 * Startup forbids building a Request or Response, timers and random values, so for the length of the warm up the
 * globals Request, Response and Headers are small stand ins and crypto's random calls are deterministic. They are
 * put back when the warm up ends, and again (synchronously, before anything else) at the start of every real
 * request or cron run, so no real request can ever see a stand in. Any failure just means less is warmed.
 */
import { forgetUserCaches } from "../server/lib/isolate-cache";
import { forgetOrgCache } from "../server/services/plans";
import { clearAuthCache } from "../server/auth/guards";

/** The warm up copy's own app secret. Not a secret: it only signs the fixture's session for the throwaway copy. */
export const WARM_SECRET = "warm-up-only-copy-signing-value-not-a-secret-0001";

export interface WarmFixture {
  cookie: string;
  routes: string[];
  /** R44: GETs answered with the fixture's own key (the /api/v1 key path), and that key. The key only exists in the
   * fixture's throwaway demo database, so it opens nothing anywhere else. */
  keyRoutes?: string[];
  bearer?: string;
  calls: { sql: string; method: string; ret: unknown }[];
}
export interface WarmReport { ran: number; ok: number; statuses: number[]; outer?: number; error?: string }
interface FetchApp { fetch(req: Request, env?: unknown, ctx?: unknown): Response | Promise<Response> }

/* ---------- stand ins for the platform classes (warm up only) ---------- */
class WarmHeaders {
  private m = new Map<string, string[]>();
  constructor(init?: unknown) {
    if (!init) return;
    if (init instanceof WarmHeaders) { init.forEach((v, k) => this.append(k, v)); return; }
    const entries = Array.isArray(init) ? init : typeof (init as { entries?: unknown }).entries === "function" && !(init as object).constructor?.name?.startsWith("Object") ? [...(init as Map<string, string>).entries()] : Object.entries(init as Record<string, string>);
    for (const [k, v] of entries as [string, string][]) this.append(k, String(v));
  }
  append(k: string, v: string) { const key = k.toLowerCase(); const a = this.m.get(key); if (a) a.push(String(v)); else this.m.set(key, [String(v)]); }
  set(k: string, v: string) { this.m.set(k.toLowerCase(), [String(v)]); }
  get(k: string) { const a = this.m.get(k.toLowerCase()); return a ? a.join(", ") : null; }
  has(k: string) { return this.m.has(k.toLowerCase()); }
  delete(k: string) { this.m.delete(k.toLowerCase()); }
  getSetCookie() { return this.m.get("set-cookie") ?? []; }
  forEach(cb: (v: string, k: string, h: WarmHeaders) => void) { for (const [k, a] of this.m) cb(a.join(", "), k, this); }
  *entries(): IterableIterator<[string, string]> { for (const [k, a] of this.m) yield [k, a.join(", ")]; }
  *keys() { yield* this.m.keys(); }
  *values() { for (const a of this.m.values()) yield a.join(", "); }
  [Symbol.iterator]() { return this.entries(); }
}
type BodyLike = string | null | undefined | ArrayBuffer | Uint8Array | { toString(): string };
const bodyText = (b: BodyLike) => (b == null ? "" : typeof b === "string" ? b : b instanceof ArrayBuffer ? new TextDecoder().decode(b) : b instanceof Uint8Array ? new TextDecoder().decode(b) : String(b));
class WarmBody {
  bodyUsed = false;
  constructor(protected _body: BodyLike) {}
  get body() {
    if (this._body == null) return null;
    const bytes = new TextEncoder().encode(bodyText(this._body));
    let sent = false;
    // A one chunk stream reader: enough for middleware that hashes or copies a body (the ETag one does).
    return { locked: false, getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })), releaseLock() {}, cancel: async () => {} }), cancel: async () => {}, tee() { return [this, this]; } };
  }
  async text() { this.bodyUsed = true; return bodyText(this._body); }
  async json() { return JSON.parse(await this.text()); }
  async arrayBuffer() { return new TextEncoder().encode(await this.text()).buffer; }
  async formData(): Promise<never> { throw new Error("warm up: no form data"); }
  async blob(): Promise<never> { throw new Error("warm up: no blob"); }
}
class WarmRequest extends WarmBody {
  url: string; method: string; headers: WarmHeaders; signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
  redirect = "follow"; cf = undefined;
  constructor(input: string | WarmRequest | URL, init: { method?: string; headers?: unknown; body?: BodyLike } = {}) {
    super(init.body ?? (input instanceof WarmRequest ? input._body : null));
    this.url = input instanceof WarmRequest ? input.url : String(input);
    this.method = (init.method ?? (input instanceof WarmRequest ? input.method : "GET")).toUpperCase();
    this.headers = new WarmHeaders(init.headers ?? (input instanceof WarmRequest ? input.headers : undefined));
  }
  clone() { return new WarmRequest(this); }
}
class WarmResponse extends WarmBody {
  status: number; statusText: string; headers: WarmHeaders; type = "default"; redirected = false; url = ""; webSocket = null;
  constructor(body?: BodyLike, init: { status?: number; statusText?: string; headers?: unknown } = {}) {
    super(body);
    this.status = init.status ?? 200; this.statusText = init.statusText ?? ""; this.headers = new WarmHeaders(init.headers);
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  clone() { return new WarmResponse(this._body, { status: this.status, headers: this.headers }); }
  static json(data: unknown, init: { status?: number; headers?: unknown } = {}) {
    const r = new WarmResponse(JSON.stringify(data), init);
    if (!r.headers.has("content-type")) r.headers.set("content-type", "application/json");
    return r;
  }
  static redirect(url: string, status = 302) { return new WarmResponse(null, { status, headers: { location: url } }); }
}

/* ---------- swapping the globals in and out ---------- */
type Saved = { Request: unknown; Response: unknown; Headers: unknown; randomUUID: unknown; getRandomValues: unknown; hadUUID: boolean; hadGRV: boolean };
let saved: Saved | null = null;
/** Set once a real request or cron run has started: from then on the fake database refuses every call. */
let closed = false;
const g = globalThis as unknown as Record<string, unknown>;

function swapIn() {
  if (saved) return;
  const c = crypto as unknown as Record<string, unknown>;
  saved = { Request: g.Request, Response: g.Response, Headers: g.Headers, randomUUID: c.randomUUID, getRandomValues: c.getRandomValues, hadUUID: Object.prototype.hasOwnProperty.call(c, "randomUUID"), hadGRV: Object.prototype.hasOwnProperty.call(c, "getRandomValues") };
  g.Request = WarmRequest; g.Response = WarmResponse; g.Headers = WarmHeaders;
  let n = 0;
  Object.defineProperty(c, "randomUUID", { value: () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`, configurable: true, writable: true });
  Object.defineProperty(c, "getRandomValues", { value: <T extends ArrayBufferView | null>(a: T) => { if (a) { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i++) u[i] = (i * 31 + ++n) & 255; } return a; }, configurable: true, writable: true });
}

/** Puts the real platform classes back. Safe to call any number of times; cheap when nothing is swapped. */
export function endWarmup(): void {
  closed = true;
  if (!saved) return;
  const s = saved; saved = null;
  g.Request = s.Request; g.Response = s.Response; g.Headers = s.Headers;
  const c = crypto as unknown as Record<string, unknown>;
  if (s.hadUUID) Object.defineProperty(c, "randomUUID", { value: s.randomUUID, configurable: true, writable: true }); else delete c.randomUUID;
  if (s.hadGRV) Object.defineProperty(c, "getRandomValues", { value: s.getRandomValues, configurable: true, writable: true }); else delete c.getRandomValues;
  dropWarmCopies();
}
/** Nothing the warm up resolved may be served later: drops every per isolate copy (it runs after each warm route too). */
function dropWarmCopies() {
  try { clearAuthCache(); forgetUserCaches(); forgetOrgCache(); } catch { /* nothing cached */ }
}
export function warmupActive(): boolean { return saved !== null; }
/** Tests only: a fresh isolate's state (the warm up runs once per isolate). */
export function resetWarmupForTests(): void { endWarmup(); closed = false; }

/* ---------- the fake database: replays the fixture, never touches real data ---------- */
export function replayD1(fixture: WarmFixture) {
  const used = new Set<number>();
  const empty = (method: string) => (method === "all" || method === "run" ? { results: [], success: true, meta: { changes: 0 } } : method === "raw" ? [] : null);
  const find = (sql: string, method: string) => {
    if (closed) throw new Error("warm up over"); // a straggler never runs alongside real requests
    for (let i = 0; i < fixture.calls.length; i++) if (!used.has(i) && fixture.calls[i].sql === sql && fixture.calls[i].method === method) { used.add(i); return fixture.calls[i].ret; }
    for (let i = fixture.calls.length - 1; i >= 0; i--) if (fixture.calls[i].sql === sql && fixture.calls[i].method === method) return fixture.calls[i].ret;
    return empty(method);
  };
  const clone = (v: unknown) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const stmt = (sql: string): Record<string, unknown> => ({
    bind: () => stmt(sql),
    all: async () => clone(find(sql, "all")),
    raw: async () => clone(find(sql, "raw")),
    first: async (col?: string) => { const r = clone(find(sql, "first")) as Record<string, unknown> | null; return col && r ? r[col] : r; },
    run: async () => clone(find(sql, "run")),
    __sql: sql,
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: { __sql: string; all: () => Promise<unknown> }[]) => Promise.all(list.map((s) => s.all())),
    exec: async () => ({ count: 0, duration: 0 }),
    withSession() { return this; },
  };
}

/**
 * Runs the fixture's GETs through `app` (built on replayD1). `wrap` is the per request wrapper the real handler
 * uses (the auth request state). Resolves when every route answered or failed; the globals are always restored.
 */
export async function warmHotRoutes(app: FetchApp, fixture: WarmFixture, origin: string, wrap: <T>(fn: () => Promise<T>) => Promise<T>, outer?: (req: Request) => Promise<unknown>): Promise<WarmReport> {
  const report: WarmReport = { ran: 0, ok: 0, statuses: [] };
  if (closed) return report;
  swapIn();
  try {
    const host = new URL(origin).host;
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const plan: { path: string; auth: Record<string, string> }[] = [
      ...fixture.routes.map((path) => ({ path, auth: { cookie: fixture.cookie } })),
      ...(fixture.bearer ? (fixture.keyRoutes ?? []).map((path) => ({ path, auth: { authorization: `Bearer ${fixture.bearer}` } })) : []),
    ];
    for (const { path, auth } of plan) {
      if (closed) break;
      report.ran++;
      try {
        const req = new WarmRequest(origin + path, { headers: { host, origin, ...auth, accept: "application/json", "user-agent": "warmup" } });
        const res = (await wrap(() => Promise.resolve(app.fetch(req as unknown as Request, undefined, ctx)))) as unknown as WarmResponse;
        const text = await res.text();
        report.statuses.push(res.status);
        if (res.status === 200) report.ok++;
        else report.error ??= `${path.split("?")[0]} ${res.status} ${text.slice(0, 120)}`;
        dropWarmCopies();
      } catch (err) {
        report.statuses.push(0);
        report.error ??= err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
      }
    }
    // The outer entry too (the error reporting wrapper and the entry's own checks), with a request it answers on
    // its own (the www redirect), so the app is not involved.
    if (outer && !closed) {
      try { const r = (await outer(new WarmRequest(origin.replace("://", "://www.") + "/warm") as unknown as Request)) as WarmResponse | undefined; report.outer = r?.status ?? 0; }
      catch (err) { report.outer = 0; report.error ??= "outer " + (err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)); }
    }
  } finally {
    endWarmup();
    dropWarmCopies();
  }
  return report;
}
