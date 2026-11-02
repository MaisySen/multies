/**
 * M4: types and plain helpers for the new app screens on existing server endpoints:
 * Invoices (GET /api/invoices/docs, /api/invoices/docs/:id), Scheduling (GET /api/scheduling/page,
 * /api/scheduling/bookings) and Links (GET /api/links). Reading and sharing only; editing stays on the web.
 */
export type PayState = "draft" | "unpaid" | "part_paid" | "paid" | "overdue" | "void" | "issued" | "accepted" | "declined";
export interface InvoiceDoc {
  id: string; kind: "invoice" | "quote" | "credit_note" | "bill"; number: string | null; status: string; state: PayState; title: string;
  buyerName: string | null; buyerEmail?: string | null; issueDate: string | null; dueDate: string | null; currency: string;
  subtotalCents: number; gstCents: number; totalCents: number; paidCents: number; creditedCents: number; owingCents: number; reference?: string | null;
}
export interface InvoiceList { items: InvoiceDoc[]; more: boolean; totals: { openCents: number; overdueCents: number; count: number } }
export interface InvoiceLine { id: string; description: string; quantityMilli: number; unitCents: number; totalCents: number }
export interface InvoicePayment { id: string; amountCents: number; paidOn: string; method?: string | null }
export interface InvoiceDetail extends InvoiceDoc { viewUrl: string | null; lines: InvoiceLine[]; payments: InvoicePayment[]; canManage: boolean }

export interface SchedulingPage { id: string; slug: string; title: string; description: string | null; slotMin: number; enabled: boolean; url: string; timezone: string }
export interface Booking { id: string; startsAt: string; endsAt: string; durationMin: number; name: string; email: string; note: string | null; status: "confirmed" | "cancelled"; meetingUrl: string | null }

export interface ShortLink { id: string; code: string; shortUrl: string; url: string; title: string | null; tags: string[]; enabled: boolean; status: string; clicks: number; lastClickAt: string | null }

export const INVOICE_FILTERS = [
  { id: "open", label: "Open" }, { id: "overdue", label: "Overdue" }, { id: "paid", label: "Paid" }, { id: "draft", label: "Drafts" }, { id: "", label: "All" },
] as const;

/** "$1,234.50" in the document's currency. */
export function money(c: number, currency = "AUD"): string {
  try { return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(c / 100); } catch { return `$${(c / 100).toFixed(2)}`; }
}

export const STATE: Record<string, { label: string; tone: "brand" | "ok" | "warn" | "bad" | "neutral" }> = {
  draft: { label: "Draft", tone: "neutral" }, unpaid: { label: "Unpaid", tone: "brand" }, part_paid: { label: "Part paid", tone: "warn" },
  paid: { label: "Paid", tone: "ok" }, overdue: { label: "Overdue", tone: "bad" }, void: { label: "Void", tone: "neutral" },
  issued: { label: "Sent", tone: "brand" }, accepted: { label: "Accepted", tone: "ok" }, declined: { label: "Declined", tone: "bad" },
};
export function stateOf(s: string) { return STATE[s] ?? { label: s, tone: "neutral" as const }; }

/** "Due 12 Nov", "Due today", "3 days overdue" for an open invoice; null otherwise. */
export function dueLine(d: Pick<InvoiceDoc, "state" | "dueDate">, today: string): string | null {
  if (!d.dueDate || !["unpaid", "part_paid", "overdue"].includes(d.state)) return null;
  const days = Math.round((Date.parse(d.dueDate) - Date.parse(today)) / 86400000);
  if (days === 0) return "Due today";
  if (days < 0) return `${-days} ${days === -1 ? "day" : "days"} overdue`;
  return `Due ${new Date(`${d.dueDate}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}`;
}

/** 1500 milli = "1.5". */
export function qty(milli: number): string { return String(Math.round(milli) / 1000); }

/** Bookings grouped by day ("Today", "Tomorrow", "Wed 5 Nov"), in order. */
export function bookingDays(list: Booking[] | undefined, now = new Date()): { day: string; items: Booking[] }[] {
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; // the phone's own day
  const t = key(now), tm = key(new Date(now.getTime() + 86400000));
  const out: { day: string; items: Booking[] }[] = [];
  for (const b of [...(list ?? [])].filter((x) => x.status === "confirmed").sort((a, z) => a.startsAt.localeCompare(z.startsAt))) {
    const d = new Date(b.startsAt), k = key(d);
    const day = k === t ? "Today" : k === tm ? "Tomorrow" : d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(b); else out.push({ day, items: [b] });
  }
  return out;
}

export function timeRange(b: Pick<Booking, "startsAt" | "endsAt">): string {
  const f = (s: string) => new Date(s).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  return `${f(b.startsAt)} to ${f(b.endsAt)}`;
}

/** "mul.ti/abc" for display: the short link without its scheme. */
export function shortLabel(u: string): string { return u.replace(/^https?:\/\//, ""); }
