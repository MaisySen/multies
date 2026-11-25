/**
 * R31: form logic and answer rules, shared by the form builder, the public form page and the
 * server. One pure module so the page hides exactly what the server skips and both give the
 * same per-field errors.
 *
 * Logic: a question can be shown only when its conditions hold (all or any). A condition can
 * only look at an EARLIER question, so a form reads top to bottom and can never loop. A
 * question that is hidden is skipped: never required, never checked, and its answer is dropped.
 */

/** R93: "rating" is a 0 to 10 or 1 to 5 scale (NPS and CSAT), its range in rules.min and rules.max. */
export type FormFieldType = "text" | "email" | "textarea" | "phone" | "select" | "multiselect" | "number" | "date" | "rating"
  // TD2 (FORMS_TD2): more answer types, then layout blocks that take no answer.
  | "time" | "datetime" | "url" | "file" | "signature"
  | "heading" | "paragraph" | "divider" | "image" | "page";
/** The answer types every form has (FORMS_TD2 off: exactly these, as before). */
export const FORM_FIELD_TYPES: FormFieldType[] = ["text", "email", "textarea", "phone", "select", "multiselect", "number", "date", "rating"];
/** TD2: answer types added with FORMS_TD2 on. */
export const TD2_ANSWER_TYPES: FormFieldType[] = ["time", "datetime", "url", "file", "signature"];
/** TD2: blocks that shape the form and take no answer. "page" starts a new page. */
export const LAYOUT_TYPES: FormFieldType[] = ["heading", "paragraph", "divider", "image", "page"];
export const TD2_FIELD_TYPES: FormFieldType[] = [...FORM_FIELD_TYPES, ...TD2_ANSWER_TYPES, ...LAYOUT_TYPES];
export const isLayout = (t: FormFieldType | undefined): boolean => !!t && LAYOUT_TYPES.includes(t);
export const isUpload = (t: FormFieldType | undefined): boolean => t === "file" || t === "signature";
/** TD2: an upload answer is one or more of these ids (unguessable, made by the upload path). */
export const UPLOAD_ID = /^fu_[A-Za-z0-9]{24}$/;
export const MAX_GROUPS = 5;

export type LogicOp = "is" | "is_not" | "contains" | "answered" | "not_answered" | "gt" | "lt";
export const LOGIC_OPS: LogicOp[] = ["is", "is_not", "contains", "answered", "not_answered", "gt", "lt"];
export const LOGIC_OP_LABELS: Record<LogicOp, string> = {
  is: "is", is_not: "is not", contains: "contains", answered: "is answered", not_answered: "is not answered", gt: "is greater than", lt: "is less than",
};
/** Operators that need no value. */
export const VALUELESS_OPS: LogicOp[] = ["answered", "not_answered"];

export interface LogicCondition { field: string; op: LogicOp; value?: string }
export interface LogicGroup { join: "all" | "any"; conditions: LogicCondition[] }
/**
 * Conditions joined by all or any. TD2: up to MAX_GROUPS groups of conditions (each with its own all or any)
 * join the single conditions, and `action` "hide" turns "show when" into "hide when".
 */
export interface FieldLogic { join: "all" | "any"; conditions: LogicCondition[]; groups?: LogicGroup[]; action?: "show" | "hide" }
export interface FieldRules {
  minLength?: number; maxLength?: number;
  min?: number; max?: number;
  minSelected?: number; maxSelected?: number;
  /** A simple pattern the whole answer must match (no flags, up to 200 characters). */
  pattern?: string; patternMessage?: string;
}
export interface LogicField {
  id: string; label: string; type: FormFieldType; required: boolean; options?: string[];
  logic?: FieldLogic | null; rules?: FieldRules | null;
  /** R93: hidden from blind reviewers; the labels at the ends of a rating scale. */
  identity?: boolean; lowLabel?: string; highLabel?: string;
  /** TD2: required only when these hold; read only (answer dropped) when these hold. */
  requireWhen?: FieldLogic | null; disableWhen?: FieldLogic | null;
  /** TD2 upload limits (checked again on the server), rating look, and layout block content. */
  fileTypes?: string[]; maxSizeMb?: number; maxFiles?: number; display?: "stars";
  text?: string; imageId?: string; imageAlt?: string;
}

