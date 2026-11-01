/**
 * R106: expenses and receipts, shared rules (server and web). Money is integer cents. GST in a GST inclusive amount is
 * one eleventh, rounded half away from zero with R105's divRound. A GST credit on a purchase over A$82.50 including GST
 * needs a tax invoice that shows the supplier's ABN, so such receipts without a valid ABN are flagged.
 */
import { abnValid, divRound } from "./invoices";

export const GST_INVOICE_THRESHOLD_CENTS = 8_250; // A$82.50 including GST
export const EXPENSE_MAX_CENTS = 99_999_999_99; // just under A$100 million
export const MAX_SPLITS = 10;
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
export const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"] as const;
export const EXPENSE_CATEGORIES = ["Travel", "Fuel", "Meals", "Accommodation", "Office supplies", "Software", "Phone and internet", "Utilities", "Professional services", "Other"] as const;
export type ExpenseStatus = "draft" | "submitted" | "approved" | "rejected";
export type ExpenseSource = "upload" | "camera" | "email";
export type ReadState = "none" | "reading" | "done" | "failed" | "unavailable";
export const EVERY = ["week", "month", "quarter", "year"] as const;
export type Every = (typeof EVERY)[number];
export const EVERY_LABEL: Record<Every, string> = { week: "Every week", month: "Every month", quarter: "Every quarter", year: "Every year" };
export const STATUS_LABEL: Record<ExpenseStatus, string> = { draft: "Draft", submitted: "Waiting for approval", approved: "Approved", rejected: "Rejected" };

export interface Split { category: string; amountCents: number; gstCents?: number; note?: string | null }

/** GST included in a GST inclusive total (one eleventh). */
export function gstOfTotal(totalCents: number): number {
  return totalCents > 0 ? divRound(totalCents, 11) : 0;
}

/** True when the receipt needs a tax invoice with an ABN before GST can be claimed and has no valid ABN. */
export function needsTaxInvoice(totalCents: number | null | undefined, abn: string | null | undefined): boolean {
  return (totalCents ?? 0) > GST_INVOICE_THRESHOLD_CENTS && !abnValid(abn);
}

/** Whether GST can be claimed: a GST amount above zero and, over the threshold, a valid ABN. */
export function canClaimGst(totalCents: number | null | undefined, gstCents: number | null | undefined, abn: string | null | undefined): boolean {
  return (gstCents ?? 0) > 0 && !needsTaxInvoice(totalCents, abn);
}

export type SplitProblem = "too_many" | "empty_category" | "bad_amount" | "sum_mismatch";
export const SPLIT_PROBLEM_TEXT: Record<SplitProblem, string> = {
  too_many: `Split into ${MAX_SPLITS} parts at most.`,
  empty_category: "Choose a category for each part.",
  bad_amount: "Each part needs an amount above zero.",
  sum_mismatch: "The parts must add up to the total.",
};

export function splitProblems(totalCents: number, splits: Split[]): SplitProblem[] {
  if (!splits.length) return [];
  const out: SplitProblem[] = [];
  if (splits.length > MAX_SPLITS) out.push("too_many");
  if (splits.some((s) => !s.category.trim())) out.push("empty_category");
  if (splits.some((s) => !Number.isSafeInteger(s.amountCents) || s.amountCents <= 0)) out.push("bad_amount");
  else if (splits.reduce((n, s) => n + s.amountCents, 0) !== totalCents) out.push("sum_mismatch");
  return out;
}

/** GST shared across the parts in proportion to their amounts; the last part takes the rounding so the parts add up. */
export function splitGst(gstCents: number, totalCents: number, splits: Split[]): Split[] {
  if (!splits.length) return [];
  let left = gstCents;
  return splits.map((s, i) => {
    const g = i === splits.length - 1 ? left : totalCents > 0 ? divRound(gstCents * s.amountCents, totalCents) : 0;
    left -= g;
    return { ...s, gstCents: g };
  });
}

/** Net (ex GST) of an expense: what is re billed on an exclusive invoice. */
export const netOf = (totalCents: number, gstCents: number) => totalCents - gstCents;

/** Next expected date for a repeating expense, from the last one. */
export function nextExpected(last: string, every: Every): string {
  const d = new Date(`${last}T00:00:00Z`);
  if (every === "week") d.setUTCDate(d.getUTCDate() + 7);
  else {
    const months = every === "month" ? 1 : every === "quarter" ? 3 : 12;
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, end));
  }
  return d.toISOString().slice(0, 10);
}

export const perYear = (cents: number, every: Every) => cents * (every === "week" ? 52 : every === "month" ? 12 : every === "quarter" ? 4 : 1);

/** Guess how often a supplier repeats from its dates (ISO, any order): null unless 2 or more fall about one period apart. */
export function guessEvery(dates: string[]): Every | null {
  const ds = [...new Set(dates)].sort();
  if (ds.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < ds.length; i++) gaps.push((Date.parse(ds[i]) - Date.parse(ds[i - 1])) / 86_400_000);
  const near = (g: number, d: number, tol: number) => Math.abs(g - d) <= tol;
  if (gaps.every((g) => near(g, 7, 1))) return "week";
  if (gaps.every((g) => near(g, 30.4, 4))) return "month";
  if (gaps.every((g) => near(g, 91, 8))) return "quarter";
  if (gaps.every((g) => near(g, 365, 10))) return "year";
  return null;
}

/** One CSV field: quoted when needed, and a leading = + - @ is made safe for spreadsheet apps. */
export function csvCell(v: string | number | boolean | null | undefined): string {
  let s = v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const centsCsv = (c: number) => (c / 100).toFixed(2);

export interface CsvExpense {
  spentOn: string | null; supplier: string | null; supplierAbn: string | null; category: string | null; totalCents: number; gstCents: number; gstClaimable: boolean;
  status: ExpenseStatus; userName: string; note: string | null; currency: string; reimbursable: boolean; splits: Split[]; rebilled: boolean;
}
export const CSV_HEADER = ["Date", "Supplier", "Supplier ABN", "Category", "Amount", "GST", "GST claimable", "Currency", "Status", "Person", "Reimburse", "Re billed", "Note"];

/** The accountant's CSV: one row per expense, or one row per part when it is split. */
export function expensesCsv(rows: CsvExpense[]): string {
  const lines = [CSV_HEADER.map(csvCell).join(",")];
  for (const r of rows) {
    const parts = r.splits.length ? splitGst(r.gstCents, r.totalCents, r.splits).map((s) => ({ category: s.category, amount: s.amountCents, gst: s.gstCents ?? 0, note: s.note || r.note }))
      : [{ category: r.category ?? "Other", amount: r.totalCents, gst: r.gstCents, note: r.note }];
    for (const p of parts) {
      lines.push([r.spentOn, r.supplier, r.supplierAbn, p.category, centsCsv(p.amount), centsCsv(p.gst), r.gstClaimable, r.currency, STATUS_LABEL[r.status], r.userName,
        r.reimbursable, r.rebilled, p.note].map(csvCell).join(","));
    }
  }
  return lines.join("\r\n") + "\r\n";
}

/** The receipts address local part for a workspace token. */
export const receiptsLocal = (token: string) => `receipts.${token}`;
export const RECEIPTS_LOCAL_RE = /^receipts\.([a-z0-9]{10,24})$/;
