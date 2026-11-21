/**
 * R93 Forms plus (flag FORMS_PLUS_R93): the form settings it adds (chat style, hidden fields, the bubble, templates,
 * review setup), the form's own signed webhook, and the NPS or CSAT score. The vv8k workspace is always left out.
 */
import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { inIds } from "../../lib/sql-chunks";
import type { Deps } from "../../context";
import { formSubmissions, formWebhookLog, forms, organizations } from "../../db/schema";
import { decryptSecret, encryptSecret, hmacSha256Hex, randomToken } from "../../lib/crypto";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { UnsafeUrlError, assertPublicHost, checkUrlShape } from "../../lib/safe-fetch";
import { sortableId, type SuiteActor } from "../suite/common";
import { csatOf, npsOf, normalisePlus, parsePlus, scoreField, WEBHOOK_PAUSE_AFTER, WEBHOOK_TIMEOUT_MS, type FormMode, type FormPlus } from "@/shared/forms-plus";
import { ratingRange, type LogicField } from "@/shared/form-logic";
import { featureOn } from "../console/flags"; // OPS1 feature flags

type FormRow = typeof forms.$inferSelect;

// ---------------------------------------------------------------- the flag, per workspace

const cache = new Map<string, { on: boolean; until: number }>();

export function isFormsPlusExcluded(org: { id: string; slug?: string | null; name?: string | null }, extra = ""): boolean {
  const hay = [org.id, org.slug ?? "", org.name ?? ""].map((s) => s.toLowerCase());
  const words = ["vv8k", ...extra.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];
  return words.some((x) => hay.some((h) => h === x || h.includes(x)));
}

/** Whether Forms plus is on for this workspace: the flag, and never for vv8k. Cached for a minute per isolate. */
export async function formsPlusOn(deps: Deps, orgId: string): Promise<boolean> {
  if (!featureOn(deps, "formsPlus", orgId)) return false; // OPS1: per workspace flag
  const hit = cache.get(orgId);
  const now = Date.now();
  if (hit && hit.until > now) return hit.on;
  const o = await deps.db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).get();
  const on = !!o && !isFormsPlusExcluded(o, deps.config.formsPlusExclude ?? "");
  cache.set(orgId, { on, until: now + 60_000 });
  return on;
}

export async function requireFormsPlus(deps: Deps, orgId: string) {
  if (!(await formsPlusOn(deps, orgId))) throw notFound("Page");
}

/** Owners and admins, or the person who made it. */
export function canManage(actor: SuiteActor, createdById: string | null | undefined) {
  return actor.role === "owner" || actor.role === "admin" || (!!createdById && createdById === actor.userId);
}

export async function managedForm(deps: Deps, actor: SuiteActor, id: string): Promise<FormRow> {
  await requireFormsPlus(deps, actor.orgId);
  const f = await deps.db.select().from(forms).where(and(eq(forms.id, id), eq(forms.orgId, actor.orgId), isNull(forms.deletedAt))).get();
  if (!f) throw notFound("Form");
  if (!canManage(actor, f.createdById)) throw forbidden("Only workspace admins and the person who made this form can change it.");
  return f;
}

// ---------------------------------------------------------------- settings

export interface PlusSettings { mode: FormMode; plus: FormPlus; webhook: { url: string | null; hasSecret: boolean; failures: number; paused: boolean } }

export function plusSettingsOf(f: Pick<FormRow, "mode" | "plus" | "webhookUrl" | "webhookSecret" | "webhookFailures">): PlusSettings {
  const plus = parsePlus(f.plus);
  return { mode: f.mode === "chat" ? "chat" : "classic", plus, webhook: { url: f.webhookUrl ?? null, hasSecret: !!f.webhookSecret, failures: f.webhookFailures ?? 0, paused: !!plus.webhookPaused } };
}

/** A webhook address must be a public https address on the normal port. */
export function checkWebhookUrl(raw: string): string {
  let u: URL;
  try { u = checkUrlShape(raw); } catch (e) { throw new HttpError(422, "validation_failed", e instanceof UnsafeUrlError ? "Use a public https address for the webhook." : "That is not a web address."); }
  if (u.protocol !== "https:") throw new HttpError(422, "validation_failed", "The webhook address must start with https.");
  if (u.toString().length > 600) throw new HttpError(422, "validation_failed", "The webhook address is too long.");
  return u.toString();
}

export interface PlusPatch { mode?: FormMode; plus?: Record<string, unknown>; webhookUrl?: string | null; resumeWebhook?: boolean }

