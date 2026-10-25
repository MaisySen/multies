/**
 * R24.1 Formula and rollup field settings: checks what a field editor or an API caller sends and
 * keeps it as JSON in custom_fields.config. Pure functions only (no database), so fields.ts and
 * computed.ts can both use them.
 *
 * A formula: { expression }. A rollup: { source, field, fn }.
 *   source: subtasks (the task's direct subtasks; on an epic, its items), epic_children (on an
 *   epic: its items and their subtasks) or project (a project level rollup over all the project's
 *   tasks, shown in the project header, not as a task column).
 *   field: points, or the id of a number, currency or formula field on the same project. count,
 *   count_done and percent_done need no field.
 *   fn: sum, count, count_done, average, min, max or percent_done.
 */
import { HttpError } from "../../lib/errors";
import { FormulaError, parse, references } from "./formula";

export const ROLLUP_SOURCES = ["subtasks", "epic_children", "project"] as const;
export const ROLLUP_FNS = ["sum", "count", "count_done", "average", "min", "max", "percent_done"] as const;
export type RollupSource = (typeof ROLLUP_SOURCES)[number];
export type RollupFn = (typeof ROLLUP_FNS)[number];
export interface FormulaConfig { expression: string }
export interface RollupConfig { source: RollupSource; field: string | null; fn: RollupFn }
export type ComputedConfig = FormulaConfig | RollupConfig;

/** Names a formula can read without a custom field of that name. */
export const BUILT_INS = ["points", "due", "start", "created", "completed", "status", "priority", "title", "assignee"] as const;

export const NEEDS_FIELD: Record<RollupFn, boolean> = { sum: true, average: true, min: true, max: true, count: false, count_done: false, percent_done: false };

interface FieldLike { id: string; name: string; type: string; config?: unknown }

const invalid = (msg: string) => new HttpError(422, "invalid_field_config", msg);

/** The formula fields a formula reaches, following formula to formula; returns the cycle path if it loops. */
export function findCycle(startName: string, expression: string, fields: FieldLike[]): string[] | null {
  const byName = new Map(fields.filter((f) => f.type === "formula").map((f) => [f.name.toLowerCase(), f]));
  const refsOf = (expr: string): string[] => { try { return [...references(parse(expr))]; } catch { return []; } };
  const path: string[] = [startName];
  const seen = new Set<string>();
  const walk = (expr: string): string[] | null => {
    for (const r of refsOf(expr)) {
      if (r === startName.toLowerCase()) return [...path, startName];
      const f = byName.get(r);
      if (!f || seen.has(r)) continue;
      seen.add(r);
      path.push(f.name);
      const found = walk((f.config as FormulaConfig | undefined)?.expression ?? "");
      if (found) return found;
      path.pop();
    }
    return null;
  };
  return walk(expression);
}

/**
 * Checks the settings for a formula or rollup field and returns what to store. `others` are the
 * project's other fields (to resolve references and catch cycles); `name` is this field's name.
 */
export function normalizeConfig(type: string, raw: unknown, name: string, others: FieldLike[]): ComputedConfig | null {
  if (type !== "formula" && type !== "rollup") return null;
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (type === "formula") {
    const expression = typeof c.expression === "string" ? c.expression.trim() : "";
    if (!expression) throw invalid("A formula field needs an expression, like {Budget} * 1.1.");
    let tree;
    try { tree = parse(expression); } catch (e) { throw invalid(e instanceof FormulaError ? e.message : "That formula can't be read."); }
    const known = new Set([...others.map((f) => f.name.toLowerCase()), ...BUILT_INS]);
    for (const r of references(tree)) {
      if (r === name.toLowerCase()) throw invalid("A formula can't refer to itself.");
      if (!known.has(r)) throw invalid(`There is no field called "${r}" on this project.`);
    }
    const cycle = findCycle(name, expression, others);
    if (cycle) throw invalid(`These formulas refer to each other in a loop: ${cycle.join(" > ")}.`);
    return { expression };
  }
  const source = c.source as RollupSource;
  if (!(ROLLUP_SOURCES as readonly string[]).includes(source)) throw invalid("Pick what to roll up: subtasks, epic_children or project.");
  const fn = c.fn as RollupFn;
  if (!(ROLLUP_FNS as readonly string[]).includes(fn)) throw invalid(`Pick a function: ${ROLLUP_FNS.join(", ")}.`);
  let field: string | null = typeof c.field === "string" && c.field ? c.field : null;
  if (NEEDS_FIELD[fn]) {
    if (!field) throw invalid("Pick the field to add up: points, or a number, currency or formula field.");
    if (field.toLowerCase() === "points") field = "points";
    else {
      const f = others.find((x) => x.id === field) ?? others.find((x) => x.name.toLowerCase() === field!.toLowerCase());
      if (!f) throw invalid(`There is no field "${field}" on this project.`);
      if (!["number", "currency", "formula"].includes(f.type)) throw invalid(`${f.name} is not a number, currency or formula field.`);
      field = f.id;
    }
  } else field = null;
  return { source, field, fn };
}

export const isProjectRollup = (f: { type: string; config?: unknown }) => f.type === "rollup" && (f.config as RollupConfig | undefined)?.source === "project";
