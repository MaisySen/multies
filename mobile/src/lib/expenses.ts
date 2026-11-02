/**
 * M2 (1.10.10): Expenses on the phone, the web's R106 expenses (GET /api/expenses, PUT /api/expenses/upload,
 * POST /api/expenses/:id/read and /submit). Pure helpers. Money is integer cents, as on the server.
 */
export type ExpenseStatus = "draft" | "submitted" | "approved" | "rejected" | string;
export interface Expense {
  id: string; own: boolean; status: ExpenseStatus; userName?: string | null; supplier?: string | null; spentOn?: string | null;
  totalCents?: number | null; gstCents?: number | null; currency?: string | null; category?: string | null; note?: string | null;
  hasFile?: boolean; fileName?: string | null; readState?: string | null; rejectReason?: string | null; decidedByName?: string | null; createdAt: string;
}
export interface ExpensesResponse { expenses: Expense[]; next: number | null; waiting: number; canApprove: boolean; canManage: boolean }

export function cents(v: number | null | undefined, currency = "AUD"): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "No total yet";
  try { return new Intl.NumberFormat("en-AU", { style: "currency", currency: currency || "AUD" }).format(v / 100); } catch { return `${currency} ${(v / 100).toFixed(2)}`; }
}

const STATUS: Record<string, { label: string; tone: "neutral" | "brand" | "ok" | "bad" | "warn" }> = {
  draft: { label: "Draft", tone: "neutral" }, submitted: { label: "Waiting for approval", tone: "warn" },
  approved: { label: "Approved", tone: "ok" }, rejected: { label: "Rejected", tone: "bad" },
};
export const statusOf = (s: ExpenseStatus) => STATUS[s] ?? { label: s ? s[0].toUpperCase() + s.slice(1) : "Unknown", tone: "neutral" as const };

/** What to call an expense in a list: the supplier, else the receipt's file name, else a plain word. */
export const expenseTitle = (e: Expense) => e.supplier?.trim() || e.fileName?.trim() || "Receipt";

/** True while the server is still reading a receipt (the fields fill in by themselves). */
export const reading = (e: Expense) => e.readState === "pending" || e.readState === "reading" || e.readState === "queued";

export const canSubmit = (e: Expense) => e.own && (e.status === "draft" || e.status === "rejected") && typeof e.totalCents === "number" && e.totalCents > 0;

/** The upload route for a receipt picked from the phone's files. */
export const receiptUploadPath = (name: string) => `/api/expenses/upload?source=upload&name=${encodeURIComponent((name || "receipt").slice(0, 200))}`;
export const RECEIPT_TYPES = ["image/*", "application/pdf"];
