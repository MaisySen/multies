/**
 * Public forms: a link anyone can fill in (/f/<slug>). Each submission makes a task (with the
 * answers in its notes) or a contact. Spam protection: Cloudflare Turnstile when it is set up,
 * plus a hidden honeypot field, a minimum fill time and a per-sender rate limit, always.
 */
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { formSubmissions, forms, organizations } from "../../db/schema";
import { hmacSha256Hex, randomToken } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, createdBy, iso, recordWrite, sortableId, type SuiteActor } from "./common";
import { createTask, getProject, parseAssignee, validateAssignee } from "./tasks";
import { requireShield } from "../spam-shield";
import { releaseCap, reserveCap, td7Completed, td7Guard, td7Public } from "../forms-td7/pro"; // TD7
import { deliverWebhook, formsPlusOn, submissionExtras, webhookPayload } from "../forms-plus/plus";
import { fillVariables, parsePlus, pickHidden } from "@/shared/forms-plus";
import type { ShieldAnswer } from "@/shared/spam-shield";
import { checkAnswers, checkLogic, cleanLogic, FORM_FIELD_TYPES, isLayout, isUpload, LOGIC_OPS, MAX_ROUTES, normaliseLogic, normaliseRules, pickRoute, TD2_FIELD_TYPES, VALUELESS_OPS, type FieldLogic, type FormFieldType, type FormRoute, type LogicField } from "@/shared/form-logic";
import { FILE_KINDS, parseTd2, type Td2Settings } from "@/shared/forms-td2";
import { attachUploads, checkFormImages, releaseUploads, uploadSummary } from "../forms-td2/uploads";

export type FieldType = FormFieldType;
/** R31: a field can carry "show this question if" logic and answer rules (src/shared/form-logic.ts). */
export interface FormField extends LogicField { placeholder?: string }
type FormRow = typeof forms.$inferSelect;

/** Submissions allowed from one sender per form in ten minutes. */
export const SUBMISSIONS_PER_WINDOW = 5;
/** A real person takes longer than this to fill in a form; bots post at once. */
export const MIN_FILL_MS = 1500;

export const DEFAULT_TASK_FIELDS: FormField[] = [
  { id: "name", label: "Your name", type: "text", required: true },
  { id: "email", label: "Email", type: "email", required: true },
  { id: "subject", label: "What do you need?", type: "text", required: true },
  { id: "details", label: "Details", type: "textarea", required: false },
];

const fieldId = (raw: unknown) => String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

/** TD2: a layout block that needs no label of its own gets a plain one. */
const LAYOUT_LABEL: Partial<Record<FieldType, string>> = { paragraph: "Text", divider: "Divider", image: "Image", page: "Page" };
const KIND_IDS = FILE_KINDS.map((k) => k.id as string);

