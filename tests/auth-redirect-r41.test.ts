import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers";
import { authErrorRedirectUrl, isAuthNavigation } from "@/server/lib/auth-redirect";

const IDP = { AUTH0_DOMAIN: "multies-test.us.auth0.com", AUTH0_CLIENT_ID: "web-client", AUTH0_CLIENT_SECRET: "web-secret" };
const nav = { accept: "text/html,application/xhtml+xml", "sec-fetch-mode": "navigate", host: "localhost" };

describe("R41 MB-222: sign in redirect routes never end on raw JSON", () => {
  it("knows a browser navigation from an API call", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(isAuthNavigation("GET", "/api/auth/callback/auth0", h(nav))).toBe(true);
    expect(isAuthNavigation("GET", "/api/auth/oauth2/callback/auth0", h(nav))).toBe(true);
    expect(isAuthNavigation("GET", "/api/auth/callback/auth0", h({ accept: "application/json", "sec-fetch-mode": "cors" }))).toBe(false);
    expect(isAuthNavigation("POST", "/api/auth/callback/auth0", h(nav))).toBe(false);
    expect(isAuthNavigation("GET", "/api/auth/get-session", h(nav))).toBe(false);
    expect(isAuthNavigation("GET", "/api/auth/verify-email", h({ accept: "*/*" }))).toBe(true);
  });

  it("builds a plain sign in page link and never echoes raw text", () => {
    expect(authErrorRedirectUrl("/api/auth/callback/auth0", 401, "unauthorized")).toBe("/login?error=signin&code=unauthorized");
    expect(authErrorRedirectUrl("/api/auth/callback/auth0", 503)).toBe("/login?error=server");
    expect(authErrorRedirectUrl("/api/auth/verify-email", 400, "<script>x</script>")).toBe("/login?error=verify&code=scriptxscript");
  });

  it("a failed provider callback in the browser redirects to /login?error=..., not JSON", async () => {
    const { app } = await makeTestApp(IDP);
    // No state cookie and a made up code: Better Auth refuses the callback.
    for (const path of ["/api/auth/callback/auth0?code=x&state=y", "/api/auth/oauth2/callback/auth0?code=x&state=y", "/api/auth/oauth2/callback/auth0?error=access_denied"]) {
      const res = await app.request(path, { headers: nav });
      expect(res.status, path).toBe(302);
      const loc = res.headers.get("location") ?? "";
      expect(loc, path).toMatch(/\/login\?error=/);
      expect(res.headers.get("content-type") ?? "").not.toContain("json");
    }
  });

  it("Better Auth's own error page sends the browser to the sign in page", async () => {
    const { app } = await makeTestApp(IDP);
    const res = await app.request("/api/auth/error?error=state_mismatch", { headers: nav });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=signin&code=state_mismatch");
  });

  it("an API caller on the same path still gets JSON", async () => {
    const { app } = await makeTestApp(IDP);
    const res = await app.request("/api/auth/get-session", { headers: { accept: "application/json", host: "localhost" } });
    expect(res.headers.get("location")).toBeNull();
  });
});
