/**
 * Security headers for every response: a strict Content Security Policy, HSTS,
 * framing, MIME sniffing, referrer and permissions policy. One source of truth for
 * the API (Hono middleware), the Workers asset handler and the Node static server.
 *
 * Notes on the CSP:
 * - script-src is 'self' plus the hash of the one inline theme script (R31). No 'unsafe-inline'.
 * - style-src allows 'unsafe-inline' because React sets style attributes and email
 *   bodies render in a sandboxed srcdoc iframe, which inherits this policy.
 * - img-src allows https: so a reader can opt in to remote images in a message; the
 *   iframe adds its own stricter policy that blocks them until then.
 * - connect-src adds Sentry's ingest hosts so browser errors can be reported.
 * - R30: WebSockets are no longer "any wss:". connect-src lists our own origin (collab and
 *   chat sockets), LiveKit Cloud (*.livekit.cloud, wss and https for region lookups) and the
 *   configured LIVEKIT_URL for a self-hosted LiveKit. Violations go to /api/csp-report, which
 *   only logs (no database rows). Sign in (Auth0, Google, Microsoft, GitHub) and Stripe
 *   Checkout and the billing portal are full page redirects, so they need no CSP entry;
 *   form-action stays 'self' because no form posts to another origin.
 */
export interface CspOptions {
  /** Extra hosts allowed in connect-src (for example a self-hosted Sentry). */
  connectSrc?: string[];
  /** Report endpoint for CSP violations (Sentry's security endpoint works). */
  reportUri?: string;
  /** The public form page: allow the Cloudflare Turnstile widget. */
  turnstile?: boolean;
  /** A Cloudflare Web Analytics beacon token is set: allow its script and its reporting host. */
  analytics?: boolean;
  /** The app's own origin (APP_URL): its ws/wss form is listed for the collab and chat sockets. */
  appUrl?: string;
  /** LIVEKIT_URL: a self-hosted LiveKit server gets its wss and https origins in connect-src. */
  livekitUrl?: string;
}

/** Where browsers send CSP violation reports (logged only, see routes/csp-report-r30.ts). */
export const CSP_REPORT_PATH = "/api/csp-report";
export const CSP_REPORT_GROUP = "csp";
/** The Reporting API header that names the report-to group. */
export const REPORTING_ENDPOINTS = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;

const LIVEKIT_CLOUD = ["wss://*.livekit.cloud", "https://*.livekit.cloud"];

/** The ws(s) and http(s) origins for a URL, for connect-src. Empty for anything unparsable. */
export function socketOrigins(url: string | undefined, withHttp: boolean): string[] {
  if (!url) return [];
  try {
    const u = new URL(url);
    if (!/^(https?|wss?):$/.test(u.protocol)) return [];
    const secure = u.protocol === "https:" || u.protocol === "wss:";
    const out = [`${secure ? "wss" : "ws"}://${u.host}`];
    if (withHttp) out.push(`${secure ? "https" : "http"}://${u.host}`);
    return out;
  } catch {
    return [];
  }
}

const TURNSTILE = "https://challenges.cloudflare.com";
const CF_INSIGHTS_SCRIPT = "https://static.cloudflareinsights.com";
const CF_INSIGHTS = "https://cloudflareinsights.com";
/** R115: free map tiles, styles and fonts for contact and visit maps (keyless). */
const MAP_TILES = "https://tiles.openfreemap.org";
const SENTRY_INGEST = ["https://*.ingest.sentry.io", "https://*.ingest.us.sentry.io", "https://*.ingest.de.sentry.io"];

/**
 * R31: the one inline script, in index.html (and the landing and sign in shells built from it): it sets the
 * saved light or dark appearance before first paint, so it cannot wait for a file. R77: inside the app it also
 * paints the cached workspace brand (CSS custom properties only) and the workspace default appearance. Its sha256 is allowed by
 * hash, never 'unsafe-inline'. tests/theme-inline-r31.test.ts keeps this hash equal to the script's bytes.
 */
