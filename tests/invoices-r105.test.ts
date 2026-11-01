/** R105: invoices and quotes API: settings checks, draft to issued numbering without gaps, ATO checks, quote to invoice,
 * payments and states, adjustment notes, void (never delete), repeats, reports, member limits and the flag. */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { issueDoc, runRepeats, dueReminders } from "@/server/services/invoices/invoices";

async function setup(env: Record<string, string> = { INVOICES_ENABLED: "true" }) {
  const ctx = await makeTestApp(env);
  let clock = Date.parse("2026-11-01T01:00:00Z");
  ctx.deps.now = () => new Date(clock);
  const c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  return { ...ctx, c, setDay: (d: string) => { clock = Date.parse(`${d}T01:00:00Z`); } };
}
const line = (d: string, unitCents: number, q = 1000, gstFree = false) => ({ description: d, quantityMilli: q, unitCents, gstFree });
async function ready(t: Awaited<ReturnType<typeof setup>>) {
  const r = await t.c.put("/api/invoices/settings", { businessName: "Fintex", abn: "51 824 753 556", bsb: "062-000", accountNumber: "12345678", accountName: "Fintex Pty Ltd", termsDays: 14 });
  expect(r.status).toBe(200);
}

describe("R105 invoices API", () => {
  it("is off without the flag", async () => {
    const t = await setup({});
    expect((await t.c.get("/api/invoices/docs")).status).toBe(404);
  });

  it("checks settings: ABN checksum, BSB and account", async () => {
    const t = await setup();
    expect((await t.c.put("/api/invoices/settings", { abn: "51 824 753 557" })).body.error?.code ?? (await t.c.put("/api/invoices/settings", { abn: "51 824 753 557" })).status).toBeTruthy();
    expect((await t.c.put("/api/invoices/settings", { abn: "51 824 753 557" })).status).toBe(422);
    expect((await t.c.put("/api/invoices/settings", { bsb: "12" })).status).toBe(422);
    await ready(t);
    const s = (await t.c.get("/api/invoices/settings")).body.settings;
    expect(s).toMatchObject({ abn: "51824753556", bsb: "062000", ready: true, next: { invoice: 1 } });
  });

  it("issues tax invoices with numbers only on issue, never reused, and refuses until ATO fields are there", async () => {
    const t = await setup();
    const a = (await t.c.post("/api/invoices/docs", { kind: "invoice", buyerName: "Bob", lines: [line("Design work", 100000), line("Stamp duty", 5000, 1000, true)] })).body.doc;
    expect(a.number).toBeNull();
    expect(a).toMatchObject({ subtotalCents: 105000, gstCents: 10000, totalCents: 115000, state: "draft", title: "Tax invoice" });
    expect(a.problems.map((p: { code: string }) => p.code)).toEqual(["supplier_name", "supplier_abn"]);
    expect((await t.c.post(`/api/invoices/docs/${a.id}/issue`)).status).toBe(422);
    await ready(t);
    const draftThrowaway = (await t.c.post("/api/invoices/docs", { kind: "invoice", lines: [line("x", 100)] })).body.doc;
    expect((await t.c.del(`/api/invoices/docs/${draftThrowaway.id}`)).status).toBe(200); // drafts have no number: deleting leaves no gap
    const issued = (await t.c.post(`/api/invoices/docs/${a.id}/issue`)).body.doc;
    expect(issued).toMatchObject({ number: "INV-0001", status: "issued", issueDate: "2026-11-01", dueDate: "2026-11-15", state: "unpaid" });
    expect(issued.viewUrl).toMatch(/\/i\/[A-Za-z0-9_-]{20,}$/);
    expect((await t.c.del(`/api/invoices/docs/${a.id}`)).status).toBe(409);
    expect((await t.c.patch(`/api/invoices/docs/${a.id}`, { notes: "x" })).status).toBe(409);
    const b = (await t.c.post("/api/invoices/docs", { kind: "invoice", buyerName: "Cy", lines: [line("More", 1000)] })).body.doc;
    expect((await t.c.post(`/api/invoices/docs/${b.id}/issue`)).body.doc.number).toBe("INV-0002");
    expect((await t.c.post(`/api/invoices/docs/${b.id}/void`, { reason: "Sent twice" })).body.doc.state).toBe("void");
    const c3 = (await t.c.post("/api/invoices/docs", { kind: "invoice", lines: [line("Next", 1000)] })).body.doc;
    expect((await t.c.post(`/api/invoices/docs/${c3.id}/issue`)).body.doc.number).toBe("INV-0003"); // the voided 0002 is not reused
  });

  it("needs the buyer's name or ABN at A$1,000 or more", async () => {
    const t = await setup(); await ready(t);
    const d = (await t.c.post("/api/invoices/docs", { kind: "invoice", lines: [line("Big job", 90910)] })).body.doc; // 909.10 + GST 90.91 = 1,000.01
    expect(d.totalCents).toBe(100001);
    expect(d.problems.map((p: { code: string }) => p.code)).toEqual(["buyer_identity"]);
    expect((await t.c.post(`/api/invoices/docs/${d.id}/issue`)).status).toBe(422);
    await t.c.patch(`/api/invoices/docs/${d.id}`, { buyerAbn: "53 004 085 616" });
    expect((await t.c.post(`/api/invoices/docs/${d.id}/issue`)).status).toBe(200);
  });

  it("works out inclusive prices and payments: part paid, paid, overdue, overpay refused", async () => {
    const t = await setup(); await ready(t);
    await t.c.put("/api/invoices/settings", { priceMode: "inclusive" });
    const d = (await t.c.post("/api/invoices/docs", { kind: "invoice", buyerName: "Bo", lines: [line("Box", 11000, 2000)] })).body.doc;
    expect(d).toMatchObject({ totalCents: 22000, gstCents: 2000, subtotalCents: 20000, priceMode: "inclusive" });
    await t.c.post(`/api/invoices/docs/${d.id}/issue`);
    expect((await t.c.post(`/api/invoices/docs/${d.id}/payments`, { amountCents: 30000 })).status).toBe(422);
    expect((await t.c.post(`/api/invoices/docs/${d.id}/payments`, { amountCents: 2000, method: "cash" })).body.doc.state).toBe("part_paid");
    t.setDay("2026-11-20");
    expect((await t.c.get(`/api/invoices/docs/${d.id}`)).body.doc.state).toBe("overdue");
    expect((await t.c.get("/api/invoices/docs?kind=invoice&state=overdue")).body.items).toHaveLength(1);
    const paid = (await t.c.post(`/api/invoices/docs/${d.id}/payments`, { amountCents: 20000 })).body.doc;
    expect(paid).toMatchObject({ state: "paid", owingCents: 0 });
    expect((await t.c.post(`/api/invoices/docs/${d.id}/void`, {})).status).toBe(409); // has payments
    const back = (await t.c.del(`/api/invoices/docs/${d.id}/payments/${paid.payments[0].id}`)).body.doc;
    expect(back.paidCents).toBe(20000);
  });

  it("converts a quote to a draft invoice once", async () => {
    const t = await setup(); await ready(t);
    const q = (await t.c.post("/api/invoices/docs", { kind: "quote", buyerName: "Dee", lines: [line("Site build", 250000)] })).body.doc;
    const iq = (await t.c.post(`/api/invoices/docs/${q.id}/issue`)).body.doc;
    expect(iq).toMatchObject({ number: "QU-0001", dueDate: "2026-12-01", title: "Quote" });
    const inv = (await t.c.post(`/api/invoices/docs/${q.id}/convert`)).body.doc;
    expect(inv).toMatchObject({ kind: "invoice", status: "draft", totalCents: 275000, reference: "QU-0001" });
    expect(inv.lines).toHaveLength(1);
    expect((await t.c.post(`/api/invoices/docs/${q.id}/convert`)).body.doc.id).toBe(inv.id);
    expect((await t.c.get(`/api/invoices/docs/${q.id}`)).body.doc).toMatchObject({ status: "accepted", convertedId: inv.id });
  });

  it("makes adjustment notes against issued invoices and reduces what is owing", async () => {
    const t = await setup(); await ready(t);
    const d = (await t.c.post("/api/invoices/docs", { kind: "invoice", buyerName: "Ed", lines: [line("Work", 10000)] })).body.doc;
    expect((await t.c.post("/api/invoices/docs", { kind: "credit_note", sourceId: d.id, lines: [line("Refund", 1000)] })).status).toBe(409);
    await t.c.post(`/api/invoices/docs/${d.id}/issue`);
    const cn = (await t.c.post("/api/invoices/docs", { kind: "credit_note", sourceId: d.id, lines: [line("Part refund", 2000)] })).body.doc;
    expect(cn).toMatchObject({ buyerName: "Ed", title: "Adjustment note" });
    expect((await t.c.post(`/api/invoices/docs/${cn.id}/issue`)).body.doc.number).toBe("CN-0001");
    expect((await t.c.get(`/api/invoices/docs/${d.id}`)).body.doc).toMatchObject({ creditedCents: 2200, owingCents: 8800, state: "part_paid" });
    expect((await t.c.post(`/api/invoices/docs/${d.id}/void`, {})).status).toBe(409);
    await t.c.post(`/api/invoices/docs/${cn.id}/void`, {});
    expect((await t.c.get(`/api/invoices/docs/${d.id}`)).body.doc.creditedCents).toBe(0);
  });

  it("repeats an invoice on its day, once, and stops at the end date", async () => {
    const t = await setup(); await ready(t);
    const d = (await t.c.post("/api/invoices/docs", { kind: "invoice", buyerName: "Fay", lines: [line("Retainer", 50000)] })).body.doc;
    await t.c.post(`/api/invoices/docs/${d.id}/issue`);
    const r = (await t.c.put(`/api/invoices/docs/${d.id}/repeat`, { every: "month", endDate: "2026-12-31" })).body.doc.repeat;
    expect(r).toMatchObject({ nextRun: "2026-12-01", active: true });
    expect((await runRepeats(t.deps)).made).toBe(0);
    t.setDay("2026-12-01");
    const run = await runRepeats(t.deps);
    expect(run.made).toBe(1);
    expect((await runRepeats(t.deps)).made).toBe(0);
    const made = (await t.c.get(`/api/invoices/docs/${run.ids[0]}`)).body.doc;
    expect(made).toMatchObject({ number: "INV-0002", issueDate: "2026-12-01", dueDate: "2026-12-15", totalCents: 55000 });
    t.setDay("2027-01-01");
    expect((await runRepeats(t.deps)).made).toBe(0);
  });

  it("finds reminders before and after the due date", async () => {
    const t = await setup(); await ready(t);
    const d = (await t.c.post("/api/invoices/docs", { kind: "invoice", buyerName: "Gus", buyerEmail: "gus@example.com", lines: [line("Work", 1000)] })).body.doc;
    await t.c.post(`/api/invoices/docs/${d.id}/issue`); // due 2026-11-15
    expect(await dueReminders(t.deps)).toEqual([]);
    t.setDay("2026-11-12");
    expect(await dueReminders(t.deps)).toEqual([{ id: d.id, orgId: d.orgId, when: "before" }]);
    t.setDay("2026-11-22");
    expect((await dueReminders(t.deps))[0]?.when).toBe("after");
  });

  it("reports aged receivables and GST for BAS on both bases", async () => {
    const t = await setup(); await ready(t);
    const d = (await t.c.post("/api/invoices/docs", { kind: "invoice", buyerName: "Hal", lines: [line("Work", 100000)] })).body.doc;
    await t.c.post(`/api/invoices/docs/${d.id}/issue`);
    const bill = (await t.c.post("/api/invoices/docs", { kind: "bill", buyerName: "Supplier", lines: [line("Laptop", 220000)] })).body.doc;
    await t.c.post(`/api/invoices/docs/${bill.id}/issue`);
    await t.c.post(`/api/invoices/docs/${d.id}/payments`, { amountCents: 55000 });
    const acc = (await t.c.get("/api/invoices/reports/gst?from=2026-10-01&to=2026-12-31")).body;
    expect(acc).toMatchObject({ g1SalesCents: 110000, gstOnSalesCents: 10000, gstOnPurchasesCents: 22000, netGstCents: -12000, quarter: { label: "Q2 FY2027" } });
    const cash = (await t.c.get("/api/invoices/reports/gst?from=2026-10-01&to=2026-12-31&basis=cash")).body;
    expect(cash).toMatchObject({ g1SalesCents: 55000, gstOnSalesCents: 5000 });
    t.setDay("2026-12-20");
    const aged = (await t.c.get("/api/invoices/reports/aged")).body;
    expect(aged.totals.d31_60).toBe(55000);
    expect(aged.rows[0]).toMatchObject({ name: "Hal", totalCents: 55000 });
  });

  it("keeps items and suppliers, and lets members draft but not issue", async () => {
    const t = await setup(); await ready(t);
    expect((await t.c.post("/api/invoices/items", { name: "Hour of design", unitCents: 15000 })).status).toBe(201);
    expect((await t.c.get("/api/invoices/items?q=design")).body.items).toHaveLength(1);
    expect((await t.c.post("/api/invoices/suppliers", { name: "Officeworks", abn: "123" })).status).toBe(422);
    expect((await t.c.post("/api/invoices/suppliers", { name: "Officeworks" })).status).toBe(201);
    const d = (await t.c.post("/api/invoices/docs", { kind: "invoice", lines: [line("x", 100)] })).body.doc;
    const member = { orgId: d.orgId, userId: "u_member", email: "m@acme.io", name: "Mem", role: "member" as const };
    await expect(issueDoc(t.deps, member, d.id)).rejects.toMatchObject({ status: 403 });
  });
});
