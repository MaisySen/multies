/**
 * R93 Forms plus: the pure rules shared by the server and the pages. Hidden fields and variables for chat style
 * forms, NPS and CSAT scoring, the review rubric, blind review, reviewer assignment, and feedback board statuses.
 */
import type { LogicField } from "./form-logic";

export type FormMode = "classic" | "chat";
export type FormTemplateKind = "nps" | "csat";

export interface RubricCriterion { id: string; label: string; max: number; weight: number }
export interface ReviewSetup { rubric: RubricCriterion[]; perEntry: number; blind: boolean; deadline: string | null }
export interface FormPlus {
  /** Names read from the form link (?ref=ads), stored with the answer, never shown to the visitor. */
  hiddenFields: string[];
  /** The button text of the website chat bubble. */
  bubbleLabel: string;
  template: FormTemplateKind | null;
  review: ReviewSetup | null;
  /** Webhook paused after too many failures in a row. */
  webhookPaused?: boolean;
}

export const MAX_HIDDEN = 10;
export const MAX_CRITERIA = 10;
export const WEBHOOK_PAUSE_AFTER = 10;
export const WEBHOOK_TIMEOUT_MS = 5000;
export const DEFAULT_BUBBLE_LABEL = "Chat with us";

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const clean = (raw: unknown) => String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
const int = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export function normaliseRubric(raw: unknown): RubricCriterion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RubricCriterion[] = [];
  for (const [i, r] of raw.slice(0, MAX_CRITERIA).entries()) {
    const o = (r ?? {}) as Record<string, unknown>;
    const label = String(o.label ?? "").trim().slice(0, 120);
    if (!label) continue;
    let id = clean(o.id) || clean(label) || `c${i + 1}`;
    if (!/^[a-z]/.test(id)) id = `c_${id}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    out.push({ id, label, max: int(o.max, 2, 10, 5), weight: int(o.weight, 1, 5, 1) });
  }
  return out;
}

export function normalisePlus(raw: unknown): FormPlus {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const hidden = Array.isArray(o.hiddenFields) ? [...new Set(o.hiddenFields.map(clean).filter((n) => NAME.test(n)))].slice(0, MAX_HIDDEN) : [];
  const label = String(o.bubbleLabel ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || DEFAULT_BUBBLE_LABEL;
  const template = o.template === "nps" || o.template === "csat" ? o.template : null;
  let review: ReviewSetup | null = null;
  if (o.review && typeof o.review === "object") {
    const r = o.review as Record<string, unknown>;
    const deadline = typeof r.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.deadline) ? r.deadline : null;
    review = { rubric: normaliseRubric(r.rubric), perEntry: int(r.perEntry, 1, 5, 2), blind: r.blind !== false, deadline };
  }
  return { hiddenFields: hidden, bubbleLabel: label, template, review, ...(o.webhookPaused ? { webhookPaused: true } : {}) };
}

export function parsePlus(json: string | null | undefined): FormPlus {
  try { return normalisePlus(JSON.parse(json || "{}")); } catch { return normalisePlus({}); }
}

/** Hidden field values from the link's query, only the names the form lists, each up to 200 characters. */
export function pickHidden(names: string[], params: Record<string, unknown> | URLSearchParams | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!params) return out;
  const get = (k: string) => (params instanceof URLSearchParams ? params.get(k) : (params as Record<string, unknown>)[k]);
  for (const n of names) {
    const v = get(n);
    if (v === undefined || v === null) continue;
    const s = String(v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
    if (s) out[n] = s;
  }
  return out;
}

/** Fills {{name}} with an answer or a hidden value. Unknown names become empty; text is never treated as markup. */
export function fillVariables(text: string, answers: Record<string, unknown>, hidden: Record<string, string> = {}): string {
  return text.replace(/\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/gi, (_m, name: string) => {
    const k = name.toLowerCase();
    const v = answers[k] ?? hidden[k];
    if (v === undefined || v === null) return "";
    return Array.isArray(v) ? v.join(", ") : String(v);
  }).replace(/[ \t]{2,}/g, " ");
}

/** The variable names a text uses (for the builder's hint). */
export function variablesIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/gi)].map((m) => m[1].toLowerCase()))];
}

// ---------------------------------------------------------------- NPS and CSAT

export interface NpsResult { kind: "nps"; n: number; score: number | null; promoters: number; passives: number; detractors: number }
export interface CsatResult { kind: "csat"; n: number; score: number | null; satisfied: number; average: number | null }

/** Net promoter score: share of 9 and 10 minus share of 0 to 6, from minus 100 to 100, rounded. */
export function npsOf(scores: number[]): NpsResult {
  const v = scores.filter((s) => Number.isFinite(s) && s >= 0 && s <= 10).map(Math.round);
  const promoters = v.filter((s) => s >= 9).length, detractors = v.filter((s) => s <= 6).length;
  const passives = v.length - promoters - detractors;
  return { kind: "nps", n: v.length, score: v.length ? Math.round(((promoters - detractors) / v.length) * 100) : null, promoters, passives, detractors };
}

/** Customer satisfaction: share of 4 and 5 on a 1 to 5 scale, as a whole percent. */
export function csatOf(scores: number[]): CsatResult {
  const v = scores.filter((s) => Number.isFinite(s) && s >= 1 && s <= 5).map(Math.round);
  const satisfied = v.filter((s) => s >= 4).length;
  return { kind: "csat", n: v.length, score: v.length ? Math.round((satisfied / v.length) * 100) : null, satisfied, average: v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null };
}

/** The question whose answer is the form's score: the first rating question. */
export function scoreField<F extends Pick<LogicField, "id" | "type">>(fields: F[]): F | undefined {
  return fields.find((f) => f.type === "rating");
}

export interface TemplateField { id: string; label: string; type: LogicField["type"]; required: boolean; rules?: { min: number; max: number }; lowLabel?: string; highLabel?: string; logic?: LogicField["logic"] }
export interface FormTemplate { kind: FormTemplateKind; name: string; description: string; successMessage: string; fields: TemplateField[] }

export const FORM_TEMPLATES: FormTemplate[] = [
  {
    kind: "nps", name: "Net promoter score", description: "A quick question about how likely people are to recommend you.",
    successMessage: "Thanks, your answer helps us get better.",
    fields: [
      { id: "score", label: "How likely are you to recommend us to a friend or colleague?", type: "rating", required: true, rules: { min: 0, max: 10 }, lowLabel: "Not likely", highLabel: "Very likely" },
      { id: "reason", label: "What is the main reason for your score?", type: "textarea", required: false },
      { id: "improve", label: "What one thing would make it a 10?", type: "textarea", required: false, logic: { join: "all", conditions: [{ field: "score", op: "lt", value: "9" }] } },
    ],
  },
  {
    kind: "csat", name: "Customer satisfaction", description: "Ask how satisfied people were after a chat, an order or a visit.",
    successMessage: "Thanks for telling us.",
    fields: [
      { id: "score", label: "How satisfied are you with the help you got?", type: "rating", required: true, rules: { min: 1, max: 5 }, lowLabel: "Not satisfied", highLabel: "Very satisfied" },
      { id: "comment", label: "Anything we could do better?", type: "textarea", required: false },
    ],
  },
];

// ---------------------------------------------------------------- review

/** Weighted rubric score out of 100, or an error message in plain words. */
export function rubricTotal(rubric: RubricCriterion[], scores: Record<string, unknown>): { total: number; scores: Record<string, number> } | { error: string } {
  if (!rubric.length) return { error: "This call has no scoring rubric yet." };
  const out: Record<string, number> = {};
  let got = 0, max = 0;
  for (const c of rubric) {
    const n = Number(scores[c.id]);
    if (!Number.isInteger(n) || n < 1 || n > c.max) return { error: `Give "${c.label}" a score from 1 to ${c.max}.` };
    out[c.id] = n;
    got += n * c.weight;
    max += c.max * c.weight;
  }
  return { total: Math.round((got / max) * 1000) / 10, scores: out };
}

/** Questions a blind reviewer never sees: email and phone, anything that asks for a name, and questions marked to hide. */
export function identityFieldIds(fields: (Pick<LogicField, "id" | "label" | "type"> & { identity?: boolean })[]): Set<string> {
  return new Set(fields.filter((f) => f.identity || f.type === "email" || f.type === "phone" || /(^|_)(name|email|phone|mobile)(_|$)/i.test(f.id) || /\b(name|email|phone|mobile)\b/i.test(f.label)).map((f) => f.id));
}

export function blindAnswers(fields: Parameters<typeof identityFieldIds>[0], answers: Record<string, string>): Record<string, string> {
  const hide = identityFieldIds(fields);
  return Object.fromEntries(Object.entries(answers).filter(([k]) => !hide.has(k)));
}

/**
 * Spreads entries over reviewers so each entry gets up to perEntry different reviewers, the least loaded first.
 * existing: pairs already made (never made twice); load: open assignments per reviewer.
 */
export function assignReviewers(entryIds: string[], reviewerIds: string[], perEntry: number, existing: { entryId: string; reviewerId: string }[] = []): { entryId: string; reviewerId: string }[] {
  const reviewers = [...new Set(reviewerIds)];
  if (!reviewers.length) return [];
  const has = new Map<string, Set<string>>();
  const load = new Map(reviewers.map((r) => [r, 0]));
  for (const p of existing) {
    if (!has.has(p.entryId)) has.set(p.entryId, new Set());
    has.get(p.entryId)!.add(p.reviewerId);
    if (load.has(p.reviewerId)) load.set(p.reviewerId, load.get(p.reviewerId)! + 1);
  }
  const out: { entryId: string; reviewerId: string }[] = [];
  for (const e of entryIds) {
    const got = has.get(e) ?? new Set<string>();
    const need = Math.max(0, Math.min(perEntry, reviewers.length) - got.size);
    const pick = reviewers.filter((r) => !got.has(r)).sort((a, b) => load.get(a)! - load.get(b)! || reviewers.indexOf(a) - reviewers.indexOf(b)).slice(0, need);
    for (const r of pick) { out.push({ entryId: e, reviewerId: r }); load.set(r, load.get(r)! + 1); got.add(r); }
    has.set(e, got);
  }
  return out;
}

// ---------------------------------------------------------------- feedback boards

export type PostStatus = "pending" | "open" | "review" | "planned" | "progress" | "done" | "closed" | "merged";
export const POST_STATUSES: PostStatus[] = ["pending", "open", "review", "planned", "progress", "done", "closed", "merged"];
export const SETTABLE_STATUSES: PostStatus[] = ["open", "review", "planned", "progress", "done", "closed"];
export const STATUS_LABELS: Record<PostStatus, string> = {
  pending: "Waiting for approval", open: "Open", review: "Under review", planned: "Planned", progress: "In progress", done: "Done", closed: "Closed", merged: "Merged",
};
/** What a visitor sees: no posts waiting for approval. Merged posts show only as a link to where they went. */
export const PUBLIC_STATUSES: PostStatus[] = ["open", "review", "planned", "progress", "done", "closed"];
export const ROADMAP_COLUMNS: PostStatus[] = ["planned", "progress", "done"];

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
export const normEmail = (s: string) => s.trim().toLowerCase();
