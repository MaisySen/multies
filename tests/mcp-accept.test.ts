import { beforeAll, describe, expect, it } from "vitest";
import { mcpPostReply } from "../src/server/routes/mcp-accept";
import { Client, makeTestApp } from "./helpers";

describe("mcpPostReply (RFC 9110 Accept negotiation)", () => {
  it.each([
    [undefined, "json"],
    ["", "json"],
    ["   ", "json"],
    ["*/*", "json"],
    ["application/json", "json"],
    ["APPLICATION/JSON", "json"],
    ["application/*", "json"],
    ["APPLICATION/*", "json"],
    ["application/json; charset=utf-8", "json"],
    ["application/json, text/event-stream", "json"],
    ["text/event-stream", "events"],
    ["TEXT/EVENT-STREAM", "events"],
    ["text/*", "events"],
    ["TEXT/*", "events"],
    ["text/event-stream;q=0.9, application/json;q=0.5", "events"],
    ["application/json;q=0, text/event-stream", "events"],
    ["application/json;q=0, */*;q=0.5", "events"],
    ["text/event-stream;q=0, */*;q=0.5", "json"],
    ["text/html, application/xhtml+xml", null],
    ["application/json;q=0, text/event-stream;q=0", null],
  ] as const)("negotiates %j -> %j", (header, expected) => {
    expect(mcpPostReply(header)).toBe(expected);
  });
});

describe("POST /api/v1/mcp honors uppercase, wildcard and weighted Accept headers", () => {
  let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
  let token: string;

  beforeAll(async () => {
    const x = await makeTestApp();
    app = x.app;
    const web = new Client(app);
    await web.signup("mcp-accept@example.test");
    const created = await web.post("/api/developer/keys", { name: "MCP Accept Key" });
    expect(created.status).toBe(201);
    token = created.body.secret as string;
  });

  async function postMcp(accept?: string) {
    const headers: Record<string, string> = {
      host: "localhost",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    if (accept !== undefined) headers.accept = accept;
    return app.request("/api/v1/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  }

  it.each([
    ["application/json", "application/json", 200],
    ["APPLICATION/JSON", "application/json", 200],
    ["application/*", "application/json", 200],
    ["*/*", "application/json", 200],
    ["application/json, text/event-stream", "application/json", 200],
    ["text/event-stream", "text/event-stream", 200],
    ["TEXT/EVENT-STREAM", "text/event-stream", 200],
    ["text/*", "text/event-stream", 200],
    ["text/event-stream;q=0.9, application/json;q=0.5", "text/event-stream", 200],
    ["application/json;q=0, text/event-stream", "text/event-stream", 200],
    ["text/html", "application/json", 406],
    ["application/json;q=0, text/event-stream;q=0", "application/json", 406],
  ] as const)("accept %s -> %s (%d)", async (accept, expectedMedia, expectedStatus) => {
    const res = await postMcp(accept);
    expect(res.status, accept).toBe(expectedStatus);
    expect(res.headers.get("content-type")?.split(";")[0]?.trim(), accept).toBe(expectedMedia);
    const raw = await res.text();
    if (expectedStatus === 200 && expectedMedia === "application/json") {
      expect(JSON.parse(raw).id).toBe(1);
    } else if (expectedStatus === 200) {
      expect(raw).toContain("data:");
      expect(raw).toContain('"id":1');
    }
  });
});
