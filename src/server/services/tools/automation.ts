/**
 * Tools P2 (automation): auto rules before sending, saved workflows, document templates and mail merge.
 * Tables from migration 0098 (raw SQL like tool_usage, so schema.ts stays untouched by Tools).
 * Engine calls go through the same signed job API as P1 (services/tools/engine-client).
 */
import { and, eq, sql } from "drizzle-orm";
import { attachments, messages } from "../../db/schema";
import { inIds } from "../../lib/sql-chunks";
import { attachmentBytes } from "../mail/store";
import { assertMailboxAccess, mailboxScope } from "../team";
import { unzipSync } from "fflate";
import type { Deps, AuthContext } from "../../context";
import { HttpError, badRequest, notFound, planLimit } from "../../lib/errors";
import { hmacSha256Hex, newId, safeEqual } from "../../lib/crypto";
import { engineFetch, type EngineConfig } from "./engine-client";
import { mintToken } from "./tokens";
import { dayOf, readToolState, recordRun, toolLimits, toolsOnFor, type ToolState } from "./usage";
import { resultName, isToolOp, type ToolOp } from "@/shared/tools";
import {
  BUILT_IN_KEYS, BUILT_IN_TEMPLATES, FIELD_KEY, MERGE_DAILY_CAP, MERGE_MAX_ROWS, MERGE_SPACING_SECONDS, TEMPLATE_FIELDS_MAX, TEMPLATE_HTML_MAX,
  builtInTemplate, checkWorkflow, clampMb, effectiveRules, fillTemplate, isEmail, mergeRowValues, mergeTemplateHtml, missingRequired,
  needsRunPassword, personalBody, fillText, placeholdersIn, unsubscribeLine,
  type RuleMode, type SendRulesRow, type TemplateDef, type TemplateField, type TemplateKind, type WorkflowFinish, type WorkflowStep,
} from "@/shared/tools-automation";

// ------------------------------------------------------------------ engine

export interface EngineFile { name: string; type: string; bytes: Uint8Array }
export interface ToolsSetup { engine: EngineConfig; tokenKey: string }

/** The engine and token key when Tools is on for this deployment; otherwise a plain 404. */
export function toolsSetup(deps: Deps): ToolsSetup {
  const t = deps.config.tools;
  if (!t.enabled || !t.engine || !t.tokenKey) throw notFound("Page");
  return { engine: t.engine, tokenKey: t.tokenKey };
}

/** The workspace's plan, switch and run counts; 404 when its admins switched Tools off. */
export async function toolStateOrOff(deps: Deps, orgId: string): Promise<ToolState> {
  const s = await readToolState(deps.db, orgId, deps.now());
  if (!s || !toolsOnFor(s)) throw notFound("Page");
  return s;
}

/** The plan's daily and monthly run allowance (an automation run counts as one Tools run). */
export function checkRunAllowance(s: ToolState, bytes: number) {
  const l = toolLimits(s.plan);
  if (bytes > l.maxBytes) throw new HttpError(413, "too_large", `That upload is larger than your plan allows (${Math.round(l.maxBytes / (1024 * 1024))} MB).`);
  if (s.month >= l.runsMonthly) throw planLimit(`Your workspace has used all ${l.runsMonthly} tool runs this month. They reset on the 1st.`);
  if (s.day >= l.runsDaily) throw planLimit(`Your workspace has used all ${l.runsDaily} tool runs for today. Try again tomorrow.`);
  return l;
}

const engineDown = () => new HttpError(503, "tools_unavailable", "Tools are warming up. Try again in a few seconds.");

async function engineError(res: Response): Promise<never> {
  let message = "";
  try { message = ((await res.json()) as { message?: string }).message ?? ""; } catch { /* not JSON */ }
  if (res.status === 400) throw new HttpError(422, "tool_input", message || "That file could not be used with this tool.");
  if (res.status === 413) throw new HttpError(413, "too_large", message || "That upload is larger than your plan allows.");
  if (res.status === 429) throw new HttpError(429, "tools_busy", message || "Tools are busy. Try again in a minute.");
  throw engineDown();
}

async function call(deps: Deps, engine: EngineConfig, init: Parameters<typeof engineFetch>[2]) {
  try { return await engineFetch(deps.fetch, engine, init); } catch { throw engineDown(); }
}

/** Builds the multipart body (files plus option fields, all strings) the engine's job API takes. */
export async function multipart(files: EngineFile[], options: Record<string, string>) {
  const fd = new FormData();
  for (const f of files) fd.append("files", new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.type || "application/octet-stream" }), f.name);
  for (const [k, v] of Object.entries(options)) fd.append(k, v);
  const req = new Request("http://engine.local/", { method: "POST", body: fd });
  const bytes = new Uint8Array(await req.arrayBuffer());
  return { bytes, contentType: req.headers.get("content-type")! };
}

