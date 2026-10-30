/**
 * Tools P2, H7: the three interactive editors (page editor, form filler, compare). They run on the same
 * private document engine as every other tool, through their own routes (/api/tools/editors), because
 * each one needs a preview step first (page thumbnails, the form's fields) or two results at once
 * (compare: the report PDF and the change list).
 *
 * TOOLS_EDITORS holds their catalogue entries for the lead to merge into TOOLS (src/shared/tools.ts);
 * each carries its feature flag and the page that opens it. The helper ops (thumbnails, form-fields)
 * are previews and are not catalogue entries.
 */
import type { ToolGroup, ToolOption } from "./tools";
import type { ToolFeature } from "./tool-features";

/** The engine ops these editors use (contract E1). */
export type EditorOp = "thumbnails" | "organize" | "form-fields" | "form-fill" | "compare";
/** The catalogue entries (what a person runs); the other two are previews. */
export type EditorToolOp = "organize" | "form-fill" | "compare";
export const EDITOR_OPS: EditorOp[] = ["thumbnails", "organize", "form-fields", "form-fill", "compare"];
export const isEditorOp = (v: unknown): v is EditorOp => typeof v === "string" && (EDITOR_OPS as string[]).includes(v);

/** Previews do not count as tool runs (a person may open the same file several times while editing). */
export const EDITOR_PREVIEW_OPS: EditorOp[] = ["thumbnails", "form-fields"];

export const EDITOR_FEATURE: Record<EditorOp, ToolFeature> = {
  thumbnails: "editor", organize: "editor", "form-fields": "forms", "form-fill": "forms", compare: "compare",
};

/** A ToolOption that may also be the engine's new "json" kind (contract: a JSON string, max_len per option). */
export type EditorOption = Omit<ToolOption, "kind"> & { kind: ToolOption["kind"] | "json" };

export interface EditorToolDef {
  op: EditorToolOp;
  label: string;
  group: ToolGroup;
  blurb: string;
  accept: string;
  acceptLabel: string;
  minFiles: number;
  maxFiles: number;
  suffix: string;
  ext: "pdf";
  contentType: string;
  options: EditorOption[];
  maxPages?: number;
  maxBytes?: number;
  slow?: { secondsPerPage: number };
  note?: string;
  ordered?: boolean;
  /** Tools P2: the flag that turns it on (TOOLS_FEATURES). */
  feature: ToolFeature;
  /** Needs a desktop style screen; the phone app hides it. */
  webOnly?: boolean;
  /** The web page that opens this tool. */
  path: string;
}

const PDF = ".pdf,application/pdf";
const PDF_TYPE = "application/pdf";

/** Most pages the page editor shows and saves (the engine's thumbnails cap is 200). */
export const EDITOR_MAX_PAGES = 200;
/** Most entries in a page plan (a page may repeat). */
export const PLAN_MAX_ENTRIES = 400;
/** Same as the engine publishes (organize plan, form-fill values; contract E1). */
export const PLAN_MAX_LEN = 40_000;
export const VALUES_MAX_LEN = 200_000;
/** The engine refuses a longer answer for one field. */
export const FIELD_VALUE_MAX = 2000;
/** Most form fields shown; a bigger form still fills, the rest keep their values. */
export const FORM_MAX_FIELDS = 500;

export const TOOLS_EDITORS: EditorToolDef[] = [
  { op: "organize", feature: "editor", webOnly: true, path: "/app/tools/pages", group: "Organise", label: "Edit pages",
    blurb: "See every page, then drag to reorder, turn or delete pages.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1,
    suffix: "-edited", ext: "pdf", contentType: PDF_TYPE,
    options: [{ name: "plan", kind: "json", label: "Pages in order", required: true, maxLen: PLAN_MAX_LEN }] },
  { op: "form-fill", feature: "forms", path: "/app/tools/forms", group: "Organise", label: "Fill a PDF form",
    blurb: "Type into a PDF form's own fields, then download it filled in.", accept: PDF, acceptLabel: "a PDF form", minFiles: 1, maxFiles: 1,
    suffix: "-filled", ext: "pdf", contentType: PDF_TYPE,
    options: [
      { name: "values", kind: "json", label: "Answers", required: true, maxLen: VALUES_MAX_LEN },
      { name: "flatten", kind: "choice", label: "Flatten so it cannot be changed", default: "no", choices: [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }] },
    ] },
  { op: "compare", feature: "compare", webOnly: true, path: "/app/tools/compare", group: "Organise", label: "Compare PDFs",
    blurb: "See what changed between two versions of a document.", accept: PDF, acceptLabel: "two PDFs, older first", minFiles: 2, maxFiles: 2,
    suffix: "-changes", ext: "pdf", contentType: PDF_TYPE, ordered: true, maxPages: 100, maxBytes: 30 * 1024 * 1024, slow: { secondsPerPage: 2 },
    options: [{ name: "output", kind: "choice", label: "Result", default: "pdf", choices: [{ value: "pdf", label: "Report PDF" }, { value: "json", label: "Change list" }] }],
    note: "Compares the words on each page. Changes in pictures or layout alone are not listed." },
];

