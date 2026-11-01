/**
 * Custom fields per project: text, number, currency (AUD), date, single select, multi
 * select, person, checkbox and URL. Values live in task_field_values, one row per task and
 * field, so lists can filter and sort on them in SQL.
 */
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { hasScheme, isHexColour, isIsoDate, isSafeToken } from "../../lib/input-checks";
import type { Deps } from "../../context";
import { agents, customFields, members, projects, taskFieldValues, tasks } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { randomBytes } from "../../lib/crypto";
import { assertWritable, createdBy, recordWrite, sortableId, type SuiteActor } from "./common";
import { normalizeConfig, type ComputedConfig } from "./formula-config";
import { renameReferences } from "./formula-rename";
import { invalidateFieldDefs } from "./read-cache";
import { inIds } from "../../lib/sql-chunks";
import { containsText } from "../../lib/like-search";

export const FIELD_TYPES = ["text", "number", "currency", "date", "select", "multiselect", "person", "checkbox", "url", "formula", "rollup"] as const;
/** R24.1: computed on read from other values; nothing is stored per task. */
export const COMPUTED_TYPES: readonly FieldType[] = ["formula", "rollup"];
export const isComputedType = (t: string) => t === "formula" || t === "rollup";
export type FieldType = (typeof FIELD_TYPES)[number];
export interface FieldOption { id: string; label: string; color: string }
export type FieldValue = string | number | boolean | string[] | null;

