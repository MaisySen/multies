/**
 * R24.1 Computed fields: formula and rollup values, worked out when tasks are read. Nothing is
 * written per task, so a list, table, board or task panel read costs 0 D1 writes; only defining
 * or changing a field writes (one custom_fields row).
 *
 * Cost per read: one query for the projects' field definitions, then (only when a project has
 * rollups) one query for the children of the listed tasks, one more for epics' grandchildren
 * when an epic_children rollup needs them, and one for the children's stored values when a
 * rollup aggregates a custom field. At most CHILD_CAP children are read per request.
 */
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Deps } from "../../context";
import { projects, tasks } from "../../db/schema";
import { notFound } from "../../lib/errors";
import type { SuiteActor } from "./common";
import { isComputedType, listFields, presentField, valuesForTasks, type Field, type FieldValue } from "./fields";
import { evaluate, FormulaError, parse, tidy, type FValue, type Node } from "./formula";
import { isProjectRollup, type FormulaConfig, type RollupConfig } from "./formula-config";
import { orgFieldDefs } from "./read-cache";

type TaskRow = typeof tasks.$inferSelect;
export const CHILD_CAP = 5000;
export const PROJECT_TASK_CAP = 2000;
export const ERROR_CELL = "#ERROR";

export interface Names {
  status?(row: TaskRow): string | undefined;
  assignee?(row: TaskRow): string | null | undefined;
  person?(value: string): string | null | undefined;
}

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const chunk = <T>(xs: T[], n = 90) => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** Parsed formulas, one per field per request. */
class Compiled {
  private cache = new Map<string, Node | FormulaError>();
  get(f: Field): Node {
    let n = this.cache.get(f.id);
    if (!n) {
      try { n = parse((f.config as FormulaConfig | undefined)?.expression ?? ""); } catch (e) { n = e instanceof FormulaError ? e : new FormulaError("This formula can't be read."); }
      this.cache.set(f.id, n);
    }
    if (n instanceof FormulaError) throw n;
    return n;
  }
}

function stored(f: Field, v: FieldValue | undefined, names: Names): FValue {
  if (v === undefined || v === null) return null;
  if (f.type === "select") return f.options.find((o) => o.id === v)?.label ?? null;
  if (f.type === "multiselect") return (v as string[]).map((id) => f.options.find((o) => o.id === id)?.label).filter(Boolean).join(", ");
  if (f.type === "person") { const s = String(v); return names.person?.(s) ?? s; }
  if (Array.isArray(v)) return v.join(", ");
  return v;
}

function builtIn(row: TaskRow, name: string, names: Names): FValue | undefined {
  switch (name) {
    case "points": return row.points ?? null;
    case "due": return day(row.dueAt);
    case "start": return day(row.startAt);
    case "created": return day(row.createdAt);
    case "completed": return day(row.completedAt);
    case "status": return names.status?.(row) ?? row.status;
    case "priority": return row.priority;
    case "title": return row.title;
    case "assignee": return names.assignee?.(row) ?? null;
  }
  return undefined;
}

type Rollup = (f: Field) => FValue;

