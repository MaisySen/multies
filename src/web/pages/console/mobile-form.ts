/**
 * OPS1: the Mobile app config form's logic, kept apart from the page so it can be tested on its own.
 * Each field (from GET /api/console/mobile) is edited as text; a draft is compared with the value phones get now
 * (the effective config) and only changed fields go into the patch PUT /api/console/mobile takes.
 */

export type MobileFieldType = "integer" | "version" | "url" | "update_ids" | "text";

export interface MobileField {
  path: string;
  label: string;
  help: string;
  type: MobileFieldType;
  nullable: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
}

export interface MobileConfigResponse {
  stored: Record<string, unknown>;
  effective: Record<string, unknown>;
  fields: MobileField[];
  updatedAt: string | null;
  updatedBy: string | null;
  updatedByEmail: string | null;
}

export type Drafts = Record<string, string>;

export interface MobileSection { id: string; title: string; description: string; fields: MobileField[] }

const SECTIONS: { id: string; title: string; description: string; match: (path: string) => boolean }[] = [
  { id: "minimum", title: "Minimum supported versions", description: "The oldest app a phone may run, and where the update screen sends people.", match: (p) => p.startsWith("min_supported.") || p.startsWith("store_url.") },
  { id: "updates", title: "Critical and rolled back updates", description: "Over the air updates that apply at once or were pulled, and how often phones check.", match: (p) => p.startsWith("ota.") },
  { id: "message", title: "Message to users", description: "An extra line on the update screen.", match: (p) => p === "message" },
];

/** The fields grouped into the form's sections, in the server's order; anything new lands in "Other settings". */
export function sectionsOf(fields: readonly MobileField[]): MobileSection[] {
  const out: MobileSection[] = SECTIONS.map((s) => ({ id: s.id, title: s.title, description: s.description, fields: fields.filter((f) => s.match(f.path)) }));
  const rest = fields.filter((f) => !SECTIONS.some((s) => s.match(f.path)));
  if (rest.length) out.push({ id: "other", title: "Other settings", description: "", fields: rest });
  return out.filter((s) => s.fields.length > 0);
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

/** The text a field's input starts with. */
export function toDraft(field: MobileField, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (field.type === "update_ids") return Array.isArray(value) ? value.join("\n") : "";
  return String(value);
}

export function draftsOf(fields: readonly MobileField[], effective: unknown): Drafts {
  return Object.fromEntries(fields.map((f) => [f.path, toDraft(f, getPath(effective, f.path))]));
}

const VERSION = /^\d+(\.\d+){0,3}$/;
const UPDATE_ID = /^[0-9a-f-]{8,64}$/i;
const STORE_URL: Record<string, { re: RegExp; problem: string }> = {
  "store_url.ios": { re: /^https:\/\/(apps|itunes)\.apple\.com\//, problem: "Use an App Store address that starts with https://apps.apple.com/." },
  "store_url.android": { re: /^https:\/\/play\.google\.com\//, problem: "Use a Google Play address that starts with https://play.google.com/." },
};

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** The value a draft stands for, or what to fix. */
export function parseDraft(field: MobileField, draft: string): Parsed {
  const t = draft.trim();
  if (field.type === "update_ids") {
    const ids = t.split(/[\s,]+/).filter(Boolean).map((x) => x.toLowerCase());
    const bad = ids.find((x) => !UPDATE_ID.test(x));
    if (bad) return { ok: false, error: `"${bad}" is not an update id. Paste update ids (UUIDs), one per line.` };
    const unique = [...new Set(ids)];
    if (field.max !== undefined && unique.length > field.max) return { ok: false, error: `Keep this list to ${field.max} updates or fewer.` };
    return { ok: true, value: unique };
  }
  if (!t) return field.nullable ? { ok: true, value: null } : { ok: false, error: "This one can't be empty." };
  if (field.type === "integer") {
    if (!/^\d+$/.test(t)) return { ok: false, error: "Use a whole number." };
    const n = Number(t);
    if (field.min !== undefined && n < field.min) return { ok: false, error: `Use ${field.min} or more.` };
    if (field.max !== undefined && n > field.max) return { ok: false, error: `Use ${field.max} or less.` };
    return { ok: true, value: n };
  }
  if (field.type === "version") return VERSION.test(t) ? { ok: true, value: t } : { ok: false, error: "Use a version number like 1.4.0." };
  if (field.type === "url") {
    const rule = STORE_URL[field.path];
    if (rule && !rule.re.test(t)) return { ok: false, error: rule.problem };
    if (!rule && !t.startsWith("https://")) return { ok: false, error: "Use a full https:// address." };
    return { ok: true, value: t };
  }
  if (field.maxLength !== undefined && t.length > field.maxLength) return { ok: false, error: `Keep it under ${field.maxLength} characters.` };
  return { ok: true, value: t };
}

const norm = (v: unknown) => JSON.stringify(Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : v ?? null);

export interface MobileChange { field: MobileField; before: unknown; after: unknown }

export interface MobileReview {
  /** The body's `patch` for PUT /api/console/mobile (changed fields only). */
  patch: Record<string, unknown>;
  changes: MobileChange[];
  /** Field path to what to fix (every field, changed or not). */
  errors: Record<string, string>;
}

/** Compares the drafts with what phones get now. */
export function reviewOf(fields: readonly MobileField[], effective: unknown, drafts: Drafts): MobileReview {
  const patch: Record<string, unknown> = {};
  const changes: MobileChange[] = [];
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const p = parseDraft(f, drafts[f.path] ?? "");
    if (!p.ok) { errors[f.path] = p.error; continue; }
    const before = getPath(effective, f.path) ?? null;
    if (norm(before) === norm(p.value)) continue;
    setPath(patch, f.path, p.value);
    changes.push({ field: f, before, after: p.value });
  }
  return { patch, changes, errors };
}

/** -1, 0 or 1 for two dotted version numbers ("1.4" equals "1.4.0"). */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The minimum version or build changes that make more phones update (a new minimum, or a higher one). */
export function raisedMinimums(changes: readonly MobileChange[]): MobileChange[] {
  return changes.filter((c) => {
    if (!c.field.path.startsWith("min_supported.") || c.after === null || c.after === undefined) return false;
    if (c.before === null || c.before === undefined) return true;
    if (typeof c.after === "number" && typeof c.before === "number") return c.after > c.before;
    return compareVersions(String(c.after), String(c.before)) > 0;
  });
}

/** How a value reads in the form and the review ("Any build", "None", "Off"). */
export function showValue(field: MobileField, v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "None";
  if (v === null || v === undefined || v === "") {
    if (field.path.startsWith("min_supported.")) return field.type === "version" ? "Any version" : "Any build";
    if (field.path === "ota.apply_on_resume_after_minutes") return "Off";
    if (field.path === "message") return "No message";
    return "None";
  }
  return String(v);
}
