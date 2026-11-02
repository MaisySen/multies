/** M4: sample Invoices, a booking page with bookings, and short links for the sample workspace and screenshots. */
import type { Booking, InvoiceDetail, InvoiceDoc, SchedulingPage, ShortLink } from "@/lib/m4";

const day = (now: number, d: number) => new Date(now + d * 86400000).toISOString().slice(0, 10);
const at = (now: number, d: number, h: number, m = 0) => { const x = new Date(now + d * 86400000); x.setHours(h, m, 0, 0); return x.toISOString(); };

export function sampleM4(now: number) {
  const doc = (id: string, n: string, buyer: string, total: number, paid: number, state: InvoiceDoc["state"], due: number, status = "issued"): InvoiceDoc => ({
    id, kind: "invoice", number: n, status, state, title: "Tax invoice", buyerName: buyer, buyerEmail: `${buyer.split(" ")[0].toLowerCase()}@example.com`,
    issueDate: day(now, due - 14), dueDate: day(now, due), currency: "AUD", subtotalCents: Math.round(total / 1.1), gstCents: total - Math.round(total / 1.1),
    totalCents: total, paidCents: paid, creditedCents: 0, owingCents: Math.max(0, total - paid), reference: null,
  });
  const invoices: InvoiceDoc[] = [
    doc("inv_1", "INV-0042", "Harbour Design Co", 495000, 0, "overdue", -3),
    doc("inv_2", "INV-0043", "Northside Dental", 132000, 0, "unpaid", 9),
    doc("inv_3", "INV-0044", "Kiri Patel", 286000, 100000, "part_paid", 14),
    doc("inv_4", "INV-0039", "Bluegum Cafe", 77000, 77000, "paid", -20),
    doc("inv_5", "INV-0045", "Lumen Studio", 210000, 0, "draft", 21, "draft"),
  ];
  const detail = (d: InvoiceDoc): InvoiceDetail => ({ ...d, viewUrl: d.status === "draft" ? null : `https://multies.si/i/sample${d.id}`, canManage: true,
    lines: [
      { id: `${d.id}_l1`, description: "Brand workshop, half day", quantityMilli: 1000, unitCents: Math.round(d.totalCents * 0.6 / 1.1), totalCents: Math.round(d.totalCents * 0.6) },
      { id: `${d.id}_l2`, description: "Design hours", quantityMilli: 4500, unitCents: Math.round(d.totalCents * 0.4 / 1.1 / 4.5), totalCents: d.totalCents - Math.round(d.totalCents * 0.6) },
    ],
    payments: d.paidCents ? [{ id: `${d.id}_p1`, amountCents: d.paidCents, paidOn: day(now, -2), method: "Bank transfer" }] : [] });
  const page: SchedulingPage = { id: "sp_1", slug: "sam", title: "Meet with Sam", description: "30 minutes to talk through your project.", slotMin: 30, enabled: true, url: "https://multies.si/book/sam", timezone: "Australia/Sydney" };
  const b = (id: string, d: number, h: number, name: string, note: string | null): Booking => ({ id, startsAt: at(now, d, h), endsAt: at(now, d, h, 30), durationMin: 30, name, email: `${name.split(" ")[0].toLowerCase()}@example.com`, note, status: "confirmed", meetingUrl: null });
  const bookings: Booking[] = [b("bk_1", 0, 15, "Ava Lin", "Website refresh"), b("bk_2", 1, 10, "Marco Rossi", null), b("bk_3", 1, 14, "Priya Shah", "Quarterly review"), b("bk_4", 3, 11, "Tom Baker", null)];
  const link = (id: string, code: string, url: string, title: string, clicks: number): ShortLink => ({ id, code, shortUrl: `https://mul.ti/${code}`, url, title, tags: [], enabled: true, status: "active", clicks, lastClickAt: at(now, 0, 9) });
  const links: ShortLink[] = [
    link("ln_1", "spring", "https://harbourdesign.example/spring-sale", "Spring sale landing page", 1284),
    link("ln_2", "deck", "https://multies.si/d/pitch-deck", "Pitch deck", 312),
    link("ln_3", "book", "https://multies.si/book/sam", "Book a call", 97),
    link("ln_4", "survey", "https://multies.si/f/feedback", "Customer survey", 41),
  ];
  return { invoices, detail, page, bookings, links };
}

/** The sample answers for the M4 paths, or undefined for anything else. */
export function m4Route(store: ReturnType<typeof sampleM4>, method: string, path: string, params: Record<string, string> = {}): unknown {
  if (method !== "GET") return undefined;
  if (path === "/invoices/docs") {
    const s = params.state ?? "";
    const items = store.invoices.filter((d) => !s || (s === "open" ? ["unpaid", "part_paid", "overdue"].includes(d.state) : d.state === s));
    const open = store.invoices.filter((d) => d.status === "issued").reduce((a, d) => a + d.owingCents, 0);
    const overdue = store.invoices.filter((d) => d.state === "overdue").reduce((a, d) => a + d.owingCents, 0);
    return { items, more: false, totals: { openCents: open, overdueCents: overdue, count: store.invoices.length } };
  }
  const m = /^\/invoices\/docs\/([^/]+)$/.exec(path);
  if (m) { const d = store.invoices.find((x) => x.id === m[1]); return d ? { doc: store.detail(d) } : undefined; }
  if (path === "/scheduling/page") return { page: store.page };
  if (path === "/scheduling/bookings") return { bookings: store.bookings, nextCursor: null };
  if (path === "/links") return { links: store.links, base: "https://mul.ti" };
  return undefined;
}
