/**
 * R31: a form's results. Responses as a table (sort, search, date filter, pages), a summary per
 * question (counts for choices, average/min/max for numbers, latest answers for text), a CSV
 * export, and setting one question's logic and rules. Reads go page by page so a busy form never
 * pulls every row in one statement, and nothing here writes except form_logic_set.
 */
import { and, asc, desc, eq, gte, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { formSubmissions, forms } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { answerList, isLayout, normaliseLogic, normaliseRules, type FieldLogic, type FieldRules } from "@/shared/form-logic";
import type { SuiteActor } from "./common";
import { normaliseFields, updateForm, type FormField } from "./forms";
import { containsText } from "../../lib/like-search";
import { filesFor } from "../forms-td2/uploads";
import { featureOn } from "../console/flags"; // OPS1 feature flags

/** Rows read per page while building a summary or an export. */
export const RESULTS_PAGE = 500;
/** A summary or export looks at the newest this many responses at most. */
export const RESULTS_SCAN_MAX = 10_000;

export interface ResponsesQuery { q?: string; from?: string; to?: string; sort?: string; dir?: "asc" | "desc"; limit?: number; offset?: number }

async function formFor(deps: Deps, orgId: string, id: string) {
  const f = await deps.db.select().from(forms).where(and(eq(forms.orgId, orgId), eq(forms.id, id), isNull(forms.deletedAt))).get();
  if (!f) throw notFound("Form");
  return { row: f, fields: JSON.parse(f.fields) as FormField[] };
}

function day(v: string | undefined, end = false): Date | undefined {
  if (!v) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) throw new HttpError(422, "validation_failed", "Dates look like 2026-10-26.");
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw new HttpError(422, "validation_failed", "Dates look like 2026-10-26.");
  return end && v.length === 10 ? new Date(d.getTime() + 86_400_000) : d;
}

function where(formId: string, q: ResponsesQuery): SQL {
  const parts: SQL[] = [eq(formSubmissions.formId, formId)];
  const from = day(q.from), to = day(q.to, true);
  if (from) parts.push(gte(formSubmissions.createdAt, from));
  if (to) parts.push(lt(formSubmissions.createdAt, to));
  const term = (q.q ?? "").trim().slice(0, 100);
  if (term) parts.push(containsText(formSubmissions.data, term));
  return and(...parts)!;
}

function present(s: typeof formSubmissions.$inferSelect) {
  return { id: s.id, answers: JSON.parse(s.data) as Record<string, string>, entityType: s.entityType, entityId: s.entityId, createdAt: s.createdAt.toISOString() };
}

/** One page of responses, newest first unless sorted by a question (sort: "createdAt" or a field id). */
export async function formResponses(deps: Deps, orgId: string, formId: string, q: ResponsesQuery = {}) {
  const { fields: allFields } = await formFor(deps, orgId, formId);
  const fields = allFields.filter((x) => !isLayout(x.type)); // TD2: layout blocks take no answer
  const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const dir = q.dir === "asc" ? asc : desc;
  const sortField = q.sort && q.sort !== "createdAt" ? fields.find((f) => f.id === q.sort) : undefined;
  if (q.sort && q.sort !== "createdAt" && !sortField) throw new HttpError(422, "validation_failed", "Sort by createdAt or one of the form's question ids.");
  const w = where(formId, q);
  const order = sortField
    ? (sortField.type === "number"
      ? [dir(sql`cast(json_extract(${formSubmissions.data}, ${`$.${sortField.id}`}) as real)`), dir(formSubmissions.id)]
      : [dir(sql`lower(coalesce(json_extract(${formSubmissions.data}, ${`$.${sortField.id}`}), ''))`), dir(formSubmissions.id)])
    : [dir(formSubmissions.createdAt), dir(formSubmissions.id)];
  const [rows, total] = await Promise.all([
    deps.db.select().from(formSubmissions).where(w).orderBy(...order).limit(limit).offset(offset),
    deps.db.select({ n: sql<number>`count(*)` }).from(formSubmissions).where(w).get(),
  ]);
  return {
    fields: fields.map((f) => ({ id: f.id, label: f.label, type: f.type })),
    responses: rows.map(present), total: Number(total?.n ?? 0), limit, offset,
    // TD2: each response's files and signatures (names and sizes only; bytes open through the signed in file path).
    ...(featureOn(deps, "formsTd2", orgId) ? { files: await filesFor(deps, orgId, formId, rows.map((r) => r.id)) } : {}),
  };
}

/** Walks the matching responses newest first, a page at a time, up to RESULTS_SCAN_MAX. */
async function* scan(deps: Deps, formId: string, q: ResponsesQuery) {
  const w = where(formId, q);
  let cursor: string | undefined;
  let seen = 0;
  while (seen < RESULTS_SCAN_MAX) {
    const page = await deps.db.select().from(formSubmissions)
      .where(cursor ? and(w, lt(formSubmissions.id, cursor)) : w)
      .orderBy(desc(formSubmissions.id)).limit(Math.min(RESULTS_PAGE, RESULTS_SCAN_MAX - seen));
    if (!page.length) return;
    for (const r of page) yield r;
    seen += page.length;
    if (page.length < RESULTS_PAGE) return;
    cursor = page[page.length - 1].id;
  }
}

