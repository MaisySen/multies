/**
 * R125: tables, a doc type (docs.kind "table"). Fields, rows (cells as JSON keyed by field id), views, CSV import and
 * export, row comments (doc_comments.row_id) and row history (the changes log, entity "table_row").
 *
 * Access follows the doc: every member opens every table and comments; editing is for everyone or, when the table is
 * set to "admins", for owners, admins and its creator. Read only keys never write. Guests read tables in their project.
 * Linked records and lookups only show rows from tables the viewer can open. Rows are paged; text filters go through
 * LK1 (containsText); field filters use json_extract on field ids taken from the saved field list, never from input.
 */
import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { inIds } from "../lib/sql-chunks";
import type { Deps } from "../context";
import { changes, docComments, docs, docTables, organizations, tableFields, tableRows, tableViews } from "../db/schema";
import { HttpError, notFound } from "../lib/errors";
import { containsText } from "../lib/like-search";
import { createDoc } from "./suite/docs";
import { actorOf, assertWritable, recordWrite, sortableId, type SuiteActor } from "./suite/common";
import { evaluate, FormulaError, parse, references, type FValue, type Node } from "./suite/formula";
import { renameReferences } from "./suite/formula-rename";
import { getDetail } from "./suite/drive-r101";
import {
  cellText, coerceCell, convertValue, FIELD_TYPES, isComputed, LIMITS, newOptionLabels, OPTION_COLOURS, opsFor, searchTextOf, TEMPLATES, toCsv,
  type LinkLabel, type TCell, type TField, type TFieldConfig, type TFieldType, type TFilter, type TSort, type ViewConfig, type ViewType,
} from "@/shared/tables-r125";

export type Viewer = { kind: "member"; actor: SuiteActor } | { kind: "guest"; actor: SuiteActor; projectId: string };
type Meta = typeof docTables.$inferSelect;
type FieldRow = typeof tableFields.$inferSelect;
type RowRow = typeof tableRows.$inferSelect;

const ID = /^[\w-]{1,64}$/;
const unprocessable = (code: string, message: string) => new HttpError(422, code, message);
const readOnly = () => new HttpError(403, "read_only", "You can view this table. Ask an admin or its creator to let you edit.");

// ---------------------------------------------------------------- on and off

/** The flag, and the client workspace kept out (vv8k always; TABLES_EXCLUDE adds more). */
export function isTablesExcluded(org: { id: string; slug?: string | null; name?: string | null }, extra = ""): boolean {
  const hay = [org.id, org.slug ?? "", org.name ?? ""].map((s) => s.toLowerCase());
  const words = ["vv8k", ...extra.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];
  return words.some((x) => hay.some((h) => h === x || h.includes(x)));
}
export async function assertTablesOn(deps: Deps, orgId: string) {
  if (!deps.config.tablesR125) throw notFound("Page");
  const o = await deps.db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).get();
  if (!o || isTablesExcluded(o, deps.config.tablesExclude ?? "")) throw notFound("Page");
}

// ---------------------------------------------------------------- loading and access

async function loadMeta(deps: Deps, viewer: Viewer, docId: string): Promise<{ meta: Meta; title: string; projectId: string | null }> {
  if (!ID.test(docId)) throw notFound("Table");
  const orgId = viewer.actor.orgId;
  const d = await deps.db.select({ id: docs.id, title: docs.title, kind: docs.kind, projectId: docs.projectId }).from(docs).where(and(eq(docs.id, docId), eq(docs.orgId, orgId), isNull(docs.deletedAt))).get();
  if (!d || d.kind !== "table") throw notFound("Table");
  if (viewer.kind === "guest" && d.projectId !== viewer.projectId) throw notFound("Table");
  const meta = await deps.db.select().from(docTables).where(and(eq(docTables.docId, docId), eq(docTables.orgId, orgId))).get();
  if (!meta) throw notFound("Table");
  return { meta, title: d.title, projectId: d.projectId };
}
export function canEdit(viewer: Viewer, meta: Pick<Meta, "editAccess" | "createdBy">): boolean {
  if (viewer.kind !== "member") return false;
  const a = viewer.actor;
  if (a.scope === "read") return false;
  if (meta.editAccess === "everyone") return true;
  return a.role === "owner" || a.role === "admin" || (!!a.userId && a.userId === meta.createdBy);
}
function assertEdit(viewer: Viewer, meta: Meta) {
  if (viewer.kind === "member") assertWritable(viewer.actor);
  if (!canEdit(viewer, meta)) throw readOnly();
}
const member = (actor: SuiteActor): Viewer => ({ kind: "member", actor });

function presentField(f: FieldRow): TField {
  let config: TFieldConfig;
  try { config = JSON.parse(f.config) as TFieldConfig; } catch { config = {}; }
  return { id: f.id, name: f.name, type: f.type as TFieldType, config, position: f.position, width: f.width };
}
async function fieldsOf(deps: Deps, orgId: string, docId: string): Promise<TField[]> {
  const rows = await deps.db.select().from(tableFields).where(and(eq(tableFields.orgId, orgId), eq(tableFields.docId, docId), isNull(tableFields.deletedAt))).orderBy(asc(tableFields.position));
  return rows.map(presentField);
}
function presentView(v: typeof tableViews.$inferSelect) {
  let config: ViewConfig;
  try { config = JSON.parse(v.config) as ViewConfig; } catch { config = {}; }
  return { id: v.id, name: v.name, type: v.type as ViewType, config, position: v.position };
}
async function viewsOf(deps: Deps, orgId: string, docId: string) {
  return (await deps.db.select().from(tableViews).where(and(eq(tableViews.orgId, orgId), eq(tableViews.docId, docId))).orderBy(asc(tableViews.position))).map(presentView);
}
/** Table docs this viewer may open, by id (for link targets). */
async function openableTables(deps: Deps, viewer: Viewer, ids: string[]): Promise<Map<string, { title: string }>> {
  const want = [...new Set(ids)].filter((x) => ID.test(x)).slice(0, 50);
  const out = new Map<string, { title: string }>();
  if (!want.length) return out;
  const rows = await deps.db.select({ id: docs.id, title: docs.title, kind: docs.kind, projectId: docs.projectId }).from(docs).where(and(eq(docs.orgId, viewer.actor.orgId), inIds(docs.id, want), isNull(docs.deletedAt)));
  for (const r of rows) if (r.kind === "table" && (viewer.kind === "member" || r.projectId === viewer.projectId)) out.set(r.id, { title: r.title });
  return out;
}

export async function tableDetail(deps: Deps, viewer: Viewer, docId: string) {
  const { meta, title } = await loadMeta(deps, viewer, docId);
  const fields = await fieldsOf(deps, viewer.actor.orgId, docId);
  const views = await viewsOf(deps, viewer.actor.orgId, docId);
  const targets = await openableTables(deps, viewer, fields.filter((f) => f.type === "link").map((f) => f.config.tableId ?? ""));
  const linked: Record<string, { title: string; fields: TField[] }> = {};
  for (const [id, t] of targets) linked[id] = { title: t.title, fields: id === docId ? fields : await fieldsOf(deps, viewer.actor.orgId, id) };
  return {
    table: { id: docId, title, editAccess: meta.editAccess, rowCount: meta.rowCount, canEdit: canEdit(viewer, meta), canManage: viewer.kind === "member" && viewer.actor.scope !== "read" && (viewer.actor.role === "owner" || viewer.actor.role === "admin" || viewer.actor.userId === meta.createdBy), guest: viewer.kind === "guest" },
    fields, views, linked,
  };
}

/** Other tables in this workspace (for a linked record field). */
export async function listTables(deps: Deps, actor: SuiteActor) {
  const rows = await deps.db.select({ id: docs.id, title: docs.title }).from(docs).where(and(eq(docs.orgId, actor.orgId), eq(docs.kind, "table"), isNull(docs.deletedAt))).orderBy(asc(docs.title)).limit(200);
  return rows;
}

// ---------------------------------------------------------------- creating a table

