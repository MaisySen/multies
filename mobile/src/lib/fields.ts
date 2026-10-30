import type { CustomField, FieldValue, PortfolioProject, ProjectHealth } from "@/api/types";
import { LOCALE } from "./format";

/** A field value ready to show: the words, an optional colour per chip, or empty for a dash. */
export interface ShownValue { empty: boolean; text: string; chips?: { label: string; color: string | null }[] }

const EMPTY: ShownValue = { empty: true, text: "-" };
const aud = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "AUD" });
const num = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 6 });

/** Australian dollars with the A$ prefix, the way the web app shows them: A$1,250.00. */
export function formatAud(n: number): string {
  const s = aud.format(n);
  // en-AU writes AUD as a bare "$"; some engines already write "A$".
  return s.includes("A$") ? s : s.replace("$", "A$");
}

/** A calendar date ("2026-10-24") as en-AU: 24 Oct 2026. Read as a plain date, no time zone shift. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Seconds as h:mm, for time logged: 0:00, 3:05, 41:30. */
export function hm(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** Formats one custom field value by its type. Anything empty or of the wrong shape shows as a dash. */
export function showValue(field: CustomField, value: FieldValue | null | undefined, people: { id: string; name: string }[] = []): ShownValue {
  if (value === null || value === undefined || value === "") return EMPTY;
  const option = (id: unknown) => field.options.find((o) => o.id === id);
  switch (field.type) {
    case "text":
    case "url":
      return typeof value === "string" ? { empty: false, text: value } : EMPTY;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? { empty: false, text: num.format(value) } : EMPTY;
    case "currency":
      return typeof value === "number" && Number.isFinite(value) ? { empty: false, text: formatAud(value) } : EMPTY;
    case "date":
      return typeof value === "string" ? { empty: false, text: formatDay(value) } : EMPTY;
    case "checkbox":
      return typeof value === "boolean" ? { empty: false, text: value ? "Yes" : "No" } : EMPTY;
    case "select": {
      const o = option(value);
      return o ? { empty: false, text: o.label, chips: [{ label: o.label, color: o.color }] } : EMPTY;
    }
    case "multiselect": {
      if (!Array.isArray(value)) return EMPTY;
      const chips = value.map(option).filter((o): o is NonNullable<typeof o> => !!o).map((o) => ({ label: o.label, color: o.color }));
      return chips.length ? { empty: false, text: chips.map((c) => c.label).join(", "), chips } : EMPTY;
    }
    case "person": {
      if (typeof value !== "string") return EMPTY;
      const p = people.find((x) => x.id === value);
      return { empty: false, text: p?.name ?? (value.startsWith("agent:") ? "An agent" : "Someone") };
    }
    default:
      return typeof value === "string" || typeof value === "number" ? { empty: false, text: String(value) } : EMPTY;
  }
}

/** The types the phone can edit. The rest are read only here and edited on the web. */
export const EDITABLE: ReadonlySet<CustomField["type"]> = new Set(["text", "number", "currency", "date", "select", "checkbox", "url"]);

/** Reads what someone typed into a number or currency field. Null when it isn't a number. */
export function parseAmount(input: string): number | null {
  const v = input.replace(/[A$,\s]/g, "");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Reads a date typed the Australian way (24/10/2026) or as 2026-10-24. Null when it isn't a real date. */
export function parseDay(input: string): string | null {
  const v = input.trim();
  let y: number, mo: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (au) [d, mo, y] = [Number(au[1]), Number(au[2]), Number(au[3])];
  else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export const HEALTH: Record<ProjectHealth | "none", { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  on_track: { label: "On track", tone: "ok" },
  at_risk: { label: "At risk", tone: "warn" },
  off_track: { label: "Off track", tone: "bad" },
  none: { label: "Not set", tone: "neutral" },
};

/** Live projects first, then by name; archived ones last. */
export function sortPortfolio(list: PortfolioProject[]): PortfolioProject[] {
  return [...list].sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, LOCALE));
}
