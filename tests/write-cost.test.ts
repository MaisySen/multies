import { it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { runMaintenance } from "@/server/services/maintenance";

/**
 * Write costs in D1 terms: D1 bills a written row once for the table and once for every index on it,
 * and the account has 100,000 a day shared by production and staging. These ceilings keep the
 * measured costs (24 October 2026) from creeping back up. docs/runbooks/d1-daily-limits.md has the table.
 */
function meter(db: unknown) {
  const c = (db as { $client: { prepare: (q: string) => Record<string, (...a: unknown[]) => unknown> } }).$client;
  const idx = new Map<string, number>();
  for (const r of c.prepare("select tbl_name t, count(*) n from sqlite_master where type='index' group by tbl_name").all() as { t: string; n: number }[]) idx.set(r.t, r.n);
  const prepare = c.prepare.bind(c);
  const changes = () => (prepare("select total_changes() n").get() as { n: number }).n;
  let total = 0;
  c.prepare = (q: string) => {
    const st = prepare(q);
    const table = /^\s*(?:insert(?: or \w+)? into|update|delete from)\s+["`]?(\w+)/i.exec(q)?.[1];
    if (!table) return st;
    for (const fn of ["run", "all", "get"]) {
      const orig = st[fn].bind(st);
      st[fn] = (...a: unknown[]) => { const before = changes(); const r = orig(...a); total += (changes() - before) * (1 + (idx.get(table) ?? 0)); return r; };
    }
    return st;
  };
  return () => { const n = total; total = 0; return n; };
}

it("keeps sign in, an idle cron pass and a demo inside their write ceilings", async () => {
  const ctx = await makeTestApp({ DEMO_MODE: "true" });
  const take = meter(ctx.db);
  const u = new Client(ctx.app);
  const email = await u.signup();
  take();
  // Measured 10: the session row (3 indexes) plus the local rate limit counter, which production keeps in a binding.
  expect((await new Client(ctx.app).login(email)).status).toBe(200);
  expect(take()).toBeLessThanOrEqual(12);
  await u.get("/api/account/me"); await u.get("/api/dashboard"); await u.get("/api/mail/messages?folder=inbox");
  expect(take()).toBe(0);
  await runMaintenance(ctx.deps);
  take();
  await runMaintenance(ctx.deps);
  // Measured 3: one uptime row. Nothing else writes when nothing changed.
  expect(take()).toBeLessThanOrEqual(5);
  await new Client(ctx.app).post("/api/account/demo");
  take();
  const d = new Client(ctx.app);
  await d.post("/api/account/demo");
  await d.post("/api/account/demo/seed");
  await d.get("/api/tasks");
  // Measured 967 for the workspace and both seed parts; the purge a day later deletes about as many.
  expect(take()).toBeLessThanOrEqual(1_100);
});

it("MCP OAuth (round 20): registration, sign in, token exchange and refresh stay small; MCP reads write nothing", async () => {
  const { pkceChallenge } = await import("@/server/services/developer/oauth");
  const ctx = await makeTestApp();
  const u = new Client(ctx.app);
  await u.signup();
  const take = meter(ctx.db);
  const h = { host: "localhost" };
  const reg = await (await ctx.app.request("/api/oauth/register", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] }) })).json() as { client_id: string };
  // Measured 5: 1 client row (no index) plus the local rate limit counter (4), which production keeps in a binding.
  const m1 = take(); expect(m1).toBeLessThanOrEqual(5);
  const verifier = "x".repeat(50);
  const request = { client_id: reg.client_id, redirect_uri: "https://claude.ai/cb", response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256" };
  const code = new URL((await u.post("/api/oauth/authorize", { decision: "allow", request })).body.redirectTo).searchParams.get("code")!;
  // Measured 10: the grant row and its one index (2), the audit row and its indexes, and the local app limiter.
  const m2 = take(); expect(m2).toBeLessThanOrEqual(10);
  const form = (o: Record<string, string>) => ({ method: "POST", headers: { ...h, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
  const t = await (await ctx.app.request("/api/oauth/token", form({ grant_type: "authorization_code", code, client_id: reg.client_id, code_verifier: verifier }))).json() as { access_token: string; refresh_token: string };
  const m3 = take(); expect(m3).toBeLessThanOrEqual(6); // grant update (2) + local limiter
  const call = () => ctx.app.request("/api/v1/mcp", { method: "POST", headers: { ...h, authorization: `Bearer ${t.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  for (let i = 0; i < 5; i++) expect((await call()).status).toBe(200);
  // Measured 15: only the local api limiter (3 a call, a binding in production). The grant's last used was written at the exchange and waits an hour.
  const mcpWrites = take(); console.log('W mcp', mcpWrites);
  expect(mcpWrites).toBeLessThanOrEqual(15);
  await ctx.app.request("/api/oauth/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token }));
  const m4 = take(); expect(m4).toBeLessThanOrEqual(6); // rotated refresh hash (2) + local limiter
});