type FieldRow = typeof customFields.$inferSelect;
export const OPTION_COLOURS = ["#ff5a36", "#2563eb", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#db2777", "#64748b"];

export function presentField(f: FieldRow) {
  const config = f.config ? (JSON.parse(f.config) as ComputedConfig) : undefined;
  return { id: f.id, projectId: f.projectId, name: f.name, type: f.type as FieldType, options: JSON.parse(f.options) as FieldOption[], position: f.position, ...(config ? { config } : {}),
    /** R84: set when the field is defined once for the whole workspace (the same key in every project). */
    workspaceKey: (f.workspaceKey ?? null) as string | null };
}
export type Field = Omit<ReturnType<typeof presentField>, "workspaceKey"> & { workspaceKey?: string | null };

const optionId = () => `opt_${Array.from(randomBytes(5), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** Keeps the ids of options that already exist (matched by id, then label), so values survive a rename. */
function mergeOptions(type: FieldType, input: { id?: string; label: string; color?: string }[] | undefined, existing: FieldOption[] = []): FieldOption[] {
  if (type !== "select" && type !== "multiselect") return [];
  const list = input ?? existing;
  const seen = new Set<string>();
  const out: FieldOption[] = [];
  list.forEach((o, i) => {
    const label = o.label.trim().slice(0, 60);
    if (!label || seen.has(label.toLowerCase())) return;
    seen.add(label.toLowerCase());
    const prev = existing.find((e) => (o.id && e.id === o.id)) ?? existing.find((e) => e.label.toLowerCase() === label.toLowerCase());
    out.push({ id: prev?.id ?? optionId(), label, color: isHexColour(o.color) ? o.color : prev?.color ?? OPTION_COLOURS[i % OPTION_COLOURS.length] });
  });
  if (out.length > 50) throw new HttpError(422, "validation_failed", "A field can have up to 50 options.");
  return out;
}

async function projectOf(deps: Deps, orgId: string, projectId: string) {
  const p = await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, projectId), isNull(projects.deletedAt))).get();
  if (!p) throw notFound("Project");
  return p;
}

export async function listFields(deps: Deps, orgId: string, projectId: string) {
  // Another workspace's project (or a made up id) is a 404, not an empty list.
  const project = await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, projectId))).get();
  if (!project) throw notFound("Project");
  const rows = await deps.db.select().from(customFields)
    .where(and(eq(customFields.orgId, orgId), eq(customFields.projectId, projectId), isNull(customFields.deletedAt)))
    .orderBy(asc(customFields.position), asc(customFields.createdAt));
  return rows.map(presentField);
}

async function fieldRow(deps: Deps, orgId: string, id: string) {
  const f = await deps.db.select().from(customFields).where(and(eq(customFields.orgId, orgId), eq(customFields.id, id), isNull(customFields.deletedAt))).get();
  if (!f) throw notFound("Field");
  return f;
}

export interface FieldInput { name: string; type: FieldType; options?: { id?: string; label: string; color?: string }[]; position?: number; /** R24.1: formula or rollup settings. */ config?: unknown }

export async function createField(deps: Deps, actor: SuiteActor, projectId: string, input: FieldInput, opts: { id?: string; retry?: boolean } = {}) {
  assertWritable(actor);
  if (opts.id && opts.retry) { // R52 (MB-239): a retry under the same Idempotency-Key returns what the first attempt made
    const hit = await deps.db.select().from(customFields).where(and(eq(customFields.id, opts.id), eq(customFields.orgId, actor.orgId))).get();
    if (hit) return presentField(hit as FieldRow);
  }
  await projectOf(deps, actor.orgId, projectId);
  const existing = await listFields(deps, actor.orgId, projectId);
  if (existing.length >= 50) throw new HttpError(422, "too_many_fields", "A project can have up to 50 custom fields.");
  const now = deps.now();
  const name = input.name.trim().slice(0, 60);
  const config = normalizeConfig(input.type, input.config, name, existing);
  const row = {
    id: opts.id ?? sortableId("fld", now.getTime()), orgId: actor.orgId, projectId, name, type: input.type, config: config ? JSON.stringify(config) : null,
    options: JSON.stringify(mergeOptions(input.type, input.options ?? (input.type === "select" || input.type === "multiselect" ? [] : undefined))),
    position: input.position ?? (existing.length ? Math.max(...existing.map((f) => f.position)) + 1 : 0),
    ...createdBy(actor), createdAt: now, updatedAt: now,
  };
  await deps.db.insert(customFields).values(row);
  invalidateFieldDefs(deps, actor.orgId); // R25 read cache
  const field = presentField({ ...row, version: 1, deletedAt: null } as FieldRow);
  await recordWrite(deps, actor, { entityType: "custom_field", entityId: field.id, op: "create", verb: "created", data: { name: field.name, type: field.type }, event: "custom_field.created", eventData: { field } });
  return field;
}

export async function updateField(deps: Deps, actor: SuiteActor, id: string, patch: Partial<Omit<FieldInput, "type">>) {
  assertWritable(actor);
  const f = await fieldRow(deps, actor.orgId, id);
  const type = f.type as FieldType;
  const set: Partial<typeof customFields.$inferInsert> = { updatedAt: deps.now(), version: f.version + 1 };
  if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 60) || f.name;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.options !== undefined) set.options = JSON.stringify(mergeOptions(type, patch.options, JSON.parse(f.options) as FieldOption[]));
  if (isComputedType(type) && (patch.config !== undefined || patch.name !== undefined)) {
    const others = (await listFields(deps, actor.orgId, f.projectId)).filter((x) => x.id !== f.id);
    const cfg = normalizeConfig(type, patch.config ?? (f.config ? JSON.parse(f.config) : {}), set.name ?? f.name, others);
    set.config = cfg ? JSON.stringify(cfg) : null;
  }
  await deps.db.update(customFields).set(set).where(eq(customFields.id, f.id));
  invalidateFieldDefs(deps, f.orgId); // R25 read cache
  if (set.name !== undefined && set.name !== f.name) await renameInFormulas(deps, actor.orgId, f.projectId, f.id, f.name, set.name);
  const field = presentField(await fieldRow(deps, actor.orgId, f.id));
  if (patch.options !== undefined) await dropMissingOptions(deps, field);
  await recordWrite(deps, actor, { entityType: "custom_field", entityId: field.id, op: "update", version: f.version + 1, verb: "updated", data: { name: field.name }, event: "custom_field.updated", eventData: { field } });
  return field;
}

/** R24 polish: formulas on the project that read the old name are rewritten to the new one (one write per changed formula). */
async function renameInFormulas(deps: Deps, orgId: string, projectId: string, fieldId: string, oldName: string, newName: string) {
  const rows = await deps.db.select().from(customFields)
    .where(and(eq(customFields.orgId, orgId), eq(customFields.projectId, projectId), eq(customFields.type, "formula"), isNull(customFields.deletedAt)));
  for (const r of rows) {
    if (r.id === fieldId || !r.config) continue;
    const cfg = JSON.parse(r.config) as { expression?: string };
    if (typeof cfg.expression !== "string") continue;
    const expression = renameReferences(cfg.expression, oldName, newName);
    if (expression === cfg.expression) continue;
    await deps.db.update(customFields).set({ config: JSON.stringify({ ...cfg, expression }), version: r.version + 1, updatedAt: deps.now() }).where(eq(customFields.id, r.id));
    invalidateFieldDefs(deps, orgId); // R25 read cache
  }
}

/** Values that point at a removed option are cleared, so filters and the board stay honest. */
async function dropMissingOptions(deps: Deps, field: Field) {
  const ids = new Set(field.options.map((o) => o.id));
  if (field.type === "select") {
    const rows = await deps.db.select({ taskId: taskFieldValues.taskId, v: taskFieldValues.valueText }).from(taskFieldValues).where(eq(taskFieldValues.fieldId, field.id));
    const gone = rows.filter((r) => r.v && !ids.has(r.v)).map((r) => r.taskId);
    for (let i = 0; i < gone.length; i += 90) await deps.db.delete(taskFieldValues).where(and(eq(taskFieldValues.fieldId, field.id), inArray(taskFieldValues.taskId, gone.slice(i, i + 90))));
  } else if (field.type === "multiselect") {
    const rows = await deps.db.select({ taskId: taskFieldValues.taskId, v: taskFieldValues.valueText }).from(taskFieldValues).where(eq(taskFieldValues.fieldId, field.id));
    for (const r of rows) {
      const list = (JSON.parse(r.v ?? "[]") as string[]);
      const kept = list.filter((x) => ids.has(x));
      if (kept.length === list.length) continue;
      if (kept.length) await deps.db.update(taskFieldValues).set({ valueText: JSON.stringify(kept) }).where(and(eq(taskFieldValues.fieldId, field.id), eq(taskFieldValues.taskId, r.taskId)));
      else await deps.db.delete(taskFieldValues).where(and(eq(taskFieldValues.fieldId, field.id), eq(taskFieldValues.taskId, r.taskId)));
    }
  }
}

export async function deleteField(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const f = await fieldRow(deps, actor.orgId, id);
  const now = deps.now();
  await deps.db.update(customFields).set({ deletedAt: now, updatedAt: now, version: f.version + 1 }).where(eq(customFields.id, f.id));
  invalidateFieldDefs(deps, f.orgId); // R25 read cache
  await deps.db.delete(taskFieldValues).where(eq(taskFieldValues.fieldId, f.id));
  await recordWrite(deps, actor, { entityType: "custom_field", entityId: f.id, op: "delete", version: f.version + 1, verb: "deleted", data: { name: f.name }, event: "custom_field.deleted", eventData: { field: presentField(f) } });
  return { ok: true as const };
}

// ---------------------------------------------------------------- values

const isDate = isIsoDate;
const bad = (field: Field, msg: string) => new HttpError(422, "invalid_field_value", `${field.name}: ${msg}`);

/** Checks and converts one value for storage. Null, "" and [] clear the value. */
export async function encodeValue(deps: Deps, orgId: string, field: Field, value: unknown): Promise<{ valueText: string | null; valueNum: number | null } | null> {
  if (isComputedType(field.type)) throw bad(field, "this field is computed and can't be set.");
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return null;
  switch (field.type) {
    case "text": {
      if (typeof value !== "string") throw bad(field, "expected text.");
      return { valueText: value.slice(0, 2000), valueNum: null };
    }
    case "url": {
      if (typeof value !== "string") throw bad(field, "expected a link.");
      const v = hasScheme(value.trim()) ? value.trim() : `https://${value.trim()}`;
      let u: URL;
      try { u = new URL(v); } catch { throw bad(field, "that link doesn't look right."); }
      if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "mailto:") throw bad(field, "links must start with https, http or mailto.");
      return { valueText: u.toString().slice(0, 2000), valueNum: null };
    }
    case "number":
    case "currency": {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[$,\s]|A\$/g, "")) : NaN;
      if (!Number.isFinite(n)) throw bad(field, "expected a number.");
      return { valueText: null, valueNum: field.type === "currency" ? Math.round(n * 100) / 100 : n };
    }
    case "date": {
      const v = typeof value === "string" ? value.slice(0, 10) : "";
      if (!isDate(v)) throw bad(field, "expected a date as YYYY-MM-DD.");
      return { valueText: v, valueNum: null };
    }
    case "checkbox": {
      if (typeof value !== "boolean" && value !== "true" && value !== "false") throw bad(field, "expected true or false.");
      const on = value === true || value === "true";
      return on ? { valueText: null, valueNum: 1 } : null;
    }
    case "select": {
      const v = String(value);
      const o = field.options.find((x) => x.id === v) ?? field.options.find((x) => x.label.toLowerCase() === v.toLowerCase());
      if (!o) throw bad(field, `"${v}" is not one of the options.`);
      return { valueText: o.id, valueNum: null };
    }
    case "multiselect": {
      const list = Array.isArray(value) ? value.map(String) : [String(value)];
      const ids = list.map((v) => (field.options.find((x) => x.id === v) ?? field.options.find((x) => x.label.toLowerCase() === v.toLowerCase()))?.id);
      if (ids.some((x) => !x)) throw bad(field, "one of those is not an option.");
      return { valueText: JSON.stringify([...new Set(ids as string[])]), valueNum: null };
    }
    case "person": {
      const raw = String(value);
      const kind = raw.slice(0, raw.indexOf(":"));
      const m = (kind === "member" || kind === "agent") && isSafeToken(raw.slice(kind.length + 1)) ? [raw, kind, raw.slice(kind.length + 1)] as const : null;
      if (!m) throw bad(field, "expected member:<id> or agent:<id>.");
      const ok = m[1] === "member"
        ? await deps.db.select({ id: members.id }).from(members).where(and(eq(members.organizationId, orgId), eq(members.userId, m[2]))).get()
        : await deps.db.select({ id: agents.id }).from(agents).where(and(eq(agents.orgId, orgId), eq(agents.id, m[2]))).get();
      if (!ok) throw bad(field, "that person is not in this workspace.");
      return { valueText: `${m[1]}:${m[2]}`, valueNum: null };
    }
  }
}