function optionList(labels: string[]): { id: string; label: string; color: string }[] {
  return labels.slice(0, LIMITS.options).map((label, i) => ({ id: `o${i + 1}${Math.random().toString(36).slice(2, 6)}`, label: label.slice(0, LIMITS.name), color: OPTION_COLOURS[i % OPTION_COLOURS.length] }));
}
async function insertField(deps: Deps, orgId: string, docId: string, f: { name: string; type: TFieldType; config: TFieldConfig; position: number; width?: number | null }) {
  const id = sortableId("fld", deps.now().getTime());
  await deps.db.insert(tableFields).values({ id, orgId, docId, name: f.name, type: f.type, config: JSON.stringify(f.config), position: f.position, width: f.width ?? null, createdAt: deps.now() });
  return id;
}
async function insertView(deps: Deps, orgId: string, docId: string, v: { name: string; type: ViewType; config: ViewConfig; position: number }) {
  const id = sortableId("tvw", deps.now().getTime());
  await deps.db.insert(tableViews).values({ id, orgId, docId, name: v.name, type: v.type, config: JSON.stringify(v.config), position: v.position, createdAt: deps.now(), updatedAt: deps.now() });
  return id;
}

export async function createTable(deps: Deps, actor: SuiteActor, input: { title?: string; template?: "clients" | "stock" | "jobs" | null; parentId?: string | null; projectId?: string | null }) {
  assertWritable(actor);
  const tpl = input.template ? TEMPLATES.find((t) => t.id === input.template) : null;
  if (input.template && !tpl) throw unprocessable("bad_template", "That template does not exist.");
  const title = (input.title ?? "").trim().slice(0, 200) || tpl?.name || "Untitled table";
  const doc = await createDoc(deps, actor, { title, text: "", parentId: input.parentId ?? null, projectId: input.projectId ?? null });
  await deps.db.update(docs).set({ kind: "table" }).where(and(eq(docs.id, doc.id), eq(docs.orgId, actor.orgId)));
  await deps.db.insert(docTables).values({ docId: doc.id, orgId: actor.orgId, editAccess: "everyone", nextSeq: 1, rowCount: 0, createdBy: actor.userId || null, createdAt: deps.now(), updatedAt: deps.now() });
  if (!tpl) {
    await insertField(deps, actor.orgId, doc.id, { name: "Name", type: "text", config: {}, position: 1, width: 220 });
    await insertField(deps, actor.orgId, doc.id, { name: "Notes", type: "longtext", config: {}, position: 2 });
    await insertField(deps, actor.orgId, doc.id, { name: "Status", type: "select", config: { options: optionList(["To do", "Doing", "Done"]) }, position: 3 });
    await insertView(deps, actor.orgId, doc.id, { name: "Grid", type: "grid", config: {}, position: 1 });
    return { id: doc.id, title };
  }
  const keyToId = new Map<string, string>();
  const made: TField[] = [];
  let pos = 1;
  for (const f of tpl.fields) {
    const config: TFieldConfig = f.options ? { options: optionList(f.options) } : f.formula ? { formula: f.formula } : f.type === "currency" ? { currency: "AUD" } : {};
    const id = await insertField(deps, actor.orgId, doc.id, { name: f.name, type: f.type, config, position: pos, width: f.width ?? null });
    keyToId.set(f.key, id);
    made.push({ id, name: f.name, type: f.type, config, position: pos++, width: f.width ?? null });
  }
  let vpos = 1;
  for (const v of tpl.views) {
    const by = v.by ? keyToId.get(v.by) ?? null : null;
    const config: ViewConfig = v.type === "form" ? { formFields: made.filter((f) => !isComputed(f.type)).map((f) => f.id), formTitle: v.name, formNote: "" } : by ? { by } : {};
    await insertView(deps, actor.orgId, doc.id, { name: v.name, type: v.type, config, position: vpos++ });
  }
  const rows = tpl.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [keyToId.get(k) ?? "", v])));
  await insertRows(deps, actor, doc.id, made, rows.map((cells) => coerceAll(made, cells).cells));
  return { id: doc.id, title };
}

// ---------------------------------------------------------------- fields

const FieldConfigIn = (type: TFieldType, raw: Record<string, unknown> | undefined, prev?: TFieldConfig): TFieldConfig => {
  const c = raw ?? {};
  if (type === "select" || type === "multiselect") {
    const list = Array.isArray(c.options) ? c.options as { id?: string; label?: string; color?: string }[] : prev?.options ?? [];
    if (list.length > LIMITS.options) throw unprocessable("too_many_options", `A field can have up to ${LIMITS.options} options.`);
    const seen = new Set<string>();
    const options = list.map((o, i) => {
      const label = String(o.label ?? "").trim().slice(0, LIMITS.name);
      if (!label) throw unprocessable("option_label", "Each option needs a name.");
      if (seen.has(label.toLowerCase())) throw unprocessable("option_twice", `"${label}" is listed twice.`);
      seen.add(label.toLowerCase());
      const id = o.id && /^[\w-]{1,40}$/.test(o.id) ? o.id : `o${Date.now().toString(36)}${i}`;
      const color = o.color && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : OPTION_COLOURS[i % OPTION_COLOURS.length];
      return { id, label, color };
    });
    return { options };
  }
  if (type === "currency") return { currency: typeof c.currency === "string" && /^[A-Z]{3}$/.test(c.currency) ? c.currency : prev?.currency ?? "AUD" };
  if (type === "number") return { decimals: typeof c.decimals === "number" ? Math.max(0, Math.min(6, Math.trunc(c.decimals))) : prev?.decimals };
  if (type === "link") return { tableId: typeof c.tableId === "string" ? c.tableId : prev?.tableId };
  if (type === "lookup") return { linkFieldId: typeof c.linkFieldId === "string" ? c.linkFieldId : prev?.linkFieldId, targetFieldId: typeof c.targetFieldId === "string" ? c.targetFieldId : prev?.targetFieldId };
  if (type === "formula") return { formula: typeof c.formula === "string" ? c.formula : prev?.formula ?? "" };
  return {};
};

/** Formula checks: it parses, every {name} is a field here, and no chain of formulas comes back to itself. */
export function checkFormulas(fields: Pick<TField, "id" | "name" | "type" | "config">[]): void {
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const deps = new Map<string, string[]>();
  for (const f of fields) {
    if (f.type !== "formula") continue;
    let node: Node;
    try { node = parse(f.config.formula ?? ""); } catch (e) { throw unprocessable("bad_formula", `${f.name}: ${e instanceof Error ? e.message : "that formula does not read right."}`); }
    const refs = [...references(node)];
    for (const r of refs) if (!byName.has(r)) throw unprocessable("bad_formula", `${f.name}: there is no field called ${r}.`);
    deps.set(f.id, refs.map((r) => byName.get(r)!.id));
  }
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const names = [...path.slice(path.indexOf(id)), id].map((x) => fields.find((f) => f.id === x)?.name ?? x);
      throw unprocessable("formula_loop", `These formulas use each other in a loop: ${names.join(" > ")}.`);
    }
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) if (deps.has(d)) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const id of deps.keys()) visit(id, []);
}

async function checkFieldConfig(deps: Deps, viewer: Viewer, docId: string, f: { name: string; type: TFieldType; config: TFieldConfig; id?: string }, all: TField[]) {
  if (f.type === "link") {
    if (!f.config.tableId) throw unprocessable("link_table", "Choose the table to link to.");
    if (!(await openableTables(deps, viewer, [f.config.tableId])).has(f.config.tableId)) throw notFound("Table");
  }
  if (f.type === "lookup") {
    const link = all.find((x) => x.id === f.config.linkFieldId && x.type === "link");
    if (!link) throw unprocessable("lookup_link", "Choose a linked record field for this lookup.");
    const target = link.config.tableId === docId ? all : await fieldsOf(deps, viewer.actor.orgId, link.config.tableId ?? "");
    if (!target.some((x) => x.id === f.config.targetFieldId && x.type !== "lookup")) throw unprocessable("lookup_field", "Choose a field to show from the linked table.");
  }
  const merged = [...all.filter((x) => x.id !== f.id), { id: f.id ?? "new", name: f.name, type: f.type, config: f.config, position: 0, width: null }];
  checkFormulas(merged);
}

