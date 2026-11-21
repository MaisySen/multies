/**
 * TD7 Forms pro B (FORMS_TD7): brand kit, close date and response cap enforced here on the server, an optional form
 * password (PBKDF2 hash, rate limited, short lived signed access), save and resume with signed expiring links,
 * and views, starts, completions and reach counts without cookies. AI draft goes through the workspace's own key
 * and the workspace AI switch only. Nothing here logs answers, passwords, tokens or prompts.
 */
import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { formPartialsTd7, formProTd7, formReachTd7, formStatsTd7, forms, organizations, workspaceBrandLogos } from "../../db/schema";
import { fromB64, hashPassword, hmacSha256Hex, randomToken, safeEqual, verifyPassword } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { DbRateLimitStore } from "../../lib/rate-limit";
import { isFormsPlusExcluded } from "../forms-plus/plus";
import { aiAllowed } from "../ai-trust-td1";
import { assertWritable, recordWrite, type SuiteActor } from "../suite/common";
import { cleanDraft, closedReason, closedText, dropOff, parseTd7, completionRate, PASSWORD_MAX, PASSWORD_MIN, type ClosedReason, type Td7Settings } from "@/shared/forms-td7";
import { featureOn } from "../console/flags"; // OPS1 feature flags

type FormRow = typeof forms.$inferSelect;
export const ACCESS_TTL_MS = 2 * 60 * 60_000;
export const RESUME_TTL_MS = 7 * 24 * 60 * 60_000;
export const UNLOCK_TRIES = 10;
export const UNLOCK_WINDOW_MS = 15 * 60_000;
export const PARTIAL_SAVES = 30;
export const EVENTS_PER_HOUR = 300;
export const PARTIAL_MAX_BYTES = 64 * 1024;
const PROMPT_MAX = 500;

const cache = new Map<string, { on: boolean; until: number }>();
/** Whether TD7 is on for this workspace: the flag, and never for the excluded workspaces. Cached for a minute. */
export async function td7On(deps: Deps, orgId: string): Promise<boolean> {
  if (!featureOn(deps, "formsTd7", orgId)) return false; // OPS1: per workspace flag
  const hit = cache.get(orgId); const now = Date.now();
  if (hit && hit.until > now) return hit.on;
  const o = await deps.db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).get();
  const on = !!o && !isFormsPlusExcluded(o, deps.config.formsPlusExclude ?? "");
  cache.set(orgId, { on, until: now + 60_000 });
  return on;
}

/** The one AI gate for TD7: the workspace AI switch (TD1). Off means no provider call. */
export async function formsAiAllowed(deps: Deps, orgId: string): Promise<boolean> {
  return aiAllowed(deps, orgId);
}
/** "ready" when a call may go out (own key, or built in AI with its flag and the existing binding); "off" is TD1's switch; "no_key" otherwise. */
export async function formsAiGate(deps: Deps, orgId: string): Promise<"ready" | "off" | "no_key"> {
  if (!(await formsAiAllowed(deps, orgId))) return "off";
  const { providerFor } = await import("../ai/keys");
  if (await providerFor(deps, orgId)) return "ready";
  return featureOn(deps, "aiConnectAi2", orgId) && deps.ai ? "ready" : "no_key"; // OPS1: per workspace flag
}

async function ownForm(deps: Deps, orgId: string, id: string): Promise<FormRow> {
  if (!(await td7On(deps, orgId))) throw notFound("Page");
  const f = await deps.db.select().from(forms).where(and(eq(forms.id, id), eq(forms.orgId, orgId))).get();
  if (!f || f.deletedAt) throw notFound("Form");
  return f;
}

export async function loadPro(deps: Deps, formId: string): Promise<{ settings: Td7Settings; passwordHash: string | null }> {
  const r = await deps.db.select().from(formProTd7).where(eq(formProTd7.formId, formId)).get();
  return { settings: parseTd7(r?.settings ?? "{}"), passwordHash: r?.passwordHash ?? null };
}

