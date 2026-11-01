/**
 * R102 Smart document inbox: detection and matching, pure functions (no database, no network, no AI).
 * - detectFields: dates (Australian day first: 1/11/2026, 01-11-2026, 1 Nov 2026, 1 November 2026, 2026-11-01), the due
 *   date, the total ($1,234.50, AUD 1,234.50, A$), GST, the type and paid words, a sender guess.
 * - ruleMatches: any, all, exact, regex (checked by safePattern, run in chunks inside a time budget), fuzzy.
 * - applyRules: top to bottom; tags add up; for sender, type and folder the first matching rule wins; fields a
 *   person corrected are never changed.
 */
import { DOC_LIMITS, type DocField, type DocFields, type DocMatch, type DocType } from "@/shared/doc-inbox";

// ---------------------------------------------------------------- dates

const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface FoundDate { date: string; index: number }
/** Every date in the text, in reading order. Numeric dates are read day first, as in Australia. */
export function findDates(text: string): FoundDate[] {
  const out: FoundDate[] = [];
  const push = (date: string | null, index: number) => { if (date) out.push({ date, index }); };
  for (const m of text.matchAll(/(?<![\d/.-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d/-])/g)) push(isoDate(+m[1], +m[2], +m[3]), m.index);
  for (const m of text.matchAll(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/.-]?\d)/g)) push(isoDate(+m[3], +m[2], +m[1]), m.index);
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, "gi"))) push(isoDate(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]), m.index);
  for (const m of text.matchAll(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"))) push(isoDate(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]), m.index);
  out.sort((a, b) => a.index - b.index);
  // One date can match two patterns at the same place; keep the first.
  return out.filter((d, i) => i === 0 || d.index !== out[i - 1].index);
}

// ---------------------------------------------------------------- amounts

export interface FoundAmount { cents: number; currency: string; index: number; explicit: boolean }
const CUR_BEFORE: Record<string, string> = { "aud": "AUD", "a$": "AUD", "$": "AUD", "au$": "AUD", "usd": "USD", "us$": "USD", "nzd": "NZD", "nz$": "NZD", "eur": "EUR", "€": "EUR", "gbp": "GBP", "£": "GBP" };
const AMOUNT_RE = /(?<![\w.,/$-])(AUD|AU\$|A\$|US\$|NZ\$|USD|NZD|EUR|GBP|€|£|\$)?\s?(-)?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d{1,9}\.\d{2}|\d{1,9})(?:\s?(AUD|USD|NZD|EUR|GBP))?(?![\d.,/%-]?\d|%|\s?%)/gi;

/** Money amounts in one line: a currency sign, or a value with cents. Plain whole numbers without a sign are not money. */
export function findAmounts(line: string, offset = 0): FoundAmount[] {
  const out: FoundAmount[] = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    const cur = m[1] ?? m[4];
    const n = m[3];
    const hasCents = /\.\d{2}$/.test(n);
    if (!cur && !hasCents) continue;
    // A value with cents right after a day and month ("1.11.2026") is not money; the lookarounds keep most out.
    const cents = Math.round(Number(n.replace(/,/g, "")) * 100) * (m[2] ? -1 : 1);
    if (!Number.isFinite(cents) || Math.abs(cents) > 99_999_999_99) continue;
    out.push({ cents, currency: cur ? CUR_BEFORE[cur.toLowerCase()] ?? cur.toUpperCase() : "AUD", index: offset + m.index, explicit: !!cur });
  }
  return out;
}

// ---------------------------------------------------------------- fields

const TOTAL_STRONG = /\b(amount due|balance due|total due|amount payable|total payable|balance owing|please pay)\b/i;
const TOTAL_WEAK = /\b(grand total|total amount|total(?: inc(?:l(?:uding)?)?\.? gst)?|amount paid|total paid|total aud|amount)\b/i;
const SUBTOTAL = /\bsub\s?-?total\b/i;
const GST_LINE = /\bgst\b/i;
const INC_GST = /\b(inc|incl|including|includes)\.?\s+gst\b/i;

const TAX_WORDS = /notice of assessment|payment summary|income statement|tax return|business activity statement|\bbas\b|australian taxation office|\bato\b|\bpayg\b|tax file number/i;
const RECEIPT_WORD = /\breceipt\b/i;
const PAID_WORDS = /\bpaid\b|payment received|paid in full|thank you for your payment/i;
const BILL_WORDS = /tax invoice|\binvoice\b|amount due|balance due|due date|please pay|\bbill\b|pay by/i;
const CONTRACT_WORDS = /\bagreement\b|\bcontract\b|\bsigned by\b|terms of engagement/i;
const COMPANY = /\b(pty\.?\s?ltd|pty\.? limited|limited|ltd|inc|llc|group|council|bank|services|co\.)\b/i;

