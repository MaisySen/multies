/**
 * Security headers for every response: a strict Content Security Policy, HSTS,
 * framing, MIME sniffing, referrer and permissions policy. One source of truth for
 * the API (Hono middleware), the Workers asset handler and the Node static server.
 *
 * Notes on the CSP:
 * - script-src is 'self' only. The SPA ships no inline scripts.
 * - style-src allows 'unsafe-inline' because React sets style attributes and email
 *   bodies render in a sandboxed srcdoc iframe, which inherits this policy.
 * - img-src allows https: so a reader can opt in to remote images in a message; the
 *   iframe adds its own stricter policy that blocks them until then.
 * - connect-src adds Sentry's ingest hosts so browser errors can be reported.
 */
export interface CspOptions {
  /** Extra hosts allowed in connect-src (for example a self-hosted Sentry). */
  connectSrc?: string[];
  /** Report endpoint for CSP violations (Sentry's security endpoint works). */
  reportUri?: string;
  /** The public form page: allow the Cloudflare Turnstile widget. */
  turnstile?: boolean;
}

const TURNSTILE = "https://challenges.cloudflare.com";
const SENTRY_INGEST = ["https://*.ingest.sentry.io", "https://*.ingest.us.sentry.io", "https://*.ingest.de.sentry.io"];

export function appCsp(opts: CspOptions = {}): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // Public form pages (/f/...) load Cloudflare Turnstile; every other page runs only our own scripts.
    "script-src": ["'self'", ...(opts.turnstile ? [TURNSTILE] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    // Video meetings: LiveKit Cloud or a self-hosted LiveKit server, over secure WebSockets.
    "connect-src": ["'self'", ...SENTRY_INGEST, "https://*.livekit.cloud", "wss:", ...(opts.connectSrc ?? [])],
    "media-src": ["'self'", "blob:"],
    "frame-src": ["'self'", "blob:", ...(opts.turnstile ? [TURNSTILE] : [])],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "manifest-src": ["'self'"],
    "upgrade-insecure-requests": [],
  };
  if (opts.reportUri) directives["report-uri"] = [opts.reportUri];
  return serialize(directives);
}

/**
 * The API reference page (Scalar) loads its renderer from jsDelivr and boots it with
 * an inline script. That page holds no user data, so it gets its own policy.
 */
export function docsCsp(): string {
  return serialize({
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
    "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
    "img-src": ["'self'", "data:", "https:"],
    "font-src": ["'self'", "data:", "https://cdn.jsdelivr.net", "https://fonts.scalar.com"],
    "connect-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  });
}

/** JSON responses never render, so the API gets the tightest possible policy. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function serialize(d: Record<string, string[]>): string {
  return Object.entries(d).map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k)).join("; ");
}

export interface HeaderOptions {
  csp: string;
  /** HSTS only makes sense over HTTPS; off for plain-HTTP local development. */
  hsts: boolean;
}

/** Headers shared by every response. */
export function securityHeaders(o: HeaderOptions): Record<string, string> {
  const h: Record<string, string> = {
    "content-security-policy": o.csp,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "accelerometer=(), camera=(self), display-capture=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(self), payment=(), usb=(), interest-cohort=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "x-dns-prefetch-control": "off",
    "x-permitted-cross-domain-policies": "none",
    "origin-agent-cluster": "?1",
  };
  if (o.hsts) h["strict-transport-security"] = "max-age=63072000; includeSubDomains";
  return h;
}

/** Copies a response with the security headers applied (for asset responses). */
export function withSecurityHeaders(res: Response, o: HeaderOptions): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(securityHeaders(o))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function isHttps(url: string): boolean {
  return url.startsWith("https://");
}
