/**
 * Round 2, Wave 2 (PR 24 leftovers): the workspace's Triage settings, kept in organizations.metadata (no migration),
 * the same way "Allow share links" is (share-links.ts).
 *
 * - `machineTriageAlways` ("AI and API tasks always wait in Triage", off by default): when on, work an API key, an
 *   agent or a connected AI app makes waits in Triage in every project, not only in projects with Triage on, and the
 *   move check treats every project as one with Triage on. Only an admin signed in to Multies changes it.
 * - `triageOnByMachine` ({ projectId: epoch ms }): when a key or an AI app turned Triage on for a project. Tasks made
 *   there before that moment never passed Triage, so the move check counts that project as Triage off for them
 *   (otherwise a key could turn Triage on for its own project and then move its tasks onto a checked board).
 *
 * Reads happen only on a machine's path, and only when the answer can change the outcome.
 */
import { eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { organizations } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { requirePerson } from "../../lib/actor-kind";
import { readMeta } from "./share-links";
import type { SuiteActor } from "./common";

const ALWAYS = "machineTriageAlways";
const ON_BY_MACHINE = "triageOnByMachine";

export interface TriageMeta {
  /** "AI and API tasks always wait in Triage". */
  always: boolean;
  /** When a key or an AI app turned Triage on, per project (epoch ms). */
  onByMachine: Record<string, number>;
}

function parse(raw: string | null | undefined): TriageMeta {
  const meta = readMeta(raw);
  const map = meta[ON_BY_MACHINE];
  const onByMachine: Record<string, number> = {};
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const [k, v] of Object.entries(map as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) onByMachine[k] = v;
  }
  return { always: meta[ALWAYS] === true, onByMachine };
}

/** One read of the workspace row. */
export async function triageMeta(deps: Deps, orgId: string): Promise<TriageMeta> {
  const org = await deps.db.select({ metadata: organizations.metadata }).from(organizations).where(eq(organizations.id, orgId)).get();
  return parse(org?.metadata);
}

export async function machineTriageAlways(deps: Deps, orgId: string): Promise<boolean> {
  return (await triageMeta(deps, orgId)).always;
}

export async function triageSettings(deps: Deps, orgId: string) {
  return { machineTasksAlwaysWait: await machineTriageAlways(deps, orgId) };
}

/** Admins and owners signed in to Multies only. One organizations row write when the value changes, none when it does not. */
export async function setTriageSettings(deps: Deps, actor: SuiteActor & { guest?: boolean }, input: { machineTasksAlwaysWait: boolean }) {
  requirePerson(actor, "Changing the workspace's Triage setting");
  if (actor.guest || (actor.role !== "owner" && actor.role !== "admin")) throw new HttpError(403, "forbidden", "Only workspace admins can do that.");
  const org = await deps.db.select({ metadata: organizations.metadata }).from(organizations).where(eq(organizations.id, actor.orgId)).get();
  if (!org) throw notFound("Workspace");
  const meta = readMeta(org.metadata);
  const on = input.machineTasksAlwaysWait;
  if ((meta[ALWAYS] === true) === on) return { machineTasksAlwaysWait: on };
  const next = { ...meta };
  if (on) next[ALWAYS] = true; else delete next[ALWAYS];
  await deps.db.update(organizations).set({ metadata: JSON.stringify(next) }).where(eq(organizations.id, actor.orgId));
  return { machineTasksAlwaysWait: on };
}

/**
 * A key or an AI app turned Triage on for a project: remember when, so tasks made there before it still count as
 * never checked when a key moves them. One read and one write of the workspace row; only on that rare path.
 */
export async function recordTriageOnByMachine(deps: Deps, orgId: string, projectId: string, at: Date) {
  const org = await deps.db.select({ metadata: organizations.metadata }).from(organizations).where(eq(organizations.id, orgId)).get();
  if (!org) return;
  const meta = readMeta(org.metadata);
  const map = parse(org.metadata).onByMachine;
  await deps.db.update(organizations).set({ metadata: JSON.stringify({ ...meta, [ON_BY_MACHINE]: { ...map, [projectId]: at.getTime() } }) }).where(eq(organizations.id, orgId));
}

/**
 * Whether a task in a project with Triage on counts as having been checked there: not when a key or an AI app turned
 * Triage on for that project after the task was made.
 */
export function passedTriageIn(meta: TriageMeta, projectId: string, createdAt: Date | number | null | undefined): boolean {
  const at = meta.onByMachine[projectId];
  if (at === undefined) return true;
  const made = createdAt instanceof Date ? createdAt.getTime() : typeof createdAt === "number" ? createdAt : 0;
  return made >= at;
}
