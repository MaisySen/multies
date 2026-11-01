/**
 * The page paths the web app routes (see src/web/router.tsx). Servers answer any other page
 * path with HTTP 404 (the app still shows its page-not-found screen), so search engines and
 * link checkers see a real 404. Keep this in step with the router.
 */
import { SWITCH_SLUGS } from "./switch-sources";
import { AREA_SLUGS } from "./marketing-areas";

const EXACT = new Set([
  "/", "/pricing", "/agents", "/developers", "/developers/mcp", "/check", "/trust", "/security", "/status", "/changelog", "/privacy", "/support", "/delete-account", "/terms", "/acceptable-use", "/dpa",
  "/login", "/signup", "/forgot-password", "/reset-password", "/email-verified", "/guest", "/thanks", "/contact", "/thank-you", "/oauth/authorize",
]);
// R58 (MB-237): the free plan page, the switch list, and one switch page per tool the import reads (unknown tools are a 404).
for (const p of ["/startups", "/switch", ...SWITCH_SLUGS.map((s) => `/switch/${s}`)]) EXACT.add(p);
// W1: the features list, one page per product area, and the public What's new address.
for (const p of ["/features", "/whats-new", ...AREA_SLUGS.map((s) => `/features/${s}`)]) EXACT.add(p);
const PREFIXES = ["/app", "/invite/", "/f/", "/m/", "/g/", "/book/", "/go/", "/dash/", "/i/", "/fb/", "/w/", "/report/", "/data-request/"]; // R112: /report/<id> anonymous reports, /data-request/<id> data requests; R114: /w/ webinar registration and attendee pages; R93: /fb/<board> public feedback boards; R105: /i/<token> invoice and quote view; R87: go links (members only); R91: /dash/<token> public dashboards

/** R76: every exact page path, so a test can check each has its own title (seo-meta.ts) and a sitemap entry where public. */
export const KNOWN_PAGE_PATHS: readonly string[] = [...EXACT];

export function isKnownPage(pathname: string) {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (EXACT.has(p)) return true;
  return PREFIXES.some((x) => (x.endsWith("/") ? p.startsWith(x) && p.length > x.length : p === x || p.startsWith(`${x}/`)));
}