/** Starts one engine job and returns its id. */
export async function submitEngineJob(deps: Deps, engine: EngineConfig, who: { orgId: string; userId: string }, op: string, files: EngineFile[], options: Record<string, string>, maxBytes: number): Promise<string> {
  const { bytes, contentType } = await multipart(files, options);
  const res = await call(deps, engine, {
    method: "POST", path: `/internal/v1/jobs?op=${encodeURIComponent(op)}`, ws: who.orgId, user: who.userId || "system", maxBytes,
    body: new Response(bytes).body, contentLength: bytes.byteLength, contentType,
  });
  if (res.status !== 202) await engineError(res);
  return ((await res.json()) as { id: string }).id;
}

export interface EngineJob { status: "queued" | "running" | "done" | "failed" | "expired"; error?: string; result?: Record<string, unknown> }

export async function engineJobStatus(deps: Deps, engine: EngineConfig, who: { orgId: string; userId: string }, id: string): Promise<EngineJob> {
  const res = await call(deps, engine, { method: "GET", path: `/internal/v1/jobs/${id}`, ws: who.orgId, user: who.userId || "system", maxBytes: 0 });
  if (res.status === 404) return { status: "expired" };
  if (!res.ok) await engineError(res);
  return (await res.json()) as EngineJob;
}

export async function engineJobOutput(deps: Deps, engine: EngineConfig, who: { orgId: string; userId: string }, id: string): Promise<Uint8Array | null> {
  const res = await call(deps, engine, { method: "GET", path: `/internal/v1/jobs/${id}/output`, ws: who.orgId, user: who.userId || "system", maxBytes: 0 });
  if (res.status === 404) return null;
  if (!res.ok) await engineError(res);
  return new Uint8Array(await res.arrayBuffer());
}

/** Starts a job for a person (counted like P1 when it finishes) and mints the status token the P1 poll and download routes read. */
export async function startTokenJob(deps: Deps, auth: Pick<AuthContext, "orgId" | "userId">, op: string, files: EngineFile[], options: Record<string, string>, name: string) {
  const { engine, tokenKey } = toolsSetup(deps);
  const s = await toolStateOrOff(deps, auth.orgId);
  const bytes = files.reduce((a, f) => a + f.bytes.byteLength, 0);
  const l = checkRunAllowance(s, bytes);
  const id = await submitEngineJob(deps, engine, auth, op, files, options, l.maxBytes);
  const now = deps.now();
  // R66 (MB-256): the run is counted by the status read that sees it finished (chargeJob), from the bytes in the token.
  // The poll and download routes only need the name and the op; ops outside the P1 list download as octet-stream.
  const token = await mintToken(tokenKey, { k: "s", j: id, w: auth.orgId, u: auth.userId, o: op as ToolOp, n: name, b: bytes }, now.getTime());
  return { token, op, status: "queued" as const, name, jobId: id };
}