/** TD2: every condition of a logic object, single and grouped. */
export function allConditions(l: FieldLogic | null | undefined): LogicCondition[] {
  if (!l) return [];
  return [...(l.conditions ?? []), ...(l.groups ?? []).flatMap((g) => g.conditions ?? [])];
}
const hasLogic = (l: FieldLogic | null | undefined): l is FieldLogic => !!l && (l.conditions?.length > 0 || !!l.groups?.length);
/** TD2: the questions a field's logic reads (show, require and disable). */
export function logicSources(f: Pick<LogicField, "logic" | "requireWhen" | "disableWhen">): string[] {
  return [...allConditions(f.logic), ...allConditions(f.requireWhen), ...allConditions(f.disableWhen)].map((c) => c.field);
}

/** R93: a rating question's range (0 to 10 unless set). */
export function ratingRange(f: Pick<LogicField, "rules">): { min: number; max: number } {
  const min = f.rules?.min === 1 ? 1 : 0;
  const max = typeof f.rules?.max === "number" && f.rules.max >= min + 1 && f.rules.max <= 10 ? Math.round(f.rules.max) : 10;
  return { min, max };
}

/** How a multi-select answer is stored as one string. */
export const MULTI_SEPARATOR = ", ";
export const MAX_CONDITIONS = 10;

export type LogicProblemCode = "self" | "later" | "cycle" | "unknown_op" | "missing_value" | "too_many" | "bad_rule";
export interface LogicProblem { field: string; code: LogicProblemCode; message: string }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Turns one raw answer (string, number, array) into the stored string. */
export function answerText(field: Pick<LogicField, "type" | "options">, raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (Array.isArray(raw)) {
    const picked = raw.map((x) => String(x).trim()).filter(Boolean);
    if (!field.options?.length) return picked.join(MULTI_SEPARATOR); // TD2: upload ids (no options)
    const ordered = field.options?.length ? field.options.filter((o) => picked.includes(o)) : picked;
    const extra = picked.filter((p) => !field.options?.includes(p));
    return [...ordered, ...extra].join(MULTI_SEPARATOR);
  }
  return String(raw).trim();
}

/** The picked options of a multi-select answer (one item for any other type). */
export function answerList(field: Pick<LogicField, "type" | "options">, text: string): string[] {
  if (!text) return [];
  if (field.type !== "multiselect") return [text];
  // Read option by option, longest first, so an option that itself contains ", " still counts once.
  const opts = [...(field.options ?? [])].sort((x, y) => y.length - x.length);
  const out: string[] = [];
  let rest = text;
  while (rest) {
    const hit = opts.find((o) => rest === o || rest.startsWith(o + MULTI_SEPARATOR));
    const item = hit ?? rest.split(MULTI_SEPARATOR)[0];
    if (item.trim()) out.push(item.trim());
    rest = rest.slice(item.length + MULTI_SEPARATOR.length);
  }
  return out;
}

/** Removes conditions that point at questions no longer on the form. Pure; returns new objects. */
export function cleanLogic<F extends LogicField>(fields: F[]): F[] {
  // TD2: a layout block takes no answer, so a condition on one is dropped like one on a deleted question.
  const ids = new Set(fields.filter((f) => !isLayout(f.type)).map((f) => f.id));
  const clean = (l: FieldLogic): FieldLogic | null => {
    const conditions = l.conditions.filter((c) => ids.has(c.field));
    const groups = (l.groups ?? []).map((g) => ({ join: g.join === "any" ? "any" as const : "all" as const, conditions: g.conditions.filter((c) => ids.has(c.field)) })).filter((g) => g.conditions.length);
    if (!conditions.length && !groups.length) return null;
    return { join: l.join === "any" ? "any" : "all", conditions, ...(groups.length ? { groups } : {}), ...(l.action === "hide" ? { action: "hide" as const } : {}) };
  };
  return fields.map((f) => {
    if (!f.logic && !f.requireWhen && !f.disableWhen) return f;
    const out = { ...f } as F;
    if (f.logic) out.logic = clean(f.logic);
    if (f.requireWhen) out.requireWhen = clean(f.requireWhen);
    if (f.disableWhen) out.disableWhen = clean(f.disableWhen);
    return out;
  });
}

