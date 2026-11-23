import { beforeAll, expect, test } from "vitest";
import { Client, makeTestApp } from "./helpers";
import { pkceChallenge } from "@/server/services/developer/oauth";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

const url = "/api/v1/mcp";
let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let jwt: string;
const protocol = "2025-11-25";

beforeAll(async () => {
  const x = await makeTestApp();
  app = x.app;
  const web = new Client(app);
  await web.signup("workspace-owner@example.test");
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const reg = await app.request("/api/oauth/register", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ client_name: "Compatibility fixture", redirect_uris: [redirect] }) });
  expect(reg.status).toBe(201);
  const { client_id } = await reg.json() as { client_id: string };
  const v = "v".repeat(50);
  const allowed = await web.post("/api/oauth/authorize", { decision: "allow", scope: "full", request: { client_id, redirect_uri: redirect, response_type: "code", code_challenge: await pkceChallenge(v), code_challenge_method: "S256", scope: "mcp:read mcp:write" } });
  expect(allowed.status).toBe(200);
  const code = new URL(allowed.body.redirectTo).searchParams.get("code");
  expect(code).toBeTruthy();
  const result = await app.request("/api/oauth/token", { method: "POST", headers: { host: "localhost", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: code!, client_id, redirect_uri: redirect, code_verifier: v }) });
  expect(result.status).toBe(200);
  jwt = (await result.json() as { access_token: string }).access_token;
  expect(Boolean(jwt)).toBe(true);
});

async function call(method: string, params: object, version = protocol, accept = "application/json, text/event-stream") {
  const r = await app.request(url, { method: "POST", headers: { host: "localhost", authorization: `Bearer ${jwt}`, "content-type": "application/json", accept, "mcp-protocol-version": version }, body: JSON.stringify({ jsonrpc: "2.0", id: 42, method, params }) });
  const text = await r.text();
  let data: { id?: number; result?: unknown; error?: { code?: number } } | undefined;
  try { data = JSON.parse(text); } catch {
    const event = text.split(/\r?\n/).find((l) => l.startsWith("data:") && l.includes('"result"'));
    if (event) data = JSON.parse(event.slice(5));
  }
  return { status: r.status, data, contentType: r.headers.get("content-type") };
}

test("ordinary OAuth session discovers tool schemas across supported protocol versions", async () => {
  for (const v of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
    const init = await call("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "compatibility fixture", version: "1.0.0" } }, v);
    const list = await call("tools/list", {}, v);
    const parsed = ListToolsResultSchema.safeParse(list.data?.result);
    expect(init.status).toBe(200);
    expect(init.data?.result && (init.data.result as { protocolVersion?: string }).protocolVersion).toBe(v);
    expect(list.status).toBe(200);
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.tools.length : 0).toBeGreaterThan(0);
  }
});

test("honours the response format advertised by OAuth clients", async () => {
  const forms = [
    ["application/json, text/event-stream", "application/json", 200],
    ["application/json", "application/json", 200],
    ["text/event-stream", "text/event-stream", 200],
    ["application/json;q=0, text/event-stream", "text/event-stream", 200],
    ["*/*", "application/json", 200],
    ["application/json;q=0, text/event-stream;q=0", "application/json", 406],
  ] as const;
  for (const [header, media, status] of forms) {
    const list = await call("tools/list", {}, protocol, header);
    expect(list.status, header).toBe(status);
    expect(list.contentType?.split(";")[0], header).toBe(media);
    if (status === 200) {
      expect(list.data?.id).toBe(42);
      expect(ListToolsResultSchema.safeParse(list.data?.result).success).toBe(true);
    }
  }
});
