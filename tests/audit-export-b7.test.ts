/**
 * B7: the audit log export read the oldest 50,000 rows of the whole log and only then applied the date range in code,
 * so on a long log the newest rows, and any recent range, were missing without a word. The range is applied in SQL
 * now, and past the export's size the newest rows are kept and the answer says it was cut.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { AUDIT_EXPORT_MAX, auditExport } from "@/server/services/privacy";

type Raw = { prepare: (q: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown }; transaction: (fn: () => void) => () => void };

describe("B7: audit log export on a long log", () => {
  it("keeps the newest rows, says it was cut, and a recent range is complete", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const raw = (ctx.db as unknown as { $client: Raw }).$client;
    const orgId = (raw.prepare("select organization_id as id from members limit 1").get() as { id: string }).id;
    const t0 = Date.UTC(2025, 0, 1);
    const ins = raw.prepare("insert into audit_logs (id, org_id, actor_email, action, created_at) values (?, ?, 'owner@acme.io', ?, ?)");
    raw.transaction(() => {
      for (let i = 0; i < AUDIT_EXPORT_MAX + 5; i++) ins.run(`aud_old_${String(i).padStart(6, "0")}`, orgId, "mail.old", t0 + i * 1000);
      ins.run("aud_new_1", orgId, "domain.added", Date.UTC(2030, 0, 1));
      ins.run("aud_new_2", orgId, "domain.removed", Date.UTC(2030, 0, 2));
    })();

    const get = async (path: string) => { const res = await ctx.app.request(path, { headers: { cookie: c.cookie, host: "localhost" } }); return { status: res.status, headers: res.headers, body: await res.json() as unknown }; };
    const all = await get("/api/org/audit/export?format=json");
    expect(all.status).toBe(200);
    expect(all.headers.get("x-audit-truncated")).toBe("newest-kept");
    const rows = all.body as { action: string; at: string }[];
    expect(rows).toHaveLength(AUDIT_EXPORT_MAX);
    expect(rows.slice(-2).map((r) => r.action)).toEqual(["domain.added", "domain.removed"]); // oldest first, newest last
    expect(rows[0].at < rows[rows.length - 1].at).toBe(true);

    const recent = await get(`/api/org/audit/export?format=json&from=${new Date(Date.UTC(2029, 11, 31)).toISOString()}&to=${new Date(Date.UTC(2030, 0, 1)).toISOString()}`);
    expect(recent.headers.get("x-audit-truncated")).toBeNull();
    expect((recent.body as { action: string }[]).map((r) => r.action)).toEqual(["domain.added"]); // both ends included

    const small = await auditExport(ctx.deps, orgId, undefined, undefined, { max: 3 });
    expect(small.truncated).toBe(true);
    expect(small.rows).toHaveLength(3);
    expect(small.rows.slice(-2).map((r) => r.action)).toEqual(["domain.added", "domain.removed"]);
  }, 120_000);
});
