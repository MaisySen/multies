/**
 * TD10 (CRM_TD10): rules that read mail for CRM suggestions, and the saved analysis templates.
 * Pure functions, shared by the server and the web app. Nothing here keeps or returns message text:
 * a signature becomes a few short fields, a phrase becomes a reason code and a due date.
 */

export interface SignatureFields { name?: string; title?: string; company?: string; phone?: string }

const CLOSING = /^(?:kind |best |warm |many |with )?(?:regards|thanks|thank you|thanks again|cheers|best|best wishes|sincerely|yours sincerely|yours truly|talk soon|speak soon)[,.!]*$/i;
const QUOTE_START = /^(?:>|on .{4,120} wrote:?$|-{2,}\s*original message\s*-{2,}|from:\s.+|sent from my )/i;
const ROLE = /\b(?:founder|co-?founder|ceo|cto|cfo|coo|cmo|chief\b.*officer|president|vice president|vp\b|director|manager|head of|lead\b|officer|partner|owner|principal|engineer|developer|designer|consultant|accountant|advisor|adviser|analyst|coordinator|specialist|executive|administrator|associate|assistant|architect|producer|editor|recruiter|sales\b|marketing\b|operations\b|bookkeeper|solicitor|lawyer|agent)\b/i;
const COMPANY = /\b(?:pty\.? ltd\.?|pty limited|ltd\.?|limited|inc\.?|llc|l\.l\.c\.|gmbh|plc|corp\.?|corporation|co\.|group|studio|studios|agency|partners|holdings|solutions|consulting|labs?)$/i;
const PHONE = /(?:^|[\s:])(\+?\(?\d[\d\s().-]{6,18}\d)(?=\s|$)/;
const PHONE_LABEL = /^(?:p|ph|phone|t|tel|telephone|m|mob|mobile|c|cell|w|work|direct|office)\s*[:.]?\s*/i;
const NOISE = /(?:@|https?:|www\.|\.(?:com|au|org|net|io|si)\b|unsubscribe|confidential|disclaimer|privacy|linkedin|twitter|facebook|instagram)/i;
const NAME = /^[A-Z][a-zA-Z'’]+(?:[ -][A-Z][a-zA-Z'’]+){1,3}$/;

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** The new part of a message: everything above the first quoted reply. */
export function newPart(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n").slice(0, 400)) {
    const line = raw.trim();
    if (QUOTE_START.test(line)) break;
    out.push(line);
  }
  return out;
}

export function digitsOf(phone: string) { return phone.replace(/\D/g, ""); }

function phoneIn(line: string): string | undefined {
  const m = PHONE.exec(line.replace(PHONE_LABEL, " "));
  if (!m) return undefined;
  const d = digitsOf(m[1]);
  if (d.length < 8 || d.length > 15) return undefined;
  if (/^(?:19|20)\d{2}$/.test(d.slice(0, 4)) && d.length === 8 && !/\s/.test(m[1])) return undefined; // a date like 20261102
  return clip(m[1], 24);
}

/** Reads a sign off: the lines after a closing word (or a "-- " line), at most 8. Returns only what it is sure of. */
export function parseSignature(text: string): SignatureFields {
  const lines = newPart(text);
  let start = -1;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 25; i--) {
    if (lines[i] === "--" || lines[i] === "-- " || CLOSING.test(lines[i])) { start = i + 1; break; }
  }
  if (start < 0) return {};
  const block = lines.slice(start).filter(Boolean).slice(0, 8);
  const out: SignatureFields = {};
  block.forEach((line, i) => {
    const phone = phoneIn(line);
    if (phone) { out.phone ??= phone; return; }
    if (NOISE.test(line) || line.length > 80) return;
    const parts = line.split(/\s*(?:\||,|·|•| at | @ )\s*/).filter(Boolean);
    if (i === 0 && !out.name && NAME.test(line) && !ROLE.test(line) && !COMPANY.test(line)) { out.name = clip(line, 60); return; }
    for (const p of parts) {
      if (!out.title && ROLE.test(p) && p.length <= 60 && !/\d{3}/.test(p)) { out.title = clip(p, 60); continue; }
      if (!out.company && COMPANY.test(p) && p.length <= 60) out.company = clip(p, 60);
    }
  });
  return out;
}

export const NEXT_REASONS = ["follow_up", "call", "meet", "send"] as const;
export type NextReason = (typeof NEXT_REASONS)[number];
export interface NextStepHit { reason: NextReason; due: string; when: string }

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const VERB: [RegExp, NextReason][] = [
  [/\b(?:call|ring|phone)\b/i, "call"],
  [/\b(?:meet|meeting|catch up|coffee|lunch|sit down)\b/i, "meet"],
  [/\b(?:send|share|forward)\b.{0,40}\b(?:proposal|quote|contract|invoice|deck|details|draft|document|agreement|it|them)\b/i, "send"],
  [/\b(?:follow up|follow-up|get back|circle back|touch base|reconnect|talk|chat|speak|check in|hear back|revisit)\b/i, "follow_up"],
];

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));

