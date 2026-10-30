import { HttpTransport } from "@/api/transport";
import { ApiError, NETWORK_ERROR } from "@/api/errors";
import { refreshOutcome, sessionExpiry, shouldRefreshEarly, singleFlight, verdictFor } from "@/lib/auth-keep";

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } } as unknown as Response;
}

function setup(route: (url: string, n: number) => Response | Error | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = jest.fn(async (url: string) => {
    calls.push(url.replace("https://api.test/api", ""));
    const next = await route(url, calls.length);
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const onUnauthorised = jest.fn();
  const t = new HttpTransport({ get: () => ({}), set: () => {} }, onUnauthorised, "https://api.test", fetchImpl);
  return { t, calls, onUnauthorised };
}

describe("R33 keep-session decision", () => {
  it("never signs out on a network error, timeout, busy server or rate limit", () => {
    expect(verdictFor(NETWORK_ERROR())).toBe("keep");
    expect(verdictFor(new TypeError("Network request failed"))).toBe("keep");
    for (const status of [408, 429, 500, 502, 503, 504, 403]) expect(verdictFor(new ApiError(status, "error", "x"))).toBe("keep");
    expect(verdictFor(NETWORK_ERROR(), true)).toBe("keep");
  });
  it("refreshes on a plain 401 and signs out only on a definite answer", () => {
    expect(verdictFor(new ApiError(401, "unauthorized", "x"))).toBe("refresh");
    expect(verdictFor(new ApiError(401, "unauthorized", "x"), true)).toBe("signOut");
    expect(verdictFor(new ApiError(401, "invalid_grant", "x"))).toBe("signOut");
    expect(verdictFor(new ApiError(401, "session_revoked", "x"))).toBe("signOut");
  });
  it("reads a session check: session ok, null or 401 gone, no answer unknown", () => {
    expect(refreshOutcome({ body: { session: { id: "s" }, user: {} } })).toBe("ok");
    expect(refreshOutcome({ body: null })).toBe("gone");
    expect(refreshOutcome({ error: new ApiError(401, "unauthorized", "x") })).toBe("gone");
    expect(refreshOutcome({ error: NETWORK_ERROR() })).toBe("unknown");
    expect(refreshOutcome({ error: new ApiError(503, "error", "x") })).toBe("unknown");
  });
  it("refreshes early inside a day of expiry or after a day without a check", () => {
    const now = 1_000_000_000_000;
    expect(shouldRefreshEarly(now + 3 * 86400_000, now - 1000, now)).toBe(false);
    expect(shouldRefreshEarly(now + 3600_000, now - 1000, now)).toBe(true);
    expect(shouldRefreshEarly(null, now - 2 * 86400_000, now)).toBe(true);
  });
  it("reads the session cookie expiry", () => {
    expect(sessionExpiry("__Secure-mymail.session_token=a.b; Max-Age=604800; Path=/", 0)).toBe(604800_000);
    expect(sessionExpiry("other=1; Max-Age=5", 0)).toBeNull();
  });
  it("runs one refresh at a time", async () => {
    let n = 0;
    const f = singleFlight(async () => { n++; await new Promise((r) => setTimeout(r, 5)); return n; });
    const [a, b] = await Promise.all([f(), f()]);
    expect([a, b, n]).toEqual([1, 1, 1]);
  });
});

describe("R33 transport refresh", () => {
  it("renews once for several 401s, then retries each request once", async () => {
    let renewed = false;
    const s = setup((url) => {
      if (url.endsWith("/auth/get-session")) { renewed = true; return new Promise((r) => setTimeout(() => r(res(200, { session: { id: "s" }, user: {} })), 5)); }
      return renewed ? res(200, { ok: url }) : res(401, { error: { code: "unauthorized", message: "Sign in" } });
    });
    const out = await Promise.all([s.t.request("GET", "/v1/a"), s.t.request("GET", "/v1/b")]);
    expect(out).toEqual([{ ok: "https://api.test/api/v1/a" }, { ok: "https://api.test/api/v1/b" }]);
    expect(s.calls.filter((c) => c === "/auth/get-session")).toHaveLength(1);
    expect(s.onUnauthorised).not.toHaveBeenCalled();
  });
  it("keeps the session when the refresh gets no answer", async () => {
    const s = setup((url) => url.endsWith("/auth/get-session") ? new TypeError("Network request failed") : res(401, { error: { code: "unauthorized" } }));
    await expect(s.t.request("GET", "/v1/a")).rejects.toMatchObject({ status: 401 });
    expect(s.onUnauthorised).not.toHaveBeenCalled();
  });
  it("keeps the session on a network error or a 503", async () => {
    const s = setup((url) => url.endsWith("/v1/a") ? new TypeError("Network request failed") : res(503, { error: { code: "busy" } }));
    await expect(s.t.request("GET", "/v1/a")).rejects.toMatchObject({ status: 0 });
    await expect(s.t.request("GET", "/v1/b")).rejects.toMatchObject({ status: 503 });
    expect(s.onUnauthorised).not.toHaveBeenCalled();
    expect(s.calls).not.toContain("/auth/get-session");
  });
  it("signs out on a revoked session without a refresh", async () => {
    const s = setup(() => res(401, { error: { code: "session_revoked" } }));
    await expect(s.t.request("POST", "/v1/a", {})).rejects.toMatchObject({ status: 401 });
    expect(s.onUnauthorised).toHaveBeenCalledTimes(1);
    expect(s.calls).toEqual(["/v1/a"]);
  });
  it("refreshes ahead of expiry and signs out when the session is gone", async () => {
    const s = setup(() => res(200, null));
    s.t.expiresAt = Date.now() + 1000;
    expect(await s.t.refreshIfDue()).toBe("gone");
    expect(s.onUnauthorised).toHaveBeenCalledTimes(1);
  });
});
