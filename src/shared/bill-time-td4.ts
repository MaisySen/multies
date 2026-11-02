/**
 * TD4: time to invoice. The money and rounding rules for billing runs, shared by the server and the web app so the
 * preview and the invoice agree to the cent. Money is integer minor units (cents); quantities are hours in thousandths,
 * the same as R105 invoice lines (src/shared/invoices.ts).
 */
import { divRound } from "./invoices";

/** The feature is on: invoices plus BILL_TD4 (server config). */
export function billTimeOn(cfg: { invoicesEnabled?: boolean; billTd4?: boolean }): boolean { return !!cfg.invoicesEnabled && !!cfg.billTd4; }

/** Minutes each entry rounds up to. 0 = exact (whole seconds). */
export const ROUNDINGS = [0, 1, 6, 15, 30] as const;
export type Rounding = (typeof ROUNDINGS)[number];
export const ROUNDING_LABEL: Record<Rounding, string> = { 0: "Exact time", 1: "1 minute", 6: "6 minutes", 15: "15 minutes", 30: "30 minutes" };
/** One sentence stating the rule, shown beside the total. */
export function roundingSentence(r: number): string { return r ? `Each entry is rounded up to ${r === 1 ? "the next minute" : `${r} minutes`}.` : "Exact time, no rounding."; }
export const MAX_RUN_ENTRIES = 500;
export const MAX_RATE_CENTS = 100_000_00; // 100,000 an hour
export const MAX_RUN_DAYS = 366;

/** Seconds after rounding one entry UP to the rule. Never below zero; exact keeps whole seconds. */
export function roundSeconds(seconds: number, rounding: number): number {
  const s = Math.max(0, Math.floor(seconds));
  if (!rounding || s === 0) return s;
  const step = rounding * 60;
  return Math.ceil(s / step) * step;
}

/** Hours in thousandths, rounded half up: 1 h = 1000, 1 min = 17 (16.67). */
export function secondsToQtyMilli(seconds: number): number {
  return divRound(Math.max(0, Math.floor(seconds)) * 1000, 3600);
}

/** The amount before tax for a line, exactly as an R105 invoice line works it out. */
export function lineCents(qtyMilli: number, rateCents: number): number {
  return divRound(qtyMilli * rateCents, 1000);
}

export interface RunEntry { id: string; seconds: number; personKey: string; personName: string; taskKey: string; taskLabel: string; rateCents: number | null }
export interface RunLine { key: string; personKey: string; personName: string; taskKey: string; taskLabel: string; entryIds: string[]; seconds: number; qtyMilli: number; rateCents: number; amountCents: number; missingRate: boolean }
export interface RunTotals { lines: RunLine[]; seconds: number; qtyMilli: number; amountCents: number; entryCount: number; missingRate: boolean }

/**
 * Group entries by person and task. Each entry rounds up first, then a line sums its entries. Entries of one person
 * on one task with different rates (a rate changed mid way) become separate lines so no rate is averaged.
 */
export function groupRun(entries: RunEntry[], rounding: number): RunTotals {
  const map = new Map<string, RunLine>();
  for (const e of entries) {
    const rate = e.rateCents ?? 0;
    const key = `${e.personKey}|${e.taskKey}|${rate}`;
    const l = map.get(key) ?? { key, personKey: e.personKey, personName: e.personName, taskKey: e.taskKey, taskLabel: e.taskLabel, entryIds: [], seconds: 0, qtyMilli: 0, rateCents: rate, amountCents: 0, missingRate: e.rateCents == null };
    l.entryIds.push(e.id);
    l.seconds += roundSeconds(e.seconds, rounding);
    map.set(key, l);
  }
  const lines = [...map.values()].sort((a, b) => a.personName.localeCompare(b.personName) || a.taskLabel.localeCompare(b.taskLabel) || a.rateCents - b.rateCents);
  let seconds = 0, qty = 0, amount = 0, count = 0, missing = false;
  for (const l of lines) {
    l.qtyMilli = secondsToQtyMilli(l.seconds);
    l.amountCents = lineCents(l.qtyMilli, l.rateCents);
    seconds += l.seconds; qty += l.qtyMilli; amount += l.amountCents; count += l.entryIds.length; missing ||= l.missingRate;
  }
  return { lines, seconds, qtyMilli: qty, amountCents: amount, entryCount: count, missingRate: missing };
}

/** Which rate applies: the person on this project, the person anywhere, the project, the workspace. Null when none is set. */
export function pickRate(r: { personProject?: number | null; person?: number | null; project?: number | null; workspace?: number | null }): number | null {
  for (const v of [r.personProject, r.person, r.project, r.workspace]) if (v != null && Number.isSafeInteger(v) && v >= 0) return v;
  return null;
}

/** "12.5 h" style text for hours in thousandths. */
export function hoursText(qtyMilli: number): string {
  return `${Number((qtyMilli / 1000).toFixed(2))} h`;
}

/** The line description written onto the invoice; it states the rounding so the client can see how time was counted. */
export function lineDescription(personName: string, taskLabel: string, from: string, to: string, rounding: number): string {
  const rule = rounding ? `, each entry rounded up to ${rounding} min` : "";
  return `${taskLabel}, ${personName} (${from} to ${to}${rule})`.slice(0, 1000);
}

export function validDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}