/** POL2 (HQ MB-344): the calendar day a moment falls on in a time zone, as a UTC midnight (UTC when the zone is unknown). */
export function localDay(at: Date, zone?: string | null): Date {
  if (zone) {
    try {
      const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
      const get = (k: string) => Number(p.find((x) => x.type === k)?.value);
      const y = get("year"), m = get("month"), d = get("day");
      if (y && m && d) return new Date(Date.UTC(y, m - 1, d));
    } catch { /* an unknown zone counts in UTC */ }
  }
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** A time phrase near a next step verb, as a due date counted from the day the message was sent where the workspace is
 * (POL2, HQ MB-344: a Tuesday morning mail in Sydney is still Monday in UTC, so "next Tuesday" read as today). */
export function parseWhen(s: string, at: Date, zone?: string | null): { due: string; when: string } | null {
  const t = s.toLowerCase();
  const base = localDay(at, zone);
  if (/\btomorrow\b/.test(t)) return { due: ymd(addDays(base, 1)), when: "tomorrow" };
  if (/\b(?:later )?today\b|\bthis afternoon\b/.test(t)) return { due: ymd(base), when: "today" };
  if (/\bnext week\b/.test(t)) { const dow = base.getUTCDay(); return { due: ymd(addDays(base, ((8 - dow) % 7) || 7)), when: "next week" }; }
  if (/\bnext month\b/.test(t)) return { due: ymd(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1))), when: "next month" };
  if (/\bend of (?:the )?week\b/.test(t)) { const dow = base.getUTCDay(); return { due: ymd(addDays(base, ((5 - dow + 7) % 7) || 7)), when: "end of the week" }; }
  const inN = /\bin (\d{1,2}|a|one|two|three) (day|days|week|weeks)\b/.exec(t);
  if (inN) {
    const n = ({ a: 1, one: 1, two: 2, three: 3 } as Record<string, number>)[inN[1]] ?? Number(inN[1]);
    const days = inN[2].startsWith("week") ? n * 7 : n;
    if (days >= 1 && days <= 90) return { due: ymd(addDays(base, days)), when: `in ${days} days` };
  }
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(t) ?? /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})(?:st|nd|rd|th)?\b/.exec(t);
  if (dm) {
    const [dayS, monS] = /^\d/.test(dm[1]) ? [dm[1], dm[2]] : [dm[2], dm[1]];
    const mon = MONTHS.indexOf(monS.slice(0, 3)); const day = Number(dayS);
    if (mon >= 0 && day >= 1 && day <= 31) {
      let d = new Date(Date.UTC(base.getUTCFullYear(), mon, day));
      if (d.getUTCMonth() !== mon) return null;
      if (d < base) d = new Date(Date.UTC(base.getUTCFullYear() + 1, mon, day));
      if ((d.getTime() - base.getTime()) / 86_400_000 > 180) return null;
      return { due: ymd(d), when: `${day} ${MONTHS[mon][0].toUpperCase()}${MONTHS[mon].slice(1)}` };
    }
  }
  const dn = /\b(?:on |this |next |by )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(t);
  if (dn) {
    const target = DAYS.indexOf(dn[1]);
    const diff = (target - base.getUTCDay() + 7) % 7 || 7;
    return { due: ymd(addDays(base, diff)), when: dn[1][0].toUpperCase() + dn[1].slice(1) };
  }
  return null;
}

/** The first sentence in the new part that pairs a next step verb with a time. */
export function findNextStep(text: string, at: Date, zone?: string | null): NextStepHit | null {
  const body = newPart(text).join(" ").slice(0, 6000);
  for (const sentence of body.split(/(?<=[.!?])\s+/).slice(0, 80)) {
    if (sentence.length > 400) continue;
    const verb = VERB.find(([re]) => re.test(sentence));
    if (!verb) continue;
    const w = parseWhen(sentence, at, zone);
    if (w) return { reason: verb[1], ...w };
  }
  return null;
}

export function nextStepTitle(reason: NextReason, who: string) {
  const name = who.trim() || "them";
  if (reason === "call") return `Call ${name}`;
  if (reason === "meet") return `Meet ${name}`;
  if (reason === "send") return `Send ${name} what they asked for`;
  return `Follow up with ${name}`;
}

export const SUGGESTION_KINDS = ["contact_details", "new_contact", "last_contacted", "next_step"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/* Saved analyses */

export const ANALYSIS_TEMPLATES = ["pipeline_by_stage", "revenue_by_month", "time_by_project", "response_rates"] as const;
export type AnalysisTemplate = (typeof ANALYSIS_TEMPLATES)[number];
export const ANALYSIS_PERIODS = [7, 30, 90, 365, 0] as const;
export type AnalysisFilterKey = "days" | "owner" | "person" | "project" | "stage" | "billable";
export interface AnalysisFilters { days?: number; owner?: string; person?: string; project?: string; stage?: string; billable?: "yes" | "no" }

export const TEMPLATE_INFO: Record<AnalysisTemplate, { title: string; blurb: string; filters: AnalysisFilterKey[]; defaultDays: number; chart: "bar" | "line" }> = {
  pipeline_by_stage: { title: "Pipeline by stage", blurb: "Value of deals in each stage.", filters: ["days", "owner"], defaultDays: 0, chart: "bar" },
  revenue_by_month: { title: "Revenue by month", blurb: "Won deals by the month they closed.", filters: ["days", "owner"], defaultDays: 365, chart: "bar" },
  time_by_project: { title: "Time by project", blurb: "Hours logged on each project.", filters: ["days", "person", "project", "billable"], defaultDays: 30, chart: "bar" },
  response_rates: { title: "Response rates", blurb: "Share of incoming mail that got a reply, by month.", filters: ["days"], defaultDays: 90, chart: "line" },
};

export function periodLabel(days: number) { return days ? (days === 365 ? "Last 12 months" : `Last ${days} days`) : "All time"; }

/** POL2 (HQ MB-330): a YYYY-MM-DD day for people ("Thu 5 Nov"), the raw text when it is not a day. */
export function dayLabel(ymdText: string | undefined | null): string {
  if (!ymdText || !/^\d{4}-\d{2}-\d{2}$/.test(ymdText)) return ymdText ?? "";
  const d = new Date(`${ymdText}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymdText;
  return d.toLocaleDateString("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
}
