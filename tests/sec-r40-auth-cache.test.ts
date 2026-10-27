import { describe, expect, it, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { clearAuthCache, effectiveSessionKey, resolveAuthCached } from "@/server/auth/guards";

// R40 sec: the in-isolate session cache must key on the cookie the sign in library really reads.
describe("session cache key (R40 sec)", () => {
  beforeEach(() => clearAuthCache());

  function tokenOf(cookie: string) {
    const m = cookie.match(/mymail\.session_token=([^;]+)/);
    return m![1];
  }

  it("a planted extra cookie cannot store someone else's session under a value the planter knows", async () => {
    const { app, deps } = await makeTestApp();
    const victim = new Client(app);
    await victim.signup();
    const real = tokenOf(victim.cookie);
    // The victim's browser carries a planted cookie X first, then the real session cookie.
    const planted = "planted.value";
    const victimHeaders = new Headers({ cookie: `__Host-mymail.session_token=${planted}; mymail.session_token=${real}`, host: "localhost" });
    const seen = await resolveAuthCached(deps, victimHeaders, "GET", "/api/tasks");
    expect(seen).not.toBeNull();
    // The planter now sends X alone: it must not read as the victim.
    const attacker = new Headers({ cookie: `mymail.session_token=${planted}`, host: "localhost" });
    expect(await resolveAuthCached(deps, attacker, "GET", "/api/tasks")).toBeNull();
  });

  it("keys on the __Host- value in production and ignores the plain name there", () => {
    const h = new Headers({ cookie: "mymail.session_token=x; __Host-mymail.session_token=real" });
    expect(effectiveSessionKey(h, true)).toBe("real");
    expect(effectiveSessionKey(new Headers({ cookie: "mymail.session_token=x" }), true)).toBeNull();
    expect(effectiveSessionKey(new Headers({ cookie: "__Secure-mymail.session_token=s" }), true)).toBe("s");
  });

  it("never caches a duplicated cookie or a request with an Authorization header", () => {
    expect(effectiveSessionKey(new Headers({ cookie: "mymail.session_token=a; mymail.session_token=b" }), false)).toBeNull();
    expect(effectiveSessionKey(new Headers({ cookie: "mymail.session_token=a", authorization: "Bearer z" }), false)).toBeNull();
    expect(effectiveSessionKey(new Headers({ cookie: "mymail.session_token=a" }), false)).toBe("a");
  });

  it("a write that can change someone else's access empties the whole isolate copy, other writes do not", async () => {
    const { app, deps } = await makeTestApp();
    const a = new Client(app);
    await a.signup();
    const b = new Client(app);
    await b.signup();
    const aHeaders = new Headers({ cookie: a.cookie, host: "localhost" });
    const first = await resolveAuthCached(deps, aHeaders, "GET", "/api/tasks");
    expect(first).not.toBeNull();
    expect(await resolveAuthCached(deps, aHeaders, "GET", "/api/tasks")).toBe(first);
    // An ordinary write by someone else leaves A's copy alone.
    await b.call("POST", "/api/tasks", { title: "x" });
    expect(await resolveAuthCached(deps, aHeaders, "GET", "/api/tasks")).toBe(first);
    // Removing a member (even one that does not exist) drops every copy, so A's next read is fresh.
    await b.call("DELETE", "/api/team/members/usr_nobody");
    const after = await resolveAuthCached(deps, aHeaders, "GET", "/api/tasks");
    expect(after).not.toBeNull();
    expect(after).not.toBe(first);
  });
});
