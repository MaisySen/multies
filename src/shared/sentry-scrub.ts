/**
 * Scrubs Sentry events before they leave the process (Workers, Node and the browser).
 * Request bodies, cookies and credential headers never leave; query strings lose their values
 * (they can carry tokens); email addresses in messages and breadcrumbs are masked.
 * Plain object work only, so it adds nothing to cold start.
 */
const SECRET_HEADERS = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-mymail-signature|x-mymail-key|x-multies-check|webhook-signature|stripe-signature|svix-signature|cf-access-jwt-assertion|x-forwarded-for|cf-connecting-ip|x-real-ip)$/i;
const SECRET_KEYS = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|signature|otp|code|card|cvc)/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const API_KEY = /\bmm_(live|test)_[A-Za-z0-9]{8,}/g;
/** MH1: one time codes in a URL written into a message (the app to web handoff, OAuth callbacks). */
const CODE_PARAM = /([?&](?:code|token)=)[^&\s"'#]+/gi;

export function scrubText(s: string): string {
  return s.replace(BEARER, "$1[redacted]").replace(CODE_PARAM, "$1[redacted]").replace(API_KEY, "mm_$1_[redacted]").replace(EMAIL, "[email]");
}

export function scrubUrl(raw: string): string {
  const q = raw.indexOf("?");
  if (q < 0) return raw;
  const base = raw.slice(0, q);
  const keys = raw.slice(q + 1).split("&").map((p) => p.split("=")[0]).filter(Boolean);
  return keys.length ? `${base}?${keys.map((k) => `${k}=[redacted]`).join("&")}` : base;
}

function scrubObject(o: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (SECRET_KEYS.test(k)) out[k] = "[redacted]";
    else if (typeof v === "string") out[k] = scrubText(v);
    else if (v && typeof v === "object" && !Array.isArray(v) && depth < 3) out[k] = scrubObject(v as Record<string, unknown>, depth + 1);
    else out[k] = v;
  }
  return out;
}

/**
 * POL5: nothing binary ever leaves in an error report or a trace. Any Blob, File, ArrayBuffer, typed array or
 * DataView value, and any data: or blob: string, anywhere in extra, contexts, tags, breadcrumb data and span data
 * (bounded depth), is replaced by this marker. Recordings stay on the device by construction.
 */
export const BINARY_REMOVED = "[binary removed]";
const MAX_STRIP_DEPTH = 8;
const BINARY_TAG = /^\[object (Blob|File|ArrayBuffer|SharedArrayBuffer|DataView|MediaStream|MediaSource|ImageData|[A-Za-z0-9]+Array)\]$/;
const BINARY_URL = /^\s*(data|blob):/i;

export function isBinaryValue(v: unknown): boolean {
  if (typeof v === "string") return BINARY_URL.test(v);
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  if (typeof ArrayBuffer !== "undefined" && (v instanceof ArrayBuffer || ArrayBuffer.isView(v))) return true;
  if (typeof Blob !== "undefined" && v instanceof Blob) return true;
  return BINARY_TAG.test(Object.prototype.toString.call(v));
}

