/**
 * Tools P2 (16): files a mail attachment into a smart folder from its file name, type and extracted text.
 * Plain rules, no AI: each folder scores signals and the best score above a floor wins; ties go to the
 * earlier folder in PRECEDENCE (an ID or a payslip is never filed as a receipt because it says "paid").
 * False positives cost more than misses here (a wrong folder looks broken), so "other" is the default.
 */
import type { AttachmentFolder } from "@/shared/attachment-folders";

/** Only the start of a document decides its kind (headings, totals and parties sit near the top). */
const TEXT_WINDOW = 20_000;
const FLOOR = 3;
const PRECEDENCE: AttachmentFolder[] = ["id", "payslip", "tax", "statement", "contract", "invoice", "receipt", "quote"];

/** True when the 11 digit number passes the ABN check (modulus 89). */
export function validAbn(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length !== 11) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += (Number(d[i]) - (i === 0 ? 1 : 0)) * w[i];
  return sum % 89 === 0;
}

/** Any ABN with a valid checksum in the text (optionally after "ABN"). */
export function hasAbn(text: string): boolean {
  for (const m of text.matchAll(/\b(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})\b/g)) if (validAbn(m[1])) return true;
  return false;
}

const MONEY = String.raw`(?:aud|a\$|\$|usd|nzd|npr|rs\.?)?\s?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})`;
const has = (s: string, re: RegExp) => re.test(s);

export interface ClassifyInput { filename: string; contentType?: string | null; text: string }

export function classifyAttachment(input: ClassifyInput): AttachmentFolder {
  const name = input.filename.toLowerCase().replace(/[_\-.]+/g, " ");
  const t = input.text.slice(0, TEXT_WINDOW).toLowerCase().replace(/[ \t]+/g, " ");
  const total = has(t, new RegExp(String.raw`\b(?:total|amount due|balance due|total due|grand total|amount payable)\b[^\n]{0,40}?${MONEY}`));
  const abn = hasAbn(t);
  const s: Record<AttachmentFolder, number> = { invoice: 0, receipt: 0, quote: 0, contract: 0, statement: 0, id: 0, payslip: 0, tax: 0, other: 0 };

  // Invoices: "tax invoice" with an ABN and a total is the Australian form (GST law); "invoice" plus a number or total.
  if (has(t, /\btax invoice\b/)) s.invoice += 3;
  else if (has(t, /\binvoice\b/)) s.invoice += 1;
  if (has(t, /\binvoice (?:no|number|#|date)\b/)) s.invoice += 1;
  if (abn) s.invoice += 1;
  if (total) s.invoice += 1;
  if (has(t, /\b(?:due date|payment terms|bsb)\b/)) s.invoice += 1;
  if (has(name, /\binvoice\b|\binv\s?\d/)) s.invoice += 2;

  // Receipts: proof of a payment already made.
  if (has(t, /\b(?:receipt|tax receipt|payment receipt)\b/)) s.receipt += 3;
  if (has(t, /\b(?:amount paid|payment received|paid with|thank you for your (?:purchase|payment|order)|paid on|transaction id|card ending)\b/)) s.receipt += 2;
  if (total) s.receipt += 1;
  if (has(name, /\breceipt\b/)) s.receipt += 2;
  if (has(t, /\bbalance due\b|\bamount due\b/)) s.receipt -= 1;

  // Quotes and estimates.
  if (has(t, /\b(?:quotation|quote (?:no|number|#)|estimate (?:no|number|#)|proposal)\b/)) s.quote += 3;
  else if (has(t, /\b(?:quote|estimate)\b/)) s.quote += 1;
  if (has(t, /\b(?:valid (?:until|for)|this quote|quote valid|expires on)\b/)) s.quote += 2;
  if (total) s.quote += 1;
  if (has(name, /\b(?:quote|quotation|estimate)\b/)) s.quote += 2;

  // Contracts: agreement or terms, plus signature lines.
  const agreement = has(t, /\b(?:agreement|contract|terms and conditions|deed of|lease)\b/);
  const signLines = has(t, /\b(?:signature|signed by|executed by|witness|authorised signatory|signed for and on behalf)\b/) || has(t, /_{8,}/);
  if (agreement) s.contract += 2;
  if (signLines) s.contract += 1;
  if (agreement && signLines) s.contract += 1;
  if (has(t, /\b(?:the parties|hereinafter|whereas|governing law|termination)\b/)) s.contract += 1;
  if (has(name, /\b(?:agreement|contract|lease|nda|terms)\b/)) s.contract += 2;

  // Statements: account or bank statements.
  if (has(t, /\b(?:statement of account|account statement|bank statement|credit card statement|statement period)\b/)) s.statement += 3;
  else if (has(t, /\bstatement\b/)) s.statement += 1;
  if (has(t, /\bopening balance\b/) && has(t, /\bclosing balance\b/)) s.statement += 2;
  if (has(name, /\bstatement\b/)) s.statement += 2;
  // R69 (QA5 18): a document headed "Statement" with an amount owing is a statement, even when it lists invoices.
  if (has(t.slice(0, 200), /\bstatement\b/) && !has(t.slice(0, 200), /\btax invoice\b/)) s.statement += 3;
  if (has(t, /\b(?:amount owing|balance owing|previous balance|statement date|statement (?:no|number|#)|account summary)\b/)) s.statement += 2;

  // ID documents: passport or licence numbers.
  if (has(t, /\bpassport\b/) && (has(t, /\b(?:passport (?:no|number)|nationality|place of birth|date of expiry)\b/) || has(t, /\b[a-z]{1,2}\d{7}\b/))) s.id += 4;
  if (has(t, /\b(?:driver'?s? licence|driver'?s? license|licence (?:no|number)|license (?:no|number)|card number)\b/) && has(t, /\b(?:date of birth|dob|expiry|class)\b/)) s.id += 4;
  if (has(t, /\bmedicare card\b/) || has(t, /\bproof of age card\b/) || has(t, /\bcitizenship certificate\b/)) s.id += 3;
  if (has(name, /\b(?:passport|licence|license|drivers? id|id card)\b/)) s.id += 2;

  // Payslips.
  if (has(t, /\b(?:payslip|pay slip|pay advice|earnings statement)\b/)) s.payslip += 3;
  if (has(t, /\bgross pay\b|\bgross earnings\b/) && has(t, /\bnet pay\b/)) s.payslip += 2;
  if (has(t, /\b(?:superannuation|super guarantee|payg withholding|ytd)\b/) && has(t, /\b(?:net pay|gross)\b/)) s.payslip += 1;
  if (has(name, /\b(?:payslip|pay slip|pay advice)\b/)) s.payslip += 2;

  // Tax.
  if (has(t, /\b(?:notice of assessment|tax return|income statement|payg payment summary|business activity statement|activity statement|tax file number declaration)\b/)) s.tax += 4;
  if (has(t, /\baustralian taxation office\b/)) s.tax += 1;
  if (has(name, /\b(?:tax return|bas|noa|tax)\b/)) s.tax += 2;

  let best: AttachmentFolder = "other";
  let score = FLOOR - 1;
  for (const f of PRECEDENCE) if (s[f] > score) { best = f; score = s[f]; }
  return score >= FLOOR ? best : "other";
}
