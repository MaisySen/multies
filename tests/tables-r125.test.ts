/** R125: the tables API: flag, templates, fields, rows, paging, filters and sort through LK1, formulas, linked records
 * that never leak, CSV import and export, views and forms, comments and history, roles (view only, read only key, guest). */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

async function setup(env: Record<string, string> = { TABLES_R125: "on" }) {
  const ctx = await makeTestApp(env);
  const c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  return { ...ctx, c };
}
async function mate(t: Awaited<ReturnType<typeof setup>>, email = "mate-r125@example.com") {
  const invite = await t.c.post("/api/team/invites", { email, role: "member" });
  const m = new Client(t.app);
  await m.signup(email, "Mate", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return m;
}
async function blank(c: Client, title = "Plants") {
  const r = await c.post("/api/tables", { title });
  expect(r.status).toBe(201);
  const d = (await c.get(`/api/tables/${r.body.table.id}`)).body;
  return { id: r.body.table.id as string, fields: d.fields as { id: string; name: string; type: string; config: { options?: { id: string; label: string }[] } }[], views: d.views as { id: string; type: string }[] };
}

describe("R125 tables API", () => {
  it("is off without the flag", async () => {
    const t = await setup({});
    expect((await t.c.post("/api/tables", { title: "x" })).status).toBe(404);
    expect((await t.c.get("/api/config")).body.tablesR125).toBeFalsy();
  });

  it("makes a table from each template, shows in Docs as a table, and keeps doc edits off its content", async () => {
    const t = await setup();
    for (const tpl of ["clients", "stock", "jobs"]) {
      const r = await t.c.post("/api/tables", { template: tpl });
      expect(r.status).toBe(201);
      const d = (await t.c.get(`/api/tables/${r.body.table.id}`)).body;
      expect(d.fields.length).toBeGreaterThan(5);
      expect(d.views.map((v: { type: string }) => v.type)).toContain("grid");
      const rows = (await t.c.get(`/api/tables/${r.body.table.id}/rows`)).body;
      expect(rows.total).toBe(3);
      expect(rows.rows).toHaveLength(3);
    }
    const stock = (await t.c.get("/api/tables")).body.tables.find((x: { title: string }) => x.title === "Stock list");
    const d = (await t.c.get(`/api/tables/${stock.id}`)).body;
    const value = d.fields.find((f: { name: string }) => f.name === "Stock value");
    const reorder = d.fields.find((f: { name: string }) => f.name === "Reorder");
    const rows = (await t.c.get(`/api/tables/${stock.id}/rows`)).body.rows;
    expect(rows[0].values[value.id]).toBeCloseTo(256);
    expect(rows[1].values[reorder.id]).toBe("Yes");
    const docs = (await t.c.get("/api/docs")).body.docs;
    expect(docs.find((x: { id: string }) => x.id === stock.id).kind).toBe("table");
    expect((await t.c.patch(`/api/docs/${stock.id}`, { text: "overwrite" })).status).toBe(409);
    expect((await t.c.patch(`/api/docs/${stock.id}`, { title: "Stock" })).status).toBe(200);
  });

  it("adds fields with checks, edits cells, converts a column and records history", async () => {
    const t = await setup();
    const tb = await blank(t.c);
    const name = tb.fields[0].id;
    const price = (await t.c.post(`/api/tables/${tb.id}/fields`, { name: "Price", type: "currency" })).body.field;
    expect((await t.c.post(`/api/tables/${tb.id}/fields`, { name: "price", type: "text" })).status).toBe(422);
    expect((await t.c.post(`/api/tables/${tb.id}/fields`, { name: "Bad", type: "nope" })).status).toBe(422);
    const qty = (await t.c.post(`/api/tables/${tb.id}/fields`, { name: "Qty", type: "text" })).body.field;
    const total = await t.c.post(`/api/tables/${tb.id}/fields`, { name: "Total", type: "formula", config: { formula: "{Qty} * {Price}" } });
    expect(total.status).toBe(201);
    expect((await t.c.post(`/api/tables/${tb.id}/fields`, { name: "Loop", type: "formula", config: { formula: "{Loop} + 1" } })).status).toBe(422);
    const made = await t.c.post(`/api/tables/${tb.id}/rows`, { rows: [{ [name]: "Fern", [price.id]: "12.50", [qty.id]: "3" }] });
    expect(made.status).toBe(201);
    const row = made.body.rows[0];
    expect(row.values[total.body.field.id]).toBe(37.5);
    expect((await t.c.post(`/api/tables/${tb.id}/rows`, { rows: [{ [price.id]: "lots" }] })).status).toBe(422);
    expect((await t.c.post(`/api/tables/${tb.id}/rows`, { rows: [{ [total.body.field.id]: 1 }] })).status).toBe(422);
    const upd = await t.c.patch(`/api/tables/${tb.id}/rows`, { rows: [{ id: row.id, cells: { [price.id]: "20" }, version: row.version }] });
    expect(upd.status).toBe(200);
    expect(upd.body.rows[0].values[total.body.field.id]).toBe(60);
    expect((await t.c.patch(`/api/tables/${tb.id}/rows`, { rows: [{ id: row.id, cells: { [price.id]: "1" }, version: row.version }] })).status).toBe(409);
    // text Qty -> number keeps the values; a rename carries into the formula
    const conv = await t.c.patch(`/api/tables/${tb.id}/fields/${qty.id}`, { type: "number", name: "Count" });
    expect(conv.status).toBe(200);
    expect(conv.body.converted).toBe(1);
    const after = (await t.c.get(`/api/tables/${tb.id}/rows/${row.id}`)).body.row;
    expect(after.values[qty.id]).toBe(3);
    expect(after.values[total.body.field.id]).toBe(60);
    expect((await t.c.call("DELETE", `/api/tables/${tb.id}/fields/${name}`)).status).toBe(422);
    const hist = (await t.c.get(`/api/tables/${tb.id}/rows/${row.id}/history`)).body.history;
    expect(hist[0].changes[0]).toMatchObject({ field: "Price", from: "$12.50", to: "$20.00" });
    expect(hist.at(-1).verb).toBe("created");
    // delete and undo (restore)
    expect((await t.c.post(`/api/tables/${tb.id}/rows/delete`, { ids: [row.id] })).body.count).toBe(1);
    expect((await t.c.get(`/api/tables/${tb.id}/rows`)).body.total).toBe(0);
    expect((await t.c.post(`/api/tables/${tb.id}/rows/restore`, { ids: [row.id] })).body.count).toBe(1);
    expect((await t.c.get(`/api/tables/${tb.id}/rows`)).body.total).toBe(1);
  });

  it("pages rows, searches through LK1, filters and sorts by field", async () => {
    const t = await setup();
    const tb = await blank(t.c, "Big");
    const name = tb.fields[0].id;
    const status = tb.fields.find((f) => f.name === "Status")!;
    const n = (await t.c.post(`/api/tables/${tb.id}/fields`, { name: "N", type: "number" })).body.field;
    const rows = Array.from({ length: 250 }, (_, i) => ({ [name]: i % 50 === 0 ? `Special 100% ${i}` : `Plant ${i}`, [n.id]: i, [status.id]: ["To do", "Doing", "Done"][i % 3] }));
    expect((await t.c.post(`/api/tables/${tb.id}/rows`, { rows })).status).toBe(201);
    const p1 = (await t.c.get(`/api/tables/${tb.id}/rows`)).body;
    expect(p1.rows).toHaveLength(100);
    expect(p1.total).toBe(250);
    const p3 = (await t.c.get(`/api/tables/${tb.id}/rows?cursor=${encodeURIComponent((await t.c.get(`/api/tables/${tb.id}/rows?cursor=${encodeURIComponent(p1.nextCursor)}`)).body.nextCursor)}`)).body;
    expect(p3.rows).toHaveLength(50);
    expect(p3.nextCursor).toBeNull();
    // LK1: % is literal, not a wildcard
    const q = (await t.c.get(`/api/tables/${tb.id}/rows?q=${encodeURIComponent("100%")}`)).body;
    expect(q.total).toBe(5);
    const flt = encodeURIComponent(JSON.stringify([{ fieldId: n.id, op: "gt", value: "200" }, { fieldId: status.id, op: "is", value: status.config.options![0].id }]));
    const f = (await t.c.get(`/api/tables/${tb.id}/rows?filters=${flt}`)).body;
    expect(f.rows.every((r: { values: Record<string, number> }) => r.values[n.id] > 200 && r.values[n.id] % 3 === 0)).toBe(true);
    expect(f.total).toBe(17);
    const sort = encodeURIComponent(JSON.stringify([{ fieldId: n.id, dir: "desc" }]));
    const s = (await t.c.get(`/api/tables/${tb.id}/rows?sort=${sort}&limit=10`)).body;
    expect(s.rows[0].values[n.id]).toBe(249);
    const s2 = (await t.c.get(`/api/tables/${tb.id}/rows?sort=${sort}&limit=10&cursor=${s.nextCursor}`)).body;
    expect(s2.rows[0].values[n.id]).toBe(239);
    expect((await t.c.get(`/api/tables/${tb.id}/rows?filters=nope`)).status).toBe(422);
  });

  it("links records with lookups and never shows rows from a table the viewer cannot open", async () => {
    const t = await setup();
    const clients = (await t.c.post("/api/tables", { template: "clients" })).body.table.id;
    const cd = (await t.c.get(`/api/tables/${clients}`)).body;
    const crow = (await t.c.get(`/api/tables/${clients}/rows`)).body.rows[0];
    const jobs = await blank(t.c, "Jobs here");
    const link = (await t.c.post(`/api/tables/${jobs.id}/fields`, { name: "Client", type: "link", config: { tableId: clients } })).body.field;
    const email = cd.fields.find((f: { name: string }) => f.name === "Email");
    const look = await t.c.post(`/api/tables/${jobs.id}/fields`, { name: "Client email", type: "lookup", config: { linkFieldId: link.id, targetFieldId: email.id } });
    expect(look.status).toBe(201);
    const r = (await t.c.post(`/api/tables/${jobs.id}/rows`, { rows: [{ [jobs.fields[0].id]: "Tap", [link.id]: [crow.id] }] })).body.rows[0];
    expect(r.labels[link.id]).toEqual([{ id: crow.id, label: "Priya Shah" }]);
    expect(r.values[look.body.field.id]).toEqual(["priya@example.com"]);
    // a row id from another table or workspace is refused
    expect((await t.c.post(`/api/tables/${jobs.id}/rows`, { rows: [{ [link.id]: [jobs.id] }] })).status).toBe(422);
    const other = await setup();
    const theirs = (await other.c.post("/api/tables", { template: "clients" })).body.table.id;
    const theirRow = (await other.c.get(`/api/tables/${theirs}/rows`)).body.rows[0].id;
    expect((await t.c.post(`/api/tables/${jobs.id}/fields`, { name: "Theirs", type: "link", config: { tableId: theirs } })).status).toBe(404);
    expect((await t.c.post(`/api/tables/${jobs.id}/rows`, { rows: [{ [link.id]: [theirRow] }] })).status).toBe(422);
    expect((await t.c.get(`/api/tables/${theirs}`)).status).toBe(404);
    // the linked table deleted: its rows are hidden, not shown
    expect((await t.c.call("DELETE", `/api/docs/${clients}`)).status).toBe(200);
    const again = (await t.c.get(`/api/tables/${jobs.id}/rows/${r.id}`)).body.row;
    expect(again.labels[link.id]).toEqual([]);
    expect(again.hidden[link.id]).toBe(1);
    expect(again.values[look.body.field.id]).toEqual([]);
  });

  it("imports CSV with bad rows reported and exports the view", async () => {
    const t = await setup();
    const rows = [["Ram", "12.50", "2/11/2026", "yes"], ["", "", "", ""], ["Sita 🎉", "lots", "31/02/2026", "maybe"], ["Hari, Jr", "3", "", "no", "extra"]];
    const imp = await t.c.post("/api/tables/import", { title: "Orders", columns: [{ name: "Name", type: "text" }, { name: "Price", type: "currency" }, { name: "Due", type: "date" }, { name: "Paid", type: "checkbox" }], rows });
    expect(imp.status).toBe(201);
    expect(imp.body).toMatchObject({ imported: 3, skipped: 1 });
    expect(imp.body.problemCount).toBe(4);
    expect(imp.body.problems[0]).toMatchObject({ row: 4, field: "Price" });
    const csv = await t.c.call("GET", `/api/tables/${imp.body.docId}/export.csv`);
    expect(csv.status).toBe(200);
    const text = typeof csv.body === "string" ? csv.body : csv.text;
    expect(text).toContain("Name,Price,Due,Paid");
    expect(text).toContain("Ram,$12.50,2026-11-02,Yes");
    expect(text).toContain('"Hari, Jr",$3.00,,No');
    expect((await t.c.post("/api/tables/import", { columns: [{ name: "a", type: "text" }], rows: Array.from({ length: 5001 }, () => ["x"]) })).status).toBe(422);
    // into an existing table: columns map onto fields, new select options are added
    const tb = await blank(t.c, "Into");
    const st = tb.fields.find((f) => f.name === "Status")!;
    const into = await t.c.post(`/api/tables/${tb.id}/import`, { columns: [{ name: "Name", type: "text", fieldId: tb.fields[0].id }, { name: "Status", type: "select", fieldId: st.id }], rows: [["A", "Blocked"], ["B", "Done"]] });
    expect(into.body.imported).toBe(2);
    const fresh = (await t.c.get(`/api/tables/${tb.id}`)).body.fields.find((f: { id: string }) => f.id === st.id);
    expect(fresh.config.options.map((o: { label: string }) => o.label)).toContain("Blocked");
  });

  it("keeps views and forms: kanban needs a select, a form adds only its fields", async () => {
    const t = await setup();
    const tb = await blank(t.c);
    const k = (await t.c.post(`/api/tables/${tb.id}/views`, { name: "Board", type: "kanban" })).body.view;
    expect(k.config.by).toBe(tb.fields.find((f) => f.type === "select")!.id);
    const form = (await t.c.post(`/api/tables/${tb.id}/views`, { name: "Ask", type: "form", config: { formFields: [tb.fields[0].id], formTitle: "Tell us" } })).body.view;
    const m = await mate(t);
    expect((await t.c.patch(`/api/tables/${tb.id}/settings`, { editAccess: "admins" })).status).toBe(200);
    expect((await m.post(`/api/tables/${tb.id}/rows`, { rows: [{ [tb.fields[0].id]: "x" }] })).status).toBe(403);
    expect((await m.post(`/api/tables/${tb.id}/views/${form.id}/submit`, { cells: { [tb.fields[0].id]: "From form" } })).status).toBe(201);
    expect((await m.post(`/api/tables/${tb.id}/views/${form.id}/submit`, { cells: { [tb.fields[1].id]: "Not on the form" } })).status).toBe(422);
    expect((await m.post(`/api/tables/${tb.id}/views/${form.id}/submit`, { cells: {} })).status).toBe(422);
    expect((await t.c.call("DELETE", `/api/tables/${tb.id}/views/${k.id}`)).status).toBe(200);
    expect((await t.c.call("DELETE", `/api/tables/${tb.id}/views/${form.id}`)).status).toBe(200);
    expect((await t.c.call("DELETE", `/api/tables/${tb.id}/views/${tb.views[0].id}`)).status).toBe(422);
  });

  it("follows roles: view only members, the creator, read only keys, comments", async () => {
    const t = await setup();
    const tb = await blank(t.c);
    const m = await mate(t);
    const row = (await m.post(`/api/tables/${tb.id}/rows`, { rows: [{ [tb.fields[0].id]: "Mine" }] })).body.rows[0];
    expect((await m.patch(`/api/tables/${tb.id}/settings`, { editAccess: "admins" })).status).toBe(403);
    expect((await t.c.patch(`/api/tables/${tb.id}/settings`, { editAccess: "admins" })).status).toBe(200);
    const d = (await m.get(`/api/tables/${tb.id}`)).body;
    expect(d.table.canEdit).toBe(false);
    expect((await m.get(`/api/tables/${tb.id}/rows`)).body.total).toBe(1);
    expect((await m.patch(`/api/tables/${tb.id}/rows`, { rows: [{ id: row.id, cells: { [tb.fields[0].id]: "x" } }] })).status).toBe(403);
    expect((await m.post(`/api/tables/${tb.id}/fields`, { name: "Z", type: "text" })).status).toBe(403);
    expect((await m.post(`/api/tables/${tb.id}/views`, { name: "Z", type: "grid" })).status).toBe(403);
    expect((await m.post(`/api/tables/${tb.id}/rows/delete`, { ids: [row.id] })).status).toBe(403);
    // comments stay open to everyone who can open the table
    const cm = await m.post(`/api/tables/${tb.id}/rows/${row.id}/comments`, { body: "Looks good" });
    expect(cm.status).toBe(201);
    expect((await t.c.get(`/api/tables/${tb.id}/rows/${row.id}/comments`)).body.comments[0].body).toBe("Looks good");
    expect((await m.post(`/api/tables/${tb.id}/rows/${row.id}/comments`, { body: "   " })).status).toBe(422);
    // a member's own table stays theirs to edit when set to admins
    const mine = await blank(m, "Mate's");
    expect((await m.patch(`/api/tables/${mine.id}/settings`, { editAccess: "admins" })).status).toBe(200);
    expect((await m.post(`/api/tables/${mine.id}/rows`, { rows: [{ [mine.fields[0].id]: "ok" }] })).status).toBe(201);
    // the comment's author or an admin deletes it
    expect((await t.c.call("DELETE", `/api/tables/${tb.id}/comments/${cm.body.comment.id}`)).status).toBe(200);
  });
});