export function decodeValue(type: FieldType, row: { valueText: string | null; valueNum: number | null }): FieldValue {
  switch (type) {
    case "number": case "currency": return row.valueNum;
    case "checkbox": return row.valueNum === 1;
    case "multiselect": return JSON.parse(row.valueText ?? "[]") as string[];
    default: return row.valueText;
  }
}

/** Values for many tasks at once: taskId to { fieldId: value }. */
export async function valuesForTasks(deps: Deps, orgId: string, taskIds: string[]) {
  const out = new Map<string, Record<string, FieldValue>>();
  if (!taskIds.length) return out;
  const chunks: string[][] = [];
  for (let i = 0; i < taskIds.length; i += 90) chunks.push(taskIds.slice(i, i + 90));
  const parts = await Promise.all(chunks.map((ids) => deps.db
    .select({ taskId: taskFieldValues.taskId, fieldId: taskFieldValues.fieldId, valueText: taskFieldValues.valueText, valueNum: taskFieldValues.valueNum, type: customFields.type, wk: customFields.workspaceKey })
    .from(taskFieldValues).innerJoin(customFields, eq(customFields.id, taskFieldValues.fieldId))
    .where(and(eq(taskFieldValues.orgId, orgId), inIds(taskFieldValues.taskId, ids), isNull(customFields.deletedAt)))));
  for (const r of parts.flat()) {
    const m = out.get(r.taskId) ?? {};
    m[r.fieldId] = decodeValue(r.type as FieldType, r);
    // R84: a workspace field's value also answers to its key, so lists across projects read one column.
    if (r.wk) m[r.wk] = m[r.fieldId];
    out.set(r.taskId, m);
  }
  return out;
}