const presentPro = (settings: Td7Settings, passwordHash: string | null, f: FormRow) => ({ settings, hasPassword: !!passwordHash, responses: f.submitCount, closed: closedReason(settings, new Date(), f.submitCount) });

export async function getPro(deps: Deps, actor: SuiteActor, formId: string) {
  const f = await ownForm(deps, actor.orgId, formId);
  const p = await loadPro(deps, f.id);
  return presentPro(p.settings, p.passwordHash, f);
}

/** Owner settings. `password`: a string sets it, null removes it, absent keeps it. The hash never leaves the server. */
export async function putPro(deps: Deps, actor: SuiteActor, formId: string, body: { settings?: unknown; password?: string | null }) {
  assertWritable(actor);
  const f = await ownForm(deps, actor.orgId, formId);
  const cur = await loadPro(deps, f.id);
  const settings = body.settings === undefined ? cur.settings : parseTd7(body.settings);
  let passwordHash = cur.passwordHash;
  if (body.password === null) passwordHash = null;
  else if (typeof body.password === "string") {
    const pw = body.password;
    if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) throw new HttpError(422, "validation_failed", `Use a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`, { fields: { password: `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.` } });
    passwordHash = await hashPassword(pw);
  }
  const now = deps.now();
  await deps.db.insert(formProTd7).values({ formId: f.id, orgId: f.orgId, settings: JSON.stringify(settings), passwordHash, updatedAt: now })
    .onConflictDoUpdate({ target: formProTd7.formId, set: { settings: JSON.stringify(settings), passwordHash, updatedAt: now } });
  await recordWrite(deps, actor, { entityType: "form", entityId: f.id, op: "update", verb: "form.pro_updated", data: { closesAt: settings.closesAt, responseCap: settings.responseCap, saveResume: settings.saveResume, password: passwordHash ? "set" : "none" } });
  return presentPro(settings, passwordHash, f);
}

// ---------------------------------------------------------------- signed tokens

const pwTag = (hash: string | null) => (hash ? hash.slice(-12) : "none");
async function sign(deps: Deps, msg: string) { return (await hmacSha256Hex(deps.config.appSecret, `td7:${msg}`)).slice(0, 40); }

/** A short lived access token for a password form. Changing the password ends every token. */
export async function accessToken(deps: Deps, formId: string, hash: string | null, now = deps.now().getTime()) {
  const exp = now + ACCESS_TTL_MS;
  return `${exp}.${await sign(deps, `a:${formId}:${exp}:${pwTag(hash)}`)}`;
}
export async function accessOk(deps: Deps, formId: string, hash: string | null, token: unknown): Promise<boolean> {
  if (!hash) return true;
  if (typeof token !== "string" || token.length > 80) return false;
  const [e, s] = token.split(".");
  const exp = Number(e);
  if (!Number.isFinite(exp) || !s || exp <= deps.now().getTime()) return false;
  return safeEqual(s, await sign(deps, `a:${formId}:${exp}:${pwTag(hash)}`));
}
export async function resumeToken(deps: Deps, formId: string, id: string, exp: number) {
  return `${id}.${exp}.${await sign(deps, `r:${formId}:${id}:${exp}`)}`;
}
/** The partial's id when the resume token is genuine, for this form, and not expired; null otherwise. */
export async function readResume(deps: Deps, formId: string, token: unknown): Promise<string | null> {
  if (typeof token !== "string" || token.length > 160) return null;
  const [id, e, s] = token.split(".");
  const exp = Number(e);
  if (!id || !/^fpt_[A-Za-z0-9_-]{8,64}$/.test(id) || !Number.isFinite(exp) || !s || exp <= deps.now().getTime()) return null;
  return safeEqual(s, await sign(deps, `r:${formId}:${id}:${exp}`)) ? id : null;
}

