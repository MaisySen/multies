/**
 * R105: invoices and quotes. Pure money and Australian tax invoice rules, shared by the server, the web and tests.
 * Money is integer cents everywhere (never floats). Quantities are integer thousandths (1.5 hours = 1500).
 * GST is 10 percent, worked out per line and added up, each line rounded to the nearest cent (half up).
 * Plain note for help pages only: check with your accountant.
 */

export const GST_RATE_BP = 1000; // 10 percent in basis points
export const BUYER_ID_THRESHOLD_CENTS = 100_000; // A$1,000: buyer identity or ABN must show at or above this total
export const MAX_LINES = 200;
export const MAX_CENTS = 99_999_999_999; // just under A$1 billion per amount, keeps sums far inside safe integers

export type DocKind = "quote" | "invoice" | "credit_note" | "bill";
export type PriceMode = "exclusive" | "inclusive";
export type Repeat = "week" | "fortnight" | "month" | "quarter" | "year";

export const DOC_PREFIX: Record<DocKind, string> = { invoice: "INV", quote: "QU", credit_note: "CN", bill: "BILL" };
export const REPEATS: { id: Repeat; label: string }[] = [
  { id: "week", label: "Every week" }, { id: "fortnight", label: "Every 2 weeks" }, { id: "month", label: "Every month" },
  { id: "quarter", label: "Every 3 months" }, { id: "year", label: "Every year" },
];
export const PAYMENT_METHODS = ["bank", "card", "cash", "cheque", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Integer division rounded half away from zero. */
export function divRound(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b === 0) throw new Error("bad_integer");
  const neg = (a < 0) !== (b < 0);
  const x = Math.abs(a), y = Math.abs(b);
  const q = Math.floor((2 * x + y) / (2 * y));
  return neg ? -q : q;
}

export interface LineInput { description: string; quantityMilli: number; unitCents: number; gstFree?: boolean }
export interface LineAmounts { netCents: number; gstCents: number; totalCents: number }

/** One line. Exclusive: net = qty x price, GST = net / 10. Inclusive: total = qty x price, GST = total / 11. */
export function lineAmounts(l: LineInput, mode: PriceMode, gstRegistered = true): LineAmounts {
  const gross = divRound(l.quantityMilli * l.unitCents, 1000);
  const taxed = gstRegistered && !l.gstFree;
  if (mode === "inclusive") {
    const gst = taxed ? divRound(gross, 11) : 0;
    return { netCents: gross - gst, gstCents: gst, totalCents: gross };
  }
  const gst = taxed ? divRound(gross * GST_RATE_BP, 10_000) : 0;
  return { netCents: gross, gstCents: gst, totalCents: gross + gst };
}

export interface Totals { subtotalCents: number; gstCents: number; totalCents: number; gstFreeCents: number; taxableCents: number }

export function docTotals(lines: LineInput[], mode: PriceMode, gstRegistered = true): Totals & { lines: LineAmounts[] } {
  const out = lines.map((l) => lineAmounts(l, mode, gstRegistered));
  let sub = 0, gst = 0, tot = 0, free = 0;
  out.forEach((a, i) => { sub += a.netCents; gst += a.gstCents; tot += a.totalCents; if (lines[i].gstFree || !gstRegistered) free += a.netCents; });
  return { lines: out, subtotalCents: sub, gstCents: gst, totalCents: tot, gstFreeCents: free, taxableCents: sub - free };
}

/** ABN: 11 digits; take 1 from the first digit, weight the digits, the sum divides by 89. */
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
export function cleanAbn(raw: string | null | undefined): string { return (raw ?? "").replace(/[\s-]/g, ""); }
export function abnValid(raw: string | null | undefined): boolean {
  const d = cleanAbn(raw);
  if (!/^\d{11}$/.test(d) || d[0] === "0") return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += (Number(d[i]) - (i === 0 ? 1 : 0)) * ABN_WEIGHTS[i];
  return sum % 89 === 0;
}
export function formatAbn(raw: string | null | undefined): string {
  const d = cleanAbn(raw);
  return /^\d{11}$/.test(d) ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : (raw ?? "");
}