/** Sets several values on one task. Fields must belong to the task's project. Returns what changed. */
export async function setTaskFieldValues(deps: Deps, orgId: string, task: { id: string; projectId: string }, values: Record<string, unknown>) {
  const ids = Object.keys(values);
  if (!ids.length) return {};
  if (ids.length > 50) throw new HttpError(422, "validation_failed", "Up to 50 fields at a time.");
  const defs = new Map((await listFields(deps, orgId, task.projectId)).map((f) => [f.id, f]));
  const changed: Record<string, FieldValue> = {};
  const now = deps.now();
  for (const id of ids) {
    const field = defs.get(id) ?? [...defs.values()].find((f) => f.name.toLowerCase() === id.toLowerCase());
    if (!field) throw new HttpError(422, "unknown_field", `No field "${id}" on this task's project.`);
    const enc = await encodeValue(deps, orgId, field, values[id]);
    if (!enc) {
      await deps.db.delete(taskFieldValues).where(and(eq(taskFieldValues.taskId, task.id), eq(taskFieldValues.fieldId, field.id)));
      changed[field.id] = null;
    } else {
      await deps.db.insert(taskFieldValues).values({ taskId: task.id, fieldId: field.id, orgId, ...enc, updatedAt: now })
        .onConflictDoUpdate({ target: [taskFieldValues.taskId, taskFieldValues.fieldId], set: { ...enc, updatedAt: now } });
      changed[field.id] = decodeValue(field.type, enc);
    }
  }
  return changed;
}