function checkName(name: unknown, all: TField[], selfId?: string): string {
  const n = String(name ?? "").trim().replace(/[{}]/g, "").slice(0, LIMITS.name);
  if (!n) throw unprocessable("field_name", "Give the field a name.");
  if (all.some((f) => f.id !== selfId && f.name.toLowerCase() === n.toLowerCase())) throw unprocessable("field_name_taken", `There is already a field called ${n}.`);
  return n;
}

export async function createField(deps: Deps, actor: SuiteActor, docId: string, body: { name: string; type: TFieldType; config?: Record<string, unknown>; afterId?: string | null }) {
  const viewer = member(actor);
  const { meta } = await loadMeta(deps, viewer, docId);
  assertEdit(viewer, meta);
  const all = await fieldsOf(deps, actor.orgId, docId);
  if (all.length >= LIMITS.fields) throw unprocessable("too_many_fields", `A table can have up to ${LIMITS.fields} fields.`);
  if (!FIELD_TYPES.includes(body.type)) throw unprocessable("field_type", "That field type does not exist.");
  const name = checkName(body.name, all);
  const config = FieldConfigIn(body.type, body.config);
  await checkFieldConfig(deps, viewer, docId, { name, type: body.type, config }, all);
  const after = body.afterId ? all.findIndex((f) => f.id === body.afterId) : -1;
  const position = after >= 0 ? (all[after + 1] ? (all[after].position + all[after + 1].position) / 2 : all[after].position + 1) : (all.at(-1)?.position ?? 0) + 1;
  const id = await insertField(deps, actor.orgId, docId, { name, type: body.type, config, position });
  await touch(deps, actor.orgId, docId);
  return (await fieldsOf(deps, actor.orgId, docId)).find((f) => f.id === id)!;
}

export async function updateField(deps: Deps, actor: SuiteActor, docId: string, fieldId: string, body: { name?: string; type?: TFieldType; config?: Record<string, unknown>; width?: number | null; position?: number }) {
  const viewer = member(actor);
  const { meta } = await loadMeta(deps, viewer, docId);
  assertEdit(viewer, meta);
  const all = await fieldsOf(deps, actor.orgId, docId);
  const f = all.find((x) => x.id === fieldId);
  if (!f) throw notFound("Field");
  const name = body.name !== undefined ? checkName(body.name, all, f.id) : f.name;
  const type = body.type ?? f.type;
  if (!FIELD_TYPES.includes(type)) throw unprocessable("field_type", "That field type does not exist.");
  if (type !== f.type && all[0]?.id === f.id && isComputed(type)) throw unprocessable("primary_type", "The first field names each row, so it cannot be worked out.");
  const config = body.config !== undefined || type !== f.type ? FieldConfigIn(type, body.config, type === f.type ? f.config : undefined) : f.config;
  // A rename carries into every formula that uses the old name.
  const renamed = name !== f.name ? all.filter((x) => x.type === "formula" && x.id !== f.id).map((x) => ({ ...x, config: { ...x.config, formula: renameReferences(x.config.formula ?? "", f.name, name) } })) : [];
  const next = all.map((x) => renamed.find((r) => r.id === x.id) ?? x);
  await checkFieldConfig(deps, viewer, docId, { id: f.id, name, type, config }, next);
  for (const r of renamed) if (r.config.formula !== all.find((x) => x.id === r.id)?.config.formula) await deps.db.update(tableFields).set({ config: JSON.stringify(r.config) }).where(eq(tableFields.id, r.id));
  await deps.db.update(tableFields).set({
    name, type, config: JSON.stringify(config),
    ...(body.width !== undefined ? { width: body.width === null ? null : Math.max(60, Math.min(800, Math.trunc(body.width))) } : {}),
    ...(body.position !== undefined && Number.isFinite(body.position) ? { position: body.position } : {}),
  }).where(and(eq(tableFields.id, f.id), eq(tableFields.orgId, actor.orgId)));
  let converted = 0;
  if (type !== f.type || (type === "select" || type === "multiselect") && body.config !== undefined) {
    const to = { ...f, name, type, config };
    converted = await rewriteCells(deps, actor.orgId, docId, next.map((x) => (x.id === f.id ? to : x)), (cells) => {
      if (!(f.id in cells)) return null;
      const v = type === f.type ? coerceOrNull(to, cells[f.id]) : convertValue(f, to, cells[f.id] ?? null);
      const out = { ...cells };
      if (v === null || isComputed(type)) delete out[f.id]; else out[f.id] = v;
      return out;
    });
  }
  await touch(deps, actor.orgId, docId);
  return { field: (await fieldsOf(deps, actor.orgId, docId)).find((x) => x.id === f.id)!, converted };
}
function coerceOrNull(f: TField, v: TCell | undefined): TCell {
  if (v === undefined || v === null) return null;
  if (f.type === "select" || f.type === "multiselect") {
    const ids = new Set((f.config.options ?? []).map((o) => o.id));
    if (f.type === "select") return typeof v === "string" && ids.has(v) ? v : null;
    return Array.isArray(v) ? v.filter((x) => ids.has(x)) : null;
  }
  return v;
}

export async function deleteField(deps: Deps, actor: SuiteActor, docId: string, fieldId: string) {
  const viewer = member(actor);
  const { meta } = await loadMeta(deps, viewer, docId);
  assertEdit(viewer, meta);
  const all = await fieldsOf(deps, actor.orgId, docId);
  const f = all.find((x) => x.id === fieldId);
  if (!f) throw notFound("Field");
  if (all[0].id === f.id) throw unprocessable("primary_field", "The first field names each row and cannot be deleted. Rename it or change its type instead.");
  const users = all.filter((x) => (x.type === "lookup" && x.config.linkFieldId === f.id) || (x.type === "formula" && references(safeParse(x.config.formula)).has(f.name.toLowerCase())));
  await deps.db.update(tableFields).set({ deletedAt: deps.now() }).where(and(eq(tableFields.id, f.id), eq(tableFields.orgId, actor.orgId)));
  await touch(deps, actor.orgId, docId);
  return { ok: true, affected: users.map((u) => u.name) };
}
const safeParse = (src?: string): Node => { try { return parse(src ?? ""); } catch { return { t: "lit", v: null }; } };

/** Rewrites every row's cells (a type change), 200 rows per statement, in this table only. */
async function rewriteCells(deps: Deps, orgId: string, docId: string, fields: TField[], fn: (cells: Record<string, TCell>) => Record<string, TCell> | null): Promise<number> {
  const rows = await deps.db.select({ id: tableRows.id, cells: tableRows.cells }).from(tableRows).where(and(eq(tableRows.orgId, orgId), eq(tableRows.docId, docId), isNull(tableRows.deletedAt))).limit(LIMITS.rows);
  const out: { id: string; c: string; s: string }[] = [];
  for (const r of rows) {
    const next = fn(parseCells(r.cells));
    if (next) out.push({ id: r.id, c: JSON.stringify(next), s: searchTextOf(fields, next) });
  }
  for (let i = 0; i < out.length; i += 200) {
    const chunk = JSON.stringify(out.slice(i, i + 200));
    await deps.db.run(sql`update table_rows set cells = json_extract(j.value, '$.c'), search_text = json_extract(j.value, '$.s'), version = version + 1 from json_each(${chunk}) as j where table_rows.id = json_extract(j.value, '$.id') and table_rows.org_id = ${orgId} and table_rows.doc_id = ${docId}`);
  }
  return out.length;
}
const parseCells = (s: string): Record<string, TCell> => { try { const v = JSON.parse(s) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, TCell> : {}; } catch { return {}; } };
async function touch(deps: Deps, orgId: string, docId: string) {
  await deps.db.update(docs).set({ updatedAt: deps.now() }).where(and(eq(docs.id, docId), eq(docs.orgId, orgId)));
}

// ---------------------------------------------------------------- cells in, rows out