export const THEME_SCRIPT = 'try{var d=document.documentElement,t=localStorage.getItem("multies-theme");if(t==="light"||t==="dark")d.dataset.theme=t;if(location.pathname.indexOf("/app")===0){var b=JSON.parse(localStorage.getItem("multies-brand")||"null");if(b){if(t!=="light"&&t!=="dark"&&(b.a==="light"||b.a==="dark"))d.dataset.theme=b.a;if(typeof b.c==="string"&&b.c){var s=document.createElement("style");s.id="brand-tokens";s.textContent=b.c;document.head.appendChild(s)}}}}catch(e){}';
export const THEME_SCRIPT_HASH = "'sha256-tTjXVFtiGiMpAU0jVWic+HURQaoh9Btt7O5R4TAwLWs='";

export function appCsp(opts: CspOptions = {}): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // Public form pages (/f/...) load Cloudflare Turnstile; every other page runs only our own scripts.
    // Cloudflare Web Analytics (cookieless) is allowed only when a beacon token is configured.
    // R78: 'wasm-unsafe-eval' lets the Tools Convert hub compile its own WebAssembly encoders (AVIF, WEBP) from our own
    // origin. It allows WebAssembly compilation only; eval and inline script stay blocked.
    "script-src": ["'self'", THEME_SCRIPT_HASH, "'wasm-unsafe-eval'", ...(opts.analytics ? [CF_INSIGHTS_SCRIPT] : []), ...(opts.turnstile ? [TURNSTILE] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    // Video meetings: LiveKit Cloud or a self-hosted LiveKit server, over secure WebSockets.
    "connect-src": unique(["'self'", ...socketOrigins(opts.appUrl, false), ...SENTRY_INGEST, ...(opts.analytics ? [CF_INSIGHTS] : []), ...LIVEKIT_CLOUD, ...socketOrigins(opts.livekitUrl, true), MAP_TILES, ...(opts.connectSrc ?? [])]),
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
  directives["report-uri"] = [opts.reportUri ?? CSP_REPORT_PATH];
  directives["report-to"] = [CSP_REPORT_GROUP];
  return serialize(directives);
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

/** The API reference renderer, pinned (R30: it used to load whatever jsDelivr called latest). */
export const SCALAR_VERSION = "1.76.0";
export const SCALAR_CDN = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/`;

/**
 * The API reference page (Scalar) loads its pinned renderer from jsDelivr through our own boot
 * script (R30: no inline script and no 'unsafe-inline' in script-src any more). That page holds
 * no user data, so it gets its own policy.
 */
export function docsCsp(): string {
  return serialize({
    "default-src": ["'self'"],
    "script-src": ["'self'", SCALAR_CDN],
    "style-src": ["'self'", "'unsafe-inline'", SCALAR_CDN],
    "img-src": ["'self'", "data:", "https:"],
    "font-src": ["'self'", "data:", SCALAR_CDN, "https://fonts.scalar.com"],
    "connect-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  });
}

/** JSON responses never render, so the API gets the tightest possible policy. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** R109: the cookie free campaign pages (unsubscribe, signup, confirm) are small HTML pages with their own
 *  inline style and a form that posts back to the same origin. No scripts, no frames, nothing third party. */
export const CAMPAIGN_PUBLIC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

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
    // R30: interest-cohort (FLoC) is gone from browsers and only drew an "Unrecognized feature"
    // console error; browsing-topics is its successor.
    "permissions-policy": "accelerometer=(), browsing-topics=(), camera=(self), display-capture=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(self), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "x-dns-prefetch-control": "off",
    "x-permitted-cross-domain-policies": "none",
    "origin-agent-cluster": "?1",
  };
  // R30: preload makes the domain eligible for the browsers' HSTS preload list (hstspreload.org);
  // submitting it there is a separate, owner level choice.
  if (o.hsts) h["strict-transport-security"] = "max-age=63072000; includeSubDomains; preload";
  if (o.csp.includes(`report-to ${CSP_REPORT_GROUP}`)) h["reporting-endpoints"] = REPORTING_ENDPOINTS;
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

/** R93: the form shown inside the website bubble (/f/<form>/embed) is the one page other sites may frame. */
export const EMBED_FORM_PATH = /^\/f\/[A-Za-z0-9_-]{1,64}\/embed\/?$/;
export function frameableCsp(csp: string): string {
  return csp.replace(/frame-ancestors [^;]*/, "frame-ancestors *");
}
