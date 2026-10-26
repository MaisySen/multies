/**
 * R38: per project rules for dependency dates on the timeline, kept in the project's board_settings row
 * (column `schedule`, JSON). Two switches:
 * - workingDaysOnly: lag, lead and shifts count working days, and a moved task never starts or ends on a day off
 *   (Saturday and Sunday by default, `daysOff` as 0 = Sunday .. 6 = Saturday).
 * - strict: moving a task by N days moves every task that waits on it by the same N days, earlier or later.
 *   Off is the flexible rule (move later only, just enough).
 * Reads are one primary key lookup (or one batched read for many projects). A save is one upsert (essential
 * write: a person changed a project setting).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { boardSettings, projects } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import { assertWritable, type SuiteActor } from "./common";
import type { Cal } from "./dependency-schedule-r37";

export interface ScheduleSettings extends Cal { strict: boolean }
export const DEFAULT_SCHEDULE: ScheduleSettings = { workingDaysOnly: false, daysOff: [0, 6], strict: false };

export function parseSchedule(raw: string | null | undefined): ScheduleSettings {
  try {
    const j = JSON.parse(raw || "{}") as Partial<ScheduleSettings>;
    const daysOff = Array.isArray(j.daysOff) ? [...new Set(j.daysOff.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : DEFAULT_SCHEDULE.daysOff;
    return { workingDaysOnly: j.workingDaysOnly === true, daysOff, strict: j.strict === true };
  } catch { return { ...DEFAULT_SCHEDULE }; }
}

async function assertProject(deps: Deps, orgId: string, projectId: string) {
  const p = await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt))).get();
  if (!p) throw notFound("Project");
}

export async function getScheduleSettings(deps: Deps, orgId: string, projectId: string): Promise<ScheduleSettings & { projectId: string }> {
  await assertProject(deps, orgId, projectId);
  const row = await deps.db.select({ schedule: boardSettings.schedule }).from(boardSettings).where(and(eq(boardSettings.projectId, projectId), eq(boardSettings.orgId, orgId))).get();
  return { projectId, ...parseSchedule(row?.schedule) };
}

/** One batched read for every project in a plan (id lists chunked by inIds). Missing rows get the defaults. */
export async function scheduleSettingsFor(deps: Deps, orgId: string, projectIds: string[]): Promise<Map<string, ScheduleSettings>> {
  const ids = [...new Set(projectIds.filter(Boolean))];
  const rows = ids.length ? await deps.db.select({ projectId: boardSettings.projectId, schedule: boardSettings.schedule }).from(boardSettings)
    .where(and(eq(boardSettings.orgId, orgId), inIds(boardSettings.projectId, ids))) : [];
  const m = new Map(rows.map((r) => [r.projectId, parseSchedule(r.schedule)]));
  for (const id of ids) if (!m.has(id)) m.set(id, { ...DEFAULT_SCHEDULE });
  return m;
}

export type SchedulePatch = { workingDaysOnly?: boolean; daysOff?: number[]; strict?: boolean };

export async function setScheduleSettings(deps: Deps, actor: SuiteActor, projectId: string, patch: SchedulePatch) {
  assertWritable(actor);
  const cur = await getScheduleSettings(deps, actor.orgId, projectId);
  if (patch.daysOff !== undefined) {
    if (!Array.isArray(patch.daysOff) || patch.daysOff.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(422, "validation_failed", "daysOff takes week days from 0 (Sunday) to 6 (Saturday).");
    if (new Set(patch.daysOff).size >= 7) throw new HttpError(422, "validation_failed", "Keep at least one working day in the week.");
  }
  const next: ScheduleSettings = {
    workingDaysOnly: patch.workingDaysOnly ?? cur.workingDaysOnly,
    daysOff: patch.daysOff !== undefined ? [...new Set(patch.daysOff)].sort() : cur.daysOff,
    strict: patch.strict ?? cur.strict,
  };
  const json = JSON.stringify(next);
  const now = deps.now();
  // Essential write (a person changed the project's schedule rules): one upsert; swimlanes and limits keep their values.
  await deps.db.insert(boardSettings).values({ projectId, orgId: actor.orgId, schedule: json, updatedBy: actor.userId || null, updatedAt: now })
    .onConflictDoUpdate({ target: boardSettings.projectId, set: { schedule: json, updatedBy: actor.userId || null, updatedAt: now } });
  return { projectId, ...next };
}
