/**
 * B10: POST /api/v1/mcp with a valid key and a body that is JSON but not a JSON-RPC message ({}, null, an object with
 * no method) answered 500 "[api] unhandled Error": the MCP transport refuses it with an HTTP exception carrying a
 * JSON-RPC answer, which reached the app's error handler as an unknown error. It answers 400 with that JSON-RPC error
 * now, and an empty batch ([]) is an Invalid Request (400), not a 202.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

describe("B10: MCP with a JSON body that is not JSON-RPC", () => {
  it("answers 400 with a JSON-RPC error, never 500", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const key = (await c.post("/api/developer/keys", { name: "MCP" })).body.secret as string;
    const post = async (body: string) => {
      const res = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
      return { status: res.status, body: await res.json() as { jsonrpc?: string; error?: { code: number; message: string }; id?: unknown } };
    };
    for (const body of ["{}", "null", "42", `{"jsonrpc":"2.0"}`, `{"jsonrpc":"2.0","id":1}`, "[]", "[{}]"]) {
      const r = await post(body);
      expect(r.status, body).toBe(400);
      expect(r.body.jsonrpc, body).toBe("2.0");
      expect(r.body.id, body).toBeNull();
      expect([-32700, -32600], body).toContain(r.body.error?.code);
    }
    // A real request still works.
    const ok = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
    expect(ok.status).toBe(200);
  }, 60_000);
});
