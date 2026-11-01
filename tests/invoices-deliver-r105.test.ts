/** R105: what leaves the app: send with a view link (QA mailbox only on the test site), the PDF, the logged out view
 * (that one document only), quote answers, cron reminders and repeats, long searches and who may do what. */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { docMail, invoicePdf, pdfSafe, publicView, runInvoiceCron, fileName } from "@/server/services/invoices/deliver";

type Sent = { to: string[]; subject: string; text: string };
async function setup(env: Record<string, string> = { INVOICES_ENABLED: "true" }) {
  const ctx = await makeTestApp(env);
  let clock = Date.parse("2026-11-01T01:00:00Z");
  ctx.deps.now = () => new Date(clock);
  const sent: Sent[] = [];
  (ctx.deps as { outbound: unknown }).outbound = { name: "fake", send: async (m: { to: { address: string }[] | string[]; subject: string; text: string }) => {
    sent.push({ to: m.to.map((x) => (typeof x === "string" ? x : x.address)), subject: m.subject, text: m.text }); return { status: "sent", provider: "fake" };
  } };
  const c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  await c.put("/api/invoices/settings", { businessName: "Fintex", abn: "51 824 753 556", bsb: "062-000", accountNumber: "12345678", accountName: "Fintex Pty Ltd", termsDays: 14 });
  sent.length = 0; // the sign up email
  return { ...ctx, c, sent, setDay: (d: string) => { clock = Date.parse(`${d}T01:00:00Z`); } };
}
const line = (d: string, unitCents: number, q = 1000, gstFree = false) => ({ description: d, quantityMilli: q, unitCents, gstFree });
async function issued(t: Awaited<ReturnType<typeof setup>>, kind = "invoice", extra: Record<string, unknown> = {}) {
  const d = (await t.c.post("/api/invoices/docs", { kind, buyerName: "Bob Builder", buyerEmail: "bob@builder.com.au", lines: [line("Design work", 100000)], ...extra })).body.doc;
  const r = await t.c.post(`/api/invoices/docs/${d.id}/issue`, {});
  expect(r.status).toBe(200);
  return r.body.doc as { id: string; number: string; viewUrl: string; totalCents: number };
}
const tokenOf = (url: string) => url.split("/i/")[1];

describe("R105 delivery helpers", () => {
  it("keeps PDF text inside Latin 1 so the file always builds", () => {
    expect(pdfSafe("Café “quoted” \u2013 fine… 日本")).toBe('Café "quoted" - fine... ??');
    expect(pdfSafe(null)).toBe("");
    expect(fileName("Tax invoice", "INV-0001")).toBe("Tax invoice INV-0001.pdf");
    expect(fileName("Quote", null)).toBe("Quote draft.pdf");
  });
  it("writes the email for a send, a reminder before and a reminder after, with the bank details and no dashes", () => {
    const v = { kind: "invoice", title: "Tax invoice", number: "INV-0007", dueDate: "2026-11-15", totalCents: 110000, owingCents: 55000, currency: "AUD", buyerName: "Bob", sourceNumber: null,
      seller: { name: "Fintex", email: "accounts@fintex.au" }, pay: { accountName: "Fintex Pty Ltd", bsb: "062 000", accountNumber: "12345678" } } as never;
    const s = docMail(v, "https://x/i/t", "send");
    expect(s.subject).toBe("Tax invoice INV-0007 from Fintex");
    expect(s.text).toContain("for $1,100.00, due on 2026-11-15");
    expect(s.text).toContain("BSB 062 000");
    expect(s.action).toEqual({ label: "View invoice", url: "https://x/i/t" });
    expect(docMail(v, "u", "before").subject).toBe("Reminder: tax invoice INV-0007 is due on 2026-11-15");
    expect(docMail(v, "u", "after").text).toContain("$550.00 is still unpaid");
    expect(docMail(v, "u", "send", "Thanks for the work").text).toContain("Thanks for the work");
    for (const k of ["send", "before", "after"] as const) expect(docMail(v, "u", k).text).not.toMatch(/[\u2013\u2014]| - /);
  });
  it("builds a PDF for a long document with GST free lines, other currencies and odd characters", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ description: `Line ${i} ${"word ".repeat(i % 7 * 8)}ÿ 漢`, quantityMilli: 1500, unitCents: 1234, gstFree: i % 3 === 0, netCents: 1851, gstCents: i % 3 === 0 ? 0 : 185, totalCents: 2036 }));
    const v = { kind: "invoice", title: "Tax invoice", number: "INV-0001", status: "issued", issueDate: "2026-11-01", dueDate: "2026-11-15", currency: "NZD", priceMode: "exclusive", gstRegistered: true,
      buyerName: "A very long buyer name ".repeat(5), buyerAbn: "51 824 753 556", buyerAddress: "1 Martin Place\nSydney NSW 2000", reference: "PO 9", notes: "n".repeat(900), terms: "Pay in 14 days",
      subtotalCents: 1, gstCents: 1, totalCents: 2, paidCents: 1, creditedCents: 0, owingCents: 1, sourceNumber: null, voided: false, lines,
      seller: { name: "Fintex", abn: "51 824 753 556", address: "Sydney", email: "a@b.au", phone: "02 9000 0000", footer: "Thank you" }, pay: { bankName: "Bank", accountName: "Fintex", bsb: "062-000", accountNumber: "12345678", note: "Or pay by card on the phone" } } as never;
    const bytes = await invoicePdf(v, "#123456");
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(3000);
  });
});