/** A copy of the value with every binary value (and anything past the depth bound) replaced. */
export function stripBinary(v: unknown, depth = 0): unknown {
  if (isBinaryValue(v)) return BINARY_REMOVED;
  if (v === null || typeof v !== "object") return v;
  if (depth >= MAX_STRIP_DEPTH) return "[depth limit]";
  if (Array.isArray(v)) return v.map((x) => stripBinary(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = stripBinary(x, depth + 1);
  return out;
}

const asRecord = (v: unknown) => stripBinary(v) as Record<string, unknown>;

interface SpanLike { op?: string; description?: string; data?: Record<string, unknown>; start_timestamp?: number }

/** Strips binary values from one span (transaction child spans and streamed spans). */
export function scrubSpan<S>(span: S): S {
  const sp = span as unknown as SpanLike;
  if (sp && typeof sp === "object") {
    if (typeof sp.description === "string") sp.description = isBinaryValue(sp.description) ? BINARY_REMOVED : scrubText(sp.description);
    if (sp.data) sp.data = asRecord(sp.data);
  }
  return span;
}

/**
 * POL5: a trace stays well under the tunnel's 200 KB. Long animation frame and long task spans are dropped (a phone
 * video compositor makes thousands), then at most MAX_SPANS spans are kept, then spans are halved until the
 * serialised event is under TRACE_BUDGET_BYTES. The count dropped rides a tag.
 */
export const MAX_SPANS = 300;
export const TRACE_BUDGET_BYTES = 120_000;
const NOISY_SPAN = /^ui\.long-(animation-frame|task)/;

export function capTransaction<E>(event: E): E {
  const e = event as unknown as { spans?: SpanLike[]; tags?: Record<string, unknown> };
  if (!Array.isArray(e.spans)) return event;
  const before = e.spans.length;
  let spans = e.spans.filter((sp) => !NOISY_SPAN.test(sp?.op ?? ""));
  if (spans.length > MAX_SPANS) spans = spans.slice(0, MAX_SPANS);
  e.spans = spans;
  const size = () => { try { return JSON.stringify(event).length; } catch { return Infinity; } };
  while (e.spans.length > 0 && size() > TRACE_BUDGET_BYTES) e.spans = e.spans.slice(0, Math.floor(e.spans.length / 2));
  const dropped = before - e.spans.length;
  if (dropped > 0) e.tags = { ...(e.tags ?? {}), spans_dropped: String(dropped) };
  return event;
}

interface ScrubbableEvent {
  message?: string;
  request?: { url?: string; query_string?: unknown; data?: unknown; cookies?: unknown; headers?: Record<string, string> };
  user?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  spans?: SpanLike[];
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
}

export function scrubEvent<E>(event: E, hint?: { attachments?: unknown[] }): E {
  const e = event as unknown as ScrubbableEvent;
  // POL5: no attachment ever rides an event (the SDK reads hint.attachments after this hook).
  if (hint && Array.isArray(hint.attachments)) hint.attachments.length = 0;
  if (e.extra) e.extra = asRecord(e.extra);
  if (e.contexts) e.contexts = asRecord(e.contexts);
  if (e.tags) e.tags = asRecord(e.tags);
  if (Array.isArray(e.spans)) for (const sp of e.spans) scrubSpan(sp);
  if (e.request) {
    delete e.request.data;
    delete e.request.cookies;
    if (e.request.query_string) e.request.query_string = "[redacted]";
    if (e.request.url) e.request.url = scrubUrl(e.request.url);
    if (e.request.headers) for (const h of Object.keys(e.request.headers)) if (SECRET_HEADERS.test(h)) e.request.headers[h] = "[redacted]";
  }
  // Keep the user id for grouping; drop the email, name and IP.
  if (e.user) e.user = e.user.id ? { id: e.user.id } : {};
  if (e.message) e.message = scrubText(e.message);
  if (e.extra) e.extra = scrubObject(e.extra);
  for (const v of e.exception?.values ?? []) if (v.value) v.value = scrubText(v.value);
  for (const b of e.breadcrumbs ?? []) {
    if (b.message) b.message = isBinaryValue(b.message) ? BINARY_REMOVED : scrubText(b.message);
    if (b.data) {
      b.data = asRecord(b.data);
      if (typeof b.data.url === "string") b.data.url = scrubUrl(b.data.url);
      b.data = scrubObject(b.data);
    }
  }
  return event;
}

/** POL5: transactions are scrubbed and capped to the trace budget. */
export function scrubTransaction<E>(event: E, hint?: { attachments?: unknown[] }): E {
  return capTransaction(scrubEvent(event, hint));
}

/**
 * POL5: envelope item types allowed to leave (browser hook and the tunnel use the same list). Attachments,
 * replays and profiles are never sent.
 */
export const ALLOWED_ENVELOPE_ITEMS = ["event", "transaction", "session", "sessions", "client_report", "span", "log"] as const;
export const envelopeItemAllowed = (type: unknown) => typeof type === "string" && (ALLOWED_ENVELOPE_ITEMS as readonly string[]).includes(type);

export const sentryPrivacy = { sendDefaultPii: false, beforeSend: scrubEvent, beforeSendTransaction: scrubTransaction, beforeSendSpan: scrubSpan };