/** "INV-0042". Numbers never repeat: a voided document keeps its number. */
export function docNumber(kind: DocKind, seq: number, prefix?: string | null): string {
  return `${(prefix ?? "").trim() || DOC_PREFIX[kind]}-${String(seq).padStart(4, "0")}`;
}

/** The heading the document must carry. ATO: a GST registered supplier's invoice says "Tax invoice"; credits are adjustment notes. */
export function docTitle(kind: DocKind, gstRegistered: boolean): string {
  if (kind === "invoice") return gstRegistered ? "Tax invoice" : "Invoice";
  if (kind === "credit_note") return gstRegistered ? "Adjustment note" : "Credit note";
  if (kind === "quote") return "Quote";
  return "Bill";
}

export interface AtoDoc {
  kind: DocKind; gstRegistered: boolean; supplierName: string; supplierAbn: string | null; issueDate: string | null;
  buyerName: string | null; buyerAbn: string | null; totalCents: number; lines: LineInput[]; sourceNumber?: string | null;
}
export type AtoProblem = "supplier_name" | "supplier_abn" | "issue_date" | "no_lines" | "line_description" | "line_quantity" | "buyer_identity" | "buyer_abn" | "credit_source";

/** What stops a document being a valid tax invoice or adjustment note. Empty means it can be issued. */
export function atoProblems(d: AtoDoc): AtoProblem[] {
  if (d.kind === "quote" || d.kind === "bill") return d.lines.length ? [] : ["no_lines"];
  const p: AtoProblem[] = [];
  if (!d.supplierName.trim()) p.push("supplier_name");
  if (d.gstRegistered && !abnValid(d.supplierAbn)) p.push("supplier_abn");
  if (!d.issueDate) p.push("issue_date");
  if (!d.lines.length) p.push("no_lines");
  if (d.lines.some((l) => !l.description.trim())) p.push("line_description");
  if (d.lines.some((l) => l.quantityMilli <= 0)) p.push("line_quantity");
  if (d.gstRegistered && Math.abs(d.totalCents) >= BUYER_ID_THRESHOLD_CENTS && !(d.buyerName ?? "").trim() && !cleanAbn(d.buyerAbn)) p.push("buyer_identity");
  if (cleanAbn(d.buyerAbn) && !abnValid(d.buyerAbn)) p.push("buyer_abn");
  if (d.kind === "credit_note" && !d.sourceNumber) p.push("credit_source");
  return p;
}
export const ATO_PROBLEM_TEXT: Record<AtoProblem, string> = {
  supplier_name: "Add your business name in invoice settings.",
  supplier_abn: "Add a valid ABN in invoice settings.",
  issue_date: "Pick an issue date.",
  no_lines: "Add at least one line.",
  line_description: "Every line needs a description.",
  line_quantity: "Every line needs a quantity above zero.",
  buyer_identity: "For A$1,000 or more, show the buyer's name or ABN.",
  buyer_abn: "The buyer's ABN does not look right. Check the 11 digits.",
  credit_source: "An adjustment note must name the invoice it changes.",
};

export type PayState = "draft" | "void" | "paid" | "part_paid" | "overdue" | "unpaid";
/** Payment state from money in, credits applied and the due date (YYYY-MM-DD, compared as text). */
export function payState(d: { issued: boolean; voided: boolean; totalCents: number; paidCents: number; creditedCents?: number; dueDate: string | null }, today: string): PayState {
  if (d.voided) return "void";
  if (!d.issued) return "draft";
  const owing = d.totalCents - d.paidCents - (d.creditedCents ?? 0);
  if (owing <= 0) return "paid";
  if (d.dueDate && d.dueDate < today) return "overdue";
  return d.paidCents + (d.creditedCents ?? 0) > 0 ? "part_paid" : "unpaid";
}
export const PAY_STATE_LABEL: Record<PayState, string> = { draft: "Draft", void: "Void", paid: "Paid", part_paid: "Part paid", overdue: "Overdue", unpaid: "Unpaid" };

