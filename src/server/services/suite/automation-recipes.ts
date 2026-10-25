/**
 * R24.4 Automation recipes: list them with their on state, and turn one on. Turning a recipe on
 * writes normal automation rows (one per rule of the recipe) through createAutomation, so every
 * check of the engine applies: ids from another workspace are refused, read only keys can't write.
 * The recipe's key rides in conditions.recipe; no new column.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { automations } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { AUTOMATION_RECIPES, fillRecipe, recipeByKey, RECIPE_CATEGORIES } from "@/shared/automation-recipes";
import { createAutomation, updateAutomation, type Automation } from "./automations";
import { assertWritable, type SuiteActor } from "./common";

export function canManageAutomations(a: SuiteActor) {
  return !a.agentId && a.role !== "member";
}

/** Every recipe with whether it is on here and the rule ids it made. Reads one table; writes nothing. */
export async function listRecipes(deps: Deps, actor: SuiteActor) {
  const rows = await deps.db.select({ id: automations.id, conditions: automations.conditions, enabled: automations.enabled }).from(automations)
    .where(and(eq(automations.orgId, actor.orgId), isNull(automations.deletedAt)));
  const byKey = new Map<string, { id: string; enabled: boolean }[]>();
  for (const r of rows) {
    const key = (JSON.parse(r.conditions) as { recipe?: unknown }).recipe;
    if (typeof key === "string") byKey.set(key, [...(byKey.get(key) ?? []), { id: r.id, enabled: r.enabled }]);
  }
  return {
    categories: RECIPE_CATEGORIES,
    canManage: canManageAutomations(actor) && actor.scope !== "read",
    recipes: AUTOMATION_RECIPES.map((r) => {
      const made = byKey.get(r.key) ?? [];
      return { ...r, added: made.length > 0, on: made.some((m) => m.enabled), automationIds: made.map((m) => m.id) };
    }),
  };
}

/**
 * Turns a recipe on with its blanks filled. When it is already added, its rules are switched on
 * again (blanks given then replace the old ones on each rule). Answers the rules it made or changed.
 */
export async function enableRecipe(deps: Deps, actor: SuiteActor, key: string, blanks: Record<string, unknown> = {}) {
  assertWritable(actor);
  if (!canManageAutomations(actor)) throw new HttpError(403, "forbidden", "Only workspace admins can turn on recipes.");
  const recipe = recipeByKey(key);
  if (!recipe) throw notFound("Recipe");
  let rules;
  try { rules = fillRecipe(recipe, blanks); } catch (err) { throw new HttpError(422, "validation_failed", (err as Error).message); }
  const existing = (await listRecipes(deps, actor)).recipes.find((r) => r.key === key)!.automationIds;
  const out: Automation[] = [];
  if (existing.length === rules.length) {
    for (const [i, id] of existing.entries()) out.push(await updateAutomation(deps, actor, id, { enabled: true, ...(recipe.blanks.length ? { conditions: rules[i].conditions, actionConfig: rules[i].actionConfig } : {}) }));
    return { recipe: key, automations: out, created: false };
  }
  for (const r of rules) {
    out.push(await createAutomation(deps, actor, { name: recipe.name.slice(0, 120), trigger: r.trigger, conditions: r.conditions, action: r.action, actionConfig: r.actionConfig, enabled: true }));
  }
  return { recipe: key, automations: out, created: true };
}
