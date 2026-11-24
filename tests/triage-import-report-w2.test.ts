import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";

/**
 * Round 2 (PR 24 leftover): only POST /work-imports/run told the caller that imported tasks wait in Triage. MCP
 * import_file, POST /data-moves/imports/run and the import history now say so too: the move carries triage: true,
 * kept in its existing created JSON (no migration).
 */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function mcpWith(token: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchViaApp }));
  return client;
}
const key = async () => (await c.post("/api/developer/keys", { name: "Bot" })).body.secret as string;
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

describe("Round 2: data moves report Triage", () => {
  it("MCP import_file into a Triage-on project answers move.triage true, and list_data_moves keeps it", async () => {
    const p = (await c.post("/api/projects", { name: "Ops" })).body.project.id as string;
    const m = await mcpWith(await key());
    const out = data(await m.callTool({ name: "import_file", arguments: { kind: "tasks", fileName: "ops.csv", content: "Title,Status\nGive contractor admin access,To do\n", projectId: p } }));
    expect(out.move.triage).toBe(true);
    const listed = data(await m.callTool({ name: "list_data_moves", arguments: {} }));
    expect(listed.items[0].triage).toBe(true);
    await m.close();
  });

  it("v1 POST /data-moves/imports/run says triage true for a key, false into a Triage-off project and for a person", async () => {
    const on = (await c.post("/api/projects", { name: "On" })).body.project.id as string;
    const off = (await c.post("/api/projects", { name: "Off", triage: false })).body.project.id as string;
    const k = await key();
    const waits = await api(k, "POST", "/data-moves/imports/run", { kind: "tasks", fileName: "a.csv", content: "Title,Status\nPay supplier,To do\n", projectId: on });
    expect(waits.status).toBe(200);
    expect(waits.body.move.triage).toBe(true);
    const board = await api(k, "POST", "/data-moves/imports/run", { kind: "tasks", fileName: "b.csv", content: "Title,Status\nOrder paper,To do\n", projectId: off });
    expect(board.body.move.triage).toBe(false);
    const mine = await c.post("/api/data-moves/imports/run", { kind: "tasks", fileName: "c.csv", content: "Title,Status\nRing the landlord,To do\n", projectId: on });
    expect(mine.status).toBe(200);
    expect(mine.body.move.triage).toBe(false);
  });
});