export const editorDef = (op: EditorToolOp) => TOOLS_EDITORS.find((t) => t.op === op)!;

/** The result's content type and extension per engine op (previews included). */
export const EDITOR_OUTPUT: Record<EditorOp, { ext: string; contentType: string; suffix: string }> = {
  thumbnails: { ext: "zip", contentType: "application/zip", suffix: "-pages" },
  organize: { ext: "pdf", contentType: PDF_TYPE, suffix: "-edited" },
  "form-fields": { ext: "json", contentType: "application/json", suffix: "-fields" },
  "form-fill": { ext: "pdf", contentType: PDF_TYPE, suffix: "-filled" },
  compare: { ext: "pdf", contentType: PDF_TYPE, suffix: "-changes" },
};

/** Options each engine op takes from the browser; anything else is dropped before it reaches the engine. */
export const EDITOR_OPTION_NAMES: Record<EditorOp, string[]> = {
  thumbnails: [], "form-fields": [], organize: ["plan"], "form-fill": ["values", "flatten"], compare: [],
};

/** The result file's name from the first input's name: letters, numbers and simple marks only. */
export function editorResultName(op: EditorOp, firstName: string | null | undefined, ext?: string): string {
  const base = (firstName ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^A-Za-z0-9 _.()+-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "document";
  const o = EDITOR_OUTPUT[op];
  return `${base}${o.suffix}.${ext ?? o.ext}`;
}

// ---------- Page editor: the plan ----------

export type Rotation = 0 | 90 | 180 | 270;
export interface PlanEntry { page: number; rotate: Rotation }

/** Checks a page plan: 1 to PLAN_MAX_ENTRIES entries, pages inside the document, right angles only. Null when fine, else a plain reason. */
export function planProblem(plan: unknown, pageCount?: number): string | null {
  if (!Array.isArray(plan) || plan.length === 0) return "Keep at least one page.";
  if (plan.length > PLAN_MAX_ENTRIES) return `A document can have up to ${PLAN_MAX_ENTRIES} pages here.`;
  for (const e of plan) {
    if (!e || typeof e !== "object") return "That page list is not valid.";
    const { page, rotate } = e as Record<string, unknown>;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || (pageCount !== undefined && page > pageCount)) return "That page list names a page the document does not have.";
    if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) return "Pages turn by a quarter at a time.";
    if (Object.keys(e as object).some((k) => k !== "page" && k !== "rotate")) return "That page list is not valid.";
  }
  return null;
}

export const turn = (r: Rotation, by: 90 | -90): Rotation => (((r + by + 360) % 360) as Rotation);

/** A short summary of what Save will do, for the button's helper line. */
export function planSummary(plan: PlanEntry[], pageCount: number): string {
  const kept = new Set(plan.map((p) => p.page));
  const deleted = pageCount - kept.size;
  const turned = plan.filter((p) => p.rotate !== 0).length;
  const moved = plan.some((p, i) => i > 0 && plan[i - 1].page >= p.page);
  const parts: string[] = [];
  if (moved) parts.push("new order");
  if (turned) parts.push(`${turned} turned`);
  if (deleted > 0) parts.push(`${deleted} deleted`);
  return parts.length ? `${plan.length} ${plan.length === 1 ? "page" : "pages"}: ${parts.join(", ")}` : "No changes yet";
}

// ---------- Form filler: the fields ----------

export type FormFieldType = "text" | "checkbox" | "radio" | "choice" | "signature";
export interface FormField {
  name: string; type: FormFieldType; value: string | boolean | null; options: string[]; page: number | null; required: boolean;
}

const FIELD_TYPES: FormFieldType[] = ["text", "checkbox", "radio", "choice", "signature"];
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

/** The engine's form-fields JSON, checked and trimmed to what the form needs. Unknown shapes become an empty list. */
export function readFormFields(raw: unknown): FormField[] {
  const list = (raw && typeof raw === "object" && Array.isArray((raw as { fields?: unknown }).fields)) ? (raw as { fields: unknown[] }).fields : [];
  const out: FormField[] = [];
  const seen = new Set<string>();
  for (const f of list) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const name = clip(r.name, 200);
    const type = FIELD_TYPES.includes(r.type as FormFieldType) ? (r.type as FormFieldType) : null;
    if (!name || !type || seen.has(name)) continue;
    seen.add(name);
    const options = Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === "string").map((o) => o.slice(0, 200)).slice(0, 200) : [];
    const value = typeof r.value === "boolean" ? r.value : typeof r.value === "string" ? r.value.slice(0, 5000) : null;
    const page = typeof r.page === "number" && Number.isInteger(r.page) && r.page > 0 ? r.page : null;
    out.push({ name, type, value, options, page, required: r.required === true });
    if (out.length >= FORM_MAX_FIELDS) break;
  }
  return out;
}

