/**
 * The page paths the web app routes (see src/web/router.tsx). Servers answer any other page
 * path with HTTP 404 (the app still shows its page-not-found screen), so search engines and
 * link checkers see a real 404. Keep this in step with the router.
 */
const EXACT = new Set([
  "/", "/pricing", "/agents", "/check", "/status", "/privacy", "/support", "/delete-account", "/terms", "/acceptable-use", "/dpa",
  "/login", "/signup", "/forgot-password", "/reset-password", "/email-verified", "/guest", "/thanks",
]);
const PREFIXES = ["/app", "/invite/", "/f/", "/m/", "/g/", "/book/"];

export function isKnownPage(pathname: string) {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (EXACT.has(p)) return true;
  return PREFIXES.some((x) => (x.endsWith("/") ? p.startsWith(x) && p.length > x.length : p === x || p.startsWith(`${x}/`)));
}
