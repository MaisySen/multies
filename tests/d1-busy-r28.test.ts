import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { d1BusyKind, isD1BusyError, withReadRetry } from "@/server/lib/d1-busy";
import { isD1LimitError } from "@/server/lib/d1-limit";
import { docs } from "@/server/db/schema";

/** R28 (found by Haajir, tsk_0mvomqzifj95btq7snu): D1 briefly unavailable answers 503 + Retry-After, not 500. */

const BUSY: [string, string, number][] = [
  ["D1_ERROR: Currently processing a long-running export.", "export", 30],
  ["D1 DB is overloaded. Too many requests queued.", "overloaded", 5],
  ["D1_ERROR: Requests queued for too long.", "overloaded", 5],
  ["D1_ERROR: Network connection lost.", "network", 2],
  ["D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node.", "network", 2],
  ["D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.", "reset", 2],
  ["D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.", "reset", 2],
  ["D1_ERROR: Durable Object reset because its code was updated.", "reset", 2],
  ["SQLITE_BUSY: database is locked", "locked", 2],
  ["D1_ERROR: The database is temporarily unavailable, please retry.", "unavailable", 5],
];
const NOT_BUSY = [
  "UNIQUE constraint failed: docs.id",
  "D1_ERROR: no such column: foo",
  "D1_ERROR: too many SQL variables",
  "D1 DB has exceeded its daily write limit",
  "Cannot read properties of undefined (reading 'id')",
];

describe("d1BusyKind", () => {
  it("classifies every retryable D1 message, also when Drizzle wraps it as a cause", () => {
    for (const [message, kind, retryAfter] of BUSY) {
      expect(d1BusyKind(new Error(message)), message).toEqual({ kind, retryAfter });
      expect(d1BusyKind(new Error("Failed query: insert into docs ...", { cause: new Error(message) })), message).toEqual({ kind, retryAfter });
    }
    expect(d1BusyKind(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }))?.kind).toBe("locked");
  });
  it("leaves real errors (and the daily limit, which has its own answer) alone", () => {
    for (const m of NOT_BUSY) expect(isD1BusyError(new Error(m)), m).toBe(false);
    expect(isD1LimitError(new Error("D1 DB has exceeded its daily write limit"))).toBe(true);
    expect(isD1BusyError(undefined)).toBe(false);
  });
});

