/**
 * R92 Booking plus: rules shared by the server and the web app (resources, time polls, event tickets).
 */
export const RESOURCE_KINDS = ["room", "desk", "vehicle", "equipment"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const RESOURCE_KIND_LABEL: Record<ResourceKind, string> = { room: "Room", desk: "Desk", vehicle: "Vehicle", equipment: "Equipment" };
export const WEEK_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];
export const STEP_CHOICES = [15, 30, 60] as const;

export const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
export function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
export function fromMinutes(n: number): string {
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

export interface ResourceRules {
  days: WeekDay[];
  openFrom: string;
  openTo: string;
  stepMin: number;
  minMin: number;
  maxMin: number;
}

/** Why a booking on a day (local minutes since midnight) breaks the resource's rules, or null when it fits. */
export function ruleProblem(r: ResourceRules, day: WeekDay, startMin: number, endMin: number): string | null {
  if (!r.days.includes(day)) return "This is closed on that day.";
  if (endMin <= startMin) return "The end must be after the start.";
  const open = toMinutes(r.openFrom), close = toMinutes(r.openTo);
  if (startMin < open || endMin > close) return `Book between ${r.openFrom} and ${r.openTo}.`;
  if ((startMin - open) % r.stepMin !== 0 || (endMin - open) % r.stepMin !== 0) return `Times move in steps of ${r.stepMin} minutes.`;
  const len = endMin - startMin;
  if (len < r.minMin) return `The shortest booking is ${durationLabel(r.minMin)}.`;
  if (len > r.maxMin) return `The longest booking is ${durationLabel(r.maxMin)}.`;
  return null;
}

/** Checks the settings an admin saves. */
export function rulesProblem(r: ResourceRules): string | null {
  if (!r.days.length) return "Pick at least one open day.";
  if (!hhmm.test(r.openFrom) || !hhmm.test(r.openTo)) return "Enter times like 09:00.";
  const span = toMinutes(r.openTo) - toMinutes(r.openFrom);
  if (span <= 0) return "Closing time must be after opening time.";
  if (span % r.stepMin !== 0) return `Opening hours must fit steps of ${r.stepMin} minutes.`;
  if (r.minMin % r.stepMin !== 0 || r.maxMin % r.stepMin !== 0) return `Lengths must be steps of ${r.stepMin} minutes.`;
  if (r.minMin < r.stepMin || r.maxMin < r.minMin) return "The longest booking must be at least the shortest.";
  if (r.minMin > span) return "The shortest booking is longer than the opening hours.";
  return null;
}

export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

export function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/* Time polls */
export const POLL_ANSWERS = ["yes", "maybe", "no"] as const;
export type PollAnswer = (typeof POLL_ANSWERS)[number];
export const POLL_ANSWER_LABEL: Record<PollAnswer, string> = { yes: "Yes", maybe: "If need be", no: "No" };
export const POLL_MAX_OPTIONS = 30;
export const POLL_MAX_VOTES = 200;

export interface PollTotal { optionId: string; yes: number; maybe: number; no: number; score: number }
/** Yes counts 2 and If need be counts 1; ties go to fewer No answers, then the earlier time. */
export function pollTotals(optionIds: string[], votes: { answers: Record<string, PollAnswer> }[]): PollTotal[] {
  return optionIds.map((optionId) => {
    const t = { optionId, yes: 0, maybe: 0, no: 0, score: 0 };
    for (const v of votes) {
      const a = v.answers[optionId];
      if (a === "yes") t.yes++; else if (a === "maybe") t.maybe++; else if (a === "no") t.no++;
    }
    t.score = t.yes * 2 + t.maybe;
    return t;
  });
}
export function bestOption(totals: PollTotal[]): string | null {
  let best: PollTotal | null = null;
  for (const t of totals) {
    if (t.yes + t.maybe === 0) continue;
    if (!best || t.score > best.score || (t.score === best.score && t.no < best.no)) best = t;
  }
  return best?.optionId ?? null;
}

/* Event tickets */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function makeTicketCode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}
/** Shown with a space in the middle so it is easy to read out. */
export function formatTicketCode(code: string): string {
  const c = normaliseTicketCode(code);
  return c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4)}` : c;
}
export function normaliseTicketCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/I/g, "1").slice(0, 8);
}
/** Reads what a scanner saw: a ticket link (/book/ticket/<id>?c=<code>) or a typed code. */
export function readScan(text: string): { ticketId: string | null; code: string } | null {
  const t = text.trim();
  const m = t.match(/\/book\/ticket\/([A-Za-z0-9_]+)\?(?:.*&)?c=([A-Za-z0-9]+)/);
  if (m) return { ticketId: m[1], code: normaliseTicketCode(m[2]) };
  const code = normaliseTicketCode(t);
  return code.length === 8 ? { ticketId: null, code } : null;
}
export const EVENT_MAX_CAPACITY = 5000;

/** CSV cell, quoted, with formula characters made safe for spreadsheets. */
export function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