async function ipKey(deps: Deps, ip: string) { return (await hmacSha256Hex(deps.config.appSecret, `form:${ip}`)).slice(0, 32); }
async function limited(deps: Deps, key: string, max: number, windowMs: number): Promise<boolean> {
  const store = new DbRateLimitStore(() => deps.db, () => deps.now().getTime());
  store.init({ windowMs });
  const { totalHits } = await store.increment(key);
  return totalHits > max;
}

// ---------------------------------------------------------------- the public form

export interface Td7Public {
  brand: Td7Settings["brand"];
  logo: boolean;
  saveResume: boolean;
  closed: ClosedReason;
  closedMessage: string;
  locked: boolean;
  closesAt: string | null;
}

/** What the public page needs from TD7, or null when TD7 is off for the form's workspace. */
export async function td7Public(deps: Deps, f: FormRow, access?: unknown): Promise<Td7Public | null> {
  if (!(await td7On(deps, f.orgId))) return null;
  const { settings, passwordHash } = await loadPro(deps, f.id);
  const closed = closedReason(settings, deps.now(), f.submitCount);
  return {
    brand: settings.brand, logo: settings.brand.logo !== "none", saveResume: settings.saveResume, closed,
    closedMessage: closed ? closedText(settings, closed) : "", locked: !closed && !(await accessOk(deps, f.id, passwordHash, access)), closesAt: settings.closesAt,
  };
}

/** Checks a public write (submit or save) against close date, cap and password. Returns the settings when TD7 is on. */
export async function td7Guard(deps: Deps, f: FormRow, access: unknown): Promise<Td7Settings | null> {
  if (!(await td7On(deps, f.orgId))) return null;
  const { settings, passwordHash } = await loadPro(deps, f.id);
  const closed = closedReason(settings, deps.now(), f.submitCount);
  if (closed) throw new HttpError(410, "form_closed", closedText(settings, closed));
  if (!(await accessOk(deps, f.id, passwordHash, access))) throw new HttpError(401, "form_locked", "This form needs its password. Open it again and enter the password.");
  return settings;
}

/** Takes one place under the response cap in one atomic step; false when the cap is already reached. */
export async function reserveCap(deps: Deps, f: FormRow, settings: Td7Settings): Promise<boolean> {
  if (settings.responseCap === null) return false;
  const r = await deps.db.run(sql`UPDATE forms SET submit_count = submit_count + 1, last_submit_at = ${deps.now().getTime()} WHERE id = ${f.id} AND submit_count < ${settings.responseCap}`);
  const changed = Number((r as { meta?: { changes?: number }; changes?: number }).meta?.changes ?? (r as { changes?: number }).changes ?? 0);
  if (!changed) throw new HttpError(410, "form_closed", closedText(settings, "cap"));
  return true;
}
export async function releaseCap(deps: Deps, f: FormRow) {
  await deps.db.run(sql`UPDATE forms SET submit_count = MAX(submit_count - 1, 0) WHERE id = ${f.id}`);
}

/** After an answer is saved: one completion, and the saved part (if any) is removed. */
export async function td7Completed(deps: Deps, f: FormRow, resume: unknown) {
  await bump(deps, f.id, "completions");
  const id = await readResume(deps, f.id, resume);
  if (id) await deps.db.delete(formPartialsTd7).where(and(eq(formPartialsTd7.id, id), eq(formPartialsTd7.formId, f.id)));
}

async function publicRow(deps: Deps, slug: string) {
  const f = await deps.db.select().from(forms).where(eq(forms.slug, String(slug).toLowerCase())).get();
  if (!f || f.deletedAt || !f.enabled || !(await td7On(deps, f.orgId))) throw notFound("Form");
  return f;
}