/** A task moved to another project keeps no values from the old project's fields. */
export async function clearForeignValues(deps: Deps, taskId: string, projectId: string) {
  await deps.db.delete(taskFieldValues).where(and(eq(taskFieldValues.taskId, taskId),
    sql`${taskFieldValues.fieldId} not in (select id from custom_fields where project_id = ${projectId})`));
}

// ---------------------------------------------------------------- filters and sorting

export const FILTER_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "empty", "notempty"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export interface FieldFilter { fieldId: string; op: FilterOp; value?: string }

/** Reads `field.<id>=<op>:<value>` (or just `<value>`) query parameters. */
export function parseFieldFilters(query: Record<string, string | undefined>): FieldFilter[] {
  const out: FieldFilter[] = [];
  for (const [k, raw] of Object.entries(query)) {
    if (!k.startsWith("field.") || raw === undefined) continue;
    const fieldId = k.slice(6);
    if (!isSafeToken(fieldId)) continue;
    const i = raw.indexOf(":");
    const head = i > 0 ? raw.slice(0, i) : raw;
    if ((FILTER_OPS as readonly string[]).includes(head)) out.push({ fieldId, op: head as FilterOp, value: i > 0 ? raw.slice(i + 1) : undefined });
    else out.push({ fieldId, op: "eq", value: raw });
  }
  return out.slice(0, 10);
}

const has = (fieldId: string | string[], cond: SQL) => Array.isArray(fieldId)
  ? sql`exists (select 1 from task_field_values v where v.task_id = ${tasks.id} and v.field_id in (${sql.join(fieldId.map((id) => sql`${id}`), sql`, `)}) and ${cond})`
  : sql`exists (select 1 from task_field_values v where v.task_id = ${tasks.id} and v.field_id = ${fieldId} and ${cond})`;

/** R84: a filter or sort may name a workspace field key; it reads every project's copy (at most 80 at a time). */
async function defsFor(deps: Deps, orgId: string, ids: string[]) {
  const keys = ids.filter(isWorkspaceKey);
  const plain = ids.filter((x) => !isWorkspaceKey(x));
  const [byId, byKey] = await Promise.all([
    plain.length ? deps.db.select().from(customFields).where(and(eq(customFields.orgId, orgId), inIds(customFields.id, plain), isNull(customFields.deletedAt))) : [],
    keys.length ? deps.db.select().from(customFields).where(and(eq(customFields.orgId, orgId), inIds(customFields.workspaceKey, keys), isNull(customFields.deletedAt))) : [],
  ]);
  const out = new Map<string, { field: Field; ids: string | string[] }>();
  for (const d of byId) out.set(d.id, { field: presentField(d), ids: d.id });
  for (const k of keys) {
    const rows = byKey.filter((d) => d.workspaceKey === k).slice(0, 80);
    if (rows.length) out.set(k, { field: presentField(rows[0]), ids: rows.map((r) => r.id) });
  }
  return out;
}

