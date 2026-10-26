/**
 * R32: what the service worker does with each request, as a pure function the tests import.
 *  - "shell":   a page load under /app: network first (3 s), then the cached app shell, then the offline page.
 *  - "static":  hashed build files and icons: cache first (they never change under a name).
 *  - "api-offline": a short allow list of API reads the shell needs to draw (config, sign in methods, who
 *               is signed in): network first, so online always reads fresh and a different person on the
 *               device never sees the last one's copy; the stored copy answers only when the network fails.
 *               Wiped at sign out. Never auth actions, never mail, never lists of work.
 *  - "network": everything else goes straight to the network and is never stored.
 */
export type SwStrategy = "shell" | "static" | "api-offline" | "network";

/**
 * The deployment's config, which sign in methods exist, and the signed in person's own account summary
 * (name, workspace, role) so the app frame draws offline. Nothing else from the API is ever stored.
 */
export const API_SWR_PATHS = ["/api/config", "/api/account/providers", "/api/account/me"] as const;

/** Unhashed files that still belong to the shell. */
export const STATIC_PATHS = ["/favicon.svg", "/favicon.ico", "/favicon-32.png", "/favicon-16.png", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/site.webmanifest", "/offline.html", "/legacy.js"] as const;

export const SHELL_KEY = "/app";
export const OFFLINE_PATH = "/offline.html";
export const NAV_TIMEOUT_MS = 3000;
export const CACHE_PREFIX = "multies-";

export interface SwRequestLike { method: string; url: string; mode?: string; headers?: { get(name: string): string | null } }

export function swStrategy(req: SwRequestLike, origin: string): SwStrategy {
  if (req.method !== "GET") return "network";
  let url: URL;
  try { url = new URL(req.url); } catch { return "network"; }
  if (url.origin !== origin) return "network";
  const path = url.pathname;
  // A request that carries credentials other than the cookie (an API key) is never stored.
  if (req.headers?.get("authorization")) return "network";
  if (path.startsWith("/api/")) return (API_SWR_PATHS as readonly string[]).includes(path) && !url.search ? "api-offline" : "network";
  if (req.mode === "navigate") return path === "/app" || path.startsWith("/app/") ? "shell" : "network";
  if (path.startsWith("/assets/")) return "static";
  if ((STATIC_PATHS as readonly string[]).includes(path)) return "static";
  return "network";
}

export interface SwResponseLike { ok: boolean; status: number; type?: string; headers: { get(name: string): string | null } }

/** A response may be stored only when it is a plain same origin 200 that does not ask not to be. */
export function isStorable(res: SwResponseLike): boolean {
  if (!res.ok || res.status !== 200) return false;
  if (res.type && res.type !== "basic" && res.type !== "default") return false;
  const cc = (res.headers.get("cache-control") ?? "").toLowerCase();
  if (cc.includes("no-store") || cc.includes("private")) return false;
  if (res.headers.get("set-cookie")) return false;
  if ((res.headers.get("vary") ?? "").toLowerCase().includes("cookie")) return false;
  return true;
}

/**
 * The body must be what the path says it is before it is kept: a missing chunk answered by an HTML fallback
 * must never be stored as JavaScript, and only real HTML becomes the offline shell (pattern from the
 * offline captures in files/teardowns/rea/linear/offline-push.md).
 */
export function typeMatches(path: string, contentType: string | null): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (/\.m?js$/.test(path)) return ct.includes("javascript");
  if (/\.css$/.test(path)) return ct.includes("text/css");
  if (/\.html$/.test(path) || !/\.[a-z0-9]+$/i.test(path)) return ct.includes("text/html") || path.startsWith("/api/");
  return true;
}

/**
 * For the api-offline list only. The API marks every answer no-store so shared HTTP caches keep nothing;
 * this cache is on the person's own device, wiped at sign out, and read only when offline. It still refuses
 * anything that sets a cookie, any non-JSON body and any error.
 */
export function isStorableApi(res: SwResponseLike): boolean {
  if (!res.ok || res.status !== 200) return false;
  if (res.type && res.type !== "basic" && res.type !== "default") return false;
  if (res.headers.get("set-cookie")) return false;
  return (res.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

export function cacheNames(version: string) {
  return { shell: `${CACHE_PREFIX}shell-${version}`, static: `${CACHE_PREFIX}static-${version}`, api: `${CACHE_PREFIX}api-${version}` };
}

/** Caches an activating worker deletes: ours from other versions. Other names are not ours to touch. */
export function staleCaches(keys: string[], version: string): string[] {
  const keep = new Set(Object.values(cacheNames(version)));
  return keys.filter((k) => k.startsWith(CACHE_PREFIX) && !keep.has(k));
}

/** Where a notification click goes: a same origin /app path, else the notifications page. */
export function clickTarget(url: unknown): string {
  return typeof url === "string" && /^\/app(\/|\?|$)/.test(url) && !url.startsWith("//") ? url : "/app/notifications";
}

/** The notification a push shows, from the payload the server sends (web-push-r32.ts). */
export function notificationFor(data: unknown): { title: string; options: { body: string; icon: string; badge: string; tag: string; data: { url: string } } } {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const s = (v: unknown, max: number, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback);
  return {
    title: s(d.title, 120, "Multies"),
    options: { body: s(d.body, 200, "Open in Multies"), icon: "/icon-192.png", badge: "/favicon-32.png", tag: s(d.tag, 64, "multies"), data: { url: clickTarget(d.url) } },
  };
}