describe("the API when the database is busy", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let key: string;
  let failWith: Error | null;
  let reported: Mock<(err: unknown, context?: Record<string, unknown>) => string | undefined>;

  beforeEach(async () => {
    ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    key = (await c.post("/api/developer/keys", { name: "Busy" })).body.secret;
    failWith = null;
    reported = vi.fn((_err: unknown, _context?: Record<string, unknown>): string | undefined => "evt_1");
    ctx.deps.reportError = reported;
    // Simulated D1 failures on the docs table only, so sign in and key checks still work.
    const db = ctx.deps.db as unknown as Record<string, (...a: unknown[]) => unknown>;
    const realInsert = db.insert.bind(db);
    db.insert = (table: unknown, ...rest: unknown[]) => { if (table === docs && failWith) throw failWith; return realInsert(table, ...rest); };
    const realSelect = db.select.bind(db);
    db.select = (...a: unknown[]) => {
      const q = realSelect(...a) as { from: (t: unknown, ...r: unknown[]) => unknown };
      const from = q.from.bind(q);
      q.from = (t: unknown, ...r: unknown[]) => { if (t === docs && failWith) throw failWith; return from(t, ...r); };
      return q;
    };
  });
  const call = (method: string, path: string, body?: unknown) => ctx.app.request(`/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });

  it("answers a write 503 with Retry-After and the code busy for each class, without reporting it as a bug", async () => {
    for (const [message, kind, retryAfter] of BUSY) {
      failWith = new Error("Failed query: insert into \"docs\"", { cause: new Error(message) });
      const res = await call("POST", "/docs", { title: "Plan" });
      expect(res.status, message).toBe(503);
      expect(res.headers.get("retry-after"), message).toBe(String(retryAfter));
      expect(await res.json()).toEqual({ error: { code: "busy", message: expect.stringContaining("try again"), details: { reason: kind } } });
    }
    expect(reported).not.toHaveBeenCalled();
    failWith = null;
    expect((await call("POST", "/docs", { title: "Plan" })).status).toBe(201);
  });

  it("answers the exact Sentry shape from 26 Oct (MYMAIL-API-Y, -Z) with 503 and Retry-After, and reports nothing", async () => {
    // Drizzle's wrapper, whose cause is the D1 error, whose own cause carries the message without the prefix.
    const inner = new Error("Currently processing a long-running export.");
    const d1 = new Error("D1_ERROR: Currently processing a long-running export.", { cause: inner });
    failWith = new Error("Failed query: select \"id\", \"title\" from \"docs\" where \"docs\".\"org_id\" = ? limit ?\nparams: org_1,200", { cause: d1 });
    expect(d1BusyKind(failWith)).toEqual({ kind: "export", retryAfter: 30 });
    expect(d1BusyKind(inner)).toEqual({ kind: "export", retryAfter: 30 });
    const warn = vi.fn();
    ctx.deps.log = { info: () => {}, warn, error: vi.fn() };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [method, body] of [["GET", undefined], ["POST", { title: "Plan" }]] as const) {
      const res = await call(method, "/docs", body);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("30");
      expect((await res.json()).error).toMatchObject({ code: "busy", details: { reason: "export" } });
    }
    expect(reported).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith("[api] unhandled", expect.anything());
    errorSpy.mockRestore();
  });

  it("answers a read the same way", async () => {
    failWith = new Error("D1_ERROR: Currently processing a long-running export.");
    const res = await call("GET", "/docs");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("keeps any other error a 500 that goes to error tracking", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    failWith = new Error("Failed query", { cause: new Error("D1_ERROR: no such column: foo") });
    const res = await call("POST", "/docs", { title: "Plan" });
    expect(res.status).toBe(500);
    expect(res.headers.get("retry-after")).toBeNull();
    expect((await res.json()).error).toMatchObject({ code: "internal", details: { eventId: "evt_1" } });
    expect(reported).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("tells an MCP client it is busy instead of failing the request", async () => {
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    failWith = new Error("D1_ERROR: Network connection lost.");
    const r = await mcp.callTool({ name: "search_docs", arguments: {} }) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^busy: /);
    expect(reported).not.toHaveBeenCalled();
    await mcp.close();
  });
});

describe("withReadRetry", () => {
  /** A stand in for the D1 binding: prepare, bind and the statement methods, failing as told. */
  function fakeD1(failures: Error[]) {
    const calls: string[] = [];
    const made: object[] = [];
    const stmt = (sql: string, params: unknown[] = []) => {
      const s = {
        sql, params,
        bind: (...p: unknown[]) => stmt(sql, p),
        all: async () => { calls.push(`all ${sql}`); const f = failures.shift(); if (f) throw f; return { results: [{ ok: 1 }] }; },
        raw: async () => { calls.push(`raw ${sql}`); const f = failures.shift(); if (f) throw f; return [[1]]; },
        first: async () => { calls.push(`first ${sql}`); const f = failures.shift(); if (f) throw f; return { ok: 1 }; },
        run: async () => { calls.push(`run ${sql}`); const f = failures.shift(); if (f) throw f; return { success: true }; },
      };
      made.push(s);
      return s;
    };
    const db = { prepare: (sql: string) => stmt(sql), batch: async (list: object[]) => list.map((s) => made.includes(s)) };
    return { db, calls };
  }
  const waits: number[] = [];
  const wait = async (ms: number) => { waits.push(ms); };

  it("retries a SELECT once after a short pause when D1 is briefly unavailable", async () => {
    const { db, calls } = fakeD1([new Error("D1_ERROR: Network connection lost.")]);
    const onRetry = vi.fn();
    withReadRetry(db, { wait, onRetry });
    expect(await db.prepare("select * from docs where id = ?").bind("doc_1").all()).toEqual({ results: [{ ok: 1 }] });
    expect(calls).toEqual(["all select * from docs where id = ?", "all select * from docs where id = ?"]);
    expect(onRetry).toHaveBeenCalledWith("network");
    expect(waits.at(-1)).toBe(150);
  });

  it("does not retry writes, exports, real errors or a second failure", async () => {
    const lost = () => new Error("D1_ERROR: Network connection lost.");
    let f = fakeD1([lost()]);
    withReadRetry(f.db, { wait });
    await expect(f.db.prepare("insert into docs (id) values (?)").bind("d").run()).rejects.toThrow("Network connection lost");
    expect(f.calls).toHaveLength(1);

    f = fakeD1([new Error("D1_ERROR: Currently processing a long-running export.")]);
    withReadRetry(f.db, { wait });
    await expect(f.db.prepare("select 1").raw()).rejects.toThrow("export");
    expect(f.calls).toHaveLength(1);

    f = fakeD1([new Error("D1_ERROR: no such column: foo")]);
    withReadRetry(f.db, { wait });
    await expect(f.db.prepare("select foo from docs").first()).rejects.toThrow("no such column");
    expect(f.calls).toHaveLength(1);

    f = fakeD1([lost(), lost()]);
    withReadRetry(f.db, { wait });
    await expect(f.db.prepare("select 1").all()).rejects.toThrow("Network connection lost");
    expect(f.calls).toHaveLength(2);
  });

  it("keeps the real statements, so batch still gets D1 statements, and wraps only once", async () => {
    const { db } = fakeD1([]);
    withReadRetry(db, { wait });
    const prepare = db.prepare;
    withReadRetry(db, { wait });
    expect(db.prepare).toBe(prepare);
    const a = db.prepare("select 1");
    const b = db.prepare("update docs set title = ?").bind("x");
    expect(await db.batch([a, b])).toEqual([true, true]);
  });
});