/** Finds a loop in "shown if" references (A depends on B depends on A). Returns the ids in the loop, or null. */
export function findCycle(fields: Pick<LogicField, "id" | "logic" | "requireWhen" | "disableWhen">[]): string[] | null {
  const deps = new Map(fields.map((f) => [f.id, logicSources(f)]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return stack.slice(stack.indexOf(id)).concat(id);
    state.set(id, 1); stack.push(id);
    for (const d of deps.get(id) ?? []) { if (!deps.has(d) || d === id) continue; /* a self reference is its own problem */ const c = visit(d); if (c) return c; }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const f of fields) { const c = visit(f.id); if (c) return c; }
  return null;
}

/** Everything wrong with a form's logic and rules, in plain words. Empty means it can be saved. */
export function checkLogic(fields: LogicField[]): LogicProblem[] {
  const problems: LogicProblem[] = [];
  const index = new Map(fields.map((f, i) => [f.id, i]));
  const label = (id: string) => fields[index.get(id) ?? -1]?.label ?? id;
  const cycle = findCycle(fields);
  if (cycle) problems.push({ field: cycle[0], code: "cycle", message: `These questions depend on each other in a loop: ${cycle.map(label).map((l) => `"${l}"`).join(" then ")}.` });
  fields.forEach((f, i) => {
    const lists = [f.logic, f.requireWhen, f.disableWhen].filter(Boolean) as FieldLogic[];
    if (lists.some((l) => l.conditions.length > MAX_CONDITIONS || (l.groups ?? []).some((g) => g.conditions.length > MAX_CONDITIONS))) problems.push({ field: f.id, code: "too_many", message: `"${f.label}" can have up to ${MAX_CONDITIONS} conditions.` });
    if (lists.some((l) => (l.groups?.length ?? 0) > MAX_GROUPS)) problems.push({ field: f.id, code: "too_many", message: `"${f.label}" can have up to ${MAX_GROUPS} groups of conditions.` });
    const conds = lists.flatMap(allConditions);
    for (const c of conds) {
      if (!LOGIC_OPS.includes(c.op)) { problems.push({ field: f.id, code: "unknown_op", message: `"${f.label}" has a condition we don't understand.` }); continue; }
      if (c.field === f.id) { problems.push({ field: f.id, code: "self", message: `"${f.label}" can't depend on its own answer.` }); continue; }
      const at = index.get(c.field);
      if (at !== undefined && at > i && !cycle) problems.push({ field: f.id, code: "later", message: `"${f.label}" can only depend on a question above it, not "${label(c.field)}".` });
      if (!VALUELESS_OPS.includes(c.op) && !String(c.value ?? "").trim()) problems.push({ field: f.id, code: "missing_value", message: `A condition on "${f.label}" needs a value.` });
    }
    const r = f.rules;
    if (r) {
      if (r.minLength !== undefined && r.maxLength !== undefined && r.minLength > r.maxLength) problems.push({ field: f.id, code: "bad_rule", message: `"${f.label}": the shortest length is longer than the longest.` });
      if (r.min !== undefined && r.max !== undefined && r.min > r.max) problems.push({ field: f.id, code: "bad_rule", message: `"${f.label}": the lowest number is above the highest.` });
      if (r.minSelected !== undefined && r.maxSelected !== undefined && r.minSelected > r.maxSelected) problems.push({ field: f.id, code: "bad_rule", message: `"${f.label}": pick at least is more than pick at most.` });
      if (r.minSelected !== undefined && f.options && r.minSelected > f.options.length) problems.push({ field: f.id, code: "bad_rule", message: `"${f.label}" asks for more picks than it has options.` });
      if (r.pattern !== undefined && !safePattern(r.pattern)) problems.push({ field: f.id, code: "bad_rule", message: `"${f.label}": the pattern isn't valid.` });
    }
  });
  return problems;
}

/** A pattern we accept: compiles, up to 200 characters, no back references or nested quantifiers. */
export function safePattern(p: string): boolean {
  if (typeof p !== "string" || !p || p.length > 200) return false;
  if (/\\\d/.test(p) || /\([^)]*[+*][^)]*\)[+*{]/.test(p)) return false;
  try { new RegExp(`^(?:${p})$`); return true; } catch { return false; } // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp (checked here: up to 200 characters, no back references or nested repeats)
}

