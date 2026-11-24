import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, oauthGrants } from "@/server/db/schema";
import { pkceChallenge } from "@/server/services/developer/oauth";

/**
 * A new sign in replaces older grants of the same client id only. Client names are self registered, so a look alike
 * client must never end another app's grant; a failure while replacing must not cost the person the tokens just
 * issued; two exchanges racing for one client must not end each other.
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

describe("OAuth grants: what a new sign in replaces", () => {
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

  it("a new sign in of the same client id ends the older grant, and that is audited", async () => {
    const id = await register();
    const t1 = await exchange(id, await approve(id));
    const t2 = await exchange(id, await approve(id));
    expect(await works(t1.body.access_token)).toBe(false);
    expect(await works(t2.body.access_token)).toBe(true);
    const audits = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "oauth.disconnected")).all();
    expect(audits).toHaveLength(1);
    const meta = audits[0].metadata;
    expect(typeof meta === "string" ? JSON.parse(meta) : meta).toMatchObject({ reason: "replaced" });
  });

  it("two exchanges for one client never end each other: the older one's replace leaves the newer grant", async () => {
    const id = await register();
    const real = ctx.deps.now;
    const t0 = real().getTime();
    ctx.deps.now = () => new Date(t0);
    const older = await approve(id);
    ctx.deps.now = () => new Date(t0 + 1000);
    const newer = await approve(id);
    ctx.deps.now = real;
    // The newer code is exchanged first.
    const tNew = await exchange(id, newer);
    expect(tNew.status).toBe(200);
    // The older code was ended by the newer exchange; it does not get tokens, and the newer grant keeps working.
    expect((await exchange(id, older)).status).toBe(400);
    expect(await works(tNew.body.access_token)).toBe(true);
    const { replaceOlderGrants } = await import("@/server/services/developer/oauth");
    const rows = await ctx.db.select().from(oauthGrants).where(eq(oauthGrants.clientId, id)).all();
    const o = rows.find((r) => r.createdAt.getTime() === t0)!;
    // Running the older grant's replace after the newer one is live ends nothing.
    await ctx.db.update(oauthGrants).set({ revokedAt: null }).where(eq(oauthGrants.id, o.id));
    expect(await replaceOlderGrants(ctx.deps, o)).toEqual([]);
    expect(await works(tNew.body.access_token)).toBe(true);
  });

  it("a failure while replacing older grants still returns the tokens, and they work", async () => {
    const id = await register();
    const t1 = await exchange(id, await approve(id));
    const code = await approve(id);
    const realUpdate = ctx.db.update.bind(ctx.db);
    const warn = vi.fn();
    ctx.deps.log = { ...(ctx.deps.log ?? {}), warn } as never;
    const spy = vi.spyOn(ctx.db, "update").mockImplementation(((table: unknown) => {
      const b = realUpdate(table as never);
      const set = b.set.bind(b);
      (b as { set: unknown }).set = (v: Record<string, unknown>) => { if (table === oauthGrants && "revokedAt" in v) throw new Error("injected replace failure"); return set(v as never); };
      return b;
    }) as typeof ctx.db.update);
    let t2;
    try { t2 = await exchange(id, code); } finally { spy.mockRestore(); }
    expect(t2.status).toBe(200);
    expect(t2.body.access_token).toMatch(/^mm_oat_/);
    expect(await works(t2.body.access_token)).toBe(true);
    expect(warn).toHaveBeenCalledWith("oauth.replace_failed", expect.anything());
    // The older grant was not ended this time; the next sign in of this client ends it.
    expect(await works(t1.body.access_token)).toBe(true);
    const live = await ctx.db.select().from(oauthGrants).where(and(eq(oauthGrants.clientId, id))).all();
    expect(live.filter((g) => !g.revokedAt)).toHaveLength(2);
  });
});