/** Reads one task's fields, formulas included, with loop detection. */
function cellReader(row: TaskRow, vals: Record<string, FieldValue>, fields: Field[], names: Names, now: Date, compiled: Compiled, rollup: Rollup | null) {
  const byName = new Map<string, Field>();
  for (const f of fields) if (!byName.has(f.name.toLowerCase())) byName.set(f.name.toLowerCase(), f);
  const memo = new Map<string, { value: FValue; error?: string }>();
  const visiting = new Set<string>();
  const valueOf = (f: Field): FValue => {
    const hit = memo.get(f.id);
    if (hit) { if (hit.error !== undefined) throw new FormulaError(hit.error); return hit.value; }
    if (f.type === "formula") {
      if (visiting.has(f.id)) throw new FormulaError(`Formulas refer to each other in a loop through {${f.name}}.`);
      visiting.add(f.id);
      try {
        const v = evaluate(compiled.get(f), ctx);
        if (typeof v === "number" && !Number.isFinite(v)) throw new FormulaError("The answer is not a finite number.");
        const value = typeof v === "number" ? tidy(v) : v;
        memo.set(f.id, { value });
        return value;
      } catch (e) {
        const msg = e instanceof FormulaError ? e.message : e instanceof RangeError ? "This formula is too complex." : null;
        if (msg === null) throw e;
        memo.set(f.id, { value: null, error: msg });
        throw new FormulaError(msg);
      } finally { visiting.delete(f.id); }
    }
    if (f.type === "rollup") {
      if (!rollup) throw new FormulaError("A rollup can't add up a formula that reads another rollup.");
      try { const value = rollup(f); memo.set(f.id, { value }); return value; }
      catch (e) { if (e instanceof FormulaError) memo.set(f.id, { value: null, error: e.message }); throw e; }
    }
    return stored(f, vals[f.id], names);
  };
  const ctx = {
    now,
    resolve(name: string, braced: boolean): FValue {
      const key = name.toLowerCase();
      const f = byName.get(key);
      if (f) return valueOf(f);
      const b = builtIn(row, key, names);
      if (b !== undefined) return b;
      throw new FormulaError(braced ? `There is no field called {${name}}.` : `Unknown name "${name}". Put field names in braces, like {${name}}.`);
    },
  };
  return {
    valueOf,
    cell(f: Field): { value: FValue; error?: string } {
      try { return { value: valueOf(f) }; } catch (e) {
        if (e instanceof FormulaError) return { value: null, error: e.message };
        throw e;
      }
    },
  };
}

/** Sum, count, average and the rest over a set of child tasks. */
export function aggregate(cfg: RollupConfig, items: TaskRow[], valueOf: (row: TaskRow) => FValue): FValue {
  if (cfg.fn === "count") return items.length;
  if (cfg.fn === "count_done") return items.filter((r) => r.status === "done").length;
  if (cfg.fn === "percent_done") return items.length ? Math.round((items.filter((r) => r.status === "done").length / items.length) * 100) : null;
  const nums: number[] = [];
  for (const r of items) {
    const v = valueOf(r);
    if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
    else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) nums.push(Number(v));
  }
  if (cfg.fn === "sum") return tidy(nums.reduce((s, x) => s + x, 0));
  if (!nums.length) return null;
  if (cfg.fn === "average") return tidy(nums.reduce((s, x) => s + x, 0) / nums.length);
  if (cfg.fn === "min") return Math.min(...nums);
  return Math.max(...nums);
}

async function liveChildren(deps: Deps, orgId: string, parentIds: string[], cap: number): Promise<TaskRow[]> {
  const out: TaskRow[] = [];
  for (const ids of chunk(parentIds)) {
    if (out.length >= cap) break;
    out.push(...await deps.db.select().from(tasks).where(and(eq(tasks.orgId, orgId), inArray(tasks.parentId, ids), isNull(tasks.deletedAt), isNull(tasks.triageState))).limit(cap - out.length));
  }
  return out;
}

/** Field definitions for these projects, in their display order. */
async function defsFor(deps: Deps, orgId: string, projectIds: string[]) {
  // R25: the workspace's live definitions come from the short read cache (one query per TTL, not per list).
  const want = new Set(projectIds);
  const rows = (await orgFieldDefs(deps, orgId)).filter((r) => want.has(r.projectId));
  const by = new Map<string, Field[]>();
  for (const r of [...rows].sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime())) {
    const list = by.get(r.projectId) ?? [];
    list.push(presentField(r));
    by.set(r.projectId, list);
  }
  return by;
}

const valueFieldOf = (cfg: RollupConfig, fields: Field[]) => (cfg.field && cfg.field !== "points" ? fields.find((f) => f.id === cfg.field) ?? null : null);

/**
 * Adds formula and rollup values to `values` (taskId to { fieldId: value }) for these rows. A
 * cell that can't be worked out holds "#ERROR"; the returned map has the message per cell.
 */
