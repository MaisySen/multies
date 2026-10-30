import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";

/**
 * R52 (MB-239): POST /api/v1/mcp sits behind the v1 Idempotency-Key middleware. A tool call sent twice with the
 * same key gets the first JSON-RPC answer back (idempotent-replayed: true) and runs once. The JSON-RPC request id
 * is not a replay key: the same id without a key runs again. Calls without a key, reads included, are unaffected.
 */
async function setup() {
  const t = await makeTestApp();
  const c = new Client(t.app);
  await c.signup("owner.mcp52@acme.io", "Olive Owner");
  const secret = (await c.post("/api/developer/keys", { name: "mcp" })).body.secret as string;
  const rpc = async (method: string, params: unknown, id: number, extra: Record<string, string> = {}) => {
    const r = await t.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const text = await r.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const json = JSON.parse(line ? line.slice(6) : text) as { result?: { content?: { text: string }[]; isError?: boolean }; error?: unknown };
    return { status: r.status, text, json, replayed: r.headers.get("idempotent-replayed") === "true" };
  };
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "r52", version: "1" } }, 0);
  const db = t.db as unknown as { all: (q: unknown) => { n: number }[] };
  const tasks = () => db.all(sql`select count(*) as n from tasks where deleted_at is null`)[0]!.n;
  const call = (name: string, args: unknown, id: number, extra: Record<string, string> = {}) => rpc("tools/call", { name, arguments: args }, id, extra);
  return { rpc, call, tasks };
}
const payload = (r: { json: { result?: { content?: { text: string }[] } } }) => JSON.parse(r.json.result!.content![0]!.text) as Record<string, unknown>;

describe("POST /mcp replay (R52 MB-239)", () => {
  it("a write tool call sent twice with one Idempotency-Key runs once and replays the same answer", async () => {
    const { call, tasks } = await setup();
    const before = tasks();
    const k = { "idempotency-key": "r52-mcp-create-0001" };
    const a = await call("create_task", { title: "Once via MCP" }, 7, k);
    expect(a.status).toBe(200);
    expect(a.json.result?.isError ?? false).toBe(false);
    const b = await call("create_task", { title: "Once via MCP" }, 7, k);
    expect(b.replayed).toBe(true);
    expect(b.text).toBe(a.text);
    expect(tasks()).toBe(before + 1);
    // The same key with a different call is refused, not run.
    const other = await call("create_task", { title: "Something else" }, 8, k);
    expect(other.status).toBe(422);
    expect(tasks()).toBe(before + 1);
  });

  it("the JSON-RPC id alone is not a replay key: the same id without a key runs again", async () => {
    const { call, tasks } = await setup();
    const before = tasks();
    await call("create_task", { title: "Twice" }, 9);
    await call("create_task", { title: "Twice" }, 9);
    expect(tasks()).toBe(before + 2);
  });

  it("a read call is unaffected: without a key it answers fresh each time, and a write in between shows", async () => {
    const { call } = await setup();
    const one = await call("list_tasks", {}, 10);
    expect(one.replayed).toBe(false);
    const n1 = JSON.stringify(payload(one)).length;
    await call("create_task", { title: "Shows up" }, 11);
    const two = await call("list_tasks", {}, 10);
    expect(two.replayed).toBe(false);
    expect(JSON.stringify(payload(two))).toContain("Shows up");
    expect(JSON.stringify(payload(two)).length).toBeGreaterThan(n1);
  });
});
