/**
 * R24 follow-up: a stored weekly capacity per person for the workload view. Owners and admins
 * set anyone's; a member sets their own. Setting is 1 row write (WITHOUT ROWID, no secondary
 * index); clearing both numbers deletes the row so the default applies again. Reading is one
 * primary key range read per workload request.
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { workloadCapacity } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { assertWritable, type SuiteActor } from "./common";
import { assignees } from "./tasks";

export interface StoredCapacity { person: string; points: number | null; hours: number | null }
export const MAX_CAPACITY = 10_000;

export async function listCapacities(deps: Deps, orgId: string): Promise<StoredCapacity[]> {
  const rows = await deps.db.select({ person: workloadCapacity.person, points: workloadCapacity.points, hours: workloadCapacity.hours })
    .from(workloadCapacity).where(eq(workloadCapacity.orgId, orgId));
  return rows.map((r) => ({ person: r.person, points: r.points ?? null, hours: r.hours ?? null }));
}

/** The capacity map with names, for Settings and the API. */
export async function capacityList(deps: Deps, actor: SuiteActor) {
  const [stored, roster] = await Promise.all([listCapacities(deps, actor.orgId), assignees(deps, actor.orgId)]);
  const byPerson = new Map(stored.map((s) => [s.person, s]));
  return {
    defaults: { points: 20, hours: 40 },
    people: roster.map((r) => ({ person: r.id, name: r.name, points: byPerson.get(r.id)?.points ?? null, hours: byPerson.get(r.id)?.hours ?? null })),
  };
}

const canSetFor = (actor: SuiteActor, person: string) =>
  actor.system || actor.role === "owner" || actor.role === "admin" || (!!actor.userId && person === `member:${actor.userId}`);

const clean = (n: number | null | undefined) => {
  if (n === undefined) return undefined;
  if (n === null) return null;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_CAPACITY) throw new HttpError(422, "validation_failed", `Use a number above 0 and up to ${MAX_CAPACITY.toLocaleString("en")}.`);
  return Math.round(n * 100) / 100;
};

/** Sets (or with both null, clears) one person's weekly capacity. A field left out keeps its stored value. */
export async function setCapacity(deps: Deps, actor: SuiteActor, input: { person: string; points?: number | null; hours?: number | null }) {
  assertWritable(actor);
  const person = input.person.trim();
  if (!/^(member|agent):[A-Za-z0-9_-]+$/.test(person)) throw new HttpError(422, "validation_failed", "Say who: member:<id> or agent:<id>.");
  const roster = await assignees(deps, actor.orgId);
  const who = roster.find((r) => r.id === person);
  // Another workspace's people are refused, never stored.
  if (!who) throw new HttpError(404, "not_found", "That person is not in this workspace.");
  if (!canSetFor(actor, person)) throw new HttpError(403, "forbidden", "Only owners and admins can set someone else's capacity.");
  const points = clean(input.points);
  const hours = clean(input.hours);
  const prev = (await deps.db.select().from(workloadCapacity).where(and(eq(workloadCapacity.orgId, actor.orgId), eq(workloadCapacity.person, person))).get()) ?? null;
  const next = { points: points === undefined ? prev?.points ?? null : points, hours: hours === undefined ? prev?.hours ?? null : hours };
  if (next.points === null && next.hours === null) {
    if (prev) await deps.db.delete(workloadCapacity).where(and(eq(workloadCapacity.orgId, actor.orgId), eq(workloadCapacity.person, person)));
  } else if (!prev || prev.points !== next.points || prev.hours !== next.hours) {
    const row = { orgId: actor.orgId, person, points: next.points, hours: next.hours, updatedBy: actor.userId || null, updatedAt: deps.now() };
    await deps.db.insert(workloadCapacity).values(row).onConflictDoUpdate({ target: [workloadCapacity.orgId, workloadCapacity.person], set: { points: row.points, hours: row.hours, updatedBy: row.updatedBy, updatedAt: row.updatedAt } });
  }
  return { person, name: who.name, points: next.points, hours: next.hours, defaults: { points: 20, hours: 40 } };
}