export async function computeForRows(deps: Deps, orgId: string, rows: TaskRow[], values: Map<string, Record<string, FieldValue>>, names: Names = {}) {
  const errors = new Map<string, Record<string, string>>();
  if (!rows.length) return errors;
  const defs = await defsFor(deps, orgId, [...new Set(rows.map((r) => r.projectId))]);
  const computedIn = (pid: string) => (defs.get(pid) ?? []).filter((f) => isComputedType(f.type) && !isProjectRollup(f));
  if (!rows.some((r) => computedIn(r.projectId).length)) return errors;
  const now = deps.now();
  const compiled = new Compiled();

  // Children for rollups, in at most three grouped reads.
  const rollupsIn = (pid: string) => computedIn(pid).filter((f) => f.type === "rollup");
  const needKids = rows.filter((r) => rollupsIn(r.projectId).length);
  const kids = needKids.length ? await liveChildren(deps, orgId, needKids.map((r) => r.id), CHILD_CAP) : [];
  const epicIds = new Set(needKids.filter((r) => r.type === "epic" && rollupsIn(r.projectId).some((f) => (f.config as RollupConfig).source === "epic_children")).map((r) => r.id));
  // Items whose own children were already read (they are in this list too) need no second read.
  const asked = new Set(needKids.map((r) => r.id));
  const items = kids.filter((k) => k.parentId && epicIds.has(k.parentId) && !asked.has(k.id));
  const grand = items.length ? await liveChildren(deps, orgId, items.map((k) => k.id), Math.max(0, CHILD_CAP - kids.length)) : [];
  const byParent = new Map<string, TaskRow[]>();
  const placed = new Set<string>();
  for (const k of [...kids, ...grand]) {
    if (placed.has(k.id)) continue;
    placed.add(k.id);
    const l = byParent.get(k.parentId!) ?? []; l.push(k); byParent.set(k.parentId!, l);
  }
  const needChildValues = needKids.some((r) => rollupsIn(r.projectId).some((f) => valueFieldOf(f.config as RollupConfig, defs.get(r.projectId) ?? [])));
  const kidVals = needChildValues ? await valuesForTasks(deps, orgId, [...kids, ...grand].map((k) => k.id)) : new Map<string, Record<string, FieldValue>>();

  for (const row of rows) {
    const comp = computedIn(row.projectId);
    if (!comp.length) continue;
    const fields = defs.get(row.projectId) ?? [];
    const childReaders = new Map<string, ReturnType<typeof cellReader>>();
    const childValue = (child: TaskRow, cfg: RollupConfig): FValue => {
      if (cfg.field === "points") return child.points ?? null;
      const vf = valueFieldOf(cfg, fields);
      if (!vf) throw new FormulaError("The field this rollup adds up was deleted.");
      let rd = childReaders.get(child.id);
      if (!rd) { rd = cellReader(child, kidVals.get(child.id) ?? {}, fields, names, now, compiled, null); childReaders.set(child.id, rd); }
      try { return rd.valueOf(vf); } catch (e) {
        if (e instanceof FormulaError) throw new FormulaError(`${child.title.slice(0, 40)}: ${e.message}`);
        throw e;
      }
    };
    const rollup: Rollup = (f) => {
      const cfg = f.config as RollupConfig;
      const direct = byParent.get(row.id) ?? [];
      let set: TaskRow[];
      if (cfg.source === "epic_children") set = row.type === "epic" ? [...direct, ...direct.flatMap((d) => byParent.get(d.id) ?? [])] : [];
      else set = direct;
      return aggregate(cfg, set, (c) => childValue(c, cfg));
    };
    const reader = cellReader(row, values.get(row.id) ?? {}, fields, names, now, compiled, rollup);
    const out = { ...(values.get(row.id) ?? {}) };
    for (const f of comp) {
      const c = reader.cell(f);
      if (c.error !== undefined) {
        out[f.id] = ERROR_CELL;
        errors.set(row.id, { ...(errors.get(row.id) ?? {}), [f.id]: c.error });
      } else out[f.id] = c.value;
    }
    values.set(row.id, out);
  }
  return errors;
}

