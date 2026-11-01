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
export type FormFieldType = "text" | "email" | "textarea" | "phone" | "select" | "multiselect" | "number" | "date" | "rating";
export const FORM_FIELD_TYPES: FormFieldType[] = ["text", "email", "textarea", "phone", "select", "multiselect", "number", "date", "rating"];

export type LogicOp = "is" | "is_not" | "contains" | "answered" | "not_answered" | "gt" | "lt";
export const LOGIC_OPS: LogicOp[] = ["is", "is_not", "contains", "answered", "not_answered", "gt", "lt"];
export const LOGIC_OP_LABELS: Record<LogicOp, string> = {
  is: "is", is_not: "is not", contains: "contains", answered: "is answered", not_answered: "is not answered", gt: "is greater than", lt: "is less than",
};
/** Operators that need no value. */
export const VALUELESS_OPS: LogicOp[] = ["answered", "not_answered"];

export interface LogicCondition { field: string; op: LogicOp; value?: string }
export interface FieldLogic { join: "all" | "any"; conditions: LogicCondition[] }
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
  const ids = new Set(fields.map((f) => f.id));
  return fields.map((f) => {
    if (!f.logic) return f;
    const conditions = f.logic.conditions.filter((c) => ids.has(c.field));
    return { ...f, logic: conditions.length ? { join: f.logic.join === "any" ? "any" : "all", conditions } : null };
  });
}

/** Finds a loop in "shown if" references (A depends on B depends on A). Returns the ids in the loop, or null. */
export function findCycle(fields: Pick<LogicField, "id" | "logic">[]): string[] | null {
  const deps = new Map(fields.map((f) => [f.id, (f.logic?.conditions ?? []).map((c) => c.field)]));
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
    const conds = f.logic?.conditions ?? [];
    if (conds.length > MAX_CONDITIONS) problems.push({ field: f.id, code: "too_many", message: `"${f.label}" can have up to ${MAX_CONDITIONS} conditions.` });
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
  try { new RegExp(`^(?:${p})$`); return true; } catch { return false; }
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
export function normaliseLogic(raw: unknown): FieldLogic | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { join?: unknown; conditions?: unknown };
  if (!Array.isArray(r.conditions) || !r.conditions.length) return null;
  const conditions = r.conditions.map((c) => {
    const x = (c ?? {}) as { field?: unknown; op?: unknown; value?: unknown };
    const op = String(x.op ?? "") as LogicOp;
    const value = x.value === undefined || x.value === null ? undefined : String(x.value).slice(0, 200);
    return { field: String(x.field ?? "").trim().slice(0, 40), op, ...(value !== undefined && !VALUELESS_OPS.includes(op) ? { value } : {}) };
  });
  return { join: r.join === "any" ? "any" : "all", conditions };
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
  const byId = new Map(fields.map((f) => [f.id, f]));
  const shown = new Set<string>();
  for (const f of fields) {
    const conds = f.logic?.conditions ?? [];
    if (!conds.length) { shown.add(f.id); continue; }
    const results = conds.map((c) => {
      const src = byId.get(c.field);
      if (!src) return true; // a deleted question never hides anything
      const ans = shown.has(c.field) ? answerText(src, raw[c.field]) : "";
      return conditionHolds(src, c, ans);
    });
    if (f.logic?.join === "any" ? results.some(Boolean) : results.every(Boolean)) shown.add(f.id);
  }
  return shown;
}

/** Problems with one shown question's answer, in plain words, or null. */
export function fieldError(f: LogicField, text: string): string | null {
  const r = f.rules ?? {};
  if (!text) return f.required ? (f.type === "multiselect" || f.type === "select" ? `Please choose an answer for "${f.label}".` : `Please fill in "${f.label}".`) : null;
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
  if (r.pattern && safePattern(r.pattern) && !new RegExp(`^(?:${r.pattern})$`).test(text)) return r.patternMessage || `"${f.label}" isn't in the expected format.`;
  return null;
}

export interface CheckedAnswers { answers: Record<string, string>; errors: Record<string, string>; shown: Set<string> }

/**
 * Checks a whole submission: hidden questions are skipped and their answers dropped; every
 * shown question gets its required and type rules. `maxLength(f)` caps stored text.
 */
export function checkAnswers(fields: LogicField[], raw: Record<string, unknown>, cap: (f: LogicField) => number = (f) => (f.type === "textarea" ? 10_000 : 500)): CheckedAnswers {
  const shown = visibleFieldIds(fields, raw);
  const answers: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (!shown.has(f.id)) continue;
    const text = answerText(f, raw[f.id]).slice(0, cap(f));
    const err = fieldError(f, text);
    if (err) { errors[f.id] = err; continue; }
    if (text) answers[f.id] = text;
  }
  return { answers, errors, shown };
}

/** R31 routing: after a submission, the first rule whose condition holds picks the task's project and assignee. */
export interface FormRoute { when: LogicCondition; projectId?: string | null; assigneeId?: string | null }
export const MAX_ROUTES = 10;

/** The first route that matches these (already checked) answers, or null. */
export function pickRoute<R extends FormRoute>(fields: LogicField[], routes: R[], answers: Record<string, string>): R | null {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return routes.find((r) => byId.has(r.when.field) && conditionHolds(byId.get(r.when.field), r.when, answers[r.when.field] ?? "")) ?? null;
}
