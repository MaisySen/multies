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

export type FieldType = "text" | "email" | "textarea" | "phone" | "select" | "number" | "date";
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; placeholder?: string }
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

export function normaliseFields(input: unknown): FormField[] {
  if (!Array.isArray(input) || !input.length) throw new HttpError(422, "validation_failed", "A form needs at least one field.");
  if (input.length > 30) throw new HttpError(422, "validation_failed", "A form can have up to 30 fields.");
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const f = raw as Partial<FormField>;
    const label = String(f.label ?? "").trim().slice(0, 120);
    if (!label) throw new HttpError(422, "validation_failed", `Field ${i + 1} needs a label.`);
    const type = (["text", "email", "textarea", "phone", "select", "number", "date"] as FieldType[]).includes(f.type as FieldType) ? (f.type as FieldType) : "text";
    let id = String(f.id ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `field_${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    const options = type === "select" ? (Array.isArray(f.options) ? f.options.map((o) => String(o).trim().slice(0, 120)).filter(Boolean).slice(0, 50) : []) : undefined;
    if (type === "select" && !options?.length) throw new HttpError(422, "validation_failed", `"${label}" needs at least one option.`);
    return { id, label, type, required: !!f.required, ...(options ? { options } : {}), ...(f.placeholder ? { placeholder: String(f.placeholder).slice(0, 120) } : {}) };
  });
}

function present(f: FormRow, origin?: string) {
  return {
    id: f.id, name: f.name, description: f.description, slug: f.slug, url: `${origin ?? ""}/f/${f.slug}`,
    target: f.target, projectId: f.projectId, assigneeId: f.assigneeType && f.assigneeId ? `${f.assigneeType}:${f.assigneeId}` : null,
    fields: JSON.parse(f.fields) as FormField[], successMessage: f.successMessage, enabled: f.enabled,
    submitCount: f.submitCount, lastSubmitAt: iso(f.lastSubmitAt), triage: !!f.triage, createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString(), version: f.version,
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
  return (await deps.db.select().from(forms).where(and(eq(forms.orgId, orgId), isNull(forms.deletedAt))).orderBy(desc(forms.createdAt))).map((f) => present(f, origin));
}

export async function getForm(deps: Deps, orgId: string, id: string) {
  const f = await formRow(deps, orgId, id);
  const recent = await deps.db.select().from(formSubmissions).where(eq(formSubmissions.formId, f.id)).orderBy(desc(formSubmissions.createdAt)).limit(50);
  return {
    form: present(f, deps.config.appUrl),
    submissions: recent.map((s) => ({ id: s.id, data: JSON.parse(s.data) as Record<string, string>, entityType: s.entityType, entityId: s.entityId, createdAt: s.createdAt.toISOString() })),
  };
}

export interface FormInput { name: string; description?: string; target?: "task" | "contact"; projectId?: string | null; assigneeId?: string | null; fields?: unknown; successMessage?: string; enabled?: boolean; /** R21: submissions wait in Triage. */ triage?: boolean }

function checkTarget(target: "task" | "contact", fields: FormField[]) {
  if (target === "contact" && !fields.some((f) => f.type === "email")) throw new HttpError(422, "validation_failed", "A form that makes contacts needs an email field.");
}

export async function createForm(deps: Deps, actor: SuiteActor, input: FormInput) {
  assertWritable(actor);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new HttpError(422, "validation_failed", "Give the form a name.");
  const target = input.target ?? "task";
  const fields = normaliseFields(input.fields ?? (target === "task" ? DEFAULT_TASK_FIELDS : DEFAULT_TASK_FIELDS.slice(0, 2)));
  checkTarget(target, fields);
  const assignee = parseAssignee(input.assigneeId ?? null);
  // The project and the assignee must be this workspace's own (another workspace's id is a 404).
  if (input.projectId) await getProject(deps, actor.orgId, input.projectId);
  await validateAssignee(deps, actor.orgId, assignee);
  const now = deps.now();
  const id = sortableId("frm", now.getTime());
  await deps.db.insert(forms).values({
    id, orgId: actor.orgId, name, description: (input.description ?? "").slice(0, 2000), slug: randomToken(9).replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toLowerCase(),
    target, projectId: input.projectId ?? null, assigneeType: assignee?.type ?? null, assigneeId: assignee?.id ?? null,
    fields: JSON.stringify(fields), successMessage: (input.successMessage ?? "Thanks, we got it. We'll be in touch.").slice(0, 500), enabled: input.enabled ?? true,
    triage: input.triage ?? false,
    ...createdBy(actor), createdAt: now, updatedAt: now,
  });
  await recordWrite(deps, actor, { entityType: "form", entityId: id, op: "create", verb: "form.created", data: { name } });
  return present(await formRow(deps, actor.orgId, id), deps.config.appUrl);
}

export async function updateForm(deps: Deps, actor: SuiteActor, id: string, patch: Partial<FormInput>) {
  assertWritable(actor);
  const f = await formRow(deps, actor.orgId, id);
  const set: Partial<FormRow> = { updatedAt: deps.now(), version: f.version + 1 };
  if (patch.name !== undefined) { const n = patch.name.trim().slice(0, 120); if (!n) throw new HttpError(422, "validation_failed", "Give the form a name."); set.name = n; }
  if (patch.description !== undefined) set.description = patch.description.slice(0, 2000);
  if (patch.target !== undefined) set.target = patch.target;
  if (patch.projectId !== undefined) { if (patch.projectId) await getProject(deps, actor.orgId, patch.projectId); set.projectId = patch.projectId; }
  if (patch.assigneeId !== undefined) { const a = parseAssignee(patch.assigneeId); await validateAssignee(deps, actor.orgId, a); set.assigneeType = a?.type ?? null; set.assigneeId = a?.id ?? null; }
  if (patch.fields !== undefined) set.fields = JSON.stringify(normaliseFields(patch.fields));
  if (patch.successMessage !== undefined) set.successMessage = patch.successMessage.slice(0, 500);
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.triage !== undefined) set.triage = patch.triage;
  checkTarget((set.target ?? f.target) as "task" | "contact", JSON.parse(set.fields ?? f.fields) as FormField[]);
  await deps.db.update(forms).set(set).where(eq(forms.id, id));
  await recordWrite(deps, actor, { entityType: "form", entityId: id, op: "update", version: f.version + 1, verb: "form.updated" });
  return present(await formRow(deps, actor.orgId, id), deps.config.appUrl);
}

export async function deleteForm(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const f = await formRow(deps, actor.orgId, id);
  await deps.db.update(forms).set({ deletedAt: deps.now(), enabled: false, updatedAt: deps.now(), version: f.version + 1 }).where(eq(forms.id, id));
  await recordWrite(deps, actor, { entityType: "form", entityId: id, op: "delete", version: f.version + 1, verb: "form.deleted" });
  return { ok: true };
}

async function publicRow(deps: Deps, slug: string) {
  const f = await deps.db.select().from(forms).where(and(eq(forms.slug, slug.toLowerCase()), isNull(forms.deletedAt))).get();
  if (!f || !f.enabled) throw notFound("Form");
  return f;
}

/** What the public form page needs: no ids, no workspace details beyond its name. */
export async function publicForm(deps: Deps, slug: string) {
  const f = await publicRow(deps, slug);
  const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, f.orgId)).get();
  return { name: f.name, description: f.description, fields: JSON.parse(f.fields) as FormField[], workspace: org?.name ?? "", turnstileSiteKey: deps.config.turnstile?.siteKey ?? null };
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAnswers(fields: FormField[], raw: Record<string, unknown>) {
  const answers: Record<string, string> = {};
  for (const f of fields) {
    const v = String(raw[f.id] ?? "").trim().slice(0, f.type === "textarea" ? 10_000 : 500);
    if (!v) { if (f.required) throw new HttpError(422, "validation_failed", `Please fill in "${f.label}".`, { field: f.id }); continue; }
    if (f.type === "email" && !EMAIL.test(v)) throw new HttpError(422, "validation_failed", `"${f.label}" doesn't look like an email address.`, { field: f.id });
    if (f.type === "number" && !Number.isFinite(Number(v))) throw new HttpError(422, "validation_failed", `"${f.label}" should be a number.`, { field: f.id });
    if (f.type === "select" && !f.options?.includes(v)) throw new HttpError(422, "validation_failed", `Pick one of the options for "${f.label}".`, { field: f.id });
    answers[f.id] = v;
  }
  return answers;
}