/** Project level rollups (fields with source project) over the project's live tasks, epics left out. */
export async function projectRollups(deps: Deps, actor: Pick<SuiteActor, "orgId">, projectId: string) {
  const p = await deps.db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.orgId, actor.orgId), eq(projects.id, projectId), isNull(projects.deletedAt))).get();
  if (!p) throw notFound("Project");
  const fields = await listFields(deps, actor.orgId, projectId);
  const defs = fields.filter(isProjectRollup);
  if (!defs.length) return { projectId, rollups: [], taskCount: 0, truncated: false };
  const rows = await deps.db.select().from(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt), isNull(tasks.triageState), ne(tasks.type, "epic"))).limit(PROJECT_TASK_CAP + 1);
  const truncated = rows.length > PROJECT_TASK_CAP;
  const list = rows.slice(0, PROJECT_TASK_CAP);
  const needVals = defs.some((d) => valueFieldOf(d.config as RollupConfig, fields));
  const vals = needVals ? await valuesForTasks(deps, actor.orgId, list.map((r) => r.id)) : new Map<string, Record<string, FieldValue>>();
  const compiled = new Compiled();
  const now = deps.now();
  const readers = new Map<string, ReturnType<typeof cellReader>>();
  const rollups = defs.map((d) => {
    const cfg = d.config as RollupConfig;
    const vf = valueFieldOf(cfg, fields);
    const base = { id: d.id, name: d.name, fn: cfg.fn, field: cfg.field, fieldName: cfg.field === "points" ? "Points" : vf?.name ?? null };
    try {
      if (cfg.field && cfg.field !== "points" && !vf) throw new FormulaError("The field this rollup adds up was deleted.");
      const value = aggregate(cfg, list, (r) => {
        if (cfg.field === "points") return r.points ?? null;
        let rd = readers.get(r.id);
        if (!rd) { rd = cellReader(r, vals.get(r.id) ?? {}, fields, {}, now, compiled, null); readers.set(r.id, rd); }
        return rd.valueOf(vf!);
      });
      return { ...base, value };
    } catch (e) {
      if (e instanceof FormulaError) return { ...base, value: ERROR_CELL, error: e.message };
      throw e;
    }
  });
  return { projectId, rollups, taskCount: list.length, truncated };
}

/** Formula and rollup values of one task, with each field's settings. */
export async function taskComputed(deps: Deps, task: { id: string; ref: string; projectId: string; fields: Record<string, FieldValue>; fieldErrors?: Record<string, string> }, orgId: string) {
  const fields = (await listFields(deps, orgId, task.projectId)).filter((f) => isComputedType(f.type) && !isProjectRollup(f));
  return {
    taskId: task.id, ref: task.ref,
    computed: fields.map((f) => ({
      fieldId: f.id, name: f.name, type: f.type, config: f.config ?? null,
      value: task.fields[f.id] ?? null, ...(task.fieldErrors?.[f.id] ? { error: task.fieldErrors[f.id] } : {}),
    })),
  };
}

/** Live preview for the field editor: a formula against one task, nothing saved. */
export async function previewFormula(deps: Deps, orgId: string, projectId: string, expression: string, taskRow: TaskRow | null, taskValues: Record<string, FieldValue>, names: Names = {}) {
  const fields = await listFields(deps, orgId, projectId);
  const temp: Field = { id: "__preview__", projectId, name: "__preview__", type: "formula", options: [], position: 0, config: { expression } };
  if (!taskRow) {
    try { parse(expression); return { value: null, error: undefined as string | undefined, task: null }; } catch (e) { return { value: null, error: e instanceof FormulaError ? e.message : "That formula can't be read.", task: null }; }
  }
  const reader = cellReader(taskRow, taskValues, [...fields, temp], names, deps.now(), new Compiled(), () => null);
  const c = reader.cell(temp);
  return { value: c.value, error: c.error, task: { id: taskRow.id, title: taskRow.title } };
}

/** The field editor's live preview: the formula against one task of the project (the first by default). */
export async function previewForProject(deps: Deps, actor: Pick<SuiteActor, "orgId">, projectId: string, expression: string, taskId?: string) {
  const p = await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, actor.orgId), eq(projects.id, projectId), isNull(projects.deletedAt))).get();
  if (!p) throw notFound("Project");
  const conds = [eq(tasks.orgId, actor.orgId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt), isNull(tasks.triageState)];
  const row = taskId
    ? await deps.db.select().from(tasks).where(and(...conds, eq(tasks.id, taskId))).get()
    : await deps.db.select().from(tasks).where(and(...conds)).orderBy(asc(tasks.position), asc(tasks.createdAt)).get();
  if (taskId && !row) throw notFound("Task");
  const vals = row ? (await valuesForTasks(deps, actor.orgId, [row.id])).get(row.id) ?? {} : {};
  return previewFormula(deps, actor.orgId, projectId, expression.slice(0, 500), row ?? null, vals);
}