export function normaliseFields(input: unknown, opts: { td2?: boolean } = {}): FormField[] {
  const td2 = !!opts.td2;
  if (!Array.isArray(input) || !input.length) throw new HttpError(422, "validation_failed", "A form needs at least one field.");
  // TD2: layout blocks don't count toward the 30 questions; 60 items in all.
  if (td2 ? input.length > 60 : input.length > 30) throw new HttpError(422, "validation_failed", td2 ? "A form can have up to 60 items." : "A form can have up to 30 fields.");
  if (td2 && input.filter((x) => !isLayout((x as Partial<FormField>)?.type)).length > 30) throw new HttpError(422, "validation_failed", "A form can have up to 30 questions.");
  const seen = new Set<string>();
  const fields = input.map((raw, i) => {
    const f = raw as Partial<FormField>;
    // Off: a new type is refused exactly as the request check did before TD2.
    if (!td2 && TD2_FIELD_TYPES.includes(f.type as FieldType) && !FORM_FIELD_TYPES.includes(f.type as FieldType)) throw new HttpError(422, "validation_failed", `Invalid option: expected one of ${FORM_FIELD_TYPES.map((x) => `"${x}"`).join("|")}`, { fields: { [`fields.${i}.type`]: "Invalid option" } });
    const type = (td2 ? TD2_FIELD_TYPES : FORM_FIELD_TYPES).includes(f.type as FieldType) ? (f.type as FieldType) : "text";
    const label = String(f.label ?? "").trim().slice(0, 120) || (td2 ? LAYOUT_LABEL[type] ?? "" : "");
    if (!label) throw new HttpError(422, "validation_failed", `Field ${i + 1} needs a label.`);
    let id = fieldId(f.id) || `field_${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    const withOptions = type === "select" || type === "multiselect";
    const options = withOptions ? (Array.isArray(f.options) ? [...new Set(f.options.map((o) => String(o).trim().slice(0, 120)).filter(Boolean))].slice(0, 50) : []) : undefined;
    if (withOptions && !options?.length) throw new HttpError(422, "validation_failed", `"${label}" needs at least one option.`);
    const ids = (l: FieldLogic | null) => { if (l) { l.conditions = l.conditions.map((c) => ({ ...c, field: fieldId(c.field) })); l.groups = l.groups?.map((g) => ({ ...g, conditions: g.conditions.map((c) => ({ ...c, field: fieldId(c.field) })) })); if (!l.groups) delete l.groups; } return l; };
    const logic = ids(normaliseLogic(f.logic, { td2 }));
    const rules = normaliseRules(type, f.rules);
    const layout = td2 && isLayout(type);
    // TD2: "required when" and "disabled when" on questions; upload limits; layout block content.
    const requireWhen = td2 && !layout ? ids(normaliseLogic(f.requireWhen, { td2 })) : null;
    const disableWhen = td2 && !layout ? ids(normaliseLogic(f.disableWhen, { td2 })) : null;
    if (td2 && type === "paragraph" && !String(f.text ?? "").trim()) throw new HttpError(422, "validation_failed", `Text block ${i + 1} needs some text.`);
    if (td2 && type === "image" && !/^[A-Za-z0-9_-]{4,64}$/.test(String(f.imageId ?? ""))) throw new HttpError(422, "validation_failed", `Image block ${i + 1} needs an image from Files.`);
    const extra: Partial<FormField> = !td2 ? {} : {
      ...(requireWhen ? { requireWhen } : {}), ...(disableWhen ? { disableWhen } : {}),
      ...(type === "file" ? {
        fileTypes: Array.isArray(f.fileTypes) ? [...new Set(f.fileTypes.map(String).filter((k) => KIND_IDS.includes(k)))] : [],
        maxSizeMb: Math.max(1, Math.min(10, Math.round(Number(f.maxSizeMb) || 10))),
        maxFiles: Math.max(1, Math.min(5, Math.round(Number(f.maxFiles) || 1))),
      } : {}),
      ...(type === "rating" && f.display === "stars" ? { display: "stars" as const } : {}),
      ...((type === "paragraph" || type === "heading") && f.text ? { text: String(f.text).trim().slice(0, 2000) } : {}),
      ...(type === "image" ? { imageId: String(f.imageId), imageAlt: String(f.imageAlt ?? "").trim().slice(0, 200) } : {}),
    };
    if (extra.fileTypes && !extra.fileTypes.length) delete extra.fileTypes;
    return {
      id, label, type, required: layout ? false : !!f.required, ...(options ? { options } : {}), ...(f.placeholder && !layout ? { placeholder: String(f.placeholder).slice(0, 120) } : {}),
      ...(logic ? { logic } : {}), ...(rules ? { rules } : {}), ...extra,
      // R93: hide from blind reviewers; a rating scale's end labels.
      ...(f.identity ? { identity: true } : {}),
      ...(type === "rating" && f.lowLabel ? { lowLabel: String(f.lowLabel).trim().slice(0, 40) } : {}),
      ...(type === "rating" && f.highLabel ? { highLabel: String(f.highLabel).trim().slice(0, 40) } : {}),
    } as FormField;
  });
  // R31: a condition on a question that is gone is dropped; loops and conditions on later questions are refused.
  const cleaned = cleanLogic(fields).map((f) => {
    const out = { ...f } as FormField & Record<string, unknown>;
    for (const k of ["logic", "requireWhen", "disableWhen"] as const) if (out[k] === null) delete out[k];
    return out as FormField;
  });
  const problems = checkLogic(cleaned);
  if (problems.length) throw new HttpError(422, "validation_failed", problems[0].message, { field: problems[0].field, code: problems[0].code, problems });
  return cleaned;
}

function present(f: FormRow, origin?: string, td2?: boolean) {
  return {
    id: f.id, name: f.name, description: f.description, slug: f.slug, url: `${origin ?? ""}/f/${f.slug}`,
    target: f.target, projectId: f.projectId, assigneeId: f.assigneeType && f.assigneeId ? `${f.assigneeType}:${f.assigneeId}` : null,
    fields: JSON.parse(f.fields) as FormField[], successMessage: f.successMessage, enabled: f.enabled,
    submitCount: f.submitCount, lastSubmitAt: iso(f.lastSubmitAt), triage: !!f.triage, routing: JSON.parse(f.routing || "[]") as FormRoute[], createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString(), version: f.version,
    // R93: chat style and the Forms plus settings (secret never included).
    mode: f.mode ?? "classic", plus: parsePlus(f.plus), hasWebhook: !!f.webhookUrl,
    // TD2: progress bar and one question at a time (only with FORMS_TD2 on).
    ...(td2 ? { td2: parseTd2(f.td2) } : {}),
  };
}
export type Form = ReturnType<typeof present>;

async function formRow(deps: Deps, orgId: string, id: string) {
  const f = await deps.db.select().from(forms).where(and(eq(forms.orgId, orgId), eq(forms.id, id), isNull(forms.deletedAt))).get();
  if (!f) throw notFound("Form");
  return f;
}

export async function listForms(deps: Deps, orgId: string) {
  const origin = deps.config.appUrl;
  return (await deps.db.select().from(forms).where(and(eq(forms.orgId, orgId), isNull(forms.deletedAt))).orderBy(desc(forms.createdAt))).map((f) => present(f, origin, !!deps.config.formsTd2));
}

export async function getForm(deps: Deps, orgId: string, id: string) {
  const f = await formRow(deps, orgId, id);
  const recent = await deps.db.select().from(formSubmissions).where(eq(formSubmissions.formId, f.id)).orderBy(desc(formSubmissions.createdAt)).limit(50);
  return {
    form: present(f, deps.config.appUrl, !!deps.config.formsTd2),
    submissions: recent.map((s) => ({ id: s.id, data: JSON.parse(s.data) as Record<string, string>, entityType: s.entityType, entityId: s.entityId, createdAt: s.createdAt.toISOString() })),
  };
}

export interface FormInput { /** R31: the first matching rule picks the task's project and assignee. */ routing?: unknown; name: string; description?: string; target?: "task" | "contact" | "review"; projectId?: string | null; assigneeId?: string | null; fields?: unknown; successMessage?: string; enabled?: boolean; /** R21: submissions wait in Triage. */ triage?: boolean; /** TD2: progress bar and one question at a time. */ td2?: Partial<Td2Settings> }

/**
 * R31: checks routing rules against the form's questions and this workspace's projects and people.
 * A rule on a question that is gone is dropped, like a "show if" condition.
 */
export async function normaliseRouting(deps: Deps, orgId: string, fields: FormField[], raw: unknown): Promise<FormRoute[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(422, "validation_failed", "Routing is a list of rules.");
  if (raw.length > MAX_ROUTES) throw new HttpError(422, "validation_failed", `A form can have up to ${MAX_ROUTES} routing rules.`);
  const ids = new Set(fields.map((f) => f.id));
  const out: FormRoute[] = [];
  for (const r of raw as { when?: { field?: unknown; op?: unknown; value?: unknown }; projectId?: unknown; assigneeId?: unknown }[]) {
    const field = String(r?.when?.field ?? "").trim();
    if (!ids.has(field)) continue;
    const op = String(r?.when?.op ?? "") as FormRoute["when"]["op"];
    if (!LOGIC_OPS.includes(op)) throw new HttpError(422, "validation_failed", "A routing rule has a condition we don't understand.");
    const value = r?.when?.value === undefined || r?.when?.value === null ? "" : String(r.when.value).slice(0, 200);
    if (!VALUELESS_OPS.includes(op) && !value.trim()) throw new HttpError(422, "validation_failed", "A routing rule needs a value to match.");
    const projectId = r.projectId ? String(r.projectId) : null;
    const assigneeId = r.assigneeId ? String(r.assigneeId) : null;
    if (!projectId && !assigneeId) throw new HttpError(422, "validation_failed", "A routing rule needs a project or a person.");
    if (projectId) await getProject(deps, orgId, projectId);
    if (assigneeId) await validateAssignee(deps, orgId, parseAssignee(assigneeId));
    out.push({ when: { field, op, ...(VALUELESS_OPS.includes(op) ? {} : { value }) }, projectId, assigneeId });
  }
  return out;
}

function checkTarget(target: "task" | "contact" | "review", fields: FormField[]) {
  if (target === "contact" && !fields.some((f) => f.type === "email")) throw new HttpError(422, "validation_failed", "A form that makes contacts needs an email field.");
}

export async function createForm(deps: Deps, actor: SuiteActor, input: FormInput, opts: { id?: string; retry?: boolean } = {}) {
  assertWritable(actor);
  if (opts.id && opts.retry && await deps.db.select({ id: forms.id }).from(forms).where(and(eq(forms.id, opts.id), eq(forms.orgId, actor.orgId))).get()) return present(await formRow(deps, actor.orgId, opts.id), deps.config.appUrl, !!deps.config.formsTd2); // R52 (MB-239): a retry under the same Idempotency-Key returns what the first attempt made
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new HttpError(422, "validation_failed", "Give the form a name.");
  const target = input.target ?? "task";
  if (target === "review" && !(await formsPlusOn(deps, actor.orgId))) throw new HttpError(422, "validation_failed", "Calls for submissions aren't on for this workspace.");
  const td2On = !!deps.config.formsTd2;
  const fields = normaliseFields(input.fields ?? (target === "task" ? DEFAULT_TASK_FIELDS : DEFAULT_TASK_FIELDS.slice(0, 2)), { td2: td2On });
  checkTarget(target, fields);
  if (td2On) await checkFormImages(deps, actor.orgId, fields);
  const assignee = parseAssignee(input.assigneeId ?? null);
  // The project and the assignee must be this workspace's own (another workspace's id is a 404).
  if (input.projectId) await getProject(deps, actor.orgId, input.projectId);
  await validateAssignee(deps, actor.orgId, assignee);
  const now = deps.now();
  const id = opts.id ?? sortableId("frm", now.getTime());
  await deps.db.insert(forms).values({
    id, orgId: actor.orgId, name, description: (input.description ?? "").slice(0, 2000), slug: randomToken(9).replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toLowerCase(),
    target, projectId: input.projectId ?? null, assigneeType: assignee?.type ?? null, assigneeId: assignee?.id ?? null,
    fields: JSON.stringify(fields), successMessage: (input.successMessage ?? "Thanks, we got it. We'll be in touch.").slice(0, 500), enabled: input.enabled ?? true,
    triage: input.triage ?? false,
    routing: JSON.stringify(await normaliseRouting(deps, actor.orgId, fields, input.routing)),
    ...(td2On && input.td2 ? { td2: JSON.stringify(parseTd2(input.td2)) } : {}),
    ...createdBy(actor), createdAt: now, updatedAt: now,
  });
  await recordWrite(deps, actor, { entityType: "form", entityId: id, op: "create", verb: "form.created", data: { name } });
  return present(await formRow(deps, actor.orgId, id), deps.config.appUrl, !!deps.config.formsTd2);
}

export async function updateForm(deps: Deps, actor: SuiteActor, id: string, patch: Partial<FormInput>) {
  assertWritable(actor);
  const f = await formRow(deps, actor.orgId, id);
  const set: Partial<FormRow> = { updatedAt: deps.now(), version: f.version + 1 };
  if (patch.name !== undefined) { const n = patch.name.trim().slice(0, 120); if (!n) throw new HttpError(422, "validation_failed", "Give the form a name."); set.name = n; }
  if (patch.description !== undefined) set.description = patch.description.slice(0, 2000);
  if (patch.target !== undefined) {
    if (patch.target === "review" && f.target !== "review" && !(await formsPlusOn(deps, actor.orgId))) throw new HttpError(422, "validation_failed", "Calls for submissions aren't on for this workspace.");
    set.target = patch.target;
  }
  if (patch.projectId !== undefined) { if (patch.projectId) await getProject(deps, actor.orgId, patch.projectId); set.projectId = patch.projectId; }
  if (patch.assigneeId !== undefined) { const a = parseAssignee(patch.assigneeId); await validateAssignee(deps, actor.orgId, a); set.assigneeType = a?.type ?? null; set.assigneeId = a?.id ?? null; }
  if (patch.fields !== undefined) {
    const next = normaliseFields(patch.fields, { td2: !!deps.config.formsTd2 });
    if (deps.config.formsTd2) await checkFormImages(deps, actor.orgId, next);
    set.fields = JSON.stringify(next);
  }
  if (patch.td2 !== undefined && deps.config.formsTd2) set.td2 = JSON.stringify(parseTd2({ ...parseTd2(f.td2), ...(patch.td2 ?? {}) }));
  if (patch.successMessage !== undefined) set.successMessage = patch.successMessage.slice(0, 500);
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.triage !== undefined) set.triage = patch.triage;
  // R31: routing is checked against the fields being saved; new fields drop rules on removed questions.
  if (patch.routing !== undefined || patch.fields !== undefined) {
    const nextFields = JSON.parse(set.fields ?? f.fields) as FormField[];
    set.routing = JSON.stringify(await normaliseRouting(deps, actor.orgId, nextFields, patch.routing !== undefined ? patch.routing : JSON.parse(f.routing || "[]")));
  }
  checkTarget((set.target ?? f.target) as "task" | "contact" | "review", JSON.parse(set.fields ?? f.fields) as FormField[]);
  await deps.db.update(forms).set(set).where(eq(forms.id, id));
  await recordWrite(deps, actor, { entityType: "form", entityId: id, op: "update", version: f.version + 1, verb: "form.updated" });
  return present(await formRow(deps, actor.orgId, id), deps.config.appUrl, !!deps.config.formsTd2);
}

export async function deleteForm(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const f = await formRow(deps, actor.orgId, id);
  await deps.db.update(forms).set({ deletedAt: deps.now(), enabled: false, updatedAt: deps.now(), version: f.version + 1 }).where(eq(forms.id, id));
  await recordWrite(deps, actor, { entityType: "form", entityId: id, op: "delete", version: f.version + 1, verb: "form.deleted" });
  return { ok: true };
}

/** TD7: a public upload to a closed form is refused, and a password form needs its access token first. */
export async function td7UploadGate(deps: Deps, slug: string, access: unknown) {
  if (!deps.config.formsTd7) return;
  await td7Guard(deps, await publicRow(deps, slug), access);
}

async function publicRow(deps: Deps, slug: string) {
  const f = await deps.db.select().from(forms).where(and(eq(forms.slug, slug.toLowerCase()), isNull(forms.deletedAt))).get();
  if (!f || !f.enabled) throw notFound("Form");
  return f;
}

/** What the public form page needs: no ids, no workspace details beyond its name. */
export async function publicForm(deps: Deps, slug: string, opts: { access?: unknown } = {}) {
  const f = await publicRow(deps, slug);
  const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, f.orgId)).get();
  // TD7: a closed or locked form shows its name only; no questions until it is open and unlocked.
  const td7 = await td7Public(deps, f, opts.access);
  if (td7 && (td7.closed || td7.locked)) return { name: f.name, description: td7.closed ? "" : f.description, fields: [] as FormField[], workspace: org?.name ?? "", turnstileSiteKey: null, td7 };
  // R93: chat style, the hidden field names, the bubble label, and whether the spam shield is needed.
  const plusOn = await formsPlusOn(deps, f.orgId);
  const plus = plusOn ? parsePlus(f.plus) : null;
  return {
    name: f.name, description: f.description, fields: JSON.parse(f.fields) as FormField[], workspace: org?.name ?? "", turnstileSiteKey: deps.config.turnstile?.siteKey ?? null,
    ...(plus ? { plus: { mode: f.mode === "chat" ? "chat" : "classic", hiddenFields: plus.hiddenFields, bubbleLabel: plus.bubbleLabel, review: f.target === "review", deadline: plus.review?.deadline ?? null } } : {}),
    // TD2: layout and pages; an image block's file id stays private (the page loads it through the form's own image path).
    ...(deps.config.formsTd2 ? { td2: parseTd2(f.td2), fields: (JSON.parse(f.fields) as FormField[]).map((x) => (x.type === "image" ? { ...x, imageId: undefined, hasImage: true } : x)) } : {}),
    ...(td7 ? { td7 } : {}),
  };
}

export async function verifyTurnstile(deps: Deps, token: string | undefined, ip: string) {
  const ts = deps.config.turnstile;
  if (!ts) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: ts.secretKey, response: token, remoteip: ip });
    const res = await deps.fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    const j = (await res.json()) as { success?: boolean };
    return !!j.success;
  } catch (err) {
    deps.reportError?.(err, { where: "turnstile" });
    return false;
  }
}

/**
 * Checks a submission against the form (R31: shared with the public page, src/shared/form-logic.ts).
 * Hidden questions are skipped and never required. Problems answer 400 with every field's error
 * in details.fields, and details.field names the first one.
 */
export function validateAnswers(fields: FormField[], raw: Record<string, unknown>, opts: { strict?: boolean } = {}) {
  const { answers, errors } = checkAnswers(fields, raw, undefined, opts);
  const first = fields.find((f) => errors[f.id]);
  if (first) throw new HttpError(400, "validation_failed", errors[first.id], { field: first.id, fields: errors });
  return answers;
}

export interface SubmitMeta {
  ip: string; turnstileToken?: string; honeypot?: string; elapsedMs?: number;
  /** R93 (Forms plus): hidden field values from the link, the spam shield answer, and where to run the webhook after the answer. */
  hidden?: Record<string, unknown>; shield?: ShieldAnswer; defer?: (p: Promise<unknown>) => void;
  /** TD7: the password access token and the resume token of a saved part. */
  td7?: { access?: unknown; resume?: unknown };
}

/**
 * A public submission. Spam is refused quietly where a bot can't learn from the answer:
 * a filled honeypot or an instant post gets the normal thank-you and creates nothing.
 */
export async function submitForm(deps: Deps, slug: string, raw: Record<string, unknown>, meta: SubmitMeta) {
  const f = await publicRow(deps, slug);
  const td7 = await td7Guard(deps, f, meta.td7?.access); // TD7: close date, response cap and password, on the server
  const fields = JSON.parse(f.fields) as FormField[];
  const thanks = { ok: true, message: f.successMessage };
  if (meta.honeypot || (meta.elapsedMs !== undefined && meta.elapsedMs < MIN_FILL_MS)) return thanks;
  if (!(await verifyTurnstile(deps, meta.turnstileToken, meta.ip))) throw new HttpError(422, "captcha_failed", "Please complete the check and try again.");
  // R93: with Forms plus on, public answers carry the spam shield (signed challenge, proof of work, one use).
  const plusOn = await formsPlusOn(deps, f.orgId);
  if (plusOn) await requireShield(deps, "fplus", meta.shield);
  const ipHash = (await hmacSha256Hex(deps.config.appSecret, `form:${meta.ip}`)).slice(0, 32);
  const since = new Date(deps.now().getTime() - 10 * 60_000);
  const recent = await deps.db.select({ n: sql<number>`count(*)` }).from(formSubmissions)
    .where(and(eq(formSubmissions.formId, f.id), eq(formSubmissions.ipHash, ipHash), gte(formSubmissions.createdAt, since))).get();
  if (Number(recent?.n ?? 0) >= SUBMISSIONS_PER_WINDOW) throw new HttpError(429, "rate_limited", "That's a lot of submissions. Please try again in a few minutes.");
  // TD2: stricter phone and date checks, and every upload answer tied to this answer before anything is made.
  const td2On = !!deps.config.formsTd2;
  const answers = validateAnswers(fields, raw, { strict: td2On });
  const now = deps.now();
  const sid = sortableId("fsb", now.getTime());
  // TD7: one place under the response cap, taken atomically before any upload is tied; given back if saving fails.
  const reserved = td7 ? await reserveCap(deps, f, td7) : false;
  let uploads = 0;
  try {
    uploads = td2On ? await attachUploads(deps, f.id, fields, answers, ipHash, sid) : 0;
    return await saveSubmission(deps, f, fields, answers, meta, { thanks, plusOn, ipHash, reserved, td7: !!td7, now, sid });
  } catch (err) {
    if (uploads) await releaseUploads(deps, sid).catch(() => undefined);
    if (reserved) await releaseCap(deps, f);
    throw err;
  }
}

async function saveSubmission(deps: Deps, f: FormRow, fields: FormField[], answers: Record<string, string>, meta: SubmitMeta, ctx: { thanks: { ok: boolean; message: string }; plusOn: boolean; ipHash: string; reserved: boolean; td7: boolean; now: Date; sid: string }) {
  const { thanks, plusOn, ipHash, now, sid } = ctx;
  const system: SuiteActor = { orgId: f.orgId, userId: "", email: "", name: `Form: ${f.name}`, system: true };
  const shownText = (x: FormField) => (isUpload(x.type) ? uploadSummary(x, answers[x.id]) : answers[x.id]);
  const lines = fields.filter((x) => answers[x.id]).map((x) => (x.type === "textarea" ? `${x.label}:\n${answers[x.id]}` : `${x.label}: ${shownText(x)}`));
  const emailField = fields.find((x) => x.type === "email" && answers[x.id]);
  const nameField = fields.find((x) => /name/i.test(x.id) || /name/i.test(x.label));
  let entity: { type: "task" | "contact"; id: string } | null;
  // R93: a call for submissions keeps each entry for review; no task or contact is made.
  if (f.target === "review") {
    entity = null;
  } else if (f.target === "contact") {
    const email = answers[emailField!.id];
    const { contactIdFor, createContact, updateContact } = await import("./contacts");
    const phone = fields.find((x) => x.type === "phone" && answers[x.id]);
    const existing = await contactIdFor(deps, f.orgId, email);
    const c = existing
      ? await updateContact(deps, system, existing, { ...(nameField && answers[nameField.id] ? { name: answers[nameField.id] } : {}), ...(phone ? { phone: answers[phone.id] } : {}) })
      : await createContact(deps, system, { email, name: nameField ? answers[nameField.id] : undefined, phone: phone ? answers[phone.id] : undefined, notes: `From the form "${f.name}".\n\n${lines.join("\n")}` });
    entity = { type: "contact", id: c.id };
  } else {
    const titleField = fields.find((x) => x.type === "text" && x.id !== nameField?.id && answers[x.id]);
    const who = nameField && answers[nameField.id] ? answers[nameField.id] : emailField ? answers[emailField.id] : "";
    const title = (titleField ? answers[titleField.id] : `${f.name}${who ? ` from ${who}` : ""}`).slice(0, 300);
    // R31: the first routing rule that matches picks the project and the assignee.
    const route = pickRoute(fields, JSON.parse(f.routing || "[]") as FormRoute[], answers);
    const routedAssignee = route?.assigneeId ? parseAssignee(route.assigneeId) : null;
    const t = await createTask(deps, system, {
      title, notes: `Sent through the form "${f.name}".\n\n${lines.join("\n\n")}`, projectId: route?.projectId ?? f.projectId ?? undefined,
      assignee: routedAssignee ?? (f.assigneeType && f.assigneeId ? { type: f.assigneeType, id: f.assigneeId } : undefined), labels: ["form"],
      // R21: the form's own "Send to triage" switch, or the project's Triage setting.
      triage: { source: "form", when: f.triage ? "always" : "if_project", from: emailField ? answers[emailField.id] || null : null },
    });
    entity = { type: "task", id: t.id };
    if (emailField) {
      const { contactIdFor } = await import("./contacts");
      const { link } = await import("./tasks");
      const cid = await contactIdFor(deps, f.orgId, answers[emailField.id]);
      if (cid) await link(deps, f.orgId, { type: "task", id: t.id }, { type: "contact", id: cid }, "about");
    }
  }
  // R93: hidden values from the link and the NPS or CSAT score are stored with the answer.
  const plus = plusOn ? parsePlus(f.plus) : null;
  const hidden = plus ? pickHidden(plus.hiddenFields, meta.hidden) : {};
  const extras = plus ? submissionExtras(fields, answers, hidden) : {};
  await Promise.all([
    deps.db.insert(formSubmissions).values({ id: sid, orgId: f.orgId, formId: f.id, data: JSON.stringify(answers), entityType: entity?.type ?? null, entityId: entity?.id ?? null, ipHash, createdAt: now, ...extras }),
    ...(ctx.reserved ? [] : [deps.db.update(forms).set({ submitCount: sql`${forms.submitCount} + 1`, lastSubmitAt: now }).where(eq(forms.id, f.id))]),
  ]);
  if (ctx.td7) await td7Completed(deps, f, meta.td7?.resume); // TD7: completion count; the saved part is removed
  await recordWrite(deps, system, { entityType: "form", entityId: f.id, op: "update", verb: "form.submitted", data: { submissionId: sid, entity },
    event: "form.submitted", eventData: { formId: f.id, form: f.name, submissionId: sid, answers, created: entity } });
  // R90: flows on "a form is sent".
  await (await import("./flows")).fireFlows(deps, f.orgId, "form_submitted", { formId: f.id, form: f.name, summary: lines.join("\n").slice(0, 4000), email: emailField ? answers[emailField.id] : "", name: nameField ? answers[nameField.id] ?? "" : "", link: `${deps.config.appUrl}/app/forms/${f.id}` }, sid);
  // R93: the form's own signed webhook, once, after the answer is saved (never holds up the visitor).
  if (plus && f.webhookUrl && f.webhookSecret && !plus.webhookPaused) {
    const p = deliverWebhook(deps, f, webhookPayload(f, { id: sid, answers, hidden, score: (extras as { score?: number | null }).score ?? null, createdAt: now }), sid)
      .catch((err) => deps.reportError?.(err, { where: "form_webhook" }));
    if (meta.defer) meta.defer(p); else await p;
  }
  const message = plus ? fillVariables(f.successMessage, answers, hidden).trim() || f.successMessage : f.successMessage;
  return { ...thanks, message, created: entity };
}