/** SQL conditions for the filters; field ids are checked against the workspace. */
export async function fieldFilterConditions(deps: Deps, orgId: string, filters: FieldFilter[]): Promise<SQL[]> {
  if (!filters.length) return [];
  const byId = await defsFor(deps, orgId, filters.map((f) => f.fieldId));
  const out: SQL[] = [];
  for (const f of filters) {
    const hit = byId.get(f.fieldId);
    if (!hit) throw new HttpError(422, "unknown_field", `No field "${f.fieldId}" in this workspace.`);
    const field = { ...hit.field, id: hit.ids };
    if (isComputedType(field.type)) throw new HttpError(422, "computed_field", `${field.name} is computed when read, so it can't be used as a filter.`);
    const anyValue = sql`(v.value_text is not null or v.value_num is not null)`;
    if (f.op === "empty") { out.push(sql`not ${has(field.id, anyValue)}`); continue; }
    if (f.op === "notempty") { out.push(has(field.id, anyValue)); continue; }
    const v = f.value ?? "";
    const numeric = field.type === "number" || field.type === "currency";
    if (field.type === "checkbox") {
      const on = v === "true" || v === "1";
      out.push(on === (f.op !== "ne") ? has(field.id, sql`v.value_num = 1`) : sql`not ${has(field.id, sql`v.value_num = 1`)}`);
    } else if (numeric) {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new HttpError(422, "invalid_filter", `${field.name}: expected a number.`);
      const cmp = { eq: sql`=`, ne: sql`<>`, gt: sql`>`, gte: sql`>=`, lt: sql`<`, lte: sql`<=`, contains: sql`=` }[f.op];
      out.push(has(field.id, sql`v.value_num ${cmp} ${n}`));
    } else if (field.type === "multiselect") {
      const id = field.options.find((o) => o.id === v || o.label.toLowerCase() === v.toLowerCase())?.id ?? v;
      const c = has(field.id, containsText(sql`v.value_text`, `"${id.replace(/"/g, "")}"`));
      out.push(f.op === "ne" ? sql`not ${c}` : c);
    } else if (field.type === "select") {
      const id = field.options.find((o) => o.id === v || o.label.toLowerCase() === v.toLowerCase())?.id ?? v;
      out.push(f.op === "ne" ? sql`not ${has(field.id, sql`v.value_text = ${id}`)}` : has(field.id, sql`v.value_text = ${id}`));
    } else if (f.op === "contains" || ((field.type === "text" || field.type === "url") && f.op === "eq")) {
      out.push(has(field.id, containsText(sql`v.value_text`, v)));
    } else {
      const cmp = { eq: sql`=`, ne: sql`<>`, gt: sql`>`, gte: sql`>=`, lt: sql`<`, lte: sql`<=`, contains: sql`=` }[f.op];
      out.push(has(field.id, sql`v.value_text ${cmp} ${v}`));
    }
  }
  return out;
}

/** An ORDER BY expression for a field: empty values last. Select fields sort by option order. */
export async function fieldOrderBy(deps: Deps, orgId: string, fieldId: string, dir: "asc" | "desc"): Promise<SQL[]> {
  const hit = (await defsFor(deps, orgId, [fieldId])).get(fieldId);
  if (!hit) throw new HttpError(422, "unknown_field", `No field "${fieldId}" in this workspace.`);
  const field = { ...hit.field, id: hit.ids };
  const inField = Array.isArray(field.id) ? sql`v.field_id in (${sql.join(field.id.map((id) => sql`${id}`), sql`, `)})` : sql`v.field_id = ${field.id}`;
  if (isComputedType(field.type)) throw new HttpError(422, "computed_field", `${field.name} is computed when read, so it can't be used to sort.`);
  const col = field.type === "number" || field.type === "currency" || field.type === "checkbox" ? sql.raw("v.value_num") : sql.raw("v.value_text");
  let expr = sql`(select ${col} from task_field_values v where v.task_id = ${tasks.id} and ${inField})`;
  if (field.type === "select" && field.options.length) {
    const cases = sql.join(field.options.map((o, i) => sql`when ${o.id} then ${i}`), sql` `);
    expr = sql`(select case v.value_text ${cases} end from task_field_values v where v.task_id = ${tasks.id} and ${inField})`;
  }
  return [sql`${expr} is null`, dir === "desc" ? sql`${expr} desc` : sql`${expr} asc`];
}

