/**
 * R31: the session cookie under the __Host- prefix in production.
 *
 * Better Auth names the cookie "__Secure-mymail.session_token" when secure cookies are on and
 * cannot emit a __Host- name itself. A __Host- cookie is pinned to this exact host, Path=/,
 * Secure, no Domain, so a sibling subdomain can never set or overwrite it. This layer sits
 * outside Better Auth:
 * - requests: "__Host-mymail.session_token" is handed to Better Auth as the __Secure- name
 *   (dual read: a browser that still holds only the old __Secure- cookie keeps working);
 * - responses: every Set-Cookie for the __Secure- name leaves as the __Host- name;
 * - migration: a request that arrived with only the old cookie gets the same value back under
 *   the __Host- name and the old one expired, so nobody is signed out.
 * Nothing changes when secure cookies are off (local development and tests over http).
 */
import type { MiddlewareHandler } from "hono";

export const SECURE_SESSION_COOKIE = "__Secure-mymail.session_token";
export const HOST_SESSION_COOKIE = "__Host-mymail.session_token";
const MIGRATE_MAX_AGE = 30 * 24 * 60 * 60; // the session lifetime; the server still checks expiry

interface Pair { name: string; value: string }

function parsePairs(header: string): Pair[] {
  const out: Pair[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() });
  }
  return out;
}

/** The Cookie header Better Auth should see, and whether the browser still needs moving to the new name. */
export function rewriteRequestCookie(header: string | null): { header: string | null; legacyValue: string | null } {
  if (!header || !header.includes("mymail.session_token")) return { header, legacyValue: null };
  const pairs = parsePairs(header);
  const host = pairs.find((p) => p.name === HOST_SESSION_COOKIE);
  const legacy = pairs.find((p) => p.name === SECURE_SESSION_COOKIE);
  if (!host) return { header, legacyValue: legacy ? legacy.value : null };
  const rest = pairs.filter((p) => p.name !== HOST_SESSION_COOKIE && p.name !== SECURE_SESSION_COOKIE);
  rest.push({ name: SECURE_SESSION_COOKIE, value: host.value });
  return { header: rest.map((p) => `${p.name}=${p.value}`).join("; "), legacyValue: null };
}

/**
 * R32: the headers Better Auth should read for a request that did not pass through the app's middleware
 * (the chat and docs WebSockets are upgraded by the entries before the app). Without this the browser's
 * __Host- cookie was unknown to Better Auth there, and both sockets answered 401 in production.
 */
export function authHeaders(headers: Headers, enabled: boolean): Headers {
  if (!enabled) return headers;
  const cookie = headers.get("cookie");
  const { header } = rewriteRequestCookie(cookie);
  if (header === cookie) return headers;
  const out = new Headers(headers);
  if (header) out.set("cookie", header); else out.delete("cookie");
  return out;
}

/** One Set-Cookie line, renamed to the __Host- form when it is the session cookie. */
export function rewriteSetCookie(line: string): string {
  if (!line.startsWith(`${SECURE_SESSION_COOKIE}=`)) return line;
  const [first, ...attrs] = line.split(";");
  const kept = attrs.map((a) => a.trim()).filter((a) => a && !/^domain=/i.test(a) && !/^path=/i.test(a) && !/^secure$/i.test(a));
  return [`${HOST_SESSION_COOKIE}=${first.slice(SECURE_SESSION_COOKIE.length + 1)}`, "Path=/", "Secure", ...kept].join("; ");
}

export function migrationCookies(value: string): string[] {
  return [
    `${HOST_SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${MIGRATE_MAX_AGE}`,
    `${SECURE_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
  ];
}

export function hostSessionCookie(enabled: boolean): MiddlewareHandler {
  return async (c, next) => {
    if (!enabled) return next();
    const { header, legacyValue } = rewriteRequestCookie(c.req.raw.headers.get("cookie"));
    if (header !== c.req.raw.headers.get("cookie")) {
      const headers = new Headers(c.req.raw.headers);
      if (header) headers.set("cookie", header); else headers.delete("cookie");
      c.req.raw = new Request(c.req.raw, { headers });
    }
    await next();
    const set = c.res.headers.getSetCookie();
    const touchesSession = set.some((s) => s.startsWith(`${SECURE_SESSION_COOKIE}=`));
    const migrate = legacyValue && !touchesSession && c.res.status < 400;
    if (!touchesSession && !migrate) return;
    const res = new Response(c.res.body, c.res);
    res.headers.delete("set-cookie");
    for (const s of set) res.headers.append("set-cookie", rewriteSetCookie(s));
    if (migrate && legacyValue) for (const s of migrationCookies(legacyValue)) res.headers.append("set-cookie", s);
    if (touchesSession) res.headers.append("set-cookie", migrationCookies("")[1]);
    c.res = undefined as unknown as Response;
    c.res = res;
  };
}
