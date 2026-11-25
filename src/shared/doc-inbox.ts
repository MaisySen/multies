/**
 * R102 Smart document inbox (DOC_INBOX_R102): shared types, labels and limits for Files > Documents.
 * Plain words in the UI: "Who sent it" (the sender), "Type" (bill, receipt, tax, contract, other), "To check".
 */

export const DOC_TYPES = ["bill", "receipt", "tax", "contract", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const isDocType = (v: unknown): v is DocType => typeof v === "string" && (DOC_TYPES as readonly string[]).includes(v);
export const DOC_TYPE_LABEL: Record<DocType, string> = { bill: "Bill", receipt: "Receipt", tax: "Tax document", contract: "Contract", other: "Other" };

/** The tabs of Documents. "unpaid" and "tax" are the saved views. */
export const DOC_VIEWS = ["check", "all", "unpaid", "tax", "bills", "receipts"] as const;
export type DocView = (typeof DOC_VIEWS)[number];
export const isDocView = (v: unknown): v is DocView => typeof v === "string" && (DOC_VIEWS as readonly string[]).includes(v);
export const DOC_VIEW_LABEL: Record<DocView, string> = { check: "To check", all: "All", unpaid: "Unpaid bills", tax: "Tax documents", bills: "Bills", receipts: "Receipts" };

export const DOC_MATCH = ["any", "all", "exact", "regex", "fuzzy"] as const;
export type DocMatch = (typeof DOC_MATCH)[number];
export const isDocMatch = (v: unknown): v is DocMatch => typeof v === "string" && (DOC_MATCH as readonly string[]).includes(v);
export const DOC_MATCH_LABEL: Record<DocMatch, string> = {
  any: "Any of these words", all: "All of these words", exact: "This exact phrase", regex: "A pattern (advanced)", fuzzy: "Close matches (small typos are fine)",
};

/** queued: waiting to be read (also when today's limit is reached); reading: the engine has it; done; failed; skipped (cannot be read). */
export type DocStatus = "queued" | "reading" | "done" | "failed" | "skipped";
export type DocField = "type" | "sender" | "docDate" | "dueDate" | "amount" | "gst" | "paid";

export const DOC_LIMITS = {
  /** Documents read per workspace per UTC day (engine and on the Worker). Over it they wait for the next day. */
  dailyPerWorkspace: 60,
  /** Documents read per UTC day, all workspaces. */
  dailyGlobal: 600,
  /** Engine jobs started per cron pass, and finished jobs collected when someone opens Documents. */
  submitPerPass: 4,
  collectOnOpen: 2,
  /** Bigger files are not read. */
  maxReadBytes: 15 * 1024 * 1024,
  /** Characters of text kept per document. */
  textCap: 200_000,
  rules: 50,
  ruleName: 80,
  pattern: 200,
  /** Time a regex rule may spend on one document, in ms, checked before each chunk (Review Z3: 1,000 characters). */
  regexBudgetMs: 50,
  regexChunk: 1_000,
  page: 50,
  sender: 120,
  maxTries: 2,
  /** An engine job not done after this is tried again (engine jobs expire within an hour). */
  jobTimeoutMs: 50 * 60_000,
} as const;

export interface DocFields {
  type: DocType | null;
  sender: string | null;
  /** YYYY-MM-DD */
  docDate: string | null;
  dueDate: string | null;
  /** Cents. */
  amount: number | null;
  gst: number | null;
  currency: string;
  paid: boolean;
}

export interface DocRow {
  id: string;
  name: string;
  contentType: string | null;
  sizeBytes: number;
  space: "team" | "private" | "brand";
  status: DocStatus;
  /** True when the row waits only because today's reading limit is reached. */
  capped: boolean;
  source: "upload" | "mail";
  fields: DocFields;
  /** Fields a person corrected (rules never change them). */
  edited: DocField[];
  checked: boolean;
  tags: string[];
  addedAt: string;
  readAt: string | null;
  canEdit: boolean;
  snippet?: string;
}

export interface DocDetail extends DocRow {
  /** The text found, capped; null when none is kept. */
  text: string | null;
  rulesApplied: { id: string; name: string }[];
  folder: { id: string | null; name: string };
}

export interface DocCounts { check: number; all: number; unpaid: number; tax: number; bills: number; receipts: number; waiting: number; capped: boolean }
export interface DocList { items: DocRow[]; counts: DocCounts; next: string | null }

export interface DocRule {
  id: string;
  name: string;
  match: DocMatch;
  pattern: string;
  caseSensitive: boolean;
  setTags: string[];
  setSender: string | null;
  setType: DocType | null;
  setFolderId: string | null;
  setFolderName: string | null;
  position: number;
  enabled: boolean;
  updatedAt: string;
}

export function centsLabel(cents: number | null, currency = "AUD"): string {
  if (cents === null || !Number.isFinite(cents)) return "";
  const v = (cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "AUD" ? `$${v}` : `${currency} ${v}`;
}

/** "12.50", "$1,234.50" or "1234" typed by a person, as cents; null when empty; NaN when it is not an amount. */
export function parseCentsInput(raw: string): number | null {
  const s = raw.replace(/[\s$,]|AUD|A\$/gi, "");
  if (!s) return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100);
}