describe("R105 send, PDF and the logged out view", () => {
  it("sends an issued invoice with its view link, only after issue, and only owners and admins", async () => {
    const t = await setup();
    const draft = (await t.c.post("/api/invoices/docs", { kind: "invoice", buyerName: "Bob", buyerEmail: "bob@builder.com.au", lines: [line("Work", 1000)] })).body.doc;
    expect((await t.c.post(`/api/invoices/docs/${draft.id}/send`, {})).status).toBe(409);
    const d = await issued(t);
    const r = await t.c.post(`/api/invoices/docs/${d.id}/send`, { message: "Thanks Bob" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sent: true, to: "bob@builder.com.au" });
    expect(r.body.doc.sentAt).toBeTruthy();
    const mail = t.sent.at(-1)!;
    expect(mail.to).toEqual(["bob@builder.com.au"]);
    expect(mail.subject).toBe(`Tax invoice ${d.number} from Fintex`);
    expect(mail.text).toContain(d.viewUrl);
    expect(mail.text).toContain("Thanks Bob");
    expect((await t.c.post(`/api/invoices/docs/${d.id}/send`, { to: "not an email" })).status).toBe(422);
    // a member drafts but cannot send
    const invite = await t.c.post("/api/team/invites", { email: "mate-r105@example.com", role: "member" });
    const mate = new Client(t.app);
    await mate.signup("mate-r105@example.com", "Mate", "");
    expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    expect((await mate.post(`/api/invoices/docs/${d.id}/send`, {})).status).toBe(403);
    expect((await mate.get("/api/invoices/settings")).body.canManage).toBe(false);
    expect((await t.c.get("/api/invoices/settings")).body.canManage).toBe(true);
    expect((await mate.get(`/api/invoices/docs/${d.id}/pdf`)).status).toBe(200); // members can read
  });

  it("on the test site sends only to the QA mailbox", async () => {
    const t = await setup({ INVOICES_ENABLED: "true", CAMPAIGN_SEND_ALLOW: "@staging-qa.invalid", CAMPAIGN_SEND_ALLOW_EXTRA: "qa+*@example.org" });
    const d = await issued(t);
    const r = await t.c.post(`/api/invoices/docs/${d.id}/send`, {});
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("QA mailbox");
    expect(t.sent).toHaveLength(0);
    expect((await t.c.post(`/api/invoices/docs/${d.id}/send`, { to: "qa+r105@example.org" })).status).toBe(200);
    expect(t.sent.map((m) => m.to[0])).toEqual(["qa+r105@example.org"]);
  });

  it("downloads the PDF for a signed in user and for the link holder", async () => {
    const t = await setup();
    const d = await issued(t);
    const a = await t.app.request(`/api/invoices/docs/${d.id}/pdf?download=1`, { headers: { cookie: (t.c as unknown as { cookie: string }).cookie ?? "" } });
    expect([200, 401]).toContain(a.status);
    const b = await t.c.get(`/api/invoices/docs/${d.id}/pdf`);
    expect(b.status).toBe(200);
    const pub = await t.app.request(`/api/invoice-view/${tokenOf(d.viewUrl)}/pdf?download=1`);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toBe("application/pdf");
    expect(pub.headers.get("content-disposition")).toContain(`attachment; filename="Tax invoice ${d.number}.pdf"`);
    expect(pub.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("shows the buyer that one document only, never drafts, bills or unknown links, and marks it viewed", async () => {
    const t = await setup();
    const d = await issued(t);
    const r = await t.app.request(`/api/invoice-view/${tokenOf(d.viewUrl)}`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { doc: Record<string, unknown> & { seller: Record<string, unknown>; pay: Record<string, unknown> } };
    expect(j.doc).toMatchObject({ title: "Tax invoice", number: d.number, totalCents: 110000, owingCents: 110000, buyerName: "Bob Builder" });
    expect(j.doc.seller).toMatchObject({ name: "Fintex", abn: "51 824 753 556" });
    expect(j.doc.pay).toMatchObject({ bsb: "062 000", accountNumber: "12345678" });
    const raw = JSON.stringify(j);
    for (const k of ["orgId", "contactId", "createdBy", "viewToken", "\"id\""]) expect(raw).not.toContain(k);
    expect((await t.c.get(`/api/invoices/docs/${d.id}`)).body.doc.viewedAt).toBeTruthy();
    expect((await t.app.request("/api/invoice-view/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await t.app.request("/api/invoice-view/bad")).status).toBe(404);
    const bill = (await t.c.post("/api/invoices/docs", { kind: "bill", buyerName: "Supplier", lines: [line("Paper", 2000)] })).body.doc;
    const ib = await t.c.post(`/api/invoices/docs/${bill.id}/issue`, {});
    expect(ib.body.doc.viewUrl).toBeNull();
    expect((await t.c.post(`/api/invoices/docs/${bill.id}/send`, {})).status).toBe(409);
  });

  it("is closed when the flag is off", async () => {
    const t = await setup({});
    expect((await t.app.request("/api/invoice-view/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await t.c.get("/api/config")).body.invoices).toBe(false);
  });

  it("lets the buyer accept or decline a quote once, and not after it expires", async () => {
    const t = await setup();
    const q = await issued(t, "quote", { dueDate: "2026-11-30" });
    const tok = tokenOf(q.viewUrl);
    const post = (answer: string) => t.app.request(`/api/invoice-view/${tok}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer }) });
    expect((await post("maybe")).status).toBe(422);
    expect((await post("accepted")).status).toBe(200);
    expect((await post("declined")).status).toBe(409);
    expect((await t.c.get(`/api/invoices/docs/${q.id}`)).body.doc.status).toBe("accepted");
    const q2 = await issued(t, "quote", { dueDate: "2026-11-05" });
    t.setDay("2026-11-06");
    const late = await t.app.request(`/api/invoice-view/${tokenOf(q2.viewUrl)}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "accepted" }) });
    expect(late.status).toBe(410);
  });

  it("searches with long text without a server error", async () => {
    const t = await setup();
    await issued(t);
    const long = "x".repeat(69);
    expect((await t.c.get(`/api/invoices/docs?kind=invoice&q=${long}`)).status).toBe(200);
    expect((await t.c.get(`/api/invoices/items?q=${long}`)).status).toBe(200);
  });
});

describe("R105 cron", () => {
  it("reminds before and after the due date once each, never for paid invoices, and only where mail is allowed", async () => {
    const t = await setup();
    const d = await issued(t); // due 2026-11-15 (14 days)
    const paid = await issued(t);
    await t.c.post(`/api/invoices/docs/${paid.id}/payments`, { amountCents: paid.totalCents, paidOn: "2026-11-02" });
    t.setDay("2026-11-11");
    expect((await runInvoiceCron(t.deps)).reminded).toBe(0);
    t.setDay("2026-11-12");
    expect((await runInvoiceCron(t.deps)).reminded).toBe(1);
    expect(t.sent.at(-1)!.subject).toBe(`Reminder: tax invoice ${d.number} is due on 2026-11-15`);
    expect((await runInvoiceCron(t.deps)).reminded).toBe(0);
    t.setDay("2026-11-22");
    expect((await runInvoiceCron(t.deps)).reminded).toBe(1);
    expect(t.sent.at(-1)!.subject).toBe(`Overdue: tax invoice ${d.number} was due on 2026-11-15`);
    expect((await runInvoiceCron(t.deps)).reminded).toBe(0);
    expect(t.sent.every((m) => !m.text.includes(paid.number))).toBe(true);
  });

  it("makes repeating invoices on their day and emails them only when asked", async () => {
    const t = await setup();
    const d = await issued(t);
    expect((await t.c.put(`/api/invoices/docs/${d.id}/repeat`, { every: "month", startDate: "2026-12-01", autoSend: true })).status).toBe(200);
    t.setDay("2026-11-30");
    expect((await runInvoiceCron(t.deps)).made).toBe(0);
    t.setDay("2026-12-01");
    const r = await runInvoiceCron(t.deps);
    expect(r).toMatchObject({ made: 1, sent: 1 });
    expect(t.sent.at(-1)!.subject).toMatch(/^Tax invoice INV/);
    expect((await runInvoiceCron(t.deps)).made).toBe(0);
  });
});

describe("R105 public view shape", () => {
  it("formats the seller ABN and BSB and hides pay details on quotes", () => {
    const base = { doc: { kind: "quote", title: "Quote", number: "QU-0001", status: "issued", state: "issued", issueDate: "2026-11-01", dueDate: null, currency: "AUD", priceMode: "exclusive", gstRegistered: true,
      buyerName: "Bob", buyerAbn: null, buyerAddress: null, reference: null, notes: null, terms: null, subtotalCents: 0, gstCents: 0, totalCents: 0, paidCents: 0, creditedCents: 0, owingCents: 0 },
      lines: [], sourceNumber: null, settings: { businessName: "Fintex", abn: "51824753556", bsb: "062000", accountNumber: "12345678", accountName: null, bankName: null, payNote: null, address: null, email: null, phone: null, footer: null } };
    const v = publicView(base as never);
    expect(v.seller.abn).toBe("51 824 753 556");
    expect(v.pay).toBeNull();
    const inv = publicView({ ...base, doc: { ...base.doc, kind: "invoice" } } as never);
    expect(inv.pay).toMatchObject({ bsb: "062 000", accountName: "Fintex" });
  });
});
