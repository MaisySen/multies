/**
 * Round 2: an API key may have an end date. Settings, Developers offers one when the key is made (default: never, the
 * old behaviour). From that moment the key answers 401 `api_key_expired`; the list shows the date.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
const DAY = 86_400_000;

async function v1(key: string, path: string) {
  const res = await ctx.app.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${key}`, host: "localhost" } });
  return { status: res.status, body: await res.json().catch(() => null) as { error?: { code: string; message: string } } | null };
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

describe("Round 2: API key expiry", () => {
  it("a key made with expiresInDays works until then and answers 401 api_key_expired after", async () => {
    const now = ctx.deps.now().getTime();
    const made = await c.post("/api/developer/keys", { name: "CI", expiresInDays: 30 });
    expect(made.status).toBe(201);
    const at = Date.parse(made.body.apiKey.expiresAt);
    expect(at).toBeGreaterThanOrEqual(now + 30 * DAY);
    expect(at).toBeLessThan(now + 30 * DAY + 60_000);
    expect((await v1(made.body.secret, "/domains")).status).toBe(200);
    const listed = (await c.get("/api/developer/keys")).body.apiKeys.find((k: { id: string }) => k.id === made.body.apiKey.id);
    expect(listed.expiresAt).toBe(made.body.apiKey.expiresAt);

    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(at + 1000);
    try {
      const r = await v1(made.body.secret, "/domains");
      expect(r.status).toBe(401);
      expect(r.body!.error!.code).toBe("api_key_expired");
      expect(r.body!.error!.message).toMatch(/expired/);
      // MCP refuses it the same way.
      const mcp = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${made.body.secret}`, "content-type": "application/json", accept: "application/json" }, body: "{}" });
      expect(mcp.status).toBe(401);
    } finally { ctx.deps.now = real; }
  });

  it("without an expiry a key never ends (the default), and the list says null", async () => {
    const made = await c.post("/api/developer/keys", { name: "Forever" });
    expect(made.body.apiKey.expiresAt).toBeNull();
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + 3650 * DAY);
    try { expect((await v1(made.body.secret, "/domains")).status).toBe(200); } finally { ctx.deps.now = real; }
  });

  it("refuses an expiry outside 1 to 3650 days", async () => {
    for (const expiresInDays of [0, -1, 3651, 1.5]) {
      expect((await c.post("/api/developer/keys", { name: "Bad", expiresInDays })).status, String(expiresInDays)).toBe(422);
    }
  });
});