export async function unlock(deps: Deps, slug: string, password: unknown, ip: string) {
  const f = await publicRow(deps, slug);
  const { settings, passwordHash } = await loadPro(deps, f.id);
  const closed = closedReason(settings, deps.now(), f.submitCount);
  if (closed) throw new HttpError(410, "form_closed", closedText(settings, closed));
  if (!passwordHash) return { access: null };
  if (await limited(deps, `td7pw:${f.id}:${await ipKey(deps, ip)}`, UNLOCK_TRIES, UNLOCK_WINDOW_MS)) throw new HttpError(429, "rate_limited", "Too many tries. Please wait 15 minutes and try again.");
  if (typeof password !== "string" || !password || password.length > PASSWORD_MAX || !(await verifyPassword(password, passwordHash))) {
    throw new HttpError(401, "wrong_password", "That password isn't right.", { fields: { password: "That password isn't right." } });
  }
  return { access: await accessToken(deps, f.id, passwordHash) };
}

const cleanAnswers = (fieldIds: Set<string>, raw: unknown): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!fieldIds.has(k)) continue;
    if (typeof v === "string") { if (v) out[k] = v.slice(0, 5000); }
    else if (Array.isArray(v)) { const a = v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 500)).slice(0, 50); if (a.length) out[k] = a; }
  }
  return out;
};
const fieldIdsOf = (f: FormRow) => new Set((JSON.parse(f.fields) as { id: string }[]).map((x) => x.id));

export async function savePartial(deps: Deps, slug: string, body: { answers?: unknown; resume?: unknown; access?: unknown }, ip: string) {
  const f = await publicRow(deps, slug);
  const settings = (await td7Guard(deps, f, body.access))!;
  if (!settings.saveResume) throw notFound("Page");
  if (await limited(deps, `td7ps:${f.id}:${await ipKey(deps, ip)}`, PARTIAL_SAVES, 10 * 60_000)) throw new HttpError(429, "rate_limited", "That's a lot of saves. Please try again in a few minutes.");
  const answers = cleanAnswers(fieldIdsOf(f), body.answers);
  const json = JSON.stringify(answers);
  if (json.length > PARTIAL_MAX_BYTES) throw new HttpError(413, "too_large", "That's too much to save. Shorten a long answer and try again.");
  const now = deps.now();
  const exp = now.getTime() + RESUME_TTL_MS;
  await deps.db.delete(formPartialsTd7).where(and(eq(formPartialsTd7.formId, f.id), lte(formPartialsTd7.expiresAt, now)));
  let id = await readResume(deps, f.id, body.resume);
  const existing = id ? await deps.db.select({ id: formPartialsTd7.id }).from(formPartialsTd7).where(and(eq(formPartialsTd7.id, id), eq(formPartialsTd7.formId, f.id))).get() : null;
  if (existing) {
    await deps.db.update(formPartialsTd7).set({ answers: json, answered: Object.keys(answers).length, expiresAt: new Date(exp), updatedAt: now }).where(eq(formPartialsTd7.id, existing.id));
  } else {
    id = `fpt_${randomToken(18)}`;
    await deps.db.insert(formPartialsTd7).values({ id, orgId: f.orgId, formId: f.id, answers: json, answered: Object.keys(answers).length, expiresAt: new Date(exp), createdAt: now, updatedAt: now });
  }
  return { resume: await resumeToken(deps, f.id, id!, exp), expiresAt: new Date(exp).toISOString() };
}

export async function loadPartial(deps: Deps, slug: string, resume: unknown, access: unknown) {
  const f = await publicRow(deps, slug);
  const settings = (await td7Guard(deps, f, access))!;
  if (!settings.saveResume) throw notFound("Saved answers");
  const id = await readResume(deps, f.id, resume);
  const row = id ? await deps.db.select().from(formPartialsTd7).where(and(eq(formPartialsTd7.id, id), eq(formPartialsTd7.formId, f.id))).get() : null;
  if (!row || row.expiresAt.getTime() <= deps.now().getTime()) throw notFound("Saved answers");
  return { answers: cleanAnswers(fieldIdsOf(f), JSON.parse(row.answers)), expiresAt: row.expiresAt.toISOString() };
}