export function detectType(text: string): DocType {
  if (TAX_WORDS.test(text)) return "tax";
  if (RECEIPT_WORD.test(text)) return "receipt";
  if (BILL_WORDS.test(text)) return "bill";
  if (PAID_WORDS.test(text)) return "receipt";
  if (CONTRACT_WORDS.test(text)) return "contract";
  return "other";
}

/** A sender guess from the top of the document: a company line, a "From:" line, or the line before the ABN. */
export function detectSender(text: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12);
  const clean = (s: string) => s.replace(/^(from|supplier|seller|issued by)\s*:?\s*/i, "").slice(0, DOC_LIMITS.sender).trim() || null;
  const from = lines.find((l) => /^(from|supplier|seller|issued by)\s*:/i.test(l));
  if (from) return clean(from);
  const co = lines.find((l) => COMPANY.test(l) && /[a-z]{3}/i.test(l) && l.length <= 80 && !/\b(invoice|receipt|total|abn)\b/i.test(l));
  if (co) return clean(co);
  const abn = lines.findIndex((l) => /\babn\b/i.test(l));
  if (abn > 0 && /[a-z]{3}/i.test(lines[abn - 1]) && !/\b(invoice|receipt|total)\b/i.test(lines[abn - 1])) return clean(lines[abn - 1]);
  return null;
}

export function detectFields(textIn: string): DocFields {
  const text = textIn.slice(0, DOC_LIMITS.textCap);
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) { starts.push(pos); pos += l.length + 1; }
  const lineAmounts = lines.map((l, i) => findAmounts(l, starts[i]));
  const nextAmount = (i: number) => (lineAmounts[i].length ? lineAmounts[i] : lineAmounts[i + 1] && !lines[i + 1]?.match(/[a-z]{4}/i) ? lineAmounts[i + 1] : lineAmounts[i + 1] ?? []);

  let total: FoundAmount | null = null;
  let strongZero = false;
  let gst: FoundAmount | null = null;
  for (let i = 0; i < lines.length && !total; i++) {
    const l = lines[i];
    if (TOTAL_STRONG.test(l) && !SUBTOTAL.test(l)) {
      const a = nextAmount(i);
      if (a.length) { total = a[a.length - 1]; if (total.cents === 0) strongZero = true; }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (GST_LINE.test(l) && !(INC_GST.test(l) && TOTAL_WEAK.test(l)) && !TOTAL_STRONG.test(l)) {
      const a = (lineAmounts[i].length ? lineAmounts[i] : nextAmount(i)).filter((x) => x.cents > 0);
      if (a.length && !gst) gst = a[0];
    }
  }
  if (!total || total.cents === 0) {
    let weak: FoundAmount | null = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (TOTAL_WEAK.test(l) && !SUBTOTAL.test(l) && !(GST_LINE.test(l) && !INC_GST.test(l))) {
        const a = nextAmount(i).filter((x) => x.cents > 0);
        if (a.length) weak = a[a.length - 1];
      }
    }
    if (weak && !total) total = weak;
  }
  if (!total) {
    const all = lineAmounts.flat().filter((a) => a.explicit && a.cents > 0);
    if (all.length) total = all.reduce((m, a) => (a.cents > m.cents ? a : m));
  }
  if (gst && total && gst.cents >= total.cents && total.cents > 0) gst = null;

  const dates = findDates(text);
  const lineOf = (index: number) => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; } return lo; };
  const near = (d: FoundDate) => { const li = lineOf(d.index); return `${lines[li - 1] ?? ""} ${lines[li].slice(0, Math.max(0, d.index - starts[li]))}`.slice(-60); };
  const due = dates.find((d) => /\b(due|pay by|payment by|payable by)\b/i.test(lines[lineOf(d.index)].slice(0, d.index - starts[lineOf(d.index)]) || near(d)));
  const issued = dates.find((d) => d !== due && /\b(invoice date|date of issue|issue date|issued|tax invoice date|date|dated)\b/i.test(lines[lineOf(d.index)].slice(0, d.index - starts[lineOf(d.index)])));
  const docDate = issued ?? dates.find((d) => d !== due) ?? null;

  const type = detectType(text);
  const paid = type === "receipt" || strongZero || (!(total && TOTAL_STRONG.test(lines[lineOf(total.index)] ?? "") && total.cents > 0) && PAID_WORDS.test(text) && type !== "tax");
  return {
    type, sender: detectSender(text), docDate: docDate?.date ?? null, dueDate: due?.date ?? null,
    amount: total ? total.cents : null, gst: gst ? gst.cents : null, currency: total?.currency ?? "AUD", paid,
  };
}

// ---------------------------------------------------------------- matching

/** Lower cased words (letters and digits, any script) of a text, at most `cap` distinct ones. */
export function tokens(text: string, caseSensitive = false, cap = 20_000): Set<string> {
  const s = new Set<string>();
  for (const m of (caseSensitive ? text : text.toLowerCase()).matchAll(/[\p{L}\p{N}]+/gu)) { s.add(m[0]); if (s.size >= cap) break; }
  return s;
}
const patternWords = (p: string, cs: boolean) => [...tokens(p, cs, 30)];