// ---------------------------------------------------------------- R84: workspace fields

/** Types a workspace field can be (computed fields stay per project: they read that project's other fields). */
export const WORKSPACE_FIELD_TYPES = ["text", "number", "currency", "date", "select", "multiselect", "person", "checkbox", "url"] as const;
export const isWorkspaceKey = (v: string) => v.startsWith("wfd_");

export interface WorkspaceField { key: string; name: string; type: FieldType; options: FieldOption[]; projects: number }

/** One entry per workspace field (its projects' copies share name, type and option ids). */
export async function listWorkspaceFields(deps: Deps, orgId: string): Promise<WorkspaceField[]> {
  const rows = await deps.db.select().from(customFields)
    .where(and(eq(customFields.orgId, orgId), sql`${customFields.workspaceKey} is not null`, isNull(customFields.deletedAt)))
    .orderBy(asc(customFields.createdAt));
  const out = new Map<string, WorkspaceField>();
  for (const r of rows) {
    const hit = out.get(r.workspaceKey!);
    if (hit) { hit.projects++; continue; }
    out.set(r.workspaceKey!, { key: r.workspaceKey!, name: r.name, type: r.type as FieldType, options: JSON.parse(r.options) as FieldOption[], projects: 1 });
  }
  return [...out.values()];
}

async function liveProjectIds(deps: Deps, orgId: string) {
  return (await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))).map((p) => p.id);
}