// ---------------------------------------------------------------- counts

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
async function bump(deps: Deps, formId: string, col: "views" | "starts" | "completions") {
  const day = dayOf(deps.now());
  const c = sql.raw(col);
  await deps.db.run(sql`INSERT INTO form_stats_td7 (form_id, day, ${c}) VALUES (${formId}, ${day}, 1) ON CONFLICT(form_id, day) DO UPDATE SET ${c} = ${c} + 1`);
}

/** One view, start or question reached. No cookie, no stored visitor id; a per address hourly cap stops inflation. */
export async function recordEvent(deps: Deps, slug: string, body: { kind?: unknown; field?: unknown }, ip: string) {
  const f = await publicRow(deps, slug);
  const kind = body.kind;
  if (kind !== "view" && kind !== "start" && kind !== "reach") throw new HttpError(422, "validation_failed", "Unknown event.");
  if (await limited(deps, `td7ev:${f.id}:${await ipKey(deps, ip)}`, EVENTS_PER_HOUR, 60 * 60_000)) return; // dropped quietly
  if (kind === "reach") {
    const field = typeof body.field === "string" ? body.field : "";
    if (!fieldIdsOf(f).has(field)) throw new HttpError(422, "validation_failed", "Unknown question.");
    await deps.db.run(sql`INSERT INTO form_reach_td7 (form_id, field_id, n) VALUES (${f.id}, ${field}, 1) ON CONFLICT(form_id, field_id) DO UPDATE SET n = n + 1`);
    return;
  }
  await bump(deps, f.id, kind === "view" ? "views" : "starts");
}

export async function analytics(deps: Deps, actor: SuiteActor, formId: string) {
  const f = await ownForm(deps, actor.orgId, formId);
  const days = await deps.db.select().from(formStatsTd7).where(eq(formStatsTd7.formId, f.id)).orderBy(desc(formStatsTd7.day)).limit(90).all();
  const totals = days.reduce((a, d) => ({ views: a.views + d.views, starts: a.starts + d.starts, completions: a.completions + d.completions }), { views: 0, starts: 0, completions: 0 });
  const reachRows = await deps.db.select().from(formReachTd7).where(eq(formReachTd7.formId, f.id)).all();
  const reach = Object.fromEntries(reachRows.map((r) => [r.fieldId, r.n]));
  const fields = (JSON.parse(f.fields) as { id: string; label: string; type: string }[]).filter((x) => !["heading", "paragraph", "image", "divider", "page"].includes(x.type));
  const partials = await deps.db.select({ n: sql<number>`count(*)` }).from(formPartialsTd7).where(and(eq(formPartialsTd7.formId, f.id), sql`${formPartialsTd7.expiresAt} > ${deps.now().getTime()}`)).get();
  return {
    totals, completionRate: completionRate(totals.views, totals.completions), startRate: completionRate(totals.views, totals.starts),
    days: days.slice(0, 30).reverse().map((d) => ({ day: d.day, views: d.views, starts: d.starts, completions: d.completions })),
    questions: dropOff(fields, reach, totals.completions), partials: Number(partials?.n ?? 0),
  };
}

export async function listPartials(deps: Deps, actor: SuiteActor, formId: string) {
  const f = await ownForm(deps, actor.orgId, formId);
  const rows = await deps.db.select().from(formPartialsTd7).where(and(eq(formPartialsTd7.formId, f.id), sql`${formPartialsTd7.expiresAt} > ${deps.now().getTime()}`)).orderBy(desc(formPartialsTd7.updatedAt)).limit(200).all();
  return { partials: rows.map((r) => ({ id: r.id, answered: r.answered, answers: JSON.parse(r.answers) as Record<string, string | string[]>, updatedAt: r.updatedAt.toISOString(), expiresAt: r.expiresAt.toISOString() })) };
}