/** Mail attachments the person can see (their mailbox scope), read from the workspace's own mail. */
export async function loadAttachmentFiles(deps: Deps, auth: Pick<AuthContext, "orgId" | "userId" | "role">, attachmentIds: string[]): Promise<EngineFile[]> {
  const ids = [...new Set(attachmentIds)].slice(0, 50);
  if (!ids.length) return [];
  const scope = await mailboxScope(deps.db, auth as AuthContext);
  const rows = await deps.db.select({ a: attachments, mailboxId: messages.mailboxId }).from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(inIds(attachments.id, ids), eq(messages.orgId, auth.orgId))).all();
  const byId = new Map(rows.filter((r) => !scope || scope.includes(r.mailboxId)).map((r) => [r.a.id, r.a]));
  const out: EngineFile[] = [];
  for (const id of ids) {
    const a = byId.get(id);
    if (!a) throw notFound("Attachment");
    const bytes = await attachmentBytes(a, deps.bodyStore);
    if (!bytes) throw new HttpError(422, "tool_input", "That attachment is not stored, so it cannot be used here.");
    out.push({ name: a.filename.replace(/[\r\n"\\/]/g, "_").slice(0, 120), type: a.contentType || "application/octet-stream", bytes: new Uint8Array(bytes) });
  }
  return out;
}

// ------------------------------------------------------------------ 3: auto rules

interface RuleRow { user_id: string; compress: string | null; compress_over_mb: number | null; word_pdf: string | null }
const asMode = (v: string | null): RuleMode | null => (v === "on" || v === "off" ? v : null);
const toRow = (r: RuleRow | undefined): SendRulesRow | null => (r ? { compress: asMode(r.compress), compressOverMb: r.compress_over_mb, wordPdf: asMode(r.word_pdf) } : null);

/** The workspace rules, the person's own and what applies to them, in one read. */
export async function readRules(deps: Deps, orgId: string, userId: string) {
  const rows = await deps.db.all<RuleRow>(sql`select user_id, compress, compress_over_mb, word_pdf from tool_send_rules where org_id = ${orgId} and user_id in ('', ${userId})`);
  const workspace = toRow(rows.find((r) => r.user_id === ""));
  const mine = toRow(rows.find((r) => r.user_id === userId && userId !== ""));
  return { workspace, mine, effective: effectiveRules(workspace, mine) };
}

/** Saves the workspace row (userId "") or a person's row. One upsert. */
export async function saveRules(deps: Deps, orgId: string, userId: string, r: SendRulesRow) {
  const mb = r.compressOverMb === null ? null : clampMb(r.compressOverMb);
  await deps.db.run(sql`insert into tool_send_rules (org_id, user_id, compress, compress_over_mb, word_pdf, updated_at)
    values (${orgId}, ${userId}, ${r.compress}, ${mb}, ${r.wordPdf}, ${deps.now().getTime()})
    on conflict (org_id, user_id) do update set compress = excluded.compress, compress_over_mb = excluded.compress_over_mb, word_pdf = excluded.word_pdf, updated_at = excluded.updated_at`);
}

// ------------------------------------------------------------------ 25: workflows

interface WorkflowRow { id: string; name: string; steps: string; finish: string; created_at: number; updated_at: number }
export interface Workflow { id: string; name: string; steps: WorkflowStep[]; finish: WorkflowFinish; createdAt: string; updatedAt: string }
const presentWorkflow = (r: WorkflowRow): Workflow => ({ id: r.id, name: r.name, steps: JSON.parse(r.steps) as WorkflowStep[], finish: (["download", "email", "share"].includes(r.finish) ? r.finish : "download") as WorkflowFinish, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() });
export const WORKFLOWS_PER_WORKSPACE = 50;

export async function listWorkflows(deps: Deps, orgId: string): Promise<Workflow[]> {
  const rows = await deps.db.all<WorkflowRow>(sql`select id, name, steps, finish, created_at, updated_at from tool_workflows where org_id = ${orgId} order by updated_at desc limit ${WORKFLOWS_PER_WORKSPACE}`);
  return rows.map(presentWorkflow);
}

export async function getWorkflow(deps: Deps, orgId: string, id: string): Promise<Workflow> {
  const r = await deps.db.get<WorkflowRow>(sql`select id, name, steps, finish, created_at, updated_at from tool_workflows where org_id = ${orgId} and id = ${id}`);
  if (!r) throw notFound("Workflow");
  return presentWorkflow(r);
}

function cleanSteps(steps: WorkflowStep[]): WorkflowStep[] {
  const out = steps.map((s) => ({ op: s.op, options: Object.fromEntries(Object.entries(s.options ?? {}).filter(([, v]) => typeof v === "string").map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 500)])) }));
  const why = checkWorkflow(out);
  if (why) throw badRequest(why);
  return out;
}

export async function saveWorkflow(deps: Deps, auth: Pick<AuthContext, "orgId" | "userId">, input: { id?: string; name: string; steps: WorkflowStep[]; finish: WorkflowFinish }): Promise<Workflow> {
  const steps = JSON.stringify(cleanSteps(input.steps));
  const now = deps.now().getTime();
  const name = input.name.trim().slice(0, 80) || "Workflow";
  if (input.id) {
    const r = await deps.db.run(sql`update tool_workflows set name = ${name}, steps = ${steps}, finish = ${input.finish}, updated_at = ${now} where org_id = ${auth.orgId} and id = ${input.id}`);
    if (!changes(r)) throw notFound("Workflow");
    return getWorkflow(deps, auth.orgId, input.id);
  }
  const n = await deps.db.get<{ n: number }>(sql`select count(*) as n from tool_workflows where org_id = ${auth.orgId}`);
  if ((n?.n ?? 0) >= WORKFLOWS_PER_WORKSPACE) throw planLimit(`A workspace can save up to ${WORKFLOWS_PER_WORKSPACE} workflows. Delete one first.`);
  const id = newId("wfl");
  await deps.db.run(sql`insert into tool_workflows (id, org_id, name, steps, finish, created_by, created_at, updated_at) values (${id}, ${auth.orgId}, ${name}, ${steps}, ${input.finish}, ${auth.userId}, ${now}, ${now})`);
  return getWorkflow(deps, auth.orgId, id);
}

export async function deleteWorkflow(deps: Deps, orgId: string, id: string) {
  const r = await deps.db.run(sql`delete from tool_workflows where org_id = ${orgId} and id = ${id}`);
  if (!changes(r)) throw notFound("Workflow");
}

const changes = (r: unknown) => Number((r as { meta?: { changes?: number }; changes?: number })?.meta?.changes ?? (r as { changes?: number })?.changes ?? 0);

/**
 * Runs a workflow as one engine chain job (contract E2). A password the protect or unlock step needs is
 * passed only for this run and never stored. Returns the P1 style job (token) the browser polls.
 */
