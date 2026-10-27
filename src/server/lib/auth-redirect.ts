/**
 * R41 (MB-222): a browser that lands on a sign in redirect route (the identity provider's callback,
 * Better Auth's own error page, an emailed confirmation link) must never be left on a raw JSON body.
 * Any status of 400 or more on one of these navigations becomes a redirect to the sign in page with a
 * plain message and a Try again button. API callers (fetch, the mobile app) keep the JSON.
 */

/** Paths a browser arrives at by navigation during sign in. */
const AUTH_NAV = /^\/api\/auth\/(callback\/|oauth2\/callback\/|error(\/|$)|verify-email(\/|$)|magic-link\/verify|reset-password\/[^/]+$|logout\/idp)/;

export function isAuthNavigation(method: string, path: string, headers: Headers): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (!AUTH_NAV.test(path)) return false;
  const mode = headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  const accept = headers.get("accept") ?? "";
  // No fetch metadata (an older browser, a mail client opening a link): anything that is not a JSON fetch.
  return !accept.includes("application/json") || accept.includes("text/html");
}

/** The sign in page with a reason code the page turns into plain words. Never echoes the raw error text. */
export function authErrorRedirectUrl(path: string, status: number, code?: string | null): string {
  const reason = path.startsWith("/api/auth/verify-email") ? "verify" : status >= 500 ? "server" : "signin";
  const q = new URLSearchParams({ error: reason });
  const c = (code ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
  if (c) q.set("code", c);
  return `/login?${q.toString()}`;
}

/** Reads a short error code from a JSON error body without trusting its size. */
export async function errorCodeOf(res: Response): Promise<string | null> {
  if (!(res.headers.get("content-type") ?? "").includes("json")) return null;
  try {
    const text = (await res.clone().text()).slice(0, 2000);
    const body = JSON.parse(text) as { error?: { code?: string } | string; code?: string };
    if (typeof body.error === "string") return body.error;
    return body.error?.code ?? body.code ?? null;
  } catch {
    return null;
  }
}

/** When a redirect points at Better Auth's own error page, the error code it carries ("" when none); otherwise undefined. */
export function authErrorPageCode(location: string): string | undefined {
  try {
    const u = new URL(location, "http://x");
    if (!/^\/api\/auth\/error\/?$/.test(u.pathname)) return undefined;
    return u.searchParams.get("error") ?? "";
  } catch {
    return undefined;
  }
}