/** Why a pattern is refused, or null when it is safe to run: too long, does not compile, back references, nested repeats. */
export function patternProblem(match: DocMatch, pattern: string): string | null {
  const p = pattern.trim();
  if (!p) return "Add the words to look for.";
  if (p.length > DOC_LIMITS.pattern) return `Keep it under ${DOC_LIMITS.pattern} characters.`;
  if (match !== "regex") return patternWords(p, false).length ? null : "Add at least one word with letters or numbers.";
  if (/\\[1-9]|\\k</.test(p)) return "Patterns cannot refer back to an earlier group.";
  // A repeated group that itself repeats or has choices inside ("(a+)+", "(a|ab)*") can take forever on some text.
  const stripped = p.replace(/\\./g, "x").replace(/\[[^\]]*\]/g, "x");
  for (const g of stripped.matchAll(/\(([^()]*)\)\s*([*+]|\{\d*,?\d*\})/g)) {
    if (/[*+}]/.test(g[1]) || g[1].includes("|")) return "This pattern repeats a group that repeats. Simplify it.";
  }
  if (/\([^()]*\([^()]*[*+][^()]*\)[^()]*\)\s*[*+{]/.test(stripped)) return "This pattern repeats a group that repeats. Simplify it.";
  try { new RegExp(p, "u"); } catch { return "This pattern is not valid."; }
  return null;
}

const typoBudget = (w: string) => (w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0);
/** Edit distance up to max (answers max + 1 when it is more). */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export interface MatchRule { match: DocMatch; pattern: string; caseSensitive: boolean }
export interface MatchCtx { text: string; lower?: string; tokens?: Set<string>; tokensCs?: Set<string>; now?: () => number }

/** Does the rule match the text? A pattern that is refused or runs out of time does not match. */
export function ruleMatches(rule: MatchRule, ctx: MatchCtx): boolean {
  const cs = rule.caseSensitive;
  const p = rule.pattern.trim();
  if (patternProblem(rule.match, p)) return false;
  const text = ctx.text;
  const toks = () => (cs ? (ctx.tokensCs ??= tokens(text, true)) : (ctx.tokens ??= tokens(text, false)));
  switch (rule.match) {
    case "any": return patternWords(p, cs).some((w) => toks().has(w));
    case "all": return patternWords(p, cs).every((w) => toks().has(w));
    case "exact": {
      const norm = (s: string) => s.replace(/\s+/g, " ");
      const hay = cs ? norm(text) : (ctx.lower ??= norm(text.toLowerCase()));
      return hay.includes(norm(cs ? p : p.toLowerCase()));
    }
    case "fuzzy": {
      const t = [...toks()];
      return patternWords(p, cs).every((w) => {
        const max = typoBudget(w);
        if (toks().has(w)) return true;
        if (max === 0) return false;
        return t.some((x) => editDistance(w, x, max) <= max);
      });
    }
    case "regex": {
      const re = new RegExp(p, cs ? "u" : "iu");
      const now = ctx.now ?? (() => Date.now());
      const started = now();
      const step = DOC_LIMITS.regexChunk;
      const overlap = Math.min(DOC_LIMITS.pattern, step / 2);
      for (let i = 0; i < text.length || i === 0; i += step) {
        if (re.test(text.slice(Math.max(0, i - overlap), i + step))) return true;
        if (now() - started > DOC_LIMITS.regexBudgetMs) return false;
        if (i + step >= text.length) break;
      }
      return false;
    }
  }
  return false;
}

export interface ApplyRule extends MatchRule { id: string; enabled: boolean; position: number; setTags: string[]; setSender: string | null; setType: DocType | null; setFolderId: string | null }
export interface RuleOutcome { applied: string[]; tags: string[]; sender?: string; type?: DocType; folderId?: string }

/** Runs the enabled rules top to bottom. Tags add up; sender, type and folder come from the first matching rule that sets them, unless a person corrected that field. */
export function applyRules(rules: ApplyRule[], text: string, edited: ReadonlySet<DocField>, now?: () => number): RuleOutcome {
  const ctx: MatchCtx = { text, now };
  const out: RuleOutcome = { applied: [], tags: [] };
  for (const r of [...rules].filter((x) => x.enabled).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))) {
    if (!ruleMatches(r, ctx)) continue;
    out.applied.push(r.id);
    for (const t of r.setTags) if (!out.tags.includes(t)) out.tags.push(t);
    if (r.setSender && out.sender === undefined && !edited.has("sender")) out.sender = r.setSender;
    if (r.setType && out.type === undefined && !edited.has("type")) out.type = r.setType;
    if (r.setFolderId && out.folderId === undefined) out.folderId = r.setFolderId;
  }
  return out;
}