export async function deletePartial(deps: Deps, actor: SuiteActor, formId: string, id: string) {
  assertWritable(actor);
  const f = await ownForm(deps, actor.orgId, formId);
  const row = await deps.db.select({ id: formPartialsTd7.id }).from(formPartialsTd7).where(and(eq(formPartialsTd7.id, id), eq(formPartialsTd7.formId, f.id))).get();
  if (!row) throw notFound("Saved answers");
  await deps.db.delete(formPartialsTd7).where(eq(formPartialsTd7.id, row.id));
  return { ok: true };
}

/** The workspace logo for a branded form, from the existing branding storage, on our own origin. */
export async function formLogo(deps: Deps, slug: string, dark: boolean) {
  const f = await publicRow(deps, slug);
  const { settings } = await loadPro(deps, f.id);
  if (settings.brand.logo === "none") throw notFound("Logo");
  const base = settings.brand.logo === "wide" ? "wide" : "mark";
  const kinds = dark ? [`${base}_dark`, `${base}_light`] : [`${base}_light`, `${base}_dark`];
  for (const kind of kinds) {
    const r = await deps.db.select().from(workspaceBrandLogos).where(and(eq(workspaceBrandLogos.orgId, f.orgId), eq(workspaceBrandLogos.kind, kind as "mark_light"))).get();
    if (r && /^image\/(png|jpeg|webp)$/.test(r.contentType)) return { bytes: fromB64(r.contentB64), contentType: r.contentType };
  }
  throw notFound("Logo");
}

// ---------------------------------------------------------------- AI draft

const DRAFT_SYSTEM = "You design short web forms. Reply with JSON only: {\"name\": string, \"description\": string, \"fields\": [{\"label\": string, \"type\": one of text, email, textarea, phone, select, multiselect, number, date, rating, \"required\": boolean, \"options\": string[] for select and multiselect}]}. Use at most 15 questions, sentence case, plain words, no dashes.";

/**
 * Drafts a form from one sentence through the workspace's existing AI routing: its own key, or built in AI (AI2)
 * with its single meter (never billed). Gate first: AI switched off (TD1) or no key and no built in AI means 409 and
 * no provider call.
 */
export async function aiDraft(deps: Deps, actor: SuiteActor, prompt: unknown) {
  assertWritable(actor);
  if (!(await td7On(deps, actor.orgId))) throw notFound("Page");
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (text.length < 4 || text.length > PROMPT_MAX) throw new HttpError(422, "validation_failed", `Describe the form in 4 to ${PROMPT_MAX} characters.`, { fields: { prompt: `Use 4 to ${PROMPT_MAX} characters.` } });
  const gate = await formsAiGate(deps, actor.orgId);
  if (gate === "off") throw new HttpError(409, "ai_off", "AI is turned off for this workspace. Paste your questions or import a CSV instead.");
  if (gate === "no_key") throw new HttpError(409, "ai_no_key", "Add your AI key in Settings to draft with AI, or paste your questions or import a CSV instead.");
  let out: string | null;
  let fallback: { reason: string; message: string } | undefined;
  try {
    const { askWorkspaceAi } = await import("../ai");
    const res = await askWorkspaceAi(deps, actor.orgId, { system: DRAFT_SYSTEM, user: text, maxTokens: 1200 });
    out = res.text;
    fallback = res.fallback; // QUAL1 review: built-in AI drafted in place of a refused workspace key, and the answer says so
  } catch (err) {
    if (err instanceof HttpError) throw err; // AI off, today's built in limit, or the provider's own refusal, in plain words
    throw new HttpError(502, "ai_failed", "The AI service didn't answer. Try again, or paste your questions instead.");
  }
  const draft = out ? cleanDraft(out) : null;
  if (!draft) throw new HttpError(502, "ai_failed", "The AI answer couldn't be used. Try again with more detail, or paste your questions instead.");
  return { draft, ...(fallback ? { fallback } : {}) };
}
