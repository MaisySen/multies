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

interface ScrubbableEvent {
  message?: string;
  request?: { url?: string; query_string?: unknown; data?: unknown; cookies?: unknown; headers?: Record<string, string> };
  user?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
}

export function scrubEvent<E>(event: E): E {
  const e = event as unknown as ScrubbableEvent;
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
    if (b.message) b.message = scrubText(b.message);
    if (b.data) {
      if (typeof b.data.url === "string") b.data.url = scrubUrl(b.data.url);
      b.data = scrubObject(b.data);
    }
  }
  return event;
}

export const sentryPrivacy = { sendDefaultPii: false, beforeSend: scrubEvent, beforeSendTransaction: scrubEvent };