/** Keeps only the rule keys that make sense for the type, as numbers. */
export function normaliseRules(type: FormFieldType, raw: unknown): FieldRules | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: FieldRules = {};
  const int = (v: unknown) => { const n = num(v); return n === undefined ? undefined : Math.max(0, Math.min(100_000, Math.floor(n))); };
  if (type === "text" || type === "textarea" || type === "phone" || type === "email") {
    const a = int(r.minLength), b = int(r.maxLength);
    if (a !== undefined) out.minLength = a;
    if (b !== undefined) out.maxLength = b;
  }
  if (type === "text" || type === "phone") {
    if (typeof r.pattern === "string" && r.pattern.trim()) out.pattern = r.pattern.trim().slice(0, 200);
    if (typeof r.patternMessage === "string" && r.patternMessage.trim()) out.patternMessage = r.patternMessage.trim().slice(0, 120);
  }
  if (type === "rating") {
    const a = num(r.min) === 1 ? 1 : 0;
    const b = Math.round(num(r.max) ?? 10);
    return { min: a, max: b >= a + 1 && b <= 10 ? b : 10 };
  }
  if (type === "number") {
    const a = num(r.min), b = num(r.max);
    if (a !== undefined) out.min = a;
    if (b !== undefined) out.max = b;
  }
  if (type === "multiselect") {
    const a = int(r.minSelected), b = int(r.maxSelected);
    if (a !== undefined) out.minSelected = a;
    if (b !== undefined) out.maxSelected = b;
  }
  return Object.keys(out).length ? out : null;
}

/** Normalises a raw logic object (unknown ops are kept so checkLogic can refuse them). */
export function normaliseLogic(raw: unknown, opts: { td2?: boolean } = {}): FieldLogic | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { join?: unknown; conditions?: unknown; groups?: unknown; action?: unknown };
  const one = (c: unknown) => {
    const x = (c ?? {}) as { field?: unknown; op?: unknown; value?: unknown };
    const op = String(x.op ?? "") as LogicOp;
    const value = x.value === undefined || x.value === null ? undefined : String(x.value).slice(0, 200);
    return { field: String(x.field ?? "").trim().slice(0, 40), op, ...(value !== undefined && !VALUELESS_OPS.includes(op) ? { value } : {}) };
  };
  const conditions = Array.isArray(r.conditions) ? r.conditions.slice(0, 50).map(one) : [];
  // TD2: groups and hide only with FORMS_TD2 on (off: read exactly as before).
  const groups = opts.td2 && Array.isArray(r.groups)
    ? r.groups.slice(0, 20).map((g) => { const x = (g ?? {}) as { join?: unknown; conditions?: unknown }; return { join: x.join === "any" ? "any" as const : "all" as const, conditions: Array.isArray(x.conditions) ? x.conditions.slice(0, 50).map(one) : [] }; }).filter((g) => g.conditions.length)
    : [];
  if (!conditions.length && !groups.length) return null;
  return { join: r.join === "any" ? "any" : "all", conditions, ...(groups.length ? { groups } : {}), ...(opts.td2 && r.action === "hide" ? { action: "hide" as const } : {}) };
}