/** Checks a set of cells against the fields; unknown or computed fields are refused, bad values say why. */
export function coerceAll(fields: TField[], input: Record<string, unknown>, opts: { lenient?: boolean } = {}): { cells: Record<string, TCell>; problems: { fieldId: string; field: string; error: string }[] } {
  const cells: Record<string, TCell> = {};
  const problems: { fieldId: string; field: string; error: string }[] = [];
  for (const [fid, raw] of Object.entries(input)) {
    if (!fid) continue;
    const f = fields.find((x) => x.id === fid);
    if (!f) { if (!opts.lenient) throw unprocessable("unknown_field", "That field is not in this table."); continue; }
    if (isComputed(f.type)) { if (!opts.lenient) throw unprocessable("computed_field", `${f.name} is worked out for you.`); continue; }
    const r = coerceCell(f, raw);
    if (r.ok) { if (r.value !== null && !(f.type === "checkbox" && r.value === false && raw === undefined)) cells[fid] = r.value; else if (r.value === null) cells[fid] = null; }
    else if (opts.lenient) problems.push({ fieldId: fid, field: f.name, error: r.error });
    else throw unprocessable("bad_value", r.error);
  }
  return { cells, problems };
}

/** Linked rows and attachments must exist where the viewer can open them; anything else is refused. */
async function assertRefs(deps: Deps, viewer: Viewer, fields: TField[], cells: Record<string, TCell>) {
  for (const f of fields) {
    const v = cells[f.id];
    if (!Array.isArray(v) || !v.length) continue;
    if (f.type === "link") {
      const t = f.config.tableId ?? "";
      if (!(await openableTables(deps, viewer, [t])).has(t)) throw notFound("Table");
      const found = await deps.db.select({ id: tableRows.id }).from(tableRows).where(and(eq(tableRows.orgId, viewer.actor.orgId), eq(tableRows.docId, t), inIds(tableRows.id, v), isNull(tableRows.deletedAt)));
      if (found.length !== v.length) throw unprocessable("bad_link", `${f.name}: a linked row was not found.`);
    } else if (f.type === "attachment") {
      for (const id of v) {
        try { await getDetail(deps, { orgId: viewer.actor.orgId, userId: viewer.actor.userId, email: viewer.actor.email, role: viewer.actor.role ?? "member" }, id); }
        catch { throw unprocessable("bad_file", `${f.name}: that file is not in Files or you cannot open it.`); }
      }
    }
  }
}

async function allocate(deps: Deps, orgId: string, docId: string, n: number): Promise<number> {
  const [r] = await deps.db.update(docTables).set({ nextSeq: sql`${docTables.nextSeq} + ${n}`, rowCount: sql`${docTables.rowCount} + ${n}`, updatedAt: deps.now() }).where(and(eq(docTables.docId, docId), eq(docTables.orgId, orgId))).returning({ next: docTables.nextSeq, count: docTables.rowCount });
  if (!r) throw notFound("Table");
  if (r.count > LIMITS.rows) {
    await deps.db.update(docTables).set({ rowCount: sql`${docTables.rowCount} - ${n}` }).where(eq(docTables.docId, docId));
    throw unprocessable("too_many_rows", `A table can hold up to ${LIMITS.rows.toLocaleString("en-AU")} rows.`);
  }
  return r.next - n;
}

/** Inserts rows (already checked), up to 250 per statement through json_each (one bound value per statement). */
async function insertRows(deps: Deps, actor: SuiteActor, docId: string, fields: TField[], list: Record<string, TCell>[]): Promise<string[]> {
  if (!list.length) return [];
  const first = await allocate(deps, actor.orgId, docId, list.length);
  const now = deps.now().getTime();
  const made = list.map((cells, i) => ({ id: sortableId("row", now), q: first + i, c: JSON.stringify(cells), s: searchTextOf(fields, cells) }));
  for (let i = 0; i < made.length; i += 250) {
    const chunk = JSON.stringify(made.slice(i, i + 250));
    await deps.db.run(sql`insert into table_rows (id, org_id, doc_id, seq, position, cells, search_text, created_by, created_at, updated_by, updated_at, version)
      select json_extract(j.value, '$.id'), ${actor.orgId}, ${docId}, json_extract(j.value, '$.q'), json_extract(j.value, '$.q'), json_extract(j.value, '$.c'), json_extract(j.value, '$.s'), ${actor.userId || null}, ${now}, ${actor.userId || null}, ${now}, 1 from json_each(${chunk}) as j`);
  }
  return made.map((m) => m.id);
}

/** Display values for a page of rows: formulas, lookups, linked record and file names (only what the viewer can open). */
async function present(deps: Deps, viewer: Viewer, docId: string, fields: TField[], rows: RowRow[]) {
  const orgId = viewer.actor.orgId;
  const linkFields = fields.filter((f) => f.type === "link");
  const parsed = rows.map((r) => ({ r, cells: parseCells(r.cells) }));
  const openable = await openableTables(deps, viewer, linkFields.map((f) => f.config.tableId ?? ""));
  // Linked rows, one read per target table for this page.
  const linkedRows = new Map<string, { cells: Record<string, TCell>; label: string }>();
  const targetFields = new Map<string, TField[]>();
  for (const f of linkFields) {
    const t = f.config.tableId ?? "";
    if (!openable.has(t)) continue;
    if (!targetFields.has(t)) targetFields.set(t, t === docId ? fields : await fieldsOf(deps, orgId, t));
    const ids = [...new Set(parsed.flatMap((p) => (Array.isArray(p.cells[f.id]) ? p.cells[f.id] as string[] : [])))].filter((id) => !linkedRows.has(id));
    const tf = targetFields.get(t)!;
    for (let i = 0; i < ids.length; i += 90) {
      const got = await deps.db.select({ id: tableRows.id, cells: tableRows.cells, seq: tableRows.seq }).from(tableRows).where(and(eq(tableRows.orgId, orgId), eq(tableRows.docId, t), inIds(tableRows.id, ids.slice(i, i + 90)), isNull(tableRows.deletedAt)));
      for (const g of got) { const c = parseCells(g.cells); linkedRows.set(g.id, { cells: c, label: (tf[0] ? cellText(tf[0], c[tf[0].id] ?? null) : "") || `Row ${g.seq}` }); }
    }
  }
  // File names for attachment cells (members only; Files decides).
  const fileNames = new Map<string, string>();
  if (viewer.kind === "member") {
    const ids = [...new Set(parsed.flatMap((p) => fields.filter((f) => f.type === "attachment").flatMap((f) => (Array.isArray(p.cells[f.id]) ? p.cells[f.id] as string[] : []))))].slice(0, 60);
    for (const id of ids) {
      try {
        const d = await getDetail(deps, { orgId, userId: viewer.actor.userId, email: viewer.actor.email, role: viewer.actor.role ?? "member" }, id) as unknown as { item?: { name?: string }; name?: string };
        fileNames.set(id, d.item?.name ?? d.name ?? "File");
      } catch { /* not openable: hidden */ }
    }
  }
  const now = deps.now();
  return parsed.map(({ r, cells }) => {
    const values: Record<string, TCell> = {};
    const labels: Record<string, LinkLabel[]> = {};
    const hidden: Record<string, number> = {};
    const errors: Record<string, string> = {};
    for (const f of fields) {
      if (f.type === "link") {
        const ids = Array.isArray(cells[f.id]) ? cells[f.id] as string[] : [];
        const shown = ids.map((id) => ({ id, row: linkedRows.get(id) })).filter((x) => x.row);
        labels[f.id] = shown.map((x) => ({ id: x.id, label: x.row!.label }));
        values[f.id] = shown.map((x) => x.id);
        if (shown.length < ids.length) hidden[f.id] = ids.length - shown.length;
      } else if (f.type === "attachment") {
        const ids = Array.isArray(cells[f.id]) ? cells[f.id] as string[] : [];
        labels[f.id] = ids.filter((id) => fileNames.has(id)).map((id) => ({ id, label: fileNames.get(id)! }));
        values[f.id] = labels[f.id].map((l) => l.id);
        if (labels[f.id].length < ids.length) hidden[f.id] = ids.length - labels[f.id].length;
      } else if (!isComputed(f.type)) values[f.id] = cells[f.id] ?? (f.type === "checkbox" ? false : null);
    }
    for (const f of fields) {
      if (f.type !== "lookup") continue;
      const link = fields.find((x) => x.id === f.config.linkFieldId && x.type === "link");
      const tf = link ? targetFields.get(link.config.tableId ?? "") : undefined;
      const target = tf?.find((x) => x.id === f.config.targetFieldId);
      if (link && !tf) { values[f.id] = []; continue; } // the linked table is gone or not yours to open: nothing shown
      if (!link || !target) { values[f.id] = null; errors[f.id] = "This lookup needs its linked field again."; continue; }
      const out = ((values[link.id] as string[] | null) ?? []).map((id) => linkedRows.get(id)).filter(Boolean).map((x) => cellText(target, x!.cells[target.id] ?? null)).filter(Boolean);
      values[f.id] = out;
    }
    const memo = new Map<string, FValue>();
    const stack = new Set<string>();
    const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
    const asF = (f: TField): FValue => {
      if (f.type === "formula") return runFormula(f);
      const v = values[f.id];
      if (v === null || v === undefined) return null;
      if (f.type === "currency") return typeof v === "number" ? v / 100 : null;
      if (f.type === "number" || f.type === "checkbox" || f.type === "date" || typeof v === "string" && f.type !== "select") return v as FValue;
      if (f.type === "link" || f.type === "attachment") return (labels[f.id] ?? []).map((l) => l.label).join(", ");
      return cellText(f, v);
    };
    const runFormula = (f: TField): FValue => {
      if (memo.has(f.id)) return memo.get(f.id)!;
      if (stack.has(f.id)) throw new FormulaError("These formulas use each other in a loop.");
      stack.add(f.id);
      try {
        const v = evaluate(parse(f.config.formula ?? ""), { now, resolve: (name) => { const x = byName.get(name.toLowerCase()); if (!x) throw new FormulaError(`There is no field called ${name}.`); return asF(x); } });
        memo.set(f.id, v);
        return v;
      } finally { stack.delete(f.id); }
    };
    for (const f of fields) {
      if (f.type !== "formula") continue;
      try { const v = runFormula(f); values[f.id] = typeof v === "number" && !Number.isFinite(v) ? null : v; }
      catch (e) { values[f.id] = null; errors[f.id] = e instanceof FormulaError ? e.message : "This formula could not be worked out."; }
    }
    return { id: r.id, seq: r.seq, version: r.version, values, labels, ...(Object.keys(hidden).length ? { hidden } : {}), ...(Object.keys(errors).length ? { errors } : {}), updatedAt: r.updatedAt?.toISOString() ?? null };
  });
}
export type PresentedRow = Awaited<ReturnType<typeof present>>[number];