export type QuestionSummary =
  | { id: string; label: string; type: string; kind: "choice"; answered: number; counts: { option: string; count: number }[] }
  | { id: string; label: string; type: string; kind: "number"; answered: number; average: number | null; min: number | null; max: number | null }
  | { id: string; label: string; type: string; kind: "text"; answered: number; latest: { answer: string; at: string }[] };

/** A summary per question over the matching responses. */
export async function formSummary(deps: Deps, orgId: string, formId: string, q: Pick<ResponsesQuery, "from" | "to" | "q"> = {}) {
  const { fields: allFields } = await formFor(deps, orgId, formId);
  const fields = allFields.filter((x) => !isLayout(x.type)); // TD2: layout blocks take no answer
  const acc = fields.map((f) => ({ f, answered: 0, counts: new Map<string, number>((f.options ?? []).map((o) => [o, 0])), sum: 0, nums: 0, min: Infinity, max: -Infinity, latest: [] as { answer: string; at: string }[] }));
  let total = 0, first: string | null = null, last: string | null = null;
  for await (const r of scan(deps, formId, q)) {
    total++;
    const at = r.createdAt.toISOString();
    if (!last) last = at;
    first = at;
    const answers = JSON.parse(r.data) as Record<string, string>;
    for (const a of acc) {
      const v = answers[a.f.id];
      if (!v) continue;
      a.answered++;
      if (a.f.type === "select" || a.f.type === "multiselect") for (const o of answerList(a.f, v)) a.counts.set(o, (a.counts.get(o) ?? 0) + 1);
      else if (a.f.type === "number") { const n = Number(v); if (Number.isFinite(n)) { a.sum += n; a.nums++; a.min = Math.min(a.min, n); a.max = Math.max(a.max, n); } }
      else if (a.latest.length < 5) a.latest.push({ answer: v.slice(0, 280), at });
    }
  }
  const questions: QuestionSummary[] = acc.map((a) => {
    const base = { id: a.f.id, label: a.f.label, type: a.f.type, answered: a.answered };
    if (a.f.type === "select" || a.f.type === "multiselect") return { ...base, kind: "choice" as const, counts: [...a.counts].map(([option, count]) => ({ option, count })) };
    if (a.f.type === "number") return { ...base, kind: "number" as const, average: a.nums ? Math.round((a.sum / a.nums) * 100) / 100 : null, min: a.nums ? a.min : null, max: a.nums ? a.max : null };
    return { ...base, kind: "text" as const, latest: a.latest };
  });
  return { total, firstAt: first, lastAt: last, capped: total >= RESULTS_SCAN_MAX, questions };
}

/** A spreadsheet cell: quoted, and a leading = + - @ is defused so a spreadsheet never runs it. */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Every matching response as CSV (newest first, up to RESULTS_SCAN_MAX rows). */
export async function formResponsesCsv(deps: Deps, orgId: string, formId: string, q: Pick<ResponsesQuery, "from" | "to" | "q"> = {}) {
  const { row, fields: allFields } = await formFor(deps, orgId, formId);
  const fields = allFields.filter((x) => !isLayout(x.type)); // TD2: layout blocks take no answer
  const lines = [["Submitted at", ...fields.map((f) => f.label)].map(csvCell).join(",")];
  for await (const r of scan(deps, formId, q)) {
    const a = JSON.parse(r.data) as Record<string, string>;
    lines.push([r.createdAt.toISOString(), ...fields.map((f) => a[f.id] ?? "")].map(csvCell).join(","));
  }
  const name = row.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "form";
  return { filename: `${name}-responses.csv`, csv: lines.join("\r\n") + "\r\n" };
}

export interface LogicInput { logic?: FieldLogic | null; rules?: FieldRules | null; required?: boolean }

/** Sets one question's "show if" logic, answer rules and required switch, with the same checks as saving the form. */
export async function setFieldLogic(deps: Deps, actor: SuiteActor, formId: string, fieldId: string, input: LogicInput) {
  const { fields } = await formFor(deps, actor.orgId, formId);
  const at = fields.findIndex((f) => f.id === fieldId);
  if (at < 0) throw notFound("Question");
  const next = fields.map((f, i) => {
    if (i !== at) return f;
    const out: FormField = { ...f };
    if (input.required !== undefined) out.required = !!input.required;
    if (input.logic !== undefined) { const l = normaliseLogic(input.logic, { td2: featureOn(deps, "formsTd2", actor.orgId) }); if (l) out.logic = l; else delete out.logic; }
    if (input.rules !== undefined) { const r = normaliseRules(f.type, input.rules); if (r) out.rules = r; else delete out.rules; }
    return out;
  });
  normaliseFields(next, { td2: featureOn(deps, "formsTd2", actor.orgId) }); // throws 422 with the problem before anything is written
  const form = await updateForm(deps, actor, formId, { fields: next });
  return { form, field: form.fields.find((f) => f.id === fieldId)! };
}
