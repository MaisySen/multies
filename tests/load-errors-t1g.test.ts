/**
 * T1G: clear errors instead of endless loading (T1-8), MCP parse errors (T1-1), long Contacts and Docs searches (T1-3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, READ_TIMEOUT, api, retryDelays } from "@/web/lib/api";
import { isFailedLoad, isServerLoadError, queryRetry, showLoadStrip } from "@/web/lib/load-errors-t1g";
import { makeTestApp, Client } from "./helpers";

const fakeQuery = (key: string, status: "error" | "success" | "pending", error: unknown, data: unknown, observers = 1) =>
  ({ queryKey: [key], state: { status, error, data }, getObserversCount: () => observers }) as unknown as Parameters<typeof isFailedLoad>[0];

describe("T1G: which failures count as a failed load", () => {
  it("server failures and dropped requests count; refusals and read only do not", () => {
    expect(isServerLoadError(new ApiError(500, "internal", "x"))).toBe(true);
    expect(isServerLoadError(new ApiError(503, "unreachable", "x"))).toBe(true);
    expect(isServerLoadError(new ApiError(0, "timeout", "x"))).toBe(true);
    expect(isServerLoadError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isServerLoadError(new ApiError(404, "not_found", "x"))).toBe(false);
    expect(isServerLoadError(new ApiError(403, "forbidden", "x"))).toBe(false);
    expect(isServerLoadError(new ApiError(503, "read_only", "x"))).toBe(false);
  });

  it("a failed read with nothing to show counts; one that keeps data, has no viewer, or is the account check does not", () => {
    const boom = new ApiError(500, "internal", "x");
    expect(isFailedLoad(fakeQuery("tasks", "error", boom, undefined))).toBe(true);
    expect(isFailedLoad(fakeQuery("tasks", "error", boom, []))).toBe(false);
    expect(isFailedLoad(fakeQuery("tasks", "error", boom, undefined, 0))).toBe(false);
    expect(isFailedLoad(fakeQuery("me", "error", boom, undefined))).toBe(false);
    expect(isFailedLoad(fakeQuery("tasks", "pending", null, undefined))).toBe(false);
    expect(isFailedLoad(fakeQuery("doc", "error", new ApiError(404, "not_found", "x"), undefined))).toBe(false);
  });

  it("the frame strip shows only online, with a failure, a skeleton on screen and no inline error", () => {
    expect(showLoadStrip({ online: true, failed: true, skeletons: 2, inline: 0 })).toBe(true);
    expect(showLoadStrip({ online: false, failed: true, skeletons: 2, inline: 0 })).toBe(false);
    expect(showLoadStrip({ online: true, failed: false, skeletons: 2, inline: 0 })).toBe(false);
    expect(showLoadStrip({ online: true, failed: true, skeletons: 0, inline: 0 })).toBe(false);
    expect(showLoadStrip({ online: true, failed: true, skeletons: 2, inline: 1 })).toBe(false);
  });

  it("reads retry a server failure once more (api.get already tried it three times) and never a 4xx", () => {
    const transient = new ApiError(500, "internal", "x");
    expect(queryRetry(0, transient)).toBe(true);
    expect(queryRetry(1, transient)).toBe(false);
    const own = new ApiError(500, "export_failed", "x");
    expect(queryRetry(1, own)).toBe(true);
    expect(queryRetry(2, own)).toBe(false);
    expect(queryRetry(0, new ApiError(404, "not_found", "x"))).toBe(false);
    expect(queryRetry(0, new ApiError(429, "rate_limited", "x"))).toBe(false);
  });
});

describe("T1G: a read that never answers is given up", () => {
  const saved = { ms: READ_TIMEOUT.ms, delays: retryDelays.ms };
  afterEach(() => { READ_TIMEOUT.ms = saved.ms; retryDelays.ms = saved.delays; vi.unstubAllGlobals(); });

  it("times out with the plain message and is not retried inside api.get", async () => {
    READ_TIMEOUT.ms = 30;
    retryDelays.ms = [1, 1];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await api.get("/tasks").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("timeout");
    expect((err as ApiError).message).toBe("Couldn't reach Multies. Trying again.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a read that answers in time is untouched", async () => {
    READ_TIMEOUT.ms = 1000;
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    expect(await api.get("/x")).toEqual({ ok: true });
  });
});

describe("T1G: server answers", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let c: Client;
  beforeEach(async () => {
    ctx = await makeTestApp();
    c = new Client(ctx.app);
    await c.signup("owner@acme.io");
  });

  it("T1-1: a malformed MCP body is a 400 JSON-RPC parse error, not a 500", async () => {
    const key = (await c.post("/api/developer/keys", { name: "MCP" })).body.secret as string;
    const res = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{bad json" });
    expect(res.status).toBe(400);
    const body = await res.json() as { jsonrpc: string; error: { code: number; message: string }; id: null };
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
    expect(body.error.message).toContain("not valid JSON");
    // A good body still works.
    const ok = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) });
    expect(ok.status).toBe(200);
  });

  it("T1-3: Contacts and Docs searches over 200 characters are cut, not refused", async () => {
    const long = "a".repeat(260);
    const contacts = await c.get(`/api/contacts?q=${long}`);
    expect(contacts.status).toBe(200);
    const docs = await c.get(`/api/docs?q=${long}`);
    expect(docs.status).toBe(200);
    expect(Array.isArray(docs.body.docs)).toBe(true);
  });
});