export async function runWorkflow(deps: Deps, auth: Pick<AuthContext, "orgId" | "userId">, steps: WorkflowStep[], files: EngineFile[], runPassword?: string) {
  const clean = cleanSteps(steps);
  if (needsRunPassword(clean)) {
    if (!runPassword || runPassword.length < 4 || runPassword.length > 128) throw badRequest("Type the password this workflow uses (4 to 128 characters).");
  }
  if (!files.length) throw badRequest("Add a file to run this workflow on.");
  const withPw = clean.map((s) => (s.op === "protect" || s.op === "unlock" ? { ...s, options: { ...s.options, password: runPassword! } } : s));
  const last = clean[clean.length - 1].op;
  const name = isToolOp(last) ? resultName(last, files[0]?.name) : `workflow-${files[0]?.name.replace(/\.[^.]+$/, "") || "result"}.pdf`;
  return startTokenJob(deps, auth, "chain", files, { steps: JSON.stringify(withPw) }, name);
}

// ------------------------------------------------------------------ 14: templates

interface TemplateRow { id: string; kind: string; name: string; html: string; fields: string; updated_at: number }
const presentTemplate = (r: TemplateRow): TemplateDef & { updatedAt: string } => ({ id: r.id, kind: r.kind as TemplateKind, name: r.name, html: r.html, fields: JSON.parse(r.fields) as TemplateField[], updatedAt: new Date(r.updated_at).toISOString() });
export const TEMPLATES_PER_WORKSPACE = 50;

export async function listTemplates(deps: Deps, orgId: string) {
  const rows = await deps.db.all<TemplateRow>(sql`select id, kind, name, html, fields, updated_at from tool_templates where org_id = ${orgId} order by updated_at desc limit ${TEMPLATES_PER_WORKSPACE}`);
  return [...BUILT_IN_TEMPLATES, ...rows.map(presentTemplate)];
}

export async function getTemplate(deps: Deps, orgId: string, id: string): Promise<TemplateDef> {
  const b = builtInTemplate(id);
  if (b) return b;
  const r = await deps.db.get<TemplateRow>(sql`select id, kind, name, html, fields, updated_at from tool_templates where org_id = ${orgId} and id = ${id}`);
  if (!r) throw notFound("Template");
  return presentTemplate(r);
}