// ---------------------------------------------------------------- listing rows (paged)

const path = (fid: string) => { if (!ID.test(fid)) throw unprocessable("bad_field", "That field is not in this table."); return sql.raw(`'$."${fid}"'`); };
const cellExpr = (fid: string) => sql`json_extract(${tableRows.cells}, ${path(fid)})`;

function filterSql(f: TField, flt: TFilter): SQL | null {
  const e = cellExpr(f.id);
  const v = (flt.value ?? "").trim();
  if (!opsFor(f.type).includes(flt.op)) return null;
  switch (flt.op) {
    case "empty": return sql`(${e} is null or ${e} = '' or ${e} = '[]')`;
    case "not_empty": return sql`(${e} is not null and ${e} != '' and ${e} != '[]')`;
    case "checked": return sql`${e} = 1`;
    case "unchecked": return sql`(${e} is null or ${e} = 0)`;
    case "contains": return v ? containsText(e, v) : null;
    default: break;
  }
  if (!v) return null;
  let val: string | number = v;
  if (f.type === "number" || f.type === "currency" || f.type === "date") {
    const r = coerceCell(f, v);
    if (!r.ok || r.value === null) return sql`0 = 1`;
    val = r.value as string | number;
  }
  if (f.type === "multiselect") {
    const has = sql`exists (select 1 from json_each(${tableRows.cells}, ${path(f.id)}) where value = ${val})`;
    return flt.op === "is" ? has : sql`not ${has}`;
  }
  switch (flt.op) {
    case "is": return f.type === "select" || typeof val === "number" || f.type === "date" ? sql`${e} = ${val}` : sql`lower(${e}) = lower(${val})`;
    case "is_not": return f.type === "select" || typeof val === "number" || f.type === "date" ? sql`(${e} is null or ${e} != ${val})` : sql`(${e} is null or lower(${e}) != lower(${val}))`;
    case "gt": return sql`${e} > ${val}`;
    case "lt": return sql`${e} < ${val}`;
    default: return null;
  }
}
function sortSql(f: TField, dir: "asc" | "desc"): SQL[] {
  const e = cellExpr(f.id);
  const d = sql.raw(dir === "desc" ? "desc" : "asc");
  const nulls = sql`(${e} is null) asc`;
  if (f.type === "select") {
    const opts = (f.config.options ?? []).filter((o) => /^[\w-]{1,40}$/.test(o.id));
    const cases = opts.length ? sql.raw(`case ${`json_extract(cells, '$."${f.id}"')`} ${opts.map((o, i) => `when '${o.id}' then ${i}`).join(" ")} else ${opts.length} end`) : e;
    return [nulls, sql`${cases} ${d}`];
  }
  if (f.type === "text" || f.type === "longtext" || f.type === "email" || f.type === "person" || f.type === "url" || f.type === "phone") return [nulls, sql`${e} collate nocase ${d}`];
  return [nulls, sql`${e} ${d}`];
}

export interface RowQuery { cursor?: string; limit?: number; q?: string; sort?: TSort[]; filters?: TFilter[]; viewId?: string }
export async function listRows(deps: Deps, viewer: Viewer, docId: string, query: RowQuery) {
  const { meta } = await loadMeta(deps, viewer, docId);
  const orgId = viewer.actor.orgId;
  const fields = await fieldsOf(deps, orgId, docId);
  let sort = query.sort ?? [];
  let filters = query.filters ?? [];
  if (query.viewId) {
    const v = (await viewsOf(deps, orgId, docId)).find((x) => x.id === query.viewId);
    if (!v) throw notFound("View");
    if (!query.sort) sort = v.config.sort ?? [];
    if (!query.filters) filters = v.config.filters ?? [];
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? LIMITS.pageSize)));
  const where: SQL[] = [eq(tableRows.orgId, orgId), eq(tableRows.docId, docId), isNull(tableRows.deletedAt)];
  const q = (query.q ?? "").trim();
  if (q) where.push(containsText(tableRows.searchText, q));
  let filtered = !!q;
  for (const flt of filters.slice(0, 10)) {
    const f = fields.find((x) => x.id === flt.fieldId);
    if (!f || isComputed(f.type)) continue;
    const s = filterSql(f, flt);
    if (s) { where.push(s); filtered = true; }
  }
  const sorts = sort.slice(0, 3).map((s) => ({ f: fields.find((x) => x.id === s.fieldId), dir: s.dir })).filter((s) => s.f && !isComputed(s.f.type) && s.f.type !== "link" && s.f.type !== "attachment");
  let rows: RowRow[];
  let nextCursor: string | null = null;
  if (!sorts.length) {
    const m = /^p:(-?[\d.e+-]+):([\w-]+)$/.exec(query.cursor ?? "");
    const after = m ? sql`(${tableRows.position} > ${Number(m[1])} or (${tableRows.position} = ${Number(m[1])} and ${tableRows.id} > ${m[2]}))` : undefined;
    rows = await deps.db.select().from(tableRows).where(and(...where, ...(after ? [after] : []))).orderBy(asc(tableRows.position), asc(tableRows.id)).limit(limit + 1);
    if (rows.length > limit) { rows = rows.slice(0, limit); const last = rows.at(-1)!; nextCursor = `p:${last.position}:${last.id}`; }
  } else {
    const offset = Math.max(0, Math.min(LIMITS.rows, Number(/^o:(\d+)$/.exec(query.cursor ?? "")?.[1] ?? 0)));
    const order = [...sorts.flatMap((s) => sortSql(s.f!, s.dir)), asc(tableRows.position), asc(tableRows.id)];
    rows = await deps.db.select().from(tableRows).where(and(...where)).orderBy(...order).limit(limit + 1).offset(offset);
    if (rows.length > limit) { rows = rows.slice(0, limit); nextCursor = `o:${offset + limit}`; }
  }
  const total = filtered ? (await deps.db.select({ n: sql<number>`count(*)` }).from(tableRows).where(and(...where)).get())?.n ?? 0 : meta.rowCount;
  return { rows: await present(deps, viewer, docId, fields, rows), nextCursor, total };
}