/** Saves the Forms plus settings. A new webhook address mints a secret; the secret is returned once, here. */
export async function savePlusSettings(deps: Deps, actor: SuiteActor, id: string, patch: PlusPatch): Promise<PlusSettings & { secret?: string }> {
  const f = await managedForm(deps, actor, id);
  const cur = parsePlus(f.plus);
  const next = normalisePlus({ ...cur, ...(patch.plus ?? {}), webhookPaused: patch.resumeWebhook ? false : cur.webhookPaused });
  const set: Partial<FormRow> = { plus: JSON.stringify(next), updatedAt: deps.now() };
  if (patch.mode) set.mode = patch.mode;
  if (patch.resumeWebhook) set.webhookFailures = 0;
  let secret: string | undefined;
  if (patch.webhookUrl !== undefined) {
    if (patch.webhookUrl === null || patch.webhookUrl === "") { set.webhookUrl = null; set.webhookSecret = null; set.webhookFailures = 0; }
    else {
      set.webhookUrl = checkWebhookUrl(patch.webhookUrl);
      if (!f.webhookSecret) { secret = `whsec_${randomToken(24).replace(/[^A-Za-z0-9]/g, "")}`; set.webhookSecret = await encryptSecret(deps.config.appSecret, secret); }
    }
  }
  await deps.db.update(forms).set(set).where(eq(forms.id, f.id));
  const row = { ...f, ...set } as FormRow;
  return { ...plusSettingsOf(row), ...(secret ? { secret } : {}) };
}

export async function rotateWebhookSecret(deps: Deps, actor: SuiteActor, id: string) {
  const f = await managedForm(deps, actor, id);
  if (!f.webhookUrl) throw new HttpError(422, "validation_failed", "Add a webhook address first.");
  const secret = `whsec_${randomToken(24).replace(/[^A-Za-z0-9]/g, "")}`;
  await deps.db.update(forms).set({ webhookSecret: await encryptSecret(deps.config.appSecret, secret), updatedAt: deps.now() }).where(eq(forms.id, f.id));
  return { secret };
}

// ---------------------------------------------------------------- webhook

export const SIGNATURE_HEADER = "x-multies-signature";
export const TIMESTAMP_HEADER = "x-multies-timestamp";