function compare(a: string, b: string): number | null {
  const x = num(a), y = num(b);
  if (x !== undefined && y !== undefined) return x - y;
  if (/^\d{4}-\d{2}-\d{2}/.test(a) && /^\d{4}-\d{2}-\d{2}/.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

export function conditionHolds(source: LogicField | undefined, c: LogicCondition, answer: string): boolean {
  const v = String(c.value ?? "").trim().toLowerCase();
  const list = source ? answerList(source, answer).map((s) => s.toLowerCase()) : [answer.toLowerCase()];
  const a = answer.toLowerCase();
  switch (c.op) {
    case "answered": return !!answer;
    case "not_answered": return !answer;
    case "is": return source?.type === "multiselect" ? list.includes(v) : a === v;
    case "is_not": return source?.type === "multiselect" ? !list.includes(v) : a !== v;
    case "contains": return source?.type === "multiselect" ? list.includes(v) : !!v && a.includes(v);
    case "gt": { if (!answer) return false; const d = compare(answer, String(c.value ?? "")); return d !== null && d > 0; }
    case "lt": { if (!answer) return false; const d = compare(answer, String(c.value ?? "")); return d !== null && d < 0; }
    default: return false;
  }
}

/**
 * Which questions are shown for these answers, top to bottom. A condition on a hidden question
 * reads that question as unanswered, so hiding cascades down the form.
 */
export function visibleFieldIds(fields: LogicField[], raw: Record<string, unknown>): Set<string> {
  return fieldStates(fields, raw).shown;
}

/** TD2: whether a logic object holds; a question that is hidden or disabled reads as unanswered. */
function logicHolds(l: FieldLogic, byId: Map<string, LogicField>, active: Set<string>, raw: Record<string, unknown>): boolean {
  const one = (c: LogicCondition) => {
    const src = byId.get(c.field);
    if (!src) return true; // a deleted question never hides anything
    return conditionHolds(src, c, active.has(c.field) ? answerText(src, raw[c.field]) : "");
  };
  const results = [...l.conditions.map(one), ...(l.groups ?? []).map((g) => (g.join === "any" ? g.conditions.some(one) : g.conditions.every(one)))];
  if (!results.length) return true;
  return l.join === "any" ? results.some(Boolean) : results.every(Boolean);
}

export interface FieldStates { shown: Set<string>; disabled: Set<string>; required: Set<string> }

/**
 * Top to bottom: which questions are shown, which are disabled (shown, answer dropped) and which are
 * required for these answers. Shared by the page and the server so a hidden or disabled question can't be forced.
 */
export function fieldStates(fields: LogicField[], raw: Record<string, unknown>): FieldStates {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const shown = new Set<string>(), disabled = new Set<string>(), required = new Set<string>(), active = new Set<string>();
  for (const f of fields) {
    if (hasLogic(f.logic)) {
      const holds = logicHolds(f.logic, byId, active, raw);
      if (f.logic.action === "hide" ? holds : !holds) continue;
    }
    shown.add(f.id);
    if (hasLogic(f.disableWhen) && logicHolds(f.disableWhen, byId, active, raw)) { disabled.add(f.id); continue; }
    active.add(f.id);
    if (f.required || (hasLogic(f.requireWhen) && logicHolds(f.requireWhen, byId, active, raw))) required.add(f.id);
  }
  return { shown, disabled, required };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d$/;
/** TD2: a web address must be http or https with a dot in the host; "example.com" gets https:// in front. */
export function normaliseUrl(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 2000 || /\s/.test(t)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".") || u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}
const realDate = (y: number, m: number, d: number) => { const x = new Date(Date.UTC(y, m - 1, d)); return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d; };

/** Problems with one shown question's answer, in plain words, or null. */
export function fieldError(f: LogicField, text: string, required: boolean = f.required, opts: { strict?: boolean } = {}): string | null {
  const r = f.rules ?? {};
  if (!text) {
    if (!required) return null;
    if (f.type === "file") return `Please add a file for "${f.label}".`;
    if (f.type === "signature") return `Please sign "${f.label}".`;
    return f.type === "multiselect" || f.type === "select" ? `Please choose an answer for "${f.label}".` : `Please fill in "${f.label}".`;
  }
  // TD2 answer types.
  if (f.type === "time" && !TIME.test(text)) return `"${f.label}" should be a time, like 14:30.`;
  if (f.type === "datetime") {
    const m = DATETIME.exec(text);
    if (!m || !realDate(+m[1], +m[2], +m[3])) return `"${f.label}" should be a date and time.`;
  }
  if (f.type === "url" && !normaliseUrl(text)) return `"${f.label}" should be a web address, like example.com.`;
  if (isUpload(f.type)) {
    const ids = text.split(MULTI_SEPARATOR).map((x) => x.trim()).filter(Boolean);
    if (!ids.length || ids.some((x) => !UPLOAD_ID.test(x)) || new Set(ids).size !== ids.length) return `Please add "${f.label}" again.`;
    const most = f.type === "signature" ? 1 : Math.max(1, Math.min(5, f.maxFiles ?? 1));
    if (ids.length > most) return `"${f.label}" takes up to ${most} file${most === 1 ? "" : "s"}.`;
  }
  if (opts.strict && f.type === "phone") {
    const digits = text.replace(/\D/g, "").length;
    if (!/^\+?[\d\s().-]+$/.test(text) || digits < 6 || digits > 15) return `"${f.label}" doesn't look like a phone number.`;
  }
  if (opts.strict && f.type === "date") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (m && !realDate(+m[1], +m[2], +m[3])) return `"${f.label}" should be a date.`;
  }
  if (f.type === "email" && !EMAIL.test(text)) return `"${f.label}" doesn't look like an email address.`;
  if (f.type === "number") {
    const n = num(text);
    if (n === undefined) return `"${f.label}" should be a number.`;
    if (r.min !== undefined && n < r.min) return `"${f.label}" should be ${r.min} or more.`;
    if (r.max !== undefined && n > r.max) return `"${f.label}" should be ${r.max} or less.`;
  }
  if (f.type === "rating") {
    const { min, max } = ratingRange(f);
    const n = num(text);
    if (n === undefined || !Number.isInteger(n) || n < min || n > max) return `Pick a number from ${min} to ${max} for "${f.label}".`;
  }
  if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return `"${f.label}" should be a date.`;
  if (f.type === "select" && f.options?.length && !f.options.includes(text)) return `Pick one of the options for "${f.label}".`;
  if (f.type === "multiselect") {
    const picked = answerList(f, text);
    if (f.options?.length && picked.some((p) => !f.options!.includes(p))) return `Pick from the options for "${f.label}".`;
    if (r.minSelected !== undefined && picked.length < r.minSelected) return `Pick at least ${r.minSelected} for "${f.label}".`;
    if (r.maxSelected !== undefined && picked.length > r.maxSelected) return `Pick up to ${r.maxSelected} for "${f.label}".`;
  }
  if (r.minLength !== undefined && text.length < r.minLength) return `"${f.label}" needs at least ${r.minLength} characters.`;
  if (r.maxLength !== undefined && text.length > r.maxLength) return `"${f.label}" can be up to ${r.maxLength} characters.`;
  if (r.pattern && safePattern(r.pattern) && !new RegExp(`^(?:${r.pattern})$`).test(text)) return r.patternMessage || `"${f.label}" isn't in the expected format.`; // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp (only a pattern safePattern accepted)
  return null;
}

export interface CheckedAnswers { answers: Record<string, string>; errors: Record<string, string>; shown: Set<string>; disabled: Set<string> }

/**
 * Checks a whole submission: hidden questions are skipped and their answers dropped; every
 * shown question gets its required and type rules. `maxLength(f)` caps stored text.
 */
export function checkAnswers(fields: LogicField[], raw: Record<string, unknown>, cap: (f: LogicField) => number = (f) => (f.type === "textarea" ? 10_000 : f.type === "url" ? 2000 : 500), opts: { strict?: boolean } = {}): CheckedAnswers {
  const { shown, disabled, required } = fieldStates(fields, raw);
  const answers: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    // TD2: layout blocks take no answer; a disabled question's answer is dropped like a hidden one's.
    if (!shown.has(f.id) || disabled.has(f.id) || isLayout(f.type)) continue;
    let text = answerText(f, raw[f.id]).slice(0, cap(f));
    const err = fieldError(f, text, required.has(f.id), opts);
    if (err) { errors[f.id] = err; continue; }
    if (f.type === "url" && text) text = normaliseUrl(text) ?? text;
    if (text) answers[f.id] = text;
  }
  return { answers, errors, shown, disabled };
}

/** R31 routing: after a submission, the first rule whose condition holds picks the task's project and assignee. */
export interface FormRoute { when: LogicCondition; projectId?: string | null; assigneeId?: string | null }
export const MAX_ROUTES = 10;

/** The first route that matches these (already checked) answers, or null. */
export function pickRoute<R extends FormRoute>(fields: LogicField[], routes: R[], answers: Record<string, string>): R | null {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return routes.find((r) => byId.has(r.when.field) && conditionHolds(byId.get(r.when.field), r.when, answers[r.when.field] ?? "")) ?? null;
}
