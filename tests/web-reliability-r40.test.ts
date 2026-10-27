import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, errorMessage, isTransientError, retryDelays, UNREACHABLE_MESSAGE } from "../src/web/lib/api";
import { clearMeCache, isSignedOut, meRetry, readMeCache, writeMeCache } from "../src/web/lib/me-cache";

/** R40 (MB-200, MB-205): the web client shrugs off empty 503s and keeps the last good account copy. */
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

function respond(status: number, body = "") {
  return new Response(body, { status, headers: body ? { "content-type": "application/json" } : {} });
}

describe("api client retries (R40)", () => {
  const saved = retryDelays.ms;
  beforeEach(() => { retryDelays.ms = [1, 1]; });
  afterEach(() => { retryDelays.ms = saved; vi.unstubAllGlobals(); });

  it("retries a GET after an empty 503 and returns the good answer", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(respond(200, '{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.get("/x")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a dropped connection on a GET, then gives the plain message", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const err = await api.get("/x").then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe(UNREACHABLE_MESSAGE);
    expect(isTransientError(err)).toBe(true);
  });

  it("never repeats an unkeyed POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(503));
    vi.stubGlobal("fetch", fetchMock);
    const err = await api.post("/projects", { name: "A" }).then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.message).toBe(UNREACHABLE_MESSAGE);
    expect(err.message).not.toMatch(/503/);
  });

  it("repeats a keyed POST with the same key", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(respond(201, '{"project":{"id":"p1"}}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.post("/projects", { name: "A" }, { idempotencyKey: "web-abcdefgh" })).resolves.toEqual({ project: { id: "p1" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const keys = fetchMock.mock.calls.map((c) => (c[1] as RequestInit & { headers: Record<string, string> }).headers["idempotency-key"]);
    expect(keys).toEqual(["web-abcdefgh", "web-abcdefgh"]);
  });

  it("does not retry a 4xx and keeps the app's own words", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(422, JSON.stringify({ error: { code: "validation", message: "Name is required." } })));
    vi.stubGlobal("fetch", fetchMock);
    const err = await api.get("/x").then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.message).toBe("Name is required.");
    expect(isTransientError(err)).toBe(false);
  });

  it("keeps a specific 5xx answer's words and does not retry it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(503, JSON.stringify({ error: { code: "write_budget", message: "Bulk changes are paused for today." } })));
    vi.stubGlobal("fetch", fetchMock);
    const err = await api.get("/x").then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.message).toBe("Bulk changes are paused for today.");
  });

  it("maps a generic 500 to the plain message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(500, JSON.stringify({ error: { code: "internal", message: "Something went wrong on our side." } }))));
    const err = await api.get("/x").then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as ApiError);
    expect(errorMessage(err)).toBe(UNREACHABLE_MESSAGE);
  });
});

describe("account copy (R40 MB-200)", () => {
  beforeEach(() => { store.clear(); clearMeCache(); vi.stubGlobal("localStorage", fakeStorage); });
  afterEach(() => vi.unstubAllGlobals());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const me = { user: { id: "u1", email: "a@x.test" }, organization: { id: "o1" } } as any;

  it("keeps the last good copy across reloads and drops it on sign out", () => {
    writeMeCache(me);
    clearMeCache();
    expect(readMeCache()).toBeUndefined();
    writeMeCache(me);
    expect(readMeCache()?.user.id).toBe("u1");
    expect(JSON.parse(store.get("multies.me.v1")!).me.user.id).toBe("u1");
    clearMeCache();
    expect(store.has("multies.me.v1")).toBe(false);
  });

  it("ignores a broken stored copy", () => {
    store.set("multies.me.v1", "{not json");
    expect(readMeCache()).toBeUndefined();
  });

  it("retries transient failures 3 times, never a 401", () => {
    const down = new ApiError(503, "unreachable", UNREACHABLE_MESSAGE);
    expect([0, 1, 2, 3].map((n) => meRetry(n, down))).toEqual([true, true, true, false]);
    const out = new ApiError(401, "unauthorized", "Sign in");
    expect(meRetry(0, out)).toBe(false);
    expect(isSignedOut(out)).toBe(true);
    expect(isSignedOut(down)).toBe(false);
  });
});