/** "sha256=" and the hex HMAC SHA256 of `${timestamp}.${body}` (the same scheme as our incoming triggers). */
export async function signFormWebhook(secret: string, timestamp: number, body: string) {
  return `sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export interface Delivery { ok: boolean; status: number | null; error: string | null; ms: number }

/**
 * One delivery: public https only, no redirects followed, a 5 second limit, one attempt (no retry storm). Logged;
 * after 10 failures in a row the webhook pauses until an admin resumes it.
 */
export async function deliverWebhook(deps: Deps, f: Pick<FormRow, "id" | "orgId" | "webhookUrl" | "webhookSecret" | "plus" | "webhookFailures">, payload: Record<string, unknown>, submissionId: string | null): Promise<Delivery> {
  const started = Date.now();
  let res: Delivery;
  try {
    if (!f.webhookUrl || !f.webhookSecret) throw new UnsafeUrlError("No webhook is set.");
    const url = new URL(checkWebhookUrl(f.webhookUrl));
    await assertPublicHost(deps.fetch, url.hostname.toLowerCase());
    const secret = await decryptSecret(deps.config.appSecret, f.webhookSecret);
    const body = JSON.stringify(payload);
    const ts = Math.floor(deps.now().getTime() / 1000);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const r = await deps.fetch(url.toString(), {
        method: "POST", redirect: "manual", signal: ctl.signal, body,
        headers: { "content-type": "application/json", "user-agent": "Multies-Forms/1.0", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signFormWebhook(secret, ts, body) },
      });
      try { await r.body?.cancel(); } catch { /* closed */ }
      res = { ok: r.status >= 200 && r.status < 300, status: r.status, error: r.status >= 200 && r.status < 300 ? null : r.status >= 300 && r.status < 400 ? "The address answered with a redirect. Use the final address." : `The address answered ${r.status}.`, ms: Date.now() - started };
    } catch {
      res = { ok: false, status: null, error: Date.now() - started >= WEBHOOK_TIMEOUT_MS - 50 ? "No answer within 5 seconds." : "The address could not be reached.", ms: Date.now() - started };
    } finally { clearTimeout(timer); }
  } catch (e) {
    res = { ok: false, status: null, error: e instanceof UnsafeUrlError || e instanceof HttpError ? (e.message.includes("previewed") ? "Use a public https address for the webhook." : e.message) : "The webhook could not be sent.", ms: Date.now() - started };
  }
  const now = deps.now();
  await deps.db.insert(formWebhookLog).values({ id: sortableId("fwh", now.getTime()), orgId: f.orgId, formId: f.id, submissionId, ok: res.ok, httpStatus: res.status, error: res.error, ms: res.ms, createdAt: now });
  const failures = res.ok ? 0 : (f.webhookFailures ?? 0) + 1;
  const set: Partial<FormRow> = { webhookFailures: failures };
  if (!res.ok && failures >= WEBHOOK_PAUSE_AFTER) set.plus = JSON.stringify({ ...parsePlus(f.plus), webhookPaused: true });
  await deps.db.update(forms).set(set).where(eq(forms.id, f.id));
  // Keep the newest 20 per form.
  const old = await deps.db.select({ id: formWebhookLog.id }).from(formWebhookLog).where(eq(formWebhookLog.formId, f.id)).orderBy(desc(formWebhookLog.createdAt), desc(formWebhookLog.id)).limit(20).offset(20).all();
  if (old.length) await deps.db.delete(formWebhookLog).where(inIds(formWebhookLog.id, old.map((o) => o.id)));
  return res;
}

export function webhookPayload(f: Pick<FormRow, "id" | "name">, sub: { id: string; answers: Record<string, string>; hidden: Record<string, string>; score: number | null; createdAt: Date }, test = false) {
  return { event: test ? "form.test" : "form.submitted", form: { id: f.id, name: f.name }, submission: { id: sub.id, createdAt: sub.createdAt.toISOString(), answers: sub.answers, hidden: sub.hidden, score: sub.score } };
}

export async function testWebhook(deps: Deps, actor: SuiteActor, id: string) {
  const f = await managedForm(deps, actor, id);
  if (!f.webhookUrl) throw new HttpError(422, "validation_failed", "Add a webhook address first.");
  return deliverWebhook(deps, f, webhookPayload(f, { id: "test", answers: { example: "This is a test from Multies" }, hidden: {}, score: null, createdAt: deps.now() }, true), null);
}

export async function webhookLog(deps: Deps, actor: SuiteActor, id: string) {
  const f = await managedForm(deps, actor, id);
  const rows = await deps.db.select().from(formWebhookLog).where(eq(formWebhookLog.formId, f.id)).orderBy(desc(formWebhookLog.createdAt), desc(formWebhookLog.id)).limit(20).all();
  return { deliveries: rows.map((r) => ({ id: r.id, ok: r.ok, status: r.httpStatus, error: r.error, ms: r.ms, at: r.createdAt.toISOString(), test: !r.submissionId })) };
}

// ---------------------------------------------------------------- submissions (called from submitForm)

/** The extra a Forms plus submission stores: hidden values and the score. */
export function submissionExtras(fields: LogicField[], answers: Record<string, string>, hidden: Record<string, string>) {
  const sf = scoreField(fields);
  let score: number | null = null;
  if (sf && answers[sf.id] !== undefined) {
    const n = Number(answers[sf.id]);
    const { min, max } = ratingRange(sf);
    if (Number.isInteger(n) && n >= min && n <= max) score = n;
  }
  return { meta: Object.keys(hidden).length ? JSON.stringify({ hidden }) : null, score };
}

/** NPS or CSAT for a form with a rating question: NPS when the scale is 0 to 10, CSAT when it is 1 to 5. */
export async function formScore(deps: Deps, orgId: string, id: string) {
  await requireFormsPlus(deps, orgId);
  const f = await deps.db.select().from(forms).where(and(eq(forms.id, id), eq(forms.orgId, orgId), isNull(forms.deletedAt))).get();
  if (!f) throw notFound("Form");
  const fields = JSON.parse(f.fields) as LogicField[];
  const sf = scoreField(fields);
  if (!sf) return { score: null };
  const rows = await deps.db.select({ s: formSubmissions.score }).from(formSubmissions).where(and(eq(formSubmissions.formId, f.id), isNotNull(formSubmissions.score))).orderBy(desc(formSubmissions.createdAt)).limit(10_000).all();
  const scores = rows.map((r) => Number(r.s));
  const { min, max } = ratingRange(sf);
  return { score: min === 0 && max === 10 ? npsOf(scores) : min === 1 && max === 5 ? csatOf(scores) : null, question: sf.label };
}

/** Old webhook log rows go after 30 days (maintenance can call this). */
export async function pruneWebhookLog(deps: Deps) {
  await deps.db.delete(formWebhookLog).where(lt(formWebhookLog.createdAt, new Date(deps.now().getTime() - 30 * 86_400_000)));
}
