/**
 * TD7 Forms pro B, shared by the page and the server: brand kit choices (fixed lists, never free CSS), close date,
 * response cap, save and resume and password settings, import from CSV or pasted questions, the AI draft clean up,
 * and drop off per question from reach counts. No payment field.
 */
import type { FormFieldType } from "./form-logic";

export const BRAND_ACCENTS = ["default", "ocean", "forest", "plum", "coral", "teal", "ink"] as const;
export const BRAND_SURFACES = ["plain", "tinted"] as const;
export const BRAND_FONTS = ["sans", "serif", "mono"] as const;
export const BRAND_LOGOS = ["none", "mark", "wide"] as const;
export type BrandAccent = (typeof BRAND_ACCENTS)[number];
export type BrandSurface = (typeof BRAND_SURFACES)[number];
export type BrandFont = (typeof BRAND_FONTS)[number];
export type BrandLogo = (typeof BRAND_LOGOS)[number];
export const ACCENT_LABELS: Record<BrandAccent, string> = { default: "Multies blue", ocean: "Ocean", forest: "Forest", plum: "Plum", coral: "Coral", teal: "Teal", ink: "Ink" };
export const FONT_LABELS: Record<BrandFont, string> = { sans: "Clean", serif: "Classic", mono: "Typewriter" };

export interface Brand { accent: BrandAccent; surface: BrandSurface; font: BrandFont; logo: BrandLogo }
export interface Td7Settings {
  brand: Brand;
  /** ISO time after which the form takes no answers, or null. */
  closesAt: string | null;
  /** Most answers the form takes in all, or null for no limit. */
  responseCap: number | null;
  /** Shown on the closed page. */
  closedMessage: string;
  /** Lets people save part of the form and come back with a link. */
  saveResume: boolean;
}
export const DEFAULT_BRAND: Brand = { accent: "default", surface: "plain", font: "sans", logo: "none" };
export const DEFAULT_TD7: Td7Settings = { brand: DEFAULT_BRAND, closesAt: null, responseCap: null, closedMessage: "", saveResume: false };
export const MAX_CAP = 1_000_000;
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 128;
export const CLOSED_MESSAGE_MAX = 500;

const pick = <T extends string>(list: readonly T[], v: unknown, d: T): T => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : d);

/** Settings from storage or a request, with anything unknown dropped. Never throws. */
export function parseTd7(raw: unknown): Td7Settings {
  let o: Record<string, unknown> = {};
  if (typeof raw === "string") { try { o = JSON.parse(raw) as Record<string, unknown>; } catch { o = {}; } } else if (raw && typeof raw === "object") o = raw as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) o = {};
  const b = (o.brand && typeof o.brand === "object" ? o.brand : {}) as Record<string, unknown>;
  const brand: Brand = { accent: pick(BRAND_ACCENTS, b.accent, "default"), surface: pick(BRAND_SURFACES, b.surface, "plain"), font: pick(BRAND_FONTS, b.font, "sans"), logo: pick(BRAND_LOGOS, b.logo, "none") };
  let closesAt: string | null = null;
  if (typeof o.closesAt === "string" && o.closesAt) { const t = Date.parse(o.closesAt); if (Number.isFinite(t)) closesAt = new Date(t).toISOString(); }
  let responseCap: number | null = null;
  const cap = typeof o.responseCap === "string" && o.responseCap.trim() ? Number(o.responseCap) : o.responseCap;
  if (typeof cap === "number" && Number.isFinite(cap) && cap >= 1) responseCap = Math.min(MAX_CAP, Math.floor(cap));
  const closedMessage = typeof o.closedMessage === "string" ? o.closedMessage.trim().slice(0, CLOSED_MESSAGE_MAX) : "";
  return { brand, closesAt, responseCap, closedMessage, saveResume: o.saveResume === true };
}

export type ClosedReason = "date" | "cap" | null;
/** Why the form is closed right now, or null when it is open. The server decides with its own clock and count. */
export function closedReason(s: Td7Settings, now: Date, count: number): ClosedReason {
  if (s.closesAt && now.getTime() >= Date.parse(s.closesAt)) return "date";
  if (s.responseCap !== null && count >= s.responseCap) return "cap";
  return null;
}
export const closedText = (s: Td7Settings, reason: ClosedReason) =>
  s.closedMessage || (reason === "cap" ? "This form has all the answers it needs. Thanks for your interest." : "This form is closed and no longer takes answers.");

// ---------------------------------------------------------------- import

