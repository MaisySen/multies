/**
 * B6: the email patterns backtrack quadratically on a long string of dots with no clean end. MCP schedule_meeting took
 * invitees with no length cap (the app and v1 schemas cap each at 254), and the contacts CSV check ran the pattern
 * before its length check. A long hostile value is refused at once now.
 */
import { describe, it, expect } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { checkRows, guessMapping } from "@/shared/crm-csv";

const hostile = (n: number) => `a@${"a.".repeat(n)}@`;

describe("B6: long email values are refused before any pattern runs", () => {
  it("MCP schedule_meeting refuses an invitee over 254 characters, quickly, and still takes a normal one", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const key = (await c.post("/api/developer/keys", { name: "MCP" })).body.secret as string;
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const t0 = performance.now();
    const bad = await mcp.callTool({ name: "schedule_meeting", arguments: { title: "Sync", invitees: [hostile(40_000)] } });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(bad.isError).toBe(true);
    const ok = await mcp.callTool({ name: "schedule_meeting", arguments: { title: "Sync", invitees: ["ana@studio.io"] } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse((ok as { content: { text: string }[] }).content[0].text).meeting.invitees).toEqual(["ana@studio.io"]);
  }, 60_000);

  it("the contacts CSV check refuses a long email before its pattern runs", () => {
    const t0 = performance.now();
    const r = checkRows([[hostile(40_000)]], guessMapping(["Email"]), 1);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(r.invalid).toEqual([{ line: 2, reason: "Email looks wrong" }]);
  });
});