/** Money typed by a person ("1,234.5", "$20") to cents, no floats. Null when it is not money. */
export function parseMoney(raw: string): number | null {
  const s = raw.replace(/[\s,$]/g, "").replace(/^A\$/i, "");
  const m = /^(-?)(\d{1,12})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0") || 0);
  return m[1] ? -cents : cents;
}
/** Quantity typed by a person ("1.5") to thousandths. */
export function parseQty(raw: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{0,3}))?$/.exec(raw.replace(/[\s,]/g, ""));
  if (!m) return null;
  return Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0") || 0);
}
export function qtyText(milli: number): string {
  const whole = Math.trunc(milli / 1000), frac = Math.abs(milli % 1000);
  return frac ? `${whole}.${String(frac).padStart(3, "0").replace(/0+$/, "")}` : String(whole);
}
export function centsText(cents: number): string {
  const neg = cents < 0, a = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.trunc(a / 100).toLocaleString("en-AU")}.${String(a % 100).padStart(2, "0")}`;
}
export function money(cents: number, currency = "AUD"): string {
  const sym = currency === "AUD" ? "$" : `${currency} `;
  return cents < 0 ? `-${sym}${centsText(-cents)}` : `${sym}${centsText(cents)}`;
}

/** Calendar maths on YYYY-MM-DD without time zones. */
export function addDays(date: string, days: number): string {
  const t = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}
function addMonths(date: string, n: number, anchorDay: number): string {
  const y = +date.slice(0, 4), m = +date.slice(5, 7) - 1 + n;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, "0")}-${String(Math.min(anchorDay, last)).padStart(2, "0")}`;
}
/** Next run of a repeating invoice; month based repeats keep the first run's day, clamped to short months. */
export function nextRun(date: string, every: Repeat, anchorDay = +date.slice(8, 10)): string {
  if (every === "week") return addDays(date, 7);
  if (every === "fortnight") return addDays(date, 14);
  return addMonths(date, every === "month" ? 1 : every === "quarter" ? 3 : 12, anchorDay);
}

export const AGE_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];
export const AGE_BUCKET_LABEL: Record<AgeBucket, string> = { current: "Not yet due", d1_30: "1 to 30 days", d31_60: "31 to 60 days", d61_90: "61 to 90 days", d90_plus: "Over 90 days" };
export function ageBucket(dueDate: string | null, today: string): AgeBucket {
  const late = dueDate ? daysBetween(dueDate, today) : 0;
  if (late <= 0) return "current";
  if (late <= 30) return "d1_30";
  if (late <= 60) return "d31_60";
  if (late <= 90) return "d61_90";
  return "d90_plus";
}

/** BAS quarters (Jul to Sep is Q1 of the financial year). */
export function basQuarter(date: string): { from: string; to: string; label: string } {
  const y = +date.slice(0, 4), m = +date.slice(5, 7);
  const qStart = Math.floor((m - 1) / 3) * 3 + 1;
  const from = `${y}-${String(qStart).padStart(2, "0")}-01`;
  const to = addDays(addMonths(from, 3, 1), -1);
  const fy = m >= 7 ? y + 1 : y;
  const q = m >= 7 ? Math.floor((m - 7) / 3) + 1 : Math.floor((m - 1) / 3) + 3;
  return { from, to, label: `Q${q} FY${fy}` };
}

/** GST on a cash basis: the GST share of each payment, rounded per payment. */
export function gstInPayment(paymentCents: number, docTotalCents: number, docGstCents: number): number {
  if (!docTotalCents) return 0;
  return divRound(paymentCents * docGstCents, docTotalCents);
}

export const CURRENCIES = ["AUD", "NZD", "USD", "GBP", "EUR", "SGD", "CAD", "JPY", "INR", "NPR"] as const;

/** BSB is 6 digits shown as 123-456; account numbers 5 to 9 digits. */
export function bsbValid(raw: string | null | undefined): boolean { return /^\d{6}$/.test((raw ?? "").replace(/[\s-]/g, "")); }
export function formatBsb(raw: string | null | undefined): string { const d = (raw ?? "").replace(/[\s-]/g, ""); return /^\d{6}$/.test(d) ? `${d.slice(0, 3)} ${d.slice(3)}` : (raw ?? ""); }
export function accountValid(raw: string | null | undefined): boolean { return /^\d{5,9}$/.test((raw ?? "").replace(/[\s-]/g, "")); }