export interface ImportedField { id: string; label: string; type: FormFieldType; required: boolean; options?: string[] }
export const IMPORT_MAX_FIELDS = 30;
const IMPORT_TYPES: Record<string, FormFieldType> = {
  text: "text", short: "text", "short text": "text", email: "email", "e-mail": "email", textarea: "textarea", long: "textarea", "long text": "textarea", paragraph: "textarea",
  phone: "phone", tel: "phone", select: "select", choice: "select", dropdown: "select", radio: "select", multiselect: "multiselect", checkboxes: "multiselect", "several choices": "multiselect",
  number: "number", date: "date", rating: "rating",
};
const slugId = (label: string, taken: Set<string>, i: number) => {
  let id = label.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `field_${i + 1}`;
  const base = id; let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`.slice(0, 48);
  taken.add(id);
  return id;
};
/** One CSV line into cells (quotes and doubled quotes as in spreadsheets). */
export function csvCells(line: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"' && !cur.trim()) { q = true; cur = ""; }
    else if (ch === "," ) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
const guessType = (label: string): FormFieldType => /e-?mail/i.test(label) ? "email" : /phone|mobile/i.test(label) ? "phone" : /\bdate\b|when\b|birthday/i.test(label) ? "date" : /message|details|describe|comments?|anything else|tell us/i.test(label) ? "textarea" : /how many|number of|\bage\b|quantity/i.test(label) ? "number" : "text";

/**
 * Questions from pasted text or a CSV file. CSV with a header row uses label, type, required and options columns
 * (options split by |); otherwise each non empty line is a question: "Question? *" is required and
 * "Choice: A | B | C" makes a choice question. Works with AI off.
 */
export function parseImport(text: string): { fields: ImportedField[]; skipped: number } {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 500);
  const taken = new Set<string>();
  const fields: ImportedField[] = []; let skipped = 0;
  const head = lines.length ? csvCells(lines[0]).map((h) => h.toLowerCase()) : [];
  const li = head.indexOf("label") >= 0 ? head.indexOf("label") : head.indexOf("question");
  if (li >= 0 && lines.length > 0) {
    const ti = head.indexOf("type"), ri = head.indexOf("required"), oi = head.indexOf("options");
    for (const line of lines.slice(1)) {
      const c = csvCells(line); const label = (c[li] ?? "").slice(0, 200);
      if (!label || fields.length >= IMPORT_MAX_FIELDS) { skipped++; continue; }
      const t = ti >= 0 ? IMPORT_TYPES[(c[ti] ?? "").toLowerCase()] : undefined;
      const options = oi >= 0 ? (c[oi] ?? "").split("|").map((x) => x.trim().slice(0, 100)).filter(Boolean).slice(0, 50) : [];
      const type: FormFieldType = t ?? (options.length ? "select" : guessType(label));
      const required = ri >= 0 ? /^(yes|y|true|1|required)$/i.test(c[ri] ?? "") : false;
      fields.push({ id: slugId(label, taken, fields.length), label, type, required, ...((type === "select" || type === "multiselect") ? { options: options.length ? options : ["Option 1", "Option 2"] } : {}) });
    }
    return { fields, skipped };
  }
  for (const raw of lines) {
    let line = raw.replace(/^(\d+[.)]|[-*•])\s+/, "");
    if (!line || fields.length >= IMPORT_MAX_FIELDS) { skipped++; continue; }
    const required = /\*\s*$/.test(line); line = line.replace(/\s*\*\s*$/, "");
    let options: string[] = [];
    const bar = line.indexOf("|");
    if (bar > 0) {
      const cut = Math.max(line.lastIndexOf(":", bar), line.lastIndexOf("?", bar));
      if (cut > 0) { options = line.slice(cut + 1).split("|").map((x) => x.trim().slice(0, 100)).filter(Boolean).slice(0, 50); line = line[cut] === "?" ? line.slice(0, cut + 1) : line.slice(0, cut); }
    }
    const label = line.trim().slice(0, 200);
    if (!label) { skipped++; continue; }
    const type: FormFieldType = options.length >= 2 ? "select" : guessType(label);
    fields.push({ id: slugId(label, taken, fields.length), label, type, required, ...(type === "select" ? { options } : {}) });
  }
  return { fields, skipped };
}

/** The AI draft's answer, kept only where it fits the known field types. */
export function cleanDraft(raw: unknown): { name: string; description: string; fields: ImportedField[] } | null {
  let o: unknown = raw;
  if (typeof raw === "string") { const s = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1); try { o = JSON.parse(s); } catch { return null; } }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const list = Array.isArray(r.fields) ? r.fields : [];
  const taken = new Set<string>(); const fields: ImportedField[] = [];
  for (const x of list.slice(0, IMPORT_MAX_FIELDS)) {
    if (!x || typeof x !== "object") continue;
    const f = x as Record<string, unknown>;
    const label = typeof f.label === "string" ? f.label.trim().slice(0, 200) : "";
    if (!label) continue;
    const type = IMPORT_TYPES[String(f.type ?? "").toLowerCase()] ?? guessType(label);
    const options = Array.isArray(f.options) ? f.options.filter((v): v is string => typeof v === "string").map((v) => v.trim().slice(0, 100)).filter(Boolean).slice(0, 50) : [];
    const choice = type === "select" || type === "multiselect";
    fields.push({ id: slugId(label, taken, fields.length), label, type: choice && options.length < 2 ? "text" : type, required: f.required === true, ...(choice && options.length >= 2 ? { options } : {}) });
  }
  if (!fields.length) return null;
  return { name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 120) : "New form", description: typeof r.description === "string" ? r.description.trim().slice(0, 1000) : "", fields };
}

// ---------------------------------------------------------------- analytics

export interface FieldReach { fieldId: string; label: string; reached: number; dropped: number }
/** Reach per question in form order, and how many people stopped after each one (never negative). */
export function dropOff(fields: { id: string; label: string }[], reach: Record<string, number>, completions: number): FieldReach[] {
  return fields.map((f, i) => {
    const reached = reach[f.id] ?? 0;
    const next = i + 1 < fields.length ? (reach[fields[i + 1].id] ?? 0) : completions;
    return { fieldId: f.id, label: f.label, reached, dropped: Math.max(0, reached - next) };
  });
}
export const completionRate = (views: number, completions: number) => (views > 0 ? Math.round((Math.min(completions, views) / views) * 100) : 0);
