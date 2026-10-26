/**
 * R34 (MB-186): board settings per project: swimlanes and WIP limits per column. One row per project; a save is
 * one upsert (essential write: a person changed the board). Reads are one primary-key lookup, no write.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { boardSettings, projects } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { DEFAULT_BOARD, SWIMLANES, normaliseLimits, type BoardLimits, type BoardSettings, type Swimlanes } from "../../../shared/board-lanes";
import { assertWritable, type SuiteActor } from "./common";

async function assertProject(deps: Deps, orgId: string, projectId: string) {
  const p = await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt))).get();
  if (!p) throw notFound("Project");
}

function parseLimits(raw: string): BoardLimits {
  try { return normaliseLimits(JSON.parse(raw)); } catch { return {}; }
}

export async function getBoardSettings(deps: Deps, orgId: string, projectId: string): Promise<BoardSettings & { projectId: string }> {
  await assertProject(deps, orgId, projectId);
  const row = await deps.db.select().from(boardSettings).where(and(eq(boardSettings.projectId, projectId), eq(boardSettings.orgId, orgId))).get();
  if (!row) return { projectId, ...DEFAULT_BOARD };
  return { projectId, swimlanes: row.swimlanes as Swimlanes, limits: parseLimits(row.limits) };
}

export type BoardPatch = { swimlanes?: Swimlanes; limits?: unknown; column?: { id: string; max?: number | null; min?: number | null } };

/**
 * Changes the board: swimlanes, the whole limits map, or one column's limit (`column`, null clears).
 * Validates first, then one upsert. 422 on a bad value.
 */
export async function setBoardSettings(deps: Deps, actor: SuiteActor, projectId: string, patch: BoardPatch) {
  assertWritable(actor);
  const cur = await getBoardSettings(deps, actor.orgId, projectId);
  if (patch.swimlanes !== undefined && !SWIMLANES.includes(patch.swimlanes)) {
    throw new HttpError(422, "validation_failed", `swimlanes must be one of ${SWIMLANES.join(", ")}.`);
  }
  let limits = cur.limits;
  try {
    if (patch.limits !== undefined) limits = normaliseLimits(patch.limits);
    if (patch.column) {
      const { id, max, min } = patch.column;
      const next = { ...limits, [id]: { ...(limits[id] ?? {}), ...(max !== undefined ? { max: max ?? undefined } : {}), ...(min !== undefined ? { min: min ?? undefined } : {}) } };
      limits = normaliseLimits(JSON.parse(JSON.stringify(next)));
    }
  } catch (e) {
    throw new HttpError(422, "validation_failed", (e as Error).message);
  }
  const swimlanes = patch.swimlanes ?? cur.swimlanes;
  const now = deps.now();
  const json = JSON.stringify(limits);
  // Essential write (a person saved the board): one upsert, no change row (settings, not work).
  await deps.db.insert(boardSettings).values({ projectId, orgId: actor.orgId, swimlanes, limits: json, updatedBy: actor.userId || null, updatedAt: now })
    .onConflictDoUpdate({ target: boardSettings.projectId, set: { swimlanes, limits: json, updatedBy: actor.userId || null, updatedAt: now } });
  return { projectId, swimlanes, limits };
}