async function rowById(deps: Deps, orgId: string, docId: string, rowId: string, withDeleted = false) {
  if (!ID.test(rowId)) throw notFound("Row");
  const r = await deps.db.select().from(tableRows).where(and(eq(tableRows.id, rowId), eq(tableRows.orgId, orgId), eq(tableRows.docId, docId), ...(withDeleted ? [] : [isNull(tableRows.deletedAt)]))).get();
  if (!r) throw notFound("Row");
  return r;
}
export async function getRow(deps: Deps, viewer: Viewer, docId: string, rowId: string) {
  await loadMeta(deps, viewer, docId);
  const fields = await fieldsOf(deps, viewer.actor.orgId, docId);
  return (await present(deps, viewer, docId, fields, [await rowById(deps, viewer.actor.orgId, docId, rowId)]))[0];
}

// ---------------------------------------------------------------- writing rows

const clipText = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);

export async function createRows(deps: Deps, actor: SuiteActor, docId: string, list: Record<string, unknown>[], opts: { formViewId?: string } = {}) {
  const viewer = member(actor);
  assertWritable(actor);
  const { meta } = await loadMeta(deps, viewer, docId);
  const fields = await fieldsOf(deps, actor.orgId, docId);
  let allowed = fields;
  if (opts.formViewId) {
    // A form adds a row with its own fields only; any member who can open the table may use it.
    const v = (await viewsOf(deps, actor.orgId, docId)).find((x) => x.id === opts.formViewId && x.type === "form");
    if (!v) throw notFound("Form");
    const ids = new Set(v.config.formFields ?? []);
    allowed = fields.filter((f) => ids.has(f.id));
    if (!list[0] || !Object.values(list[0]).some((x) => x !== null && x !== "" && x !== false && !(Array.isArray(x) && !x.length))) throw unprocessable("empty_form", "Fill in at least one field.");
  } else assertEdit(viewer, meta);
  if (list.length > LIMITS.pasteRows) throw unprocessable("too_many_rows", `Add up to ${LIMITS.pasteRows} rows at a time.`);
  const checked = list.map((c) => coerceAll(allowed, c).cells);
  for (const c of checked) await assertRefs(deps, viewer, fields, c);
  const ids = await insertRows(deps, actor, docId, fields, checked);
  for (const id of ids.slice(0, 20)) await recordWrite(deps, actor, { entityType: "table_row" as never, entityId: id, op: "create", verb: opts.formViewId ? "submitted" : "created", data: { docId } });
  await touch(deps, actor.orgId, docId);
  const rows = await deps.db.select().from(tableRows).where(and(eq(tableRows.orgId, actor.orgId), inIds(tableRows.id, ids.slice(0, 90))));
  rows.sort((a, b) => a.seq - b.seq);
  return present(deps, viewer, docId, fields, rows);
}

/** Changes cells on rows (one row from the grid, or a pasted block). Each row writes one history entry with old and new text. */
export async function updateRows(deps: Deps, actor: SuiteActor, docId: string, updates: { id: string; cells: Record<string, unknown>; version?: number }[]) {
  const viewer = member(actor);
  const { meta } = await loadMeta(deps, viewer, docId);
  assertEdit(viewer, meta);
  if (updates.length > LIMITS.pasteRows) throw unprocessable("too_many_rows", `Change up to ${LIMITS.pasteRows} rows at a time.`);
  const fields = await fieldsOf(deps, actor.orgId, docId);
  const checked = updates.map((u) => ({ ...u, cells: coerceAll(fields, u.cells).cells }));
  for (const u of checked) await assertRefs(deps, viewer, fields, u.cells);
  const before = new Map<string, RowRow>();
  for (let i = 0; i < checked.length; i += 90) {
    const got = await deps.db.select().from(tableRows).where(and(eq(tableRows.orgId, actor.orgId), eq(tableRows.docId, docId), inIds(tableRows.id, checked.slice(i, i + 90).map((u) => u.id)), isNull(tableRows.deletedAt)));
    for (const g of got) before.set(g.id, g);
  }
  const now = deps.now();
  const writes: { id: string; c: string; s: string }[] = [];
  for (const u of checked) {
    const old = before.get(u.id);
    if (!old) throw notFound("Row");
    if (u.version !== undefined && u.version !== old.version) throw new HttpError(409, "row_changed", "Someone changed this row. It has been refreshed, try again.");
    const prev = parseCells(old.cells);
    const next = { ...prev };
    const diff: { f: string; name: string; from: string; to: string }[] = [];
    for (const [fid, v] of Object.entries(u.cells)) {
      const f = fields.find((x) => x.id === fid)!;
      const a = cellText(f, prev[fid] ?? null), b = cellText(f, v);
      if (JSON.stringify(prev[fid] ?? null) === JSON.stringify(v ?? null)) continue;
      if (v === null) delete next[fid]; else next[fid] = v;
      diff.push({ f: fid, name: f.name, from: f.type === "link" || f.type === "attachment" ? `${(prev[fid] as string[] | undefined)?.length ?? 0} items` : clipText(a), to: f.type === "link" || f.type === "attachment" ? `${(v as string[] | null)?.length ?? 0} items` : clipText(b) });
    }
    if (!diff.length) continue;
    writes.push({ id: u.id, c: JSON.stringify(next), s: searchTextOf(fields, next) });
    if (writes.length <= 50) await recordWrite(deps, actor, { entityType: "table_row" as never, entityId: u.id, op: "update", version: old.version + 1, verb: "edited", data: { docId, changes: diff.slice(0, 20) } });
  }
  const who = actor.userId || null;
  for (let i = 0; i < writes.length; i += 200) {
    const chunk = JSON.stringify(writes.slice(i, i + 200));
    await deps.db.run(sql`update table_rows set cells = json_extract(j.value, '$.c'), search_text = json_extract(j.value, '$.s'), version = version + 1, updated_at = ${now.getTime()}, updated_by = ${who} from json_each(${chunk}) as j where table_rows.id = json_extract(j.value, '$.id') and table_rows.org_id = ${actor.orgId} and table_rows.doc_id = ${docId}`);
  }
  if (writes.length) await touch(deps, actor.orgId, docId);
  const ids = checked.map((u) => u.id);
  const rows: RowRow[] = [];
  for (let i = 0; i < ids.length; i += 90) rows.push(...await deps.db.select().from(tableRows).where(and(eq(tableRows.orgId, actor.orgId), inIds(tableRows.id, ids.slice(i, i + 90)))));
  rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return present(deps, viewer, docId, fields, rows);
}

