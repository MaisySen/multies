import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, oauthGrants } from "@/server/db/schema";
import { pkceChallenge } from "@/server/services/developer/oauth";

/**
 * Round 2: sign ins of one app on several devices live side by side (up to MAX_GRANTS_PER_CLIENT per person, workspace
 * and client id); Settings groups them in one row and Disconnect ends them all. Client names are self registered, so
 * a look alike client never counts against, or ends, another app's grants.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
const verifier = "v".repeat(20) + "-verifier-for-pkce-tests-0123456789";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost" }, body: new URLSearchParams(o).toString() });

async function register(name = "Claude", redirect = REDIRECT) {
  const res = await ctx.app.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }) });
  return (await res.json() as { client_id: string }).client_id;
}
async function approve(clientId: string, redirect = REDIRECT, scope: "full" | "read" = "full") {
  const request = { client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "s" };
  const r = await c.post("/api/oauth/authorize", { decision: "allow", scope, request });
  expect(r.status).toBe(200);
  return new URL(r.body.redirectTo).searchParams.get("code")!;
}
async function exchange(clientId: string, code: string, redirect = REDIRECT) {
  const res = await ctx.app.request("/api/oauth/token", form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier }));
  return { status: res.status, body: await res.json() as Record<string, string> };
}
async function works(token: string) {
  const res = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  return res.status === 200;
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

describe("OAuth grants: several devices, one row", () => {
  it("a look alike client (same name and redirect host, another client id) cannot end the real app's grant", async () => {
    const real = await register("Claude");
    const t1 = await exchange(real, await approve(real));
    const fake = await register("Claude");
    const t2 = await exchange(fake, await approve(fake));
    expect(t2.status).toBe(200);
    expect(await works(t1.body.access_token)).toBe(true);
    expect(await works(t2.body.access_token)).toBe(true);
    // Settings still shows one row for the two (display only), and Disconnect on it ends both, each audited.
    const list = (await c.get("/api/oauth/grants")).body.grants as { id: string }[];
    expect(list).toHaveLength(1);
    expect((await c.del(`/api/oauth/grants/${list[0].id}`)).status).toBe(200);
    expect(await works(t1.body.access_token)).toBe(false);
    expect(await works(t2.body.access_token)).toBe(false);
    expect(await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "oauth.disconnected")).all()).toHaveLength(2);
  });

  it("a grouped Settings row shows the widest scope, the latest use and how many sign ins it holds (R5)", async () => {
    const real = ctx.deps.now;
    const t0 = real().getTime();
    const wide = await register("Claude");
    ctx.deps.now = () => new Date(t0);
    const tWide = await exchange(wide, await approve(wide, REDIRECT, "full"));
    const narrow = await register("Claude");
    ctx.deps.now = () => new Date(t0 + 60_000);
    const tNarrow = await exchange(narrow, await approve(narrow, REDIRECT, "read"));
    expect(tNarrow.status).toBe(200);
    expect(await works(tNarrow.body.access_token)).toBe(true);
    ctx.deps.now = real;
    // The older, wider grant was used last.
    expect(await works(tWide.body.access_token)).toBe(true);
    await ctx.db.update(oauthGrants).set({ lastUsedAt: new Date(t0 + 30 * 60_000) }).where(eq(oauthGrants.clientId, wide));
    const list = (await c.get("/api/oauth/grants")).body.grants as { scope: string; lastUsedAt: string | null; grants: number }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ scope: "full", lastUsedAt: new Date(t0 + 30 * 60_000).toISOString(), grants: 2 });
  });

  // Round 2 (owner decision): a second device signing in the same client keeps the first signed in. Before, the newer
  // sign in revoked every older grant of the client id, so a laptop and a phone with the same app logged each other out.
  it("two devices signing in the same client both stay signed in; Settings shows one row with both", async () => {
    const id = await register();
    const t1 = await exchange(id, await approve(id));
    const t2 = await exchange(id, await approve(id));
    expect(await works(t1.body.access_token)).toBe(true);
    expect(await works(t2.body.access_token)).toBe(true);
    expect(await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "oauth.disconnected")).all()).toEqual([]);
    const list = (await c.get("/api/oauth/grants")).body.grants as { id: string; grants: number }[];
    expect(list).toHaveLength(1);
    expect(list[0].grants).toBe(2);
    // Refreshing on one device leaves the other alone.
    const r1 = await ctx.app.request("/api/oauth/token", form({ grant_type: "refresh_token", refresh_token: t1.body.refresh_token, client_id: id }));
    expect(r1.status).toBe(200);
    expect(await works(t2.body.access_token)).toBe(true);
  });

  it(`at most ${10} live sign ins per person, workspace and client: the oldest ends, audited with reason "limit"`, async () => {
    const { MAX_GRANTS_PER_CLIENT } = await import("@/server/services/developer/oauth");
    expect(MAX_GRANTS_PER_CLIENT).toBe(10);
    const id = await register();
    const real = ctx.deps.now;
    const t0 = real().getTime();
    const tokens: string[] = [];
    try {
      for (let i = 0; i < 11; i++) {
        ctx.deps.now = () => new Date(t0 + i * 1000);
        const t = await exchange(id, await approve(id));
        expect(t.status).toBe(200);
        tokens.push(t.body.access_token);
      }
    } finally { ctx.deps.now = real; }
    expect(await works(tokens[0])).toBe(false);
    for (const t of tokens.slice(1)) expect(await works(t)).toBe(true);
    const audits = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "oauth.disconnected")).all();
    expect(audits).toHaveLength(1);
    const meta = audits[0].metadata;
    expect(typeof meta === "string" ? JSON.parse(meta) : meta).toMatchObject({ reason: "limit" });
    // Another client of the same person is not counted against this one.
    const other = await register("Cursor", "https://cursor.example/cb");
    expect(await works((await exchange(other, await approve(other, "https://cursor.example/cb"), "https://cursor.example/cb")).body.access_token)).toBe(true);
    expect(await works(tokens[1])).toBe(true);
  });

  it("Disconnect on the row ends every device's sign in", async () => {
    const id = await register();
    const t1 = await exchange(id, await approve(id));
    const t2 = await exchange(id, await approve(id));
    const t3 = await exchange(id, await approve(id));
    const list = (await c.get("/api/oauth/grants")).body.grants as { id: string; grants: number }[];
    expect(list).toEqual([expect.objectContaining({ grants: 3 })]);
    expect((await c.del(`/api/oauth/grants/${list[0].id}`)).status).toBe(200);
    for (const t of [t1, t2, t3]) expect(await works(t.body.access_token)).toBe(false);
    expect((await c.get("/api/oauth/grants")).body.grants).toEqual([]);
  });

  it("codes nobody exchanged, revoked and expired grants don't crowd a live one out of the list", async () => {
    const id = await register();
    const live = await exchange(id, await approve(id));
    expect(live.status).toBe(200);
    const g = (await ctx.db.select().from(oauthGrants).where(eq(oauthGrants.clientId, id)).get())!;
    const later = new Date(g.createdAt.getTime() + 60_000);
    const old = new Date(ctx.deps.now().getTime() - 86_400_000);
    // 250 newer rows that aren't connections: abandoned codes, revoked and expired grants.
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `mcpg_noise${String(i).padStart(4, "0")}`, clientId: id, orgId: g.orgId, userId: g.userId, scope: "full" as const, redirectUri: REDIRECT, createdAt: later,
      ...(i % 3 === 0 ? { codeHash: "x" } : i % 3 === 1 ? { codeUsedAt: later, revokedAt: later } : { codeUsedAt: later, refreshHash: "y", refreshExpiresAt: old }),
    }));
    for (let i = 0; i < rows.length; i += 5) await ctx.db.insert(oauthGrants).values(rows.slice(i, i + 5));
    const list = (await c.get("/api/oauth/grants")).body.grants as { id: string; grants: number }[];
    expect(list).toEqual([expect.objectContaining({ id: g.id, grants: 1 })]);
  });
});