/** Defines a field once for the workspace: one copy in every project, same key and option ids. */
export async function createWorkspaceField(deps: Deps, actor: SuiteActor, input: { name: string; type: FieldType; options?: { id?: string; label: string; color?: string }[] }) {
  assertWritable(actor);
  if (!(WORKSPACE_FIELD_TYPES as readonly string[]).includes(input.type)) throw new HttpError(422, "validation_failed", "Formula and rollup fields belong to one project.");
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new HttpError(422, "validation_failed", "Give the field a name.");
  const existing = await listWorkspaceFields(deps, actor.orgId);
  if (existing.some((f) => f.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "field_exists", `There is already a workspace field called ${name}.`);
  if (existing.length >= 30) throw new HttpError(422, "too_many_fields", "A workspace can have up to 30 workspace fields.");
  const ids = await liveProjectIds(deps, actor.orgId);
  const counts = ids.length ? await deps.db.select({ projectId: customFields.projectId, n: sql<number>`count(*)`, p: sql<number>`coalesce(max(${customFields.position}), -1)` }).from(customFields)
    .where(and(eq(customFields.orgId, actor.orgId), isNull(customFields.deletedAt))).groupBy(customFields.projectId) : [];
  const byProject = new Map(counts.map((c) => [c.projectId, c]));
  const full = ids.filter((id) => Number(byProject.get(id)?.n ?? 0) >= 50);
  if (full.length) throw new HttpError(422, "too_many_fields", "A project already has 50 custom fields. Remove one there first.");
  const now = deps.now();
  const key = sortableId("wfd", now.getTime());
  const options = JSON.stringify(mergeOptions(input.type, input.options ?? (input.type === "select" || input.type === "multiselect" ? [] : undefined)));
  const rows = ids.map((projectId, i) => ({
    id: sortableId("fld", now.getTime() + i), orgId: actor.orgId, projectId, name, type: input.type, config: null, options, workspaceKey: key,
    position: Number(byProject.get(projectId)?.p ?? -1) + 1, ...createdBy(actor), createdAt: now, updatedAt: now,
  }));
  for (let i = 0; i < rows.length; i += 8) await deps.db.insert(customFields).values(rows.slice(i, i + 8));
  invalidateFieldDefs(deps, actor.orgId);
  const field: WorkspaceField = { key, name, type: input.type, options: JSON.parse(options) as FieldOption[], projects: rows.length };
  await recordWrite(deps, actor, { entityType: "custom_field", entityId: key, op: "create", verb: "created", data: { name, type: input.type, workspace: true }, event: "custom_field.created", eventData: { field } });
  return field;
}

async function copiesOf(deps: Deps, orgId: string, key: string) {
  const rows = await deps.db.select().from(customFields).where(and(eq(customFields.orgId, orgId), eq(customFields.workspaceKey, key), isNull(customFields.deletedAt)));
  if (!rows.length) throw notFound("Field");
  return rows;
}

/** Renames a workspace field or changes its options in every project at once (option ids are kept). */
export async function updateWorkspaceField(deps: Deps, actor: SuiteActor, key: string, patch: { name?: string; options?: { id?: string; label: string; color?: string }[] }) {
  assertWritable(actor);
  const rows = await copiesOf(deps, actor.orgId, key);
  const first = rows[0];
  const set: Partial<typeof customFields.$inferInsert> = { updatedAt: deps.now() };
  if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 60) || first.name;
  if (patch.options !== undefined) set.options = JSON.stringify(mergeOptions(first.type as FieldType, patch.options, JSON.parse(first.options) as FieldOption[]));
  await deps.db.update(customFields).set({ ...set, version: sql`${customFields.version} + 1` }).where(and(eq(customFields.orgId, actor.orgId), eq(customFields.workspaceKey, key), isNull(customFields.deletedAt)));
  invalidateFieldDefs(deps, actor.orgId);
  if (set.name !== undefined && set.name !== first.name) for (const r of rows) await renameInFormulas(deps, actor.orgId, r.projectId, r.id, first.name, set.name);
  if (patch.options !== undefined) for (const r of rows) await dropMissingOptions(deps, presentField({ ...r, options: set.options! }));
  const field: WorkspaceField = { key, name: set.name ?? first.name, type: first.type as FieldType, options: JSON.parse(set.options ?? first.options) as FieldOption[], projects: rows.length };
  await recordWrite(deps, actor, { entityType: "custom_field", entityId: key, op: "update", verb: "updated", data: { name: field.name, workspace: true }, event: "custom_field.updated", eventData: { field } });
  return field;
}

/** Removes a workspace field and its values from every project. */
export async function deleteWorkspaceField(deps: Deps, actor: SuiteActor, key: string) {
  assertWritable(actor);
  const rows = await copiesOf(deps, actor.orgId, key);
  const now = deps.now();
  await deps.db.update(customFields).set({ deletedAt: now, updatedAt: now }).where(and(eq(customFields.orgId, actor.orgId), eq(customFields.workspaceKey, key), isNull(customFields.deletedAt)));
  invalidateFieldDefs(deps, actor.orgId);
  for (let i = 0; i < rows.length; i += 80) await deps.db.delete(taskFieldValues).where(inArray(taskFieldValues.fieldId, rows.slice(i, i + 80).map((r) => r.id)));
  await recordWrite(deps, actor, { entityType: "custom_field", entityId: key, op: "delete", verb: "deleted", data: { name: rows[0].name, workspace: true }, event: "custom_field.deleted", eventData: { field: { key, name: rows[0].name } } });
  return { ok: true as const };
}

/** A new project gets a copy of every workspace field (called when a project is made). */
export async function copyWorkspaceFields(deps: Deps, actor: SuiteActor, projectId: string) {
  const list = await listWorkspaceFields(deps, actor.orgId);
  if (!list.length) return;
  const now = deps.now();
  const rows = list.map((f, i) => ({
    id: sortableId("fld", now.getTime() + i), orgId: actor.orgId, projectId, name: f.name, type: f.type, config: null, options: JSON.stringify(f.options), workspaceKey: f.key,
    position: i, ...createdBy(actor), createdAt: now, updatedAt: now,
  }));
  for (let i = 0; i < rows.length; i += 8) await deps.db.insert(customFields).values(rows.slice(i, i + 8));
  invalidateFieldDefs(deps, actor.orgId);
}
