/** R106: expenses and receipts: field rules (dd/mm dates, totals, GST one eleventh, ABN checksum, the A$82.50 tax invoice
 * flag), splits, approval states, re bill onto an R105 invoice draft, CSV export, subscriptions, receipts by mail,
 * members vs approvers vs admins, and the flags. */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import {
  canClaimGst, csvCell, expensesCsv, gstOfTotal, guessEvery, needsTaxInvoice, nextExpected, perYear, splitGst, splitProblems, GST_INVOICE_THRESHOLD_CENTS,
} from "@/shared/expenses";
import { fieldsFromRow, rebillLine, receiveReceiptMail, receiptTypeOk } from "@/server/services/expenses/expenses";
import { extractInvoice } from "@/server/services/tools/ai-docs";

const ON = { INVOICES_ENABLED: "true", EXPENSES_R106: "on", EXPENSES_FAKE_READ: "1", FREE_MAIL_DOMAIN: "free.example.net" };
const RECEIPT = "Officeworks Pty Ltd\nTAX INVOICE\nABN 51 824 753 556\nDate 03/10/2026\nPrinter paper 2 boxes\nTotal $132.00\nGST included $12.00\n";

async function setup(env: Record<string, string> = ON) {
  const ctx = await makeTestApp(env);
  ctx.deps.now = () => new Date("2026-11-01T01:00:00Z");
  const c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  const upload = async (who: Client, text: string, name = "receipt.pdf", type = "application/pdf", source = "upload") => {
    const res = await ctx.app.request(`/api/expenses/upload?source=${source}&name=${encodeURIComponent(name)}`, {
      method: "PUT", headers: { cookie: who.cookie, host: "localhost", "content-type": type, "x-multies-upload": "1" }, body: new TextEncoder().encode(text),
    });
    return { status: res.status, body: await res.json() as { expense: { id: string } & Record<string, unknown>; error?: { code: string } } };
  };
  const join = async (email: string, name: string, role: "member" | "admin" = "member") => {
    const inv = await c.post("/api/team/invites", { email, role });
    const m = new Client(ctx.app);
    await m.signup(email, name, `${name} Co`);
    expect((await m.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    return m;
  };
  return { ...ctx, c, upload, join };
}

describe("R106 rules", () => {
  it("works out GST as one eleventh and flags receipts over $82.50 with no ABN", () => {
    expect(gstOfTotal(11000)).toBe(1000);
    expect(gstOfTotal(1)).toBe(0);
    expect(gstOfTotal(6)).toBe(1); // 0.545 rounds up
    expect(GST_INVOICE_THRESHOLD_CENTS).toBe(8250);
    expect(needsTaxInvoice(8250, null)).toBe(false);
    expect(needsTaxInvoice(8251, null)).toBe(true);
    expect(needsTaxInvoice(8251, "51 824 753 557")).toBe(true); // bad checksum
    expect(needsTaxInvoice(20000, "51 824 753 556")).toBe(false);
    expect(canClaimGst(20000, 1818, null)).toBe(false);
    expect(canClaimGst(5000, 455, null)).toBe(true);
    expect(canClaimGst(5000, 0, "51824753556")).toBe(false);
  });

  it("reads supplier, ABN, day first dates, total and GST from receipt text", () => {
    const f = fieldsFromRow(extractInvoice({ pages: [{ page: 1, text: RECEIPT }] }, "r.pdf"));
    expect(f).toMatchObject({ supplier: "Officeworks Pty Ltd", supplierAbn: "51824753556", spentOn: "2026-10-03", totalCents: 13200, gstCents: 1200, category: "Office supplies" });
    const noGst = fieldsFromRow(extractInvoice({ pages: [{ page: 1, text: "Corner Cafe\nABN 51 824 753 556\n5 March 2026\nTotal 22.00\n" }] }, "r.jpg"));
    expect(noGst).toMatchObject({ spentOn: "2026-03-05", totalCents: 2200, gstCents: 200, category: "Meals" });
    const noAbn = fieldsFromRow(extractInvoice({ pages: [{ page: 1, text: "Market stall\n12/01/2026\nTotal $9.50\n" }] }, "r.jpg"));
    expect(noAbn.gstCents).toBeUndefined();
    expect(noAbn.supplierAbn).toBeUndefined();
    expect(noAbn.spentOn).toBe("2026-01-12");
  });

  it("checks splits and shares GST so the parts add up", () => {
    expect(splitProblems(1000, [])).toEqual([]);
    expect(splitProblems(1000, [{ category: "Meals", amountCents: 600 }, { category: "Travel", amountCents: 300 }])).toEqual(["sum_mismatch"]);
    expect(splitProblems(1000, [{ category: "", amountCents: 1000 }])).toEqual(["empty_category"]);
    expect(splitProblems(1000, [{ category: "Meals", amountCents: 0 }, { category: "Travel", amountCents: 1000 }])).toEqual(["bad_amount"]);
    expect(splitProblems(11, Array.from({ length: 11 }, () => ({ category: "x", amountCents: 1 })))).toContain("too_many");
    const s = splitGst(100, 1100, [{ category: "a", amountCents: 333 }, { category: "b", amountCents: 333 }, { category: "c", amountCents: 434 }]);
    expect(s.reduce((n, p) => n + (p.gstCents ?? 0), 0)).toBe(100);
  });

  it("guesses repeating costs and the next date, and keeps month ends", () => {
    expect(guessEvery(["2026-01-15", "2026-02-15", "2026-03-14"])).toBe("month");
    expect(guessEvery(["2026-01-01", "2026-01-08"])).toBe("week");
    expect(guessEvery(["2026-01-01", "2026-02-20"])).toBeNull();
    expect(guessEvery(["2026-01-01"])).toBeNull();
    expect(nextExpected("2026-01-31", "month")).toBe("2026-02-28");
    expect(nextExpected("2026-11-30", "quarter")).toBe("2027-02-28");
    expect(nextExpected("2026-12-28", "week")).toBe("2027-01-04");
    expect(perYear(1500, "month")).toBe(18000);
  });

  it("writes a safe CSV, one row per part when split", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    const csv = expensesCsv([{ spentOn: "2026-10-03", supplier: "Officeworks", supplierAbn: "51 824 753 556", category: "Office supplies", totalCents: 13200, gstCents: 1200, gstClaimable: true,
      status: "approved", userName: "Ada", note: null, currency: "AUD", reimbursable: true, splits: [{ category: "Office supplies", amountCents: 10000 }, { category: "Meals", amountCents: 3200 }], rebilled: false }]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("Supplier ABN");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("100.00");
    expect(lines[2]).toContain("32.00");
  });

  it("takes photos and PDFs only, and re bills net on exclusive drafts", () => {
    expect(receiptTypeOk("image/jpeg", "a.jpg")).toBe("image/jpeg");
    expect(receiptTypeOk("", "scan.PDF")).toBe("application/pdf");
    expect(receiptTypeOk("text/html", "a.html")).toBeNull();
    const r = { supplier: "Qantas", spentOn: "2026-10-03", note: "Client trip", totalCents: 33000, gstCents: 3000, category: "Travel" };
    expect(rebillLine(r, "exclusive")).toMatchObject({ unitCents: 30000, gstFree: false, description: "Re billed: Qantas, 03/10/2026, Client trip" });
    expect(rebillLine({ ...r, gstCents: 0 }, "inclusive")).toMatchObject({ unitCents: 33000, gstFree: true });
  });
});

describe("R106 expenses API", () => {
  it("is off without the flags", async () => {
    const t = await setup({ INVOICES_ENABLED: "true" });
    expect((await t.c.get("/api/expenses")).status).toBe(404);
    const t2 = await setup({ EXPENSES_R106: "on" });
    expect((await t2.c.get("/api/expenses")).status).toBe(404);
  });

  it("adds a receipt, reads its fields, keeps edits, and guards GST claims over $82.50", async () => {
    const t = await setup();
    const up = await t.upload(t.c, RECEIPT);
    expect(up.body.error ?? null).toBeNull();
    expect(up.status).toBe(201);
    const id = up.body.expense.id;
    expect(up.body.expense).toMatchObject({ readState: "none", hasFile: true, source: "upload", status: "draft" });
    const read = (await t.c.post(`/api/expenses/${id}/read`)).body.expense;
    expect(read).toMatchObject({ readState: "done", supplier: "Officeworks Pty Ltd", spentOn: "2026-10-03", totalCents: 13200, gstCents: 1200, gstClaimable: true, needsTaxInvoice: false });
    // The person's edit sticks when the receipt is read again.
    expect((await t.c.patch(`/api/expenses/${id}`, { supplier: "Officeworks Bondi", supplierAbn: "" })).body.expense).toMatchObject({ supplier: "Officeworks Bondi", needsTaxInvoice: true, gstClaimable: false });
    expect((await t.c.patch(`/api/expenses/${id}`, { gstClaimable: true })).status).toBe(422);
    expect((await t.c.patch(`/api/expenses/${id}`, { supplierAbn: "51 824 753 557" })).status).toBe(422);
    expect((await t.c.post(`/api/expenses/${id}/read`)).body.expense.supplier).toBe("Officeworks Bondi");
    expect((await t.c.patch(`/api/expenses/${id}`, { gstCents: 99999 })).status).toBe(422);
    // Receipt bytes come back to its owner.
    const f = await t.app.request(`/api/expenses/${id}/receipt?inline=1`, { headers: { cookie: t.c.cookie, host: "localhost" } });
    expect(f.status).toBe(200);
    expect(f.headers.get("content-type")).toBe("application/pdf");
    // Wrong file types and empty files are refused.
    expect((await t.upload(t.c, "<b>x</b>", "x.html", "text/html")).status).toBe(422);
    expect((await t.upload(t.c, "", "x.pdf")).status).toBe(422);
  });

  it("submits, approves, rejects with a reason, and keeps members to their own", async () => {
    const t = await setup();
    const mem = await t.join("mo@acme.io", "Mo");
    const e = (await t.upload(mem, RECEIPT)).body.expense;
    const blank = (await mem.post("/api/expenses", {})).body.expense;
    expect((await mem.post(`/api/expenses/${blank.id}/submit`)).status).toBe(422);
    await mem.post(`/api/expenses/${e.id}/read`);
    expect((await mem.patch(`/api/expenses/${e.id}`, { splits: [{ category: "Office supplies", amountCents: 10000 }, { category: "Meals", amountCents: 3000 }] })).status).toBe(422);
    expect((await mem.patch(`/api/expenses/${e.id}`, { splits: [{ category: "Office supplies", amountCents: 10000 }, { category: "Meals", amountCents: 3200 }] })).body.expense.splits[1].gstCents).toBe(291);
    expect((await mem.post(`/api/expenses/${e.id}/submit`)).body.expense.status).toBe("submitted");
    expect((await mem.patch(`/api/expenses/${e.id}`, { note: "x" })).status).toBe(409);
    // Members see only their own and cannot approve.
    expect((await mem.get("/api/expenses?view=all")).status).toBe(403);
    expect((await mem.post(`/api/expenses/${e.id}/approve`)).status).toBe(403);
    const mine = (await t.c.post("/api/expenses", {})).body.expense;
    expect((await mem.get(`/api/expenses/${mine.id}`)).status).toBe(404);
    expect((await mem.get("/api/expenses?view=mine")).body.expenses).toHaveLength(2);
    // The owner sees it waiting, rejects without a reason (refused), then with one; the member fixes and resubmits.
    const list = (await t.c.get("/api/expenses?view=approve")).body;
    expect(list.waiting).toBe(1);
    expect((await t.c.post(`/api/expenses/${e.id}/reject`, { reason: " " })).status).toBe(422);
    expect((await t.c.post(`/api/expenses/${e.id}/reject`, { reason: "Add the client name" })).body.expense).toMatchObject({ status: "rejected", rejectReason: "Add the client name" });
    expect((await mem.patch(`/api/expenses/${e.id}`, { note: "For Bob" })).body.expense.status).toBe("draft");
    await mem.post(`/api/expenses/${e.id}/submit`);
    expect((await t.c.post(`/api/expenses/${e.id}/approve`)).body.expense).toMatchObject({ status: "approved", decidedByName: "Ada Lovelace" });
    expect((await mem.del(`/api/expenses/${e.id}`)).status).toBe(409);
    expect((await mem.patch(`/api/expenses/${e.id}`, { note: "x" })).status).toBe(409);
  });

  it("lets admins pick approvers, and someone else approves your own when there is someone", async () => {
    const t = await setup();
    const mem = await t.join("mo@acme.io", "Mo");
    expect((await mem.put("/api/expenses/settings", { approverIds: [] })).status).toBe(403);
    const s = (await t.c.get("/api/expenses/settings")).body;
    expect(s.receiptsAddress).toMatch(/^receipts\.[a-z0-9]{10,}@free\.example\.net$/);
    const moId = s.people.find((p: { name: string }) => p.name === "Mo").id;
    expect((await t.c.put("/api/expenses/settings", { approverIds: ["nobody"] })).status).toBe(422);
    expect((await t.c.put("/api/expenses/settings", { approverIds: [moId] })).status).toBe(200);
    expect((await mem.get("/api/expenses/settings")).body).toMatchObject({ canApprove: true, canManage: false, receiptsAddress: s.receiptsAddress, people: [] });
    const own = (await t.upload(t.c, RECEIPT)).body.expense;
    await t.c.post(`/api/expenses/${own.id}/read`);
    await t.c.post(`/api/expenses/${own.id}/submit`);
    expect((await t.c.post(`/api/expenses/${own.id}/approve`)).status).toBe(403);
    expect((await mem.post(`/api/expenses/${own.id}/approve`)).body.expense.status).toBe("approved");
    const reset = (await t.c.put("/api/expenses/settings", { resetAddress: true })).body;
    expect(reset.receiptsAddress).not.toBe(s.receiptsAddress);
  });

  it("re bills an expense once onto an invoice draft, never onto an issued one", async () => {
    const t = await setup();
    const e = (await t.upload(t.c, RECEIPT)).body.expense;
    await t.c.post(`/api/expenses/${e.id}/read`);
    const draft = (await t.c.post("/api/invoices/docs", { kind: "invoice", buyerName: "Bob", lines: [{ description: "Design", quantityMilli: 1000, unitCents: 10000 }] })).body.doc;
    expect((await t.c.get("/api/expenses/rebill-targets")).body.invoices.map((d: { id: string }) => d.id)).toContain(draft.id);
    const r = (await t.c.post(`/api/expenses/${e.id}/rebill`, { docId: draft.id })).body;
    expect(r.expense.rebillDocId).toBe(draft.id);
    const doc = (await t.c.get(`/api/invoices/docs/${draft.id}`)).body.doc;
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[1]).toMatchObject({ unitCents: 12000, description: "Re billed: Officeworks Pty Ltd, 03/10/2026" });
    expect(doc.subtotalCents).toBe(22000);
    expect((await t.c.post(`/api/expenses/${e.id}/rebill`, { docId: draft.id })).status).toBe(409);
    const e2 = (await t.upload(t.c, RECEIPT)).body.expense;
    await t.c.post(`/api/expenses/${e2.id}/read`);
    expect((await t.c.post(`/api/expenses/${e2.id}/rebill`, { docId: "nope" })).status).toBe(404);
  });

  it("exports CSV for the accountant: members their own, approvers all", async () => {
    const t = await setup();
    const mem = await t.join("mo@acme.io", "Mo");
    const a = (await t.upload(mem, RECEIPT)).body.expense;
    await mem.post(`/api/expenses/${a.id}/read`);
    const b = (await t.upload(t.c, RECEIPT.replace("Officeworks Pty Ltd", "Bunnings"))).body.expense;
    await t.c.post(`/api/expenses/${b.id}/read`);
    const get = async (who: Client, q: string) => { const r = await t.app.request(`/api/expenses/export.csv?${q}`, { headers: { cookie: who.cookie, host: "localhost" } }); return { status: r.status, text: await r.text() }; };
    const m = await get(mem, "view=mine");
    expect(m.text.trim().split("\r\n")).toHaveLength(2);
    expect(m.text).toContain("Officeworks");
    expect((await get(mem, "view=all")).status).toBe(403);
    const all = await get(t.c, "view=all");
    expect(all.text).toContain("Bunnings");
    expect(all.text).toContain("Officeworks");
  });

  it("tracks subscriptions: marked ones and suppliers that repeat", async () => {
    const t = await setup();
    for (const [d, s] of [["2026-08-02", "Netflix"], ["2026-09-02", "Netflix"], ["2026-10-02", "Netflix"], ["2026-10-05", "Cafe"]]) {
      const e = (await t.c.post("/api/expenses", {})).body.expense;
      await t.c.patch(`/api/expenses/${e.id}`, { supplier: s, spentOn: d, totalCents: s === "Cafe" ? 800 : 2299 });
    }
    const x = (await t.c.post("/api/expenses", {})).body.expense;
    await t.c.patch(`/api/expenses/${x.id}`, { supplier: "Hosting", spentOn: "2026-10-20", totalCents: 1100, every: "month" });
    const s = (await t.c.get("/api/expenses/subscriptions")).body;
    expect(s.subscriptions.map((r: { supplier: string }) => r.supplier).sort()).toEqual(["Hosting", "Netflix"]);
    expect(s.subscriptions.find((r: { supplier: string }) => r.supplier === "Netflix")).toMatchObject({ every: "month", suggested: true, nextOn: "2026-11-02", perYearCents: 27588 });
    expect(s.subscriptions.find((r: { supplier: string }) => r.supplier === "Hosting")).toMatchObject({ suggested: false, nextOn: "2026-11-20" });
  });

  it("takes receipts by mail only from members' own address", async () => {
    const t = await setup();
    const addr = (await t.c.get("/api/expenses/settings")).body.receiptsAddress as string;
    const pdf = { filename: "receipt.pdf", contentType: "application/pdf", content: new TextEncoder().encode(RECEIPT) };
    const mail = (from: string, extra: Partial<Parameters<typeof receiveReceiptMail>[1]> = {}) => receiveReceiptMail(t.deps, { rcpt: addr, fromAddress: from, subject: "Fwd: Paper", dmarcFail: false, attachments: [pdf], ...extra });
    expect(await mail("stranger@evil.test")).toMatchObject({ handled: true, accepted: false });
    expect(await mail("ADA@acme.io", { dmarcFail: true })).toMatchObject({ accepted: false });
    expect(await mail("ada@acme.io", { attachments: [{ filename: "x.exe", contentType: "application/octet-stream", content: new Uint8Array([1]) }] })).toMatchObject({ accepted: false });
    const ok = await mail("ADA@acme.io");
    expect(ok).toMatchObject({ handled: true, accepted: true });
    expect(await receiveReceiptMail(t.deps, { rcpt: "receipts.zzzzzzzzzzzz@free.example.net", fromAddress: "ada@acme.io", subject: null, dmarcFail: false, attachments: [pdf] })).toMatchObject({ accepted: false });
    expect(await receiveReceiptMail(t.deps, { rcpt: "hello@free.example.net", fromAddress: "ada@acme.io", subject: null, dmarcFail: false, attachments: [pdf] })).toEqual({ handled: false });
    const list = (await t.c.get("/api/expenses")).body.expenses;
    expect(list[0]).toMatchObject({ source: "email", note: "Paper", hasFile: true });
  });

  it("refuses API keys and agents (people only)", async () => {
    const { assertPerson } = await import("@/server/services/expenses/expenses");
    expect(() => assertPerson({ orgId: "o", userId: "u", email: "a@b.c", name: "A", apiKeyId: "k" })).toThrow();
    expect(assertPerson({ orgId: "o", userId: "u", email: "a@b.c", name: "A" })).toBe("u");
  });
});