export async function deleteRows(deps: Deps, actor: SuiteActor, docId: string, ids: string[], restore = false) {
  const viewer = member(actor);
  const { meta } = await loadMeta(deps, viewer, docId);
  assertEdit(viewer, meta);
  const clean = [...new Set(ids)].filter((x) => ID.test(x)).slice(0, LIMITS.pasteRows);
  let n = 0;
  for (let i = 0; i < clean.length; i += 90) {
    const r = await deps.db.update(tableRows).set({ deletedAt: restore ? null : deps.now(), updatedAt: deps.now(), updatedBy: actor.userId || null })
      .where(and(eq(tableRows.orgId, actor.orgId), eq(tableRows.docId, docId), inIds(tableRows.id, clean.slice(i, i + 90)), restore ? sql`${tableRows.deletedAt} is not null` : isNull(tableRows.deletedAt))).returning({ id: tableRows.id });
    n += r.length;
    for (const x of r.slice(0, 20)) await recordWrite(deps, actor, { entityType: "table_row" as never, entityId: x.id, op: restore ? "update" : "delete", verb: restore ? "restored" : "deleted", data: { docId } });
  }
  if (n) await deps.db.update(docTables).set({ rowCount: sql`max(0, ${docTables.rowCount} ${sql.raw(restore ? "+" : "-")} ${n})` }).where(and(eq(docTables.docId, docId), eq(docTables.orgId, actor.orgId)));
  await touch(deps, actor.orgId, docId);
  return { ok: true, count: n };
}

// ---------------------------------------------------------------- views and settings

export async function createView(deps: Deps, actor: SuiteActor, docId: string, body: { name: string; type: ViewType; config?: ViewConfig }) {
  const viewer = member(actor);
  const { meta } = await loadMeta(deps, viewer, docId);
  assertEdit(viewer, meta);
  const views = await viewsOf(deps, actor.orgId, docId);
  if (views.length >= LIMITS.views) throw unprocessable("too_many_views", `A table can have up to ${LIMITS.views} views.`);
  const fields = await fieldsOf(deps, actor.orgId, docId);
  const config = cleanViewConfig(body.type, body.config ?? {}, fields);
  const id = await insertView(deps, actor.orgId, docId, { name: body.name.trim().slice(0, LIMITS.name) || "View", type: body.type, config, position: (views.at(-1)?.position ?? 0) + 1 });
  return (await viewsOf(deps, actor.orgId, docId)).find((v) => v.id === id)!;
}
function cleanViewConfig(type: ViewType, c: ViewConfig, fields: TField[]): ViewConfig {
  const has = (id: unknown) => typeof id === "string" && fields.some((f) => f.id === id);
  const out: ViewConfig = {
    sort: (c.sort ?? []).filter((s) => has(s.fieldId)).slice(0, 3).map((s) => ({ fieldId: s.fieldId, dir: s.dir === "desc" ? "desc" : "asc" })),
    filters: (c.filters ?? []).filter((f) => has(f.fieldId)).slice(0, 10).map((f) => ({ fieldId: f.fieldId, op: f.op, value: typeof f.value === "string" ? f.value.slice(0, 200) : undefined })),
    groupBy: has(c.groupBy) ? c.groupBy : null,
    hidden: (c.hidden ?? []).filter(has),
    widths: Object.fromEntries(Object.entries(c.widths ?? {}).filter(([k, v]) => has(k) && typeof v === "number").map(([k, v]) => [k, Math.max(60, Math.min(800, Math.trunc(v)))])),
  };
  if (type === "kanban") { const f = fields.find((x) => x.id === c.by); out.by = f && f.type === "select" ? f.id : fields.find((x) => x.type === "select")?.id ?? null; }
  if (type === "calendar") { const f = fields.find((x) => x.id === c.by); out.by = f && f.type === "date" ? f.id : fields.find((x) => x.type === "date")?.id ?? null; }
  if (type === "form") {
    out.formFields = (c.formFields ?? fields.filter((f) => !isComputed(f.type)).map((f) => f.id)).filter((id) => fields.some((f) => f.id === id && !isComputed(f.type)));
    out.formTitle = (c.formTitle ?? "").slice(0, 120);
    out.formNote = (c.formNote ?? "").slice(0, 1000);
  }
  return out;
}
export async function updateView(deps: Deps, actor: SuiteActor, docId: string, viewId: string, body: { name?: string; config?: ViewConfig }) {
  const viewer = member(actor);
  const { meta } = await loadMeta(deps, viewer, docId);
  assertEdit(viewer, meta);
  const v = (await viewsOf(deps, actor.orgId, docId)).find((x) => x.id === viewId);
  if (!v) throw notFound("View");
  const fields = await fieldsOf(deps, actor.orgId, docId);
  await deps.db.update(tableViews).set({
    ...(body.name !== undefined ? { name: body.name.trim().slice(0, LIMITS.name) || v.name } : {}),
    ...(body.config ? { config: JSON.stringify(cleanViewConfig(v.type, { ...v.config, ...body.config }, fields)) } : {}),
    updatedAt: deps.now(),
  }).where(and(eq(tableViews.id, v.id), eq(tableViews.orgId, actor.orgId)));
  return (await viewsOf(deps, actor.orgId, docId)).find((x) => x.id === viewId)!;
}
export async function deleteView(deps: Deps, actor: SuiteActor, docId: string, viewId: string) {
  const viewer = member(actor);
  const { meta } = await loadMeta(deps, viewer, docId);
  assertEdit(viewer, meta);
  const views = await viewsOf(deps, actor.orgId, docId);
  if (!views.some((v) => v.id === viewId)) throw notFound("View");
  if (views.length <= 1) throw unprocessable("last_view", "A table keeps at least one view.");
  await deps.db.delete(tableViews).where(and(eq(tableViews.id, viewId), eq(tableViews.orgId, actor.orgId)));
  return { ok: true };
}
export async function updateSettings(deps: Deps, actor: SuiteActor, docId: string, body: { editAccess: "everyone" | "admins" }) {
  const viewer = member(actor);
  assertWritable(actor);
  const { meta } = await loadMeta(deps, viewer, docId);
  if (!(actor.role === "owner" || actor.role === "admin" || actor.userId === meta.createdBy)) throw new HttpError(403, "forbidden", "Only admins and the person who made this table can change who edits it.");
  await deps.db.update(docTables).set({ editAccess: body.editAccess, updatedAt: deps.now() }).where(and(eq(docTables.docId, docId), eq(docTables.orgId, actor.orgId)));
  return { editAccess: body.editAccess };
}

// ---------------------------------------------------------------- CSV

