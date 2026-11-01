/**
 * R125: tables (a doc type). Pure rules shared by the server and the web: field types, checking and converting cell
 * values, display text, CSV read and write, type guessing for imports, and the three starter templates.
 * Money is integer cents. Dates are YYYY-MM-DD; typed dates are read day first (dd/mm/yyyy), the Australian way.
 */
export const FIELD_TYPES = [
  "text", "longtext", "number", "currency", "date", "checkbox", "select", "multiselect", "person", "email", "phone", "url", "attachment", "link", "lookup", "formula",
] as const;
export type TFieldType = (typeof FIELD_TYPES)[number];
export const COMPUTED: readonly TFieldType[] = ["lookup", "formula"];
export const isComputed = (t: TFieldType) => t === "lookup" || t === "formula";
export const TYPE_LABELS: Record<TFieldType, string> = {
  text: "Text", longtext: "Long text", number: "Number", currency: "Currency", date: "Date", checkbox: "Checkbox", select: "Single select",
  multiselect: "Multi select", person: "Person", email: "Email", phone: "Phone", url: "Link to a website", attachment: "Attachment",
  link: "Linked record", lookup: "Lookup", formula: "Formula",
};
export const OPTION_COLOURS = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#db2777", "#ff5a36", "#64748b"];
export const LIMITS = { fields: 60, rows: 10_000, importRows: 5_000, text: 2_000, longtext: 20_000, options: 100, pageSize: 100, pasteRows: 500, views: 30, name: 80 };

export interface TOption { id: string; label: string; color: string }
export interface TFieldConfig {
  options?: TOption[];
  currency?: string;
  decimals?: number;
  /** link: the table (doc id) the field points at. */
  tableId?: string;
  /** lookup: the link field on this table and the field to show from the linked table. */
  linkFieldId?: string;
  targetFieldId?: string;
  /** formula source, field names in braces. */
  formula?: string;
}
export interface TField { id: string; name: string; type: TFieldType; config: TFieldConfig; position: number; width: number | null }
export type TCell = string | number | boolean | string[] | null;
export type Coerced = { ok: true; value: TCell } | { ok: false; error: string };

const ok = (value: TCell): Coerced => ({ ok: true, value });
const bad = (error: string): Coerced => ({ ok: false, error });

// ---------------------------------------------------------------- dates and money

const pad = (n: number) => String(n).padStart(2, "0");
function validDay(y: number, m: number, d: number): string | null {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A typed or imported date as YYYY-MM-DD, or null. Reads 2026-11-02, 2/11/2026, 02-11-26, 2 Nov 2026 (day first). */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return validDay(y, +m[2], +m[1]); }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m) { const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); return mi < 0 ? null : validDay(+m[3], mi + 1, +m[1]); }
  return null;
}
/** dd/mm/yyyy for people. */
export const showDate = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; };

