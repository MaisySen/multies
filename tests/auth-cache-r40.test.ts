import { describe, expect, it, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { clearAuthCache, resolveAuthCached, sessionCookieKey, AUTH_CACHE_MS } from "@/server/auth/guards";

// R40 (MB-199): reads reuse a resolved session inside the isolate for a few seconds; writes never do.
describe("in-isolate session cache (R40)", () => {
  beforeEach(() => clearAuthCache());

  it("reads the session cookie under every name", () => {
    expect(sessionCookieKey(new Headers({ cookie: "a=1; mymail.session_token=abc.sig" }))).toBe("abc.sig");
    expect(sessionCookieKey(new Headers({ cookie: "__Host-mymail.session_token=xyz.s" }))).toBe("xyz.s");
    expect(sessionCookieKey(new Headers({ cookie: "__Secure-mymail.session_token=q.r; b=2" }))).toBe("q.r");
    expect(sessionCookieKey(new Headers({ cookie: "other=1" }))).toBeNull();
    expect(AUTH_CACHE_MS).toBeLessThanOrEqual(30_000);
  });

  it("a GET reuses the resolved session, a write resolves afresh", async () => {
    const { app, deps } = await makeTestApp();
    const c = new Client(app);
    await c.signup();
    const headers = new Headers({ cookie: c.cookie, host: "localhost" });
    const a = await resolveAuthCached(deps, headers, "GET");
    const b = await resolveAuthCached(deps, headers, "GET");
    expect(a).not.toBeNull();
    expect(b).toBe(a); // same object: served from the cache
    const w = await resolveAuthCached(deps, headers, "POST");
    expect(w).not.toBe(a); // writes never use the cached copy
    expect(w?.userId).toBe(a?.userId);
  });

  it("signing out is seen by the very next read", async () => {
    const { app } = await makeTestApp();
    const c = new Client(app);
    await c.signup();
    const cookie = c.cookie;
    expect((await c.get("/api/account/me")).status).toBe(200);
    expect((await c.get("/api/account/me")).status).toBe(200);
    const out = await c.post("/api/auth/sign-out", {}, );
    expect(out.status).toBe(200);
    // Replay the old cookie: the cached copy was dropped by the write, and the session is gone.
    c.cookie = cookie;
    expect((await c.get("/api/account/me")).status).toBe(401);
  });

  it("an unknown cookie is never cached as signed in", async () => {
    const { deps } = await makeTestApp();
    const headers = new Headers({ cookie: "mymail.session_token=forged.value", host: "localhost" });
    expect(await resolveAuthCached(deps, headers, "GET")).toBeNull();
    expect(await resolveAuthCached(deps, headers, "GET")).toBeNull();
  });
});