export interface ImportColumn { name: string; type: TFieldType; fieldId?: string | null; skip?: boolean }
/** Imports CSV rows (the header already removed). New tables make their fields from the columns; an existing table maps columns onto fields. */
export async function importCsv(deps: Deps, actor: SuiteActor, body: { docId?: string; title?: string; parentId?: string | null; columns: ImportColumn[]; rows: string[][] }) {
  assertWritable(actor);
  if (body.rows.length > LIMITS.importRows) throw unprocessable("too_many_rows", `A CSV file can bring in up to ${LIMITS.importRows.toLocaleString("en-AU")} rows at a time.`);
  if (!body.columns.length || body.columns.length > LIMITS.fields) throw unprocessable("columns", `A CSV file needs 1 to ${LIMITS.fields} columns.`);
  let docId = body.docId;
  let fields: TField[];
  const colField: (TField | null)[] = [];
  if (!docId) {
    const made = await createTableShell(deps, actor, body.title ?? "Imported table", body.parentId ?? null);
    docId = made;
    const used = new Set<string>();
    let pos = 1;
    for (const [i, c] of body.columns.entries()) {
      if (c.skip) { colField.push(null); continue; }
      let name = (c.name ?? "").trim().replace(/[{}]/g, "").slice(0, LIMITS.name) || `Column ${i + 1}`;
      while (used.has(name.toLowerCase())) name = `${name} ${i + 1}`;
      used.add(name.toLowerCase());
      const type: TFieldType = FIELD_TYPES.includes(c.type) && !isComputed(c.type) && c.type !== "link" && c.type !== "attachment" ? c.type : "text";
      const config: TFieldConfig = type === "select" || type === "multiselect" ? { options: optionList(newOptionLabels({ type, config: {} }, body.rows.map((r) => r[i] ?? ""))) } : type === "currency" ? { currency: "AUD" } : {};
      const id = await insertField(deps, actor.orgId, docId, { name, type, config, position: pos });
      colField.push({ id, name, type, config, position: pos++, width: null });
    }
    if (!colField.some(Boolean)) throw unprocessable("columns", "Choose at least one column to bring in.");
    await insertView(deps, actor.orgId, docId, { name: "Grid", type: "grid", config: {}, position: 1 });
    fields = colField.filter((f): f is TField => !!f);
  } else {
    const viewer = member(actor);
    const { meta } = await loadMeta(deps, viewer, docId);
    assertEdit(viewer, meta);
    fields = await fieldsOf(deps, actor.orgId, docId);
    for (const c of body.columns) { const f = c.skip ? undefined : fields.find((x) => x.id === c.fieldId && !isComputed(x.type) && x.type !== "link" && x.type !== "attachment"); colField.push(f ?? null); }
    // New select options found in the file are added to the field.
    for (const [i, f] of colField.entries()) {
      if (!f) continue;
      const extra = newOptionLabels(f, body.rows.map((r) => r[i] ?? ""));
      if (extra.length) {
        const options = [...(f.config.options ?? []), ...optionList(extra).map((o, k) => ({ ...o, color: OPTION_COLOURS[((f.config.options ?? []).length + k) % OPTION_COLOURS.length] }))].slice(0, LIMITS.options);
        f.config = { ...f.config, options };
        await deps.db.update(tableFields).set({ config: JSON.stringify(f.config) }).where(eq(tableFields.id, f.id));
      }
    }
  }
  const problems: { row: number; field: string; error: string }[] = [];
  let problemCount = 0;
  let skipped = 0;
  const list: Record<string, TCell>[] = [];
  body.rows.forEach((r, n) => {
    if (!r.some((x) => (x ?? "").trim() !== "")) { skipped++; return; }
    const input: Record<string, unknown> = {};
    colField.forEach((f, i) => { if (f) input[f.id] = r[i] ?? ""; });
    const { cells, problems: p } = coerceAll(fields, input, { lenient: true });
    for (const x of p) { problemCount++; if (problems.length < 100) problems.push({ row: n + 2, field: x.field, error: x.error }); }
    if (r.length > body.columns.length && r.slice(body.columns.length).some((x) => x.trim())) { problemCount++; if (problems.length < 100) problems.push({ row: n + 2, field: "", error: "This row has more cells than there are columns. The extra cells were left out." }); }
    list.push(Object.fromEntries(Object.entries(cells).filter(([, v]) => v !== null)));
  });
  await insertRows(deps, actor, docId, fields, list);
  await recordWrite(deps, actor, { entityType: "doc", entityId: docId, op: "update", verb: "imported_rows", data: { rows: list.length } });
  await touch(deps, actor.orgId, docId);
  return { docId, imported: list.length, skipped, problems, problemCount };
}
async function createTableShell(deps: Deps, actor: SuiteActor, title: string, parentId: string | null): Promise<string> {
  const doc = await createDoc(deps, actor, { title: title.trim().slice(0, 200) || "Imported table", text: "", parentId });
  await deps.db.update(docs).set({ kind: "table" }).where(and(eq(docs.id, doc.id), eq(docs.orgId, actor.orgId)));
  await deps.db.insert(docTables).values({ docId: doc.id, orgId: actor.orgId, editAccess: "everyone", nextSeq: 1, rowCount: 0, createdBy: actor.userId || null, createdAt: deps.now(), updatedAt: deps.now() });
  return doc.id;
}

/** The view as CSV: its filters and sort, its visible fields, worked out values included. */
export async function exportCsv(deps: Deps, viewer: Viewer, docId: string, viewId?: string) {
  const { title } = await loadMeta(deps, viewer, docId);
  const fields = await fieldsOf(deps, viewer.actor.orgId, docId);
  const view = viewId ? (await viewsOf(deps, viewer.actor.orgId, docId)).find((v) => v.id === viewId) : undefined;
  const hidden = new Set(view?.config.hidden ?? []);
  const shown = fields.filter((f) => !hidden.has(f.id));
  const out: string[][] = [shown.map((f) => f.name)];
  let cursor: string | undefined;
  for (let guard = 0; guard < LIMITS.rows / 500 + 1; guard++) {
    const page = await listRows(deps, viewer, docId, { cursor, limit: 500, viewId: view?.id });
    for (const r of page.rows) out.push(shown.map((f) => f.type === "date" && typeof r.values[f.id] === "string" ? String(r.values[f.id]) : cellText(f, r.values[f.id] ?? null, r.labels[f.id])));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const safe = title.replace(/[^\w .()-]+/g, " ").trim().slice(0, 80) || "table";
  return { filename: `${safe}.csv`, csv: toCsv(out) };
}

// ---------------------------------------------------------------- comments and history

export async function listRowComments(deps: Deps, viewer: Viewer, docId: string, rowId: string) {
  await loadMeta(deps, viewer, docId);
  await rowById(deps, viewer.actor.orgId, docId, rowId);
  const rows = await deps.db.select({ id: docComments.id, body: docComments.body, authorName: docComments.authorName, authorId: docComments.authorId, createdAt: docComments.createdAt })
    .from(docComments).where(and(eq(docComments.orgId, viewer.actor.orgId), eq(docComments.rowId, rowId), eq(docComments.docId, docId), isNull(docComments.deletedAt), eq(docComments.status, "visible"))).orderBy(asc(docComments.createdAt)).limit(200);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), mine: r.authorId === viewer.actor.userId }));
}
export async function addRowComment(deps: Deps, actor: SuiteActor, docId: string, rowId: string, body: string) {
  const viewer = member(actor);
  assertWritable(actor);
  await loadMeta(deps, viewer, docId);
  await rowById(deps, actor.orgId, docId, rowId);
  const text = body.trim();
  if (!text) throw unprocessable("empty_comment", "Write a comment first.");
  const id = sortableId("dcm", deps.now().getTime());
  const who = actorOf(actor);
  await deps.db.insert(docComments).values({ id, orgId: actor.orgId, docId, rowId, thread: "team", authorType: "member", authorId: actor.userId || null, authorName: who.name, body: text.slice(0, 5000), status: "visible", createdAt: deps.now() });
  await recordWrite(deps, actor, { entityType: "table_row" as never, entityId: rowId, op: "update", verb: "commented", data: { docId, text: clipText(text) } });
  return { id, body: text.slice(0, 5000), authorName: who.name, authorId: actor.userId, createdAt: deps.now().toISOString(), mine: true };
}
export async function deleteRowComment(deps: Deps, actor: SuiteActor, docId: string, commentId: string) {
  assertWritable(actor);
  await loadMeta(deps, member(actor), docId);
  const c = await deps.db.select().from(docComments).where(and(eq(docComments.id, commentId), eq(docComments.orgId, actor.orgId), eq(docComments.docId, docId), isNull(docComments.deletedAt))).get();
  if (!c || !c.rowId) throw notFound("Comment");
  if (c.authorId !== actor.userId && actor.role !== "owner" && actor.role !== "admin") throw new HttpError(403, "forbidden", "You can delete your own comments.");
  await deps.db.update(docComments).set({ deletedAt: deps.now() }).where(eq(docComments.id, c.id));
  return { ok: true };
}
export async function rowHistory(deps: Deps, viewer: Viewer, docId: string, rowId: string) {
  await loadMeta(deps, viewer, docId);
  await rowById(deps, viewer.actor.orgId, docId, rowId, true);
  const rows = await deps.db.select({ seq: changes.seq, verb: changes.verb, actorName: changes.actorName, data: changes.data, createdAt: changes.createdAt })
    .from(changes).where(and(eq(changes.entityType, "table_row"), eq(changes.entityId, rowId), eq(changes.orgId, viewer.actor.orgId), sql`${changes.verb} is not null`)).orderBy(desc(changes.seq)).limit(50);
  return rows.map((r) => {
    let data: { changes?: { name: string; from: string; to: string }[]; text?: string } = {};
    try { data = JSON.parse(r.data ?? "{}") as typeof data; } catch { data = {}; }
    return { id: r.seq, verb: r.verb, who: r.actorName ?? "Someone", at: r.createdAt.toISOString(), changes: (data.changes ?? []).map((c) => ({ field: c.name, from: c.from, to: c.to })), text: data.text ?? null };
  });
}
