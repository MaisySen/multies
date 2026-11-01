/** R125: a 5,000 row table stays quick: first page, a deep page by cursor, a search through LK1, a sort and a filter.
 * Prints the times so the round report can quote them; the bounds are loose so a slow box does not flake. */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

describe("R125 tables at 5,000 rows", () => {
  it("imports 5,000 rows and pages, searches, sorts and filters quickly", async () => {
    const ctx = await makeTestApp({ TABLES_R125: "on", WORKSPACE_DAILY_WRITES: "0" });
    const c = new Client(ctx.app);
    await c.signup("perf-r125@acme.io", "Perf", "Acme");
    const statuses = ["Lead", "Won", "Lost"];
    const rows = Array.from({ length: 5000 }, (_, i) => [`Client ${i + 1}`, `${(i * 7) % 1000}.50`, statuses[i % 3], `note ${i % 97} harbour`]);
    let t0 = Date.now();
    const imp = await c.post("/api/tables/import", { title: "Big", columns: [{ name: "Name", type: "text" }, { name: "Spend", type: "currency" }, { name: "Status", type: "select" }, { name: "Notes", type: "text" }], rows });
    const importMs = Date.now() - t0;
    expect(imp.status).toBe(201);
    expect(imp.body.imported).toBe(5000);
    const id = imp.body.docId as string;
    const d = (await c.get(`/api/tables/${id}`)).body as { fields: { id: string; name: string; config: { options?: { id: string; label: string }[] } }[] };
    const spend = d.fields.find((f) => f.name === "Spend")!;
    const status = d.fields.find((f) => f.name === "Status")!;
    const won = status.config.options!.find((o) => o.label === "Won")!;
    const time = async (url: string) => { const s = Date.now(); const r = await c.get(url); expect(r.status).toBe(200); return { ms: Date.now() - s, body: r.body as { rows: unknown[]; nextCursor: string | null; total: number } }; };
    const first = await time(`/api/tables/${id}/rows?limit=100`);
    expect(first.body.rows).toHaveLength(100);
    expect(first.body.total).toBe(5000);
    let cursor = first.body.nextCursor;
    let pages = 1;
    let deepMs = 0;
    while (cursor && pages < 30) { const p = await time(`/api/tables/${id}/rows?limit=100&cursor=${encodeURIComponent(cursor)}`); deepMs = p.ms; cursor = p.body.nextCursor; pages++; }
    const search = await time(`/api/tables/${id}/rows?limit=100&q=${encodeURIComponent("Client 4999")}`);
    expect(search.body.total).toBe(1);
    const sorted = await time(`/api/tables/${id}/rows?limit=100&sort=${encodeURIComponent(JSON.stringify([{ fieldId: spend.id, dir: "desc" }]))}`);
    expect(sorted.body.rows).toHaveLength(100);
    const filtered = await time(`/api/tables/${id}/rows?limit=100&filters=${encodeURIComponent(JSON.stringify([{ fieldId: status.id, op: "is", value: won.id }]))}`);
    expect(filtered.body.total).toBe(1667);
    t0 = Date.now();
    const csv = await c.call("GET", `/api/tables/${id}/export.csv`);
    const exportMs = Date.now() - t0;
    expect(String(csv.body).split("\r\n").length).toBeGreaterThan(5000);
    const out = { importMs, firstMs: first.ms, page30Ms: deepMs, searchMs: search.ms, sortMs: sorted.ms, filterMs: filtered.ms, exportMs };
    console.log("R125_PERF " + JSON.stringify(out));
    for (const k of ["firstMs", "page30Ms", "searchMs", "sortMs", "filterMs"] as const) expect(out[k]).toBeLessThan(3000);
  }, 120_000);
});