export interface SubmitMeta { ip: string; turnstileToken?: string; honeypot?: string; elapsedMs?: number }

/**
 * A public submission. Spam is refused quietly where a bot can't learn from the answer:
 * a filled honeypot or an instant post gets the normal thank-you and creates nothing.
 */
export async function submitForm(deps: Deps, slug: string, raw: Record<string, unknown>, meta: SubmitMeta) {
  const f = await publicRow(deps, slug);
  const fields = JSON.parse(f.fields) as FormField[];
  const thanks = { ok: true, message: f.successMessage };
  if (meta.honeypot || (meta.elapsedMs !== undefined && meta.elapsedMs < MIN_FILL_MS)) return thanks;
  if (!(await verifyTurnstile(deps, meta.turnstileToken, meta.ip))) throw new HttpError(422, "captcha_failed", "Please complete the check and try again.");
  const ipHash = (await hmacSha256Hex(deps.config.appSecret, `form:${meta.ip}`)).slice(0, 32);
  const since = new Date(deps.now().getTime() - 10 * 60_000);
  const recent = await deps.db.select({ n: sql<number>`count(*)` }).from(formSubmissions)
    .where(and(eq(formSubmissions.formId, f.id), eq(formSubmissions.ipHash, ipHash), gte(formSubmissions.createdAt, since))).get();
  if (Number(recent?.n ?? 0) >= SUBMISSIONS_PER_WINDOW) throw new HttpError(429, "rate_limited", "That's a lot of submissions. Please try again in a few minutes.");
  const answers = validateAnswers(fields, raw);

  const system: SuiteActor = { orgId: f.orgId, userId: "", email: "", name: `Form: ${f.name}`, system: true };
  const lines = fields.filter((x) => answers[x.id]).map((x) => (x.type === "textarea" ? `${x.label}:\n${answers[x.id]}` : `${x.label}: ${answers[x.id]}`));
  const emailField = fields.find((x) => x.type === "email" && answers[x.id]);
  const nameField = fields.find((x) => /name/i.test(x.id) || /name/i.test(x.label));
  let entity: { type: "task" | "contact"; id: string };
  if (f.target === "contact") {
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
    const t = await createTask(deps, system, {
      title, notes: `Sent through the form "${f.name}".\n\n${lines.join("\n\n")}`, projectId: f.projectId ?? undefined,
      assignee: f.assigneeType && f.assigneeId ? { type: f.assigneeType, id: f.assigneeId } : undefined, labels: ["form"],
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
  const now = deps.now();
  const sid = sortableId("fsb", now.getTime());
  await Promise.all([
    deps.db.insert(formSubmissions).values({ id: sid, orgId: f.orgId, formId: f.id, data: JSON.stringify(answers), entityType: entity.type, entityId: entity.id, ipHash, createdAt: now }),
    deps.db.update(forms).set({ submitCount: sql`${forms.submitCount} + 1`, lastSubmitAt: now }).where(eq(forms.id, f.id)),
  ]);
  await recordWrite(deps, system, { entityType: "form", entityId: f.id, op: "update", verb: "form.submitted", data: { submissionId: sid, entity },
    event: "form.submitted", eventData: { formId: f.id, form: f.name, submissionId: sid, answers, created: entity } });
  return { ...thanks, created: entity };
}