/** "A$1,234.50", "$12", "-3.5", "1 200" as cents, or null. */
export function parseCents(raw: string): number | null {
  const s = raw.trim().replace(/^(A\$|AUD|\$|NZ\$|US\$)\s*/i, "").replace(/\s*(AUD|NZD|USD)$/i, "").replace(/[,\s]/g, "");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Math.round(Number(s) * 100);
  return Number.isSafeInteger(n) && Math.abs(n) <= 1e15 ? n : null;
}
export function centsText(c: number, currency = "AUD") {
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(c);
  const whole = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sym = currency === "AUD" ? "$" : `${currency} `;
  return `${sign}${sym}${whole}.${pad(a % 100)}`;
}
export function parseNumber(raw: string): number | null {
  const s = raw.trim().replace(/,/g, "").replace(/%$/, "");
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- checking a value for a field

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{6,24}$/;
const truthyWords = new Set(["true", "yes", "y", "1", "x", "checked", "done", "✓", "✔"]);
const falsyWords = new Set(["false", "no", "n", "0", "", "unchecked"]);

/** Turns what a person typed, pasted or imported (or a JSON value from the API) into the stored value, or says why not. */
export function coerceCell(f: Pick<TField, "type" | "config" | "name">, raw: unknown): Coerced {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "") || (Array.isArray(raw) && raw.length === 0)) {
    return isComputed(f.type) ? bad(`${f.name} is worked out for you.`) : ok(f.type === "checkbox" ? false : null);
  }
  const text = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : null;
  switch (f.type) {
    case "text": case "person": {
      if (text === null) return bad(`${f.name} needs text.`);
      const t = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
      return t.length > LIMITS.text ? bad(`${f.name} can be up to ${LIMITS.text} characters.`) : ok(t);
    }
    case "longtext":
      if (text === null) return bad(`${f.name} needs text.`);
      return text.length > LIMITS.longtext ? bad(`${f.name} can be up to ${LIMITS.longtext} characters.`) : ok(text.replace(/\r\n/g, "\n"));
    case "number": {
      const n = typeof raw === "number" ? raw : text === null ? null : parseNumber(text);
      return n === null || !Number.isFinite(n) ? bad(`${f.name} needs a number.`) : ok(n);
    }
    case "currency": {
      if (typeof raw === "number") return Number.isSafeInteger(raw) ? ok(raw) : bad(`${f.name} needs whole cents.`);
      const c = text === null ? null : parseCents(text);
      return c === null ? bad(`${f.name} needs an amount like 12.50.`) : ok(c);
    }
    case "date": {
      const d = text === null ? null : parseDate(text);
      return d ? ok(d) : bad(`${f.name} needs a date like 02/11/2026.`);
    }
    case "checkbox": {
      if (typeof raw === "boolean") return ok(raw);
      const t = (text ?? "").trim().toLowerCase();
      if (truthyWords.has(t)) return ok(true);
      if (falsyWords.has(t)) return ok(false);
      return bad(`${f.name} needs yes or no.`);
    }
    case "email": {
      const t = (text ?? "").trim();
      return EMAIL.test(t) && t.length <= 254 ? ok(t) : bad(`${f.name} needs an email address.`);
    }
    case "phone": {
      const t = (text ?? "").trim();
      return PHONE.test(t) ? ok(t) : bad(`${f.name} needs a phone number.`);
    }
    case "url": {
      let t = (text ?? "").trim();
      if (t && !/^[a-z][a-z0-9+.-]*:/i.test(t)) t = `https://${t}`;
      try { const u = new URL(t); return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") && t.length <= 2000 ? ok(t) : bad(`${f.name} needs a web address.`); }
      catch { return bad(`${f.name} needs a web address.`); }
    }
    case "select": {
      const opts = f.config.options ?? [];
      const v = Array.isArray(raw) ? raw[0] : text;
      const o = opts.find((x) => x.id === v) ?? opts.find((x) => x.label.toLowerCase() === String(v ?? "").trim().toLowerCase());
      return o ? ok(o.id) : bad(`${f.name} has no option "${String(v).slice(0, 40)}".`);
    }
    case "multiselect": {
      const opts = f.config.options ?? [];
      const parts = Array.isArray(raw) ? raw.map(String) : (text ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      const ids: string[] = [];
      for (const p of parts) {
        const o = opts.find((x) => x.id === p) ?? opts.find((x) => x.label.toLowerCase() === p.toLowerCase());
        if (!o) return bad(`${f.name} has no option "${p.slice(0, 40)}".`);
        if (!ids.includes(o.id)) ids.push(o.id);
      }
      return ok(ids);
    }
    case "attachment": case "link": {
      const ids = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null;
      if (!ids || ids.some((x) => typeof x !== "string" || x.length > 64 || !/^[\w-]+$/.test(x))) return bad(`${f.name} needs a list of ids.`);
      if (ids.length > 100) return bad(`${f.name} can hold up to 100 items.`);
      return ok([...new Set(ids as string[])]);
    }
    default:
      return bad(`${f.name} is worked out for you.`);
  }
}

/** Option labels found in imported text that the field does not have yet (CSV import adds them). */
export function newOptionLabels(f: Pick<TField, "type" | "config">, values: string[]): string[] {
  if (f.type !== "select" && f.type !== "multiselect") return [];
  const have = new Set((f.config.options ?? []).map((o) => o.label.toLowerCase()));
  const out: string[] = [];
  for (const v of values) for (const p of f.type === "select" ? [v.trim()] : v.split(/[,;]/).map((s) => s.trim())) {
    if (p && !have.has(p.toLowerCase()) && out.length < LIMITS.options) { have.add(p.toLowerCase()); out.push(p.slice(0, LIMITS.name)); }
  }
  return out;
}

// ---------------------------------------------------------------- showing a value

export interface LinkLabel { id: string; label: string }
/** One line of text for a cell (grid, CSV, search). Linked records and lookups use labels the server resolved. */
export function cellText(f: Pick<TField, "type" | "config">, v: TCell, labels?: LinkLabel[] | null): string {
  if (v === null || v === undefined) return "";
  switch (f.type) {
    case "currency": return typeof v === "number" ? centsText(v, f.config.currency || "AUD") : "";
    case "number": return typeof v === "number" ? String(Number(v.toPrecision(12))) : String(v);
    case "date": return typeof v === "string" ? showDate(v) : "";
    case "checkbox": return v === true ? "Yes" : "No";
    case "select": { const o = (f.config.options ?? []).find((x) => x.id === v); return o?.label ?? ""; }
    case "multiselect": return Array.isArray(v) ? v.map((id) => (f.config.options ?? []).find((x) => x.id === id)?.label).filter(Boolean).join(", ") : "";
    case "link": return (labels ?? []).map((l) => l.label).join(", ");
    case "attachment": return (labels ?? []).map((l) => l.label).join(", ");
    case "lookup": return Array.isArray(v) ? v.join(", ") : String(v);
    case "formula": return typeof v === "boolean" ? (v ? "Yes" : "No") : typeof v === "number" ? String(Number(v.toPrecision(12))) : String(v);
    default: return Array.isArray(v) ? v.join(", ") : String(v);
  }
}

/** Converting a column to another type: each value goes through its text form, and what does not fit is cleared. */
export function convertValue(from: Pick<TField, "type" | "config">, to: Pick<TField, "type" | "config" | "name">, v: TCell): TCell {
  if (v === null) return to.type === "checkbox" ? false : null;
  if (isComputed(to.type)) return null;
  if ((from.type === "link" || from.type === "attachment") && from.type === to.type) return v;
  if (from.type === "link" || from.type === "attachment" || to.type === "link" || to.type === "attachment") return null;
  if (from.type === "currency" && to.type === "number" && typeof v === "number") return v / 100;
  if (from.type === "number" && to.type === "currency" && typeof v === "number") return Math.round(v * 100);
  if (from.type === "checkbox" && to.type !== "checkbox" && to.type !== "text") return null;
  const text = from.type === "date" && typeof v === "string" ? v : from.type === "currency" && typeof v === "number" ? (v / 100).toFixed(2) : cellText(from, v);
  const r = coerceCell(to, text);
  return r.ok ? r.value : to.type === "checkbox" ? false : null;
}

/** The lowercased words of a row's text like cells, for the LK1 text search column (clipped). */
export function searchTextOf(fields: Pick<TField, "id" | "type" | "config">[], cells: Record<string, TCell>): string {
  const parts: string[] = [];
  for (const f of fields) {
    if (f.type === "link" || f.type === "attachment" || f.type === "lookup" || f.type === "formula" || f.type === "checkbox") continue;
    const t = cellText(f, cells[f.id] ?? null);
    if (t) parts.push(t);
  }
  return parts.join(" ").slice(0, 2000);
}

// ---------------------------------------------------------------- CSV

/** RFC 4180 CSV (quotes, doubled quotes, new lines inside quotes, CRLF), a byte order mark dropped; a , ; or tab separator guessed. */
export function parseCsv(input: string, maxRows = LIMITS.importRows + 1): string[][] {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const firstLine = s.slice(0, s.search(/\r?\n|$/));
  const counts = [",", ";", "\t"].map((c) => [c, firstLine.split(c).length] as const).sort((a, b) => b[1] - a[1]);
  const sep = counts[0][1] > 1 ? counts[0][0] : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
      if (rows.length >= maxRows) return rows;
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const csvCell = (v: string) => {
  const t = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; // a cell that a spreadsheet would run as a formula starts with '
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
export function toCsv(rows: string[][]): string { return "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n"; }

/** A type for an imported column from its values (empty values ignored). */
export function guessType(values: string[]): TFieldType {
  const vals = values.map((v) => v.trim()).filter(Boolean).slice(0, 500);
  if (!vals.length) return "text";
  const all = (fn: (v: string) => boolean) => vals.every(fn);
  if (all((v) => truthyWords.has(v.toLowerCase()) || ["false", "no", "n", "0", "unchecked"].includes(v.toLowerCase())) && vals.some((v) => !/^\d+$/.test(v))) return "checkbox";
  if (all((v) => /^(A\$|\$)/i.test(v) && parseCents(v) !== null)) return "currency";
  if (all((v) => parseNumber(v) !== null)) return "number";
  if (all((v) => parseDate(v) !== null)) return "date";
  if (all((v) => EMAIL.test(v))) return "email";
  if (all((v) => /^https?:\/\//i.test(v))) return "url";
  if (all((v) => /^\+?[\d\s()-]{8,20}$/.test(v) && /\d{3}/.test(v))) return "phone";
  if (vals.some((v) => v.length > 200 || v.includes("\n"))) return "longtext";
  const distinct = new Set(vals.map((v) => v.toLowerCase()));
  if (vals.length >= 6 && distinct.size <= Math.min(12, Math.ceil(vals.length / 3)) && [...distinct].every((v) => v.length <= 40)) return "select";
  return "text";
}

// ---------------------------------------------------------------- templates

export interface TemplateField { key: string; name: string; type: TFieldType; options?: string[]; formula?: string; width?: number }
export interface TemplateDef { id: "clients" | "stock" | "jobs"; name: string; description: string; fields: TemplateField[]; views: { name: string; type: "grid" | "kanban" | "calendar" | "form"; by?: string }[]; rows: Record<string, unknown>[] }
export const TEMPLATES: TemplateDef[] = [
  {
    id: "clients", name: "Clients", description: "People you work for, their stage and what they are worth.",
    fields: [
      { key: "name", name: "Name", type: "text", width: 200 }, { key: "company", name: "Company", type: "text" }, { key: "email", name: "Email", type: "email" },
      { key: "phone", name: "Phone", type: "phone" }, { key: "stage", name: "Stage", type: "select", options: ["Lead", "Talking", "Client", "Past"] },
      { key: "value", name: "Value", type: "currency" }, { key: "next", name: "Next call", type: "date" }, { key: "notes", name: "Notes", type: "longtext" },
    ],
    views: [{ name: "All clients", type: "grid" }, { name: "By stage", type: "kanban", by: "stage" }, { name: "Calls", type: "calendar", by: "next" }, { name: "New client", type: "form" }],
    rows: [
      { name: "Priya Shah", company: "Harbour Design", email: "priya@example.com", phone: "0412 345 678", stage: "Client", value: "4800", next: "2026-11-09" },
      { name: "Tom Nguyen", company: "Nguyen Plumbing", email: "tom@example.com", stage: "Talking", value: "1200", next: "2026-11-04" },
      { name: "Grace Lee", company: "Lee and Co", stage: "Lead", value: "650" },
    ],
  },
  {
    id: "stock", name: "Stock list", description: "What you hold, what it costs and when to reorder.",
    fields: [
      { key: "item", name: "Item", type: "text", width: 200 }, { key: "sku", name: "Code", type: "text" }, { key: "cat", name: "Category", type: "select", options: ["Parts", "Tools", "Consumables"] },
      { key: "qty", name: "On hand", type: "number" }, { key: "min", name: "Reorder at", type: "number" }, { key: "cost", name: "Unit cost", type: "currency" },
      { key: "value", name: "Stock value", type: "formula", formula: "{On hand} * {Unit cost}" },
      { key: "reorder", name: "Reorder", type: "formula", formula: "IF({On hand} <= {Reorder at}, \"Yes\", \"No\")" }, { key: "supplier", name: "Supplier", type: "text" },
    ],
    views: [{ name: "All stock", type: "grid" }, { name: "By category", type: "kanban", by: "cat" }, { name: "Stock count", type: "form" }],
    rows: [
      { item: "Copper pipe 15 mm", sku: "CP15", cat: "Parts", qty: 40, min: 20, cost: "6.40", supplier: "Reece" },
      { item: "PTFE tape", sku: "PT12", cat: "Consumables", qty: 8, min: 10, cost: "1.20" },
      { item: "Pipe cutter", sku: "TL03", cat: "Tools", qty: 3, min: 1, cost: "34.00" },
    ],
  },
  {
    id: "jobs", name: "Jobs", description: "Work to do, who has it, when it is due and how far along it is.",
    fields: [
      { key: "job", name: "Job", type: "text", width: 220 }, { key: "client", name: "Client", type: "text" }, { key: "status", name: "Status", type: "select", options: ["To do", "Booked", "In progress", "Done"] },
      { key: "who", name: "Assigned to", type: "person" }, { key: "date", name: "Date", type: "date" }, { key: "quote", name: "Quote", type: "currency" },
      { key: "paid", name: "Paid", type: "checkbox" }, { key: "days", name: "Days away", type: "formula", formula: "days_between(today(), {Date})" }, { key: "notes", name: "Notes", type: "longtext" },
    ],
    views: [{ name: "All jobs", type: "grid" }, { name: "Board", type: "kanban", by: "status" }, { name: "Schedule", type: "calendar", by: "date" }, { name: "Job request", type: "form" }],
    rows: [
      { job: "Kitchen tap swap", client: "Priya Shah", status: "Booked", date: "2026-11-05", quote: "220" },
      { job: "Hot water service", client: "Tom Nguyen", status: "To do", date: "2026-11-12", quote: "1650" },
      { job: "Bathroom leak", client: "Grace Lee", status: "Done", date: "2026-10-28", quote: "340", paid: true },
    ],
  },
];

// ---------------------------------------------------------------- views

export type ViewType = "grid" | "kanban" | "calendar" | "form";
export const FILTER_OPS = ["contains", "is", "is_not", "empty", "not_empty", "gt", "lt", "checked", "unchecked"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export interface TFilter { fieldId: string; op: FilterOp; value?: string }
export interface TSort { fieldId: string; dir: "asc" | "desc" }
export interface ViewConfig {
  sort?: TSort[]; filters?: TFilter[]; groupBy?: string | null; hidden?: string[]; widths?: Record<string, number>;
  /** kanban: a single select field; calendar: a date field. */
  by?: string | null;
  /** form: the fields shown, in order, and its words. */
  formFields?: string[]; formTitle?: string; formNote?: string;
}
export const OPS_FOR: Record<string, FilterOp[]> = {
  text: ["contains", "is", "is_not", "empty", "not_empty"], number: ["is", "gt", "lt", "empty", "not_empty"], date: ["is", "gt", "lt", "empty", "not_empty"],
  checkbox: ["checked", "unchecked"], select: ["is", "is_not", "empty", "not_empty"], other: ["empty", "not_empty"],
};
export function opsFor(t: TFieldType): FilterOp[] {
  if (t === "text" || t === "longtext" || t === "email" || t === "phone" || t === "url" || t === "person") return OPS_FOR.text;
  if (t === "number" || t === "currency") return OPS_FOR.number;
  if (t === "date") return OPS_FOR.date;
  if (t === "checkbox") return OPS_FOR.checkbox;
  if (t === "select" || t === "multiselect") return OPS_FOR.select;
  return OPS_FOR.other;
}
export const OP_LABELS: Record<FilterOp, string> = { contains: "contains", is: "is", is_not: "is not", empty: "is empty", not_empty: "is not empty", gt: "is more than", lt: "is less than", checked: "is ticked", unchecked: "is not ticked" };
