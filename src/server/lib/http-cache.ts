/**
 * R25 API speed: ETag and 304 Not Modified for GETs that suit it.
 *
 * The body is still built on the server; what a matching If-None-Match saves is the transfer and
 * the client's parse. Every policy here makes the client revalidate on each use (no-cache), so a
 * change is never hidden. Private data says "private" so a shared cache (a CDN or a proxy) never
 * keeps it, and varies on the credentials so one person's copy is never offered to another.
 * Only the workspace config is public: it has no account data in it.
 */
import type { Hono, MiddlewareHandler } from "hono";
import { etag } from "hono/etag";

export const PUBLIC_REVALIDATE = "public, no-cache";
export const PRIVATE_REVALIDATE = "private, no-cache";

/** Paths (exact) and the Cache-Control each gets. Keep this list to read only, cheap to compare GETs. */
export const REVALIDATED_GETS: Record<string, string> = {
  "/api/config": PUBLIC_REVALIDATE,
  "/api/team/people": PRIVATE_REVALIDATE,
  "/api/tasks/assignees": PRIVATE_REVALIDATE,
  "/api/projects": PRIVATE_REVALIDATE,
  "/api/chat/channels": PRIVATE_REVALIDATE,
};

const tag = etag({ weak: true });

export function revalidate(policy: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    await tag(c, async () => {
      await next();
      if (!c.res.ok) return;
      c.res.headers.set("cache-control", policy);
      if (policy.startsWith("private")) c.res.headers.append("vary", "Cookie, Authorization");
    });
  };
}

/** Registers the policies on the app. Call after the /api/* no-store default, before the routes. */
export function installHttpCache(app: Hono<any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const [path, policy] of Object.entries(REVALIDATED_GETS)) app.use(path, revalidate(policy));
}