/** "Applicant.First_name[0]" becomes "Applicant first name": a readable label from a field's internal name. */
export function fieldLabel(name: string): string {
  const last = name.replace(/\[\d+\]/g, "").split(".").filter(Boolean).pop() ?? name;
  const words = last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

export type FormValues = Record<string, string | boolean>;

/** Starting answers: what the form already holds. */
export function initialValues(fields: FormField[]): FormValues {
  const v: FormValues = {};
  for (const f of fields) {
    if (f.type === "signature") continue;
    if (f.type === "checkbox") v[f.name] = f.value === true || (typeof f.value === "string" && (f.options.includes(f.value) || /^(yes|on|true|1|x)$/i.test(f.value)));
    // A radio group or list holding a value it does not offer ("Off") starts empty.
    else if ((f.type === "radio" || f.type === "choice") && f.options.length && !(typeof f.value === "string" && f.options.includes(f.value))) v[f.name] = "";
    else v[f.name] = typeof f.value === "string" ? f.value : "";
  }
  return v;
}

/** Required fields still empty, by name. */
export function missingRequired(fields: FormField[], values: FormValues): string[] {
  return fields.filter((f) => f.required && f.type !== "signature" && (f.type === "checkbox" ? values[f.name] !== true : !String(values[f.name] ?? "").trim())).map((f) => f.name);
}

/**
 * What goes to the engine: the answers that changed. Flattening an unchanged form still needs at least
 * one value, so then every answer that is not empty goes.
 */
export function valuesToSend(fields: FormField[], values: FormValues, flatten: boolean): FormValues {
  const changed = changedValues(fields, values);
  if (Object.keys(changed).length || !flatten) return changed;
  const out: FormValues = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.type === "signature" || v === undefined) continue;
    if (f.type === "checkbox" ? v === true : String(v).trim() !== "") out[f.name] = f.type === "checkbox" ? v : String(v);
  }
  return out;
}

/** Only the fields the person can see and that changed from the form's own value go to the engine. */
export function changedValues(fields: FormField[], values: FormValues): FormValues {
  const start = initialValues(fields);
  const out: FormValues = {};
  for (const f of fields) {
    if (f.type === "signature" || !(f.name in values)) continue;
    let v = values[f.name];
    if (f.type !== "checkbox") v = String(v);
    if ((f.type === "radio" || f.type === "choice") && v !== "" && f.options.length && !f.options.includes(v as string)) continue;
    if (v !== start[f.name]) out[f.name] = v;
  }
  return out;
}

// ---------- Compare: the change list ----------

export interface PageChange { page: number; added: string[]; removed: string[] }
export interface CompareChanges { pages: PageChange[]; wordsAdded: number; wordsRemoved: number }

/** The engine's compare JSON, checked: up to 500 pages, 200 runs a side per page, 500 characters a run. */
export function readCompareChanges(raw: unknown): CompareChanges {
  const list = (raw && typeof raw === "object" && Array.isArray((raw as { pages?: unknown }).pages)) ? (raw as { pages: unknown[] }).pages : [];
  const runs = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.slice(0, 500)).slice(0, 200) : []);
  const pages: PageChange[] = [];
  for (const p of list.slice(0, 500)) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    if (typeof r.page !== "number" || !Number.isInteger(r.page) || r.page < 1) continue;
    const added = runs(r.added), removed = runs(r.removed);
    if (added.length || removed.length) pages.push({ page: r.page, added, removed });
  }
  pages.sort((a, b) => a.page - b.page);
  const words = (xs: string[]) => xs.reduce((n, s) => n + s.trim().split(/\s+/).filter(Boolean).length, 0);
  return { pages, wordsAdded: pages.reduce((n, p) => n + words(p.added), 0), wordsRemoved: pages.reduce((n, p) => n + words(p.removed), 0) };
}

/** Facts the editors' results carry (never file contents). */
export interface EditorFacts { pages?: number; fields?: number; fields_filled?: number; pages_changed?: number; words_added?: number; words_removed?: number }
export const EDITOR_FACT_KEYS = ["pages", "fields", "fields_filled", "pages_changed", "words_added", "words_removed"] as const;

export type EditorJobStatus = "queued" | "running" | "done" | "failed" | "expired";
export interface EditorJob {
  token: string; op: EditorOp; status: EditorJobStatus; name: string; error?: string; bytes?: number; downloadUrl?: string;
  progress?: { done: number; total: number };
  result?: EditorFacts;
}
/** Compare starts two engine jobs on the same two files: the report PDF and the change list. */
export interface CompareStart { report: EditorJob; changes: EditorJob }