/** Checks a custom template: field keys, types, size, no scripts or remote resources. */
export function checkTemplate(input: { name: string; html: string; fields: TemplateField[] }): string | null {
  if (!input.name.trim()) return "Give the template a name.";
  if (input.html.length > TEMPLATE_HTML_MAX) return "That template is too long (100,000 characters at most).";
  if (input.fields.length > TEMPLATE_FIELDS_MAX) return `A template has up to ${TEMPLATE_FIELDS_MAX} fields.`;
  if (/<script|\son[a-z]+\s*=|javascript:/i.test(input.html)) return "Templates can't contain scripts.";
  if (/(src|href)\s*=\s*["']?\s*(https?:)?\/\//i.test(input.html) || /url\(\s*["']?\s*(https?:)?\/\//i.test(input.html)) return "Templates can't load files from other websites. Use {{logo}} for your workspace logo.";
  const keys = new Set<string>();
  for (const f of input.fields) {
    if (!FIELD_KEY.test(f.key)) return `"${f.key}" can't be a field name. Use lowercase letters, numbers and underscores.`;
    if (BUILT_IN_KEYS.has(f.key)) return `"${f.key}" is filled in for you, so it can't be a field.`;
    if (keys.has(f.key)) return `The field "${f.key}" is listed twice.`;
    keys.add(f.key);
  }
  const unknown = placeholdersIn(input.html).filter((k) => !keys.has(k) && !BUILT_IN_KEYS.has(k));
  if (unknown.length) return `Add a field for ${unknown.map((k) => `{{${k}}}`).join(", ")}, or take it out of the template.`;
  return null;
}

export async function saveTemplate(deps: Deps, auth: Pick<AuthContext, "orgId" | "userId">, input: { id?: string; kind: TemplateKind; name: string; html: string; fields: TemplateField[] }) {
  const why = checkTemplate(input);
  if (why) throw badRequest(why);
  const now = deps.now().getTime();
  const fields = JSON.stringify(input.fields.map((f) => ({ key: f.key, label: f.label.slice(0, 80) || f.key, type: f.type, required: !!f.required })));
  const name = input.name.trim().slice(0, 80);
  if (input.id) {
    if (builtInTemplate(input.id)) throw badRequest("Built in templates can't be changed. Save a copy instead.");
    const r = await deps.db.run(sql`update tool_templates set kind = ${input.kind}, name = ${name}, html = ${input.html}, fields = ${fields}, updated_at = ${now} where org_id = ${auth.orgId} and id = ${input.id}`);
    if (!changes(r)) throw notFound("Template");
    return getTemplate(deps, auth.orgId, input.id);
  }
  const n = await deps.db.get<{ n: number }>(sql`select count(*) as n from tool_templates where org_id = ${auth.orgId}`);
  if ((n?.n ?? 0) >= TEMPLATES_PER_WORKSPACE) throw planLimit(`A workspace can save up to ${TEMPLATES_PER_WORKSPACE} templates. Delete one first.`);
  const id = newId("tpl");
  await deps.db.run(sql`insert into tool_templates (id, org_id, kind, name, html, fields, created_by, created_at, updated_at) values (${id}, ${auth.orgId}, ${input.kind}, ${name}, ${input.html}, ${fields}, ${auth.userId}, ${now}, ${now})`);
  return getTemplate(deps, auth.orgId, id);
}

export async function deleteTemplate(deps: Deps, orgId: string, id: string) {
  if (builtInTemplate(id)) throw badRequest("Built in templates can't be deleted.");
  const r = await deps.db.run(sql`delete from tool_templates where org_id = ${orgId} and id = ${id}`);
  if (!changes(r)) throw notFound("Template");
}

/** The workspace name and its logo as a data URI (only an inline logo; the engine fetches nothing remote). */
export async function templateContext(deps: Deps, orgId: string) {
  const o = await deps.db.get<{ name: string; logo: string | null }>(sql`select name, logo from organizations where id = ${orgId}`);
  const logo = o?.logo && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(o.logo) && o.logo.length < 400_000 ? o.logo : null;
  return { workspaceName: o?.name ?? "Your business", logoDataUri: logo, today: dayOf(deps.now()) };
}

/** Fills a template and asks the engine to render it as a PDF. The values are filled and escaped here. */
export async function renderTemplate(deps: Deps, auth: Pick<AuthContext, "orgId" | "userId">, id: string, values: Record<string, unknown>) {
  const t = await getTemplate(deps, auth.orgId, id);
  const missing = missingRequired(t, values);
  if (missing.length) throw badRequest(`Fill in ${missing.join(", ")}.`);
  const html = fillTemplate(t, values, await templateContext(deps, auth.orgId));
  const label = String(values.invoice_number ?? values.quote_number ?? values.subject ?? "").replace(/[^\w.-]+/g, "-").slice(0, 40);
  const name = `${t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${label ? `-${label}` : ""}.pdf`;
  return startTokenJob(deps, auth, "render", [{ name: "template.html", type: "text/html", bytes: new TextEncoder().encode(html) }], { data: "{}" }, name);
}

// ------------------------------------------------------------------ 15: mail merge

function fileStore(deps: Deps) {
  if (!deps.toolFiles) throw new HttpError(503, "tools_unavailable", "Mail merge isn't set up on this server yet.");
  return deps.toolFiles;
}

export interface MergePerson { email: string; name: string; data: Record<string, string> }
export interface MergeInput { templateId: string; mailboxId: string; subject: string; body: string; people: MergePerson[]; consent: boolean; marketing: boolean }

export const CONSENT_REQUIRED = "Tick the box to confirm these people agreed to get this email.";

/**
 * Takes `n` people from today's mail merge allowance in one conditional upsert, so two runs started at
 * once can never pass the cap. Returns false (and takes nothing) when the run would go over.
 */
export async function reserveMergeQuota(deps: Deps, orgId: string, n: number, cap: number): Promise<boolean> {
  if (n > cap) return false;
  const day = dayOf(deps.now());
  const rows = await deps.db.all<{ n: number }>(sql`insert into merge_daily (org_id, day, n) values (${orgId}, ${day}, ${n})
    on conflict (org_id, day) do update set n = merge_daily.n + excluded.n where merge_daily.n + excluded.n <= ${cap}
    returning n`);
  return rows.length > 0;
}

export async function mergeUsedToday(deps: Deps, orgId: string): Promise<number> {
  const r = await deps.db.get<{ n: number }>(sql`select n from merge_daily where org_id = ${orgId} and day = ${dayOf(deps.now())}`);
  return Number(r?.n ?? 0);
}

async function releaseMergeQuota(deps: Deps, orgId: string, n: number, day: string) {
  if (n > 0) await deps.db.run(sql`update merge_daily set n = max(0, n - ${n}) where org_id = ${orgId} and day = ${day}`);
}

const MERGE_KEY_TTL = 3 * 86_400;
const pdfKey = (runId: string, idx: number) => `merge/${runId}/${idx}.pdf`;
const rowFile = (idx: number) => String(idx).padStart(4, "0");

/**
 * Starts a merge: consent is required, the people are cleaned (valid, unique, not unsubscribed for a
 * marketing send), today's cap is reserved, then one render-batch job makes everyone's PDF.
 */
export async function startMerge(deps: Deps, auth: MergeWho, input: MergeInput) {
  if (input.consent !== true) throw new HttpError(400, "consent_required", CONSENT_REQUIRED);
  if (!input.subject.trim()) throw badRequest("Add a subject.");
  // PRIV1b (P16): a merge writes new mail to everyone on the list, so it needs the Send level on the mailbox.
  await assertMailboxAccess(deps.db, auth, input.mailboxId, "send");
  const { engine } = toolsSetup(deps);
  const s = await toolStateOrOff(deps, auth.orgId);
  const t = await getTemplate(deps, auth.orgId, input.templateId);
  const seen = new Set<string>();
  let people = input.people.map((p) => ({ email: p.email.trim().toLowerCase(), name: p.name.trim().slice(0, 120), data: Object.fromEntries(Object.entries(p.data ?? {}).slice(0, 60).map(([k, v]) => [k.slice(0, 40), String(v ?? "").slice(0, 2000)])) }))
    .filter((p) => isEmail(p.email) && !seen.has(p.email) && seen.add(p.email));
  if (!people.length) throw badRequest("None of those rows has a valid email address.");
  if (people.length > MERGE_MAX_ROWS) throw badRequest(`A mail merge sends to up to ${MERGE_MAX_ROWS} people at once.`);
  let skipped = 0;
  if (input.marketing) {
    const unsub = new Set((await deps.db.all<{ email: string }>(sql`select email from merge_unsubscribes where org_id = ${auth.orgId}`)).map((r) => r.email));
    const before = people.length;
    people = people.filter((p) => !unsub.has(p.email));
    skipped = before - people.length;
    if (!people.length) throw badRequest("Everyone on this list has unsubscribed from your emails.");
  }
  const cap = MERGE_DAILY_CAP[s.plan];
  const used = await mergeUsedToday(deps, auth.orgId);
  if (!(await reserveMergeQuota(deps, auth.orgId, people.length, cap))) {
    throw planLimit(`Your plan can mail merge to ${cap} people a day. ${Math.max(0, cap - used)} left today, and this list has ${people.length}. Send the rest tomorrow.`);
  }
  const day = dayOf(deps.now());
  try {
    checkRunAllowance(s, 0);
    const ctx = await templateContext(deps, auth.orgId);
    const html = mergeTemplateHtml(t.html).replace(/\{\{\s*logo\s*\}\}/g, ctx.logoDataUri ? `<img class="logo" src="${ctx.logoDataUri}" alt="">` : "");
    const rows = people.map((p, i) => ({ ...mergeRowValues(t, { name: p.name, email: p.email, ...p.data }, ctx), _file: rowFile(i) }));
    const id = newId("mrg");
    const jobId = await submitEngineJob(deps, engine, auth, "render-batch", [{ name: "template.html", type: "text/html", bytes: new TextEncoder().encode(html) }],
      { rows: JSON.stringify(rows), name_field: "_file" }, toolLimits(s.plan).maxBytes);
    const now = deps.now().getTime();
    await deps.db.run(sql`insert into merge_runs (id, org_id, user_id, mailbox_id, template_id, subject, body, marketing, consent_at, total, status, engine_job, created_at, updated_at)
      values (${id}, ${auth.orgId}, ${auth.userId}, ${input.mailboxId}, ${t.id}, ${input.subject.slice(0, 300)}, ${input.body.slice(0, 20_000)}, ${input.marketing ? 1 : 0}, ${now}, ${people.length}, 'rendering', ${jobId}, ${now}, ${now})`);
    // One insert per 15 people (90 bound values) keeps each statement under D1's limit of 100.
    for (let i = 0; i < people.length; i += 15) {
      const chunk = people.slice(i, i + 15).map((p, j) => sql`(${id}, ${i + j}, ${auth.orgId}, ${p.email}, ${p.name}, ${JSON.stringify(p.data)})`);
      await deps.db.run(sql`insert into merge_recipients (run_id, idx, org_id, email, name, data) values ${sql.join(chunk, sql`, `)}`);
    }
    await recordRun(deps.db, auth.orgId, deps.now(), 0);
    return { id, total: people.length, skippedUnsubscribed: skipped };
  } catch (err) {
    await releaseMergeQuota(deps, auth.orgId, people.length, day);
    throw err;
  }
}

interface RunRow { id: string; org_id: string; user_id: string; mailbox_id: string; template_id: string; subject: string; body: string; marketing: number; total: number; sent: number; failed: number; status: string; engine_job: string | null; error: string | null; created_at: number; updated_at: number }

async function runRow(deps: Deps, orgId: string, id: string) {
  const r = await deps.db.get<RunRow>(sql`select * from merge_runs where org_id = ${orgId} and id = ${id}`);
  if (!r) throw notFound("Mail merge");
  return r;
}

/** PRIV1b (P16): who asks about merge runs: a person, whose role and mailboxes decide which runs they see. */
export type MergeWho = Pick<AuthContext, "orgId" | "userId" | "role">;

/** PRIV1b (P16): the SQL that keeps runs to the ones this person started or whose sending mailbox they can open. */
async function mergeVisible(deps: Deps, who: MergeWho) {
  const scope = await mailboxScope(deps.db, who);
  return scope ? sql`(user_id = ${who.userId} or ${inIds(sql`mailbox_id`, scope)})` : sql`1`;
}

/** A run this person may see (404 otherwise, as a run in another workspace). */
async function visibleRun(deps: Deps, who: MergeWho, id: string) {
  const r = await deps.db.get<RunRow>(sql`select * from merge_runs where org_id = ${who.orgId} and id = ${id} and ${await mergeVisible(deps, who)}`);
  if (!r) throw notFound("Mail merge");
  return r;
}

/**
 * Moves a rendering run on: when the engine's batch is done, every PDF goes to the tool file store
 * (3 days) and one send job per person is queued, spaced MERGE_SPACING_SECONDS apart.
 */
export async function advanceMerge(deps: Deps, r: RunRow): Promise<RunRow> {
  if (r.status !== "rendering" || !r.engine_job) return r;
  const { engine } = toolsSetup(deps);
  const who = { orgId: r.org_id, userId: r.user_id };
  const j = await engineJobStatus(deps, engine, who, r.engine_job);
  const now = deps.now().getTime();
  if (j.status === "queued" || j.status === "running") return r;
  const fail = async (msg: string) => {
    await deps.db.run(sql`update merge_runs set status = 'failed', error = ${msg}, updated_at = ${now} where id = ${r.id} and status = 'rendering'`);
    await releaseMergeQuota(deps, r.org_id, r.total, dayOf(new Date(r.created_at)));
    return { ...r, status: "failed", error: msg };
  };
  if (j.status !== "done") return fail(j.error || "The documents could not be made. Check the template and try again.");
  const zip = await engineJobOutput(deps, engine, who, r.engine_job);
  if (!zip) return fail("The documents expired before they could be sent. Start the merge again.");
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(zip); } catch { return fail("The documents could not be read. Start the merge again."); }
  // Claim the run first so two passes never queue the sends twice.
  const claimed = await deps.db.run(sql`update merge_runs set status = 'sending', updated_at = ${now} where id = ${r.id} and status = 'rendering'`);
  if (!changes(claimed)) return runRow(deps, r.org_id, r.id);
  const { enqueue } = await import("../jobs");
  for (let i = 0; i < r.total; i++) {
    const entry = Object.entries(files).find(([n]) => n.replace(/^.*\//, "").startsWith(rowFile(i)));
    if (entry) await fileStore(deps).put(pdfKey(r.id, i), entry[1], { ttlSeconds: MERGE_KEY_TTL });
    await enqueue(deps, "tools.merge_send", { runId: r.id, orgId: r.org_id, idx: i }, { orgId: r.org_id, delayMs: i * MERGE_SPACING_SECONDS * 1000, maxAttempts: 3 });
  }
  return { ...r, status: "sending" };
}

export async function mergeProgress(deps: Deps, who: MergeWho, id: string) {
  const orgId = who.orgId;
  let r = await visibleRun(deps, who, id);
  if (r.status === "rendering") r = await advanceMerge(deps, r);
  // The cron pass runs queued jobs every 15 minutes; while someone watches the progress view, sends that are
  // due go now (still one per MERGE_SPACING_SECONDS, still through the same queue and its claim).
  if (r.status === "sending") {
    const { runDueJobs } = await import("../jobs");
    await runDueJobs(deps, 2, { types: ["tools.merge_send"], orgId, budgetMs: 5000 });
    r = await runRow(deps, orgId, id);
  }
  const failures = await deps.db.all<{ email: string; error: string | null }>(sql`select email, error from merge_recipients where run_id = ${id} and status = 'failed' limit 50`);
  return { id: r.id, status: r.status, total: r.total, sent: r.sent, failed: r.failed, error: r.error, marketing: !!r.marketing, subject: r.subject, createdAt: new Date(r.created_at).toISOString(), failures };
}

export async function listMerges(deps: Deps, who: MergeWho) {
  const rows = await deps.db.all<RunRow>(sql`select * from merge_runs where org_id = ${who.orgId} and ${await mergeVisible(deps, who)} order by created_at desc limit 20`);
  return rows.map((r) => ({ id: r.id, status: r.status, total: r.total, sent: r.sent, failed: r.failed, subject: r.subject, createdAt: new Date(r.created_at).toISOString() }));
}

/** Stops a run: queued sends are skipped and the unused part of today's allowance comes back. */
export async function cancelMerge(deps: Deps, who: MergeWho, id: string) {
  const orgId = who.orgId;
  const r = await visibleRun(deps, who, id);
  // PRIV1b (SL2): stopping someone else's run changes the mailbox's mail, so it takes Read and reply (403 for a read share).
  if (r.user_id !== who.userId) await assertMailboxAccess(deps.db, who, r.mailbox_id, "reply");
  if (r.status === "done" || r.status === "cancelled" || r.status === "failed") return;
  await deps.db.run(sql`update merge_runs set status = 'cancelled', updated_at = ${deps.now().getTime()} where id = ${id}`);
  const left = await deps.db.get<{ n: number }>(sql`select count(*) as n from merge_recipients where run_id = ${id} and status = 'queued'`);
  await deps.db.run(sql`update merge_recipients set status = 'skipped' where run_id = ${id} and status = 'queued'`);
  if (dayOf(new Date(r.created_at)) === dayOf(deps.now())) await releaseMergeQuota(deps, orgId, Number(left?.n ?? 0), dayOf(deps.now()));
}

/** Cron pass for the lead: moves on runs whose page was closed while they rendered. Cost: 1 read + up to 3 runs. */
export async function runMergePass(deps: Deps): Promise<{ advanced: number }> {
  if (!deps.config.tools.enabled || !deps.config.tools.features.includes("merge_mail")) return { advanced: 0 };
  const rows = await deps.db.all<RunRow>(sql`select * from merge_runs where status = 'rendering' order by updated_at limit 3`);
  let advanced = 0;
  for (const r of rows) {
    try { const n = await advanceMerge(deps, r); if (n.status !== "rendering") advanced++; } catch { /* the next pass tries again */ }
  }
  return { advanced };
}

export async function unsubscribeToken(deps: Deps, orgId: string, email: string) {
  const key = deps.config.tools.tokenKey ?? "";
  return (await hmacSha256Hex(key, `merge.unsub.${orgId}.${email.toLowerCase()}`)).slice(0, 32);
}

export async function unsubscribeUrl(deps: Deps, orgId: string, email: string) {
  const q = new URLSearchParams({ o: orgId, e: email.toLowerCase(), s: await unsubscribeToken(deps, orgId, email) });
  return `${deps.config.appUrl}/api/mail-merge/unsubscribe?${q}`;
}

export async function checkUnsubscribe(deps: Deps, orgId: string, email: string, sig: string) {
  if (!orgId || !email || !sig || sig.length !== 32) return false;
  return safeEqual(await unsubscribeToken(deps, orgId, email), sig);
}

export async function recordUnsubscribe(deps: Deps, orgId: string, email: string) {
  await deps.db.run(sql`insert into merge_unsubscribes (org_id, email, created_at) values (${orgId}, ${email.toLowerCase()}, ${deps.now().getTime()}) on conflict do nothing`);
}

/** The send job: one email with the person's PDF, through the normal send service (its limits apply). */
export async function sendMergeOne(deps: Deps, payload: { runId: string; orgId: string; idx: number }) {
  const r = await deps.db.get<RunRow>(sql`select * from merge_runs where id = ${payload.runId} and org_id = ${payload.orgId}`);
  if (!r || r.status !== "sending") return;
  const p = await deps.db.get<{ email: string; name: string; data: string; status: string }>(sql`select email, name, data, status from merge_recipients where run_id = ${r.id} and idx = ${payload.idx}`);
  if (!p || p.status !== "queued") return;
  const person = { email: p.email, name: p.name, data: JSON.parse(p.data) as Record<string, string> };
  const now = deps.now().getTime();
  const mark = async (status: "sent" | "failed", error: string | null) => {
    const done = await deps.db.run(sql`update merge_recipients set status = ${status}, error = ${error}, sent_at = ${now} where run_id = ${r.id} and idx = ${payload.idx} and status = 'queued'`);
    if (!changes(done)) return;
    await deps.db.run(status === "sent"
      ? sql`update merge_runs set sent = sent + 1, updated_at = ${now}, status = case when sent + 1 + failed >= total then 'done' else status end where id = ${r.id}`
      : sql`update merge_runs set failed = failed + 1, updated_at = ${now}, status = case when sent + failed + 1 >= total then 'done' else status end where id = ${r.id}`);
  };
  if (r.marketing) {
    const u = await deps.db.get<{ email: string }>(sql`select email from merge_unsubscribes where org_id = ${r.org_id} and email = ${p.email}`);
    if (u) return mark("failed", "Unsubscribed");
  }
  const file = await fileStore(deps).get(pdfKey(r.id, payload.idx));
  if (!file) return mark("failed", "The document expired before it was sent.");
  const ctx = await templateContext(deps, r.org_id);
  let text = personalBody(r.body, person);
  if (r.marketing) text += unsubscribeLine(ctx.workspaceName, await unsubscribeUrl(deps, r.org_id, p.email));
  const user = await deps.db.get<{ email: string; name: string }>(sql`select email, name from users where id = ${r.user_id}`);
  const auth: AuthContext = { userId: r.user_id, email: user?.email ?? "", name: user?.name ?? "", orgId: r.org_id, role: "member", sessionId: `merge:${r.id}` };
  const safe = (person.name || person.email.split("@")[0]).replace(/[^\w .-]+/g, "").trim().slice(0, 60) || "document";
  try {
    const { sendMessage } = await import("../mail/send");
    await sendMessage(deps, auth, { mailboxId: r.mailbox_id, to: [p.email], subject: fillText(r.subject, person), text }, {
      attachments: [{ filename: `${safe}.pdf`, contentType: "application/pdf", content: new Uint8Array(file.bytes) }], noQueue: true,
    });
    await fileStore(deps).delete(pdfKey(r.id, payload.idx));
    await mark("sent", null);
  } catch (err) {
    const msg = err instanceof HttpError ? err.message : "The email could not be sent.";
    await mark("failed", msg.slice(0, 300));
  }
}
