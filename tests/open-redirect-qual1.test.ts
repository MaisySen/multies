import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers";
import { authErrorRedirectUrl } from "@/server/lib/auth-redirect";
import { movedPath } from "@/shared/nav-menu";

/**
 * QUAL1 (CI green): Semgrep's express_open_redirect rule flags the sign in error redirect (src/server/app.ts) and the
 * old mail setup address redirect (src/entry/node.ts, the same movedPath in src/entry/worker.ts). Both build the
 * Location from a fixed path on our own site, never from a URL in the request. This proves it with the inputs an
 * attacker would try: a scheme, a protocol relative host, a backslash host and encoded forms of them.
 */
const NASTY = [
  "https://evil.example", "//evil.example", "/\\evil.example", "\\\\evil.example", "%2F%2Fevil.example",
  "javascript:alert(1)", "/%2F%2Fevil.example", "//evil.example/%2e%2e", " //evil.example", "\t/\\evil.example",
];
/** Same origin: a single slash that is not followed by another slash or a backslash, and it resolves to our host. */
function sameOrigin(loc: string) {
  expect(loc, loc).toMatch(/^\/(?![/\\])/);
  expect(new URL(loc, "https://multies.si").origin, loc).toBe("https://multies.si");
}

describe("redirects flagged by Semgrep stay on our own site", () => {
  it("the sign in error redirect is always /login with a cleaned code", () => {
    for (const bad of NASTY) {
      for (const status of [400, 500]) {
        const loc = authErrorRedirectUrl("/api/auth/callback/auth0", status, bad);
        sameOrigin(loc);
        expect(loc.startsWith("/login?error=")).toBe(true);
        expect(new URL(loc, "https://multies.si").searchParams.get("code") ?? "").toMatch(/^[a-z0-9_]*$/);
      }
    }
  });

  it("Better Auth's error page with a hostile error value lands on /login (app.ts, both redirect lines)", async () => {
    const { app } = await makeTestApp();
    const nav = { accept: "text/html", "sec-fetch-mode": "navigate", host: "localhost" };
    for (const bad of NASTY) {
      const res = await app.request(`/api/auth/error?error=${encodeURIComponent(bad)}`, { headers: nav });
      expect(res.status, bad).toBe(302);
      const loc = res.headers.get("location") ?? "";
      sameOrigin(loc);
      expect(loc.startsWith("/login?error=signin")).toBe(true);
    }
  });

  it("an old mail setup address moves under /app/settings whatever follows it", () => {
    for (const bad of NASTY) {
      for (const old of ["/app/mailboxes", "/app/domains", "/app/deliverability"]) {
        for (const path of [`${old}/${bad}`, `${old}//${bad}`, `${old}/${bad}?next=${bad}`]) {
          const moved = movedPath(path);
          expect(moved, path).not.toBeNull();
          sameOrigin(moved!);
          expect(moved!.startsWith("/app/settings/"), path).toBe(true);
        }
      }
      // Anything that is not an old mail setup address is left alone (no redirect at all).
      expect(movedPath(bad)).toBeNull();
      expect(movedPath(`/${bad}`)).toBeNull();
    }
  });
});
