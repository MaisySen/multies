/**
 * R130: guided onboarding (flag TOURS_R130). The Get started checklist (steps complete themselves from real rows),
 * workspace tours an admin builds, and each person's progress. Every query is scoped to the caller's workspace; only
 * owners and admins build tours or reset someone's progress. No tracking beyond the person's own progress rows.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { docs, invitations, mailboxes, members, organizations, sites, tasks, tourProgress, tours } from "../db/schema";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { newId } from "../lib/crypto";
import {
  audienceMatches, BUILTIN_TOURS, checklistFor, checklistView, isManagerRole, isMarkable, MAX_STEPS, parseChecklist, TourStep,
  type AdminTour, type Audience, type ChecklistState, type ChecklistStepId, type TourDef, type TourInput, type TourPatch, type ToursMe,
} from "@/shared/tours-r130";

type Actor = Pick<AuthContext, "orgId" | "userId" | "role">;
const CHECKLIST = "checklist";

/** vv8k (a client workspace) and any listed in TOURS_EXCLUDE never get tours or the checklist. */
export function isToursExcluded(org: { id: string; slug?: string | null; name?: string | null }, extra = ""): boolean {
  const hay = [org.id, org.slug ?? "", org.name ?? ""].map((s) => s.toLowerCase());
  const words = ["vv8k", ...extra.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];
  return words.some((x) => hay.some((h) => h === x || h.includes(x)));
}
async function enabledFor(deps: Deps, orgId: string): Promise<boolean> {
  if (!deps.config.toursR130) return false;
  const o = await deps.db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).get();
  return !!o && !isToursExcluded(o, deps.config.toursExclude ?? "");
}
async function assertOn(deps: Deps, orgId: string) { if (!(await enabledFor(deps, orgId))) throw notFound("Page"); }
function assertManager(a: Actor) { if (!isManagerRole(a.role)) throw forbidden("Only workspace admins can build tours."); }

function parse(raw: string | null | undefined): unknown { if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }

/** Data steps are checked against real rows, one cheap query each (limit 1), only while they are not done yet. */
export async function dataStepDone(deps: Deps, a: Actor, id: ChecklistStepId): Promise<boolean> {
  const one = async (q: { get: () => unknown }) => !!(await q.get());
  switch (id) {
    case "mail": return one(deps.db.select({ x: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.orgId, a.orgId), eq(mailboxes.kind, "person"))).limit(1));
    case "invite": {
      if (await one(deps.db.select({ x: invitations.id }).from(invitations).where(eq(invitations.organizationId, a.orgId)).limit(1))) return true;
      return one(deps.db.select({ x: members.id }).from(members).where(and(eq(members.organizationId, a.orgId), ne(members.userId, a.userId), eq(members.kind, "human"))).limit(1));
    }
    case "task": return one(deps.db.select({ x: tasks.id }).from(tasks).where(and(eq(tasks.orgId, a.orgId), eq(tasks.createdById, a.userId))).limit(1));
    case "doc": return one(deps.db.select({ x: docs.id }).from(docs).where(and(eq(docs.orgId, a.orgId), eq(docs.createdById, a.userId))).limit(1));
    case "site": return one(deps.db.select({ x: sites.id }).from(sites).where(eq(sites.orgId, a.orgId)).limit(1));
    default: return false;
  }
}

async function readProgress(deps: Deps, a: Actor) {
  return deps.db.select({ key: tourProgress.key, state: tourProgress.state, data: tourProgress.data }).from(tourProgress)
    .where(and(eq(tourProgress.orgId, a.orgId), eq(tourProgress.userId, a.userId))).all();
}
async function writeChecklist(deps: Deps, a: Actor, s: ChecklistState) {
  const data = JSON.stringify(s); const now = Date.now();
  await deps.db.insert(tourProgress).values({ orgId: a.orgId, userId: a.userId, key: CHECKLIST, state: s.dismissed ? "dismissed" : "open", step: s.done.length, data, updatedAt: now })
    .onConflictDoUpdate({ target: [tourProgress.orgId, tourProgress.userId, tourProgress.key], set: { state: s.dismissed ? "dismissed" : "open", step: s.done.length, data, updatedAt: now } });
}

function rowToTour(r: typeof tours.$inferSelect): AdminTour {
  const raw = parse(r.steps);
  const steps = (Array.isArray(raw) ? raw : []).map((s) => TourStep.safeParse(s)).filter((p) => p.success).map((p) => p.data!).slice(0, MAX_STEPS);
  return { id: r.id, name: r.name, page: r.page, audience: r.audience as Audience, newDays: r.newDays ?? null, status: r.status as "draft" | "published", steps, updatedAt: r.updatedAt };
}

export async function toursMe(deps: Deps, a: Actor): Promise<ToursMe> {
  if (!(await enabledFor(deps, a.orgId))) return { enabled: false, canBuild: false, checklist: null, tours: [], seen: [] };
  const rows = await readProgress(deps, a);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const state = parseChecklist(parse(byKey.get(CHECKLIST)?.data));
  const defs = checklistFor(a.role, { sites: !!deps.config.sites });
  if (!state.dismissed) {
    let changed = false;
    for (const d of defs) {
      if (d.kind !== "data" || state.done.includes(d.id)) continue;
      if (await dataStepDone(deps, a, d.id)) { state.done.push(d.id); changed = true; }
    }
    if (changed) await writeChecklist(deps, a, state);
  }
  // Workspace tours: published, audience matched, not seen yet.
  const published = await deps.db.select().from(tours).where(and(eq(tours.orgId, a.orgId), eq(tours.status, "published"))).all();
  let joinedAt = 0;
  if (published.some((t) => t.newDays != null)) {
    const m = await deps.db.select({ at: members.createdAt }).from(members).where(and(eq(members.organizationId, a.orgId), eq(members.userId, a.userId))).get();
    joinedAt = m?.at ? new Date(m.at as unknown as number | Date).getTime() : 0;
  }
  const list: TourDef[] = published.map(rowToTour)
    .filter((t) => t.steps.length && !byKey.has(t.id) && audienceMatches(t, { role: a.role, joinedAt }))
    .map(({ id, name, page, steps }) => ({ id, name, page, steps }));
  return {
    enabled: true, canBuild: isManagerRole(a.role), checklist: checklistView(defs, state), tours: list,
    seen: rows.filter((r) => r.key.startsWith("builtin:")).map((r) => r.key),
  };
}

export async function updateChecklist(deps: Deps, a: Actor, body: { action: "mark" | "dismiss" | "resume" | "celebrated"; step?: string }): Promise<ToursMe> {
  await assertOn(deps, a.orgId);
  const rows = await readProgress(deps, a);
  const state = parseChecklist(parse(rows.find((r) => r.key === CHECKLIST)?.data));
  if (body.action === "mark") {
    const step = body.step ?? "";
    // Only steps the app itself observes can be marked; data steps are checked against real rows.
    if (!isMarkable(step)) throw badRequest("That step completes itself.");
    if (!checklistFor(a.role).some((d) => d.id === step) && step !== "tour") throw badRequest("That step is not on your list.");
    if (!state.done.includes(step)) state.done.push(step);
  } else if (body.action === "dismiss") state.dismissed = true;
  else if (body.action === "resume") state.dismissed = false;
  else if (body.action === "celebrated") state.celebrated = true;
  await writeChecklist(deps, a, state);
  return toursMe(deps, a);
}

/** A tour finished or closed. Built in tours count toward the checklist's tour step. */
export async function recordProgress(deps: Deps, a: Actor, p: { key: string; state: "done" | "skipped"; step: number }): Promise<{ ok: true }> {
  await assertOn(deps, a.orgId);
  if (p.key === CHECKLIST) throw badRequest("Use the checklist route.");
  if (p.key.startsWith("builtin:")) { if (!BUILTIN_TOURS.some((t) => t.id === p.key)) throw notFound("Tour"); }
  else {
    const t = await deps.db.select({ id: tours.id }).from(tours).where(and(eq(tours.orgId, a.orgId), eq(tours.id, p.key))).get();
    if (!t) throw notFound("Tour");
  }
  const now = Date.now();
  await deps.db.insert(tourProgress).values({ orgId: a.orgId, userId: a.userId, key: p.key, state: p.state, step: p.step, updatedAt: now })
    .onConflictDoUpdate({ target: [tourProgress.orgId, tourProgress.userId, tourProgress.key], set: { state: p.state, step: p.step, updatedAt: now } });
  if (p.key === "builtin:getting_around") {
    const rows = await readProgress(deps, a);
    const state = parseChecklist(parse(rows.find((r) => r.key === CHECKLIST)?.data));
    if (!state.done.includes("tour")) { state.done.push("tour"); await writeChecklist(deps, a, state); }
  }
  return { ok: true };
}

/* ---------------------------------------------------------------- builder (owners and admins) */

export async function listTours(deps: Deps, a: Actor): Promise<{ tours: AdminTour[]; people: { userId: string; name: string }[] }> {
  await assertOn(deps, a.orgId); assertManager(a);
  const rows = await deps.db.select().from(tours).where(eq(tours.orgId, a.orgId)).orderBy(sql`${tours.updatedAt} desc`).limit(200).all();
  const people = await deps.db.all<{ userId: string; name: string }>(sql`select m.user_id as userId, coalesce(nullif(u.name, ''), u.email) as name from members m join users u on u.id = m.user_id where m.organization_id = ${a.orgId} and m.kind = 'human' and m.disabled_at is null order by name limit 500`);
  return { tours: rows.map(rowToTour), people };
}
async function own(deps: Deps, a: Actor, id: string) {
  const r = await deps.db.select().from(tours).where(and(eq(tours.orgId, a.orgId), eq(tours.id, id))).get();
  if (!r) throw notFound("Tour");
  return r;
}
export async function getTour(deps: Deps, a: Actor, id: string): Promise<AdminTour> {
  await assertOn(deps, a.orgId); assertManager(a);
  return rowToTour(await own(deps, a, id));
}
export async function createTour(deps: Deps, a: Actor, input: TourInput): Promise<AdminTour> {
  await assertOn(deps, a.orgId); assertManager(a);
  const n = await deps.db.select({ n: sql<number>`count(*)` }).from(tours).where(eq(tours.orgId, a.orgId)).get();
  if ((n?.n ?? 0) >= 100) throw badRequest("A workspace can have up to 100 tours.");
  const now = Date.now();
  const id = newId("tour");
  await deps.db.insert(tours).values({ id, orgId: a.orgId, name: input.name, page: input.page, audience: input.audience, newDays: input.newDays, status: "draft", steps: JSON.stringify(input.steps), createdById: a.userId, createdAt: now, updatedAt: now });
  return getTour(deps, a, id);
}
export async function updateTour(deps: Deps, a: Actor, id: string, patch: TourPatch): Promise<AdminTour> {
  await assertOn(deps, a.orgId); assertManager(a);
  const cur = rowToTour(await own(deps, a, id));
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as AdminTour;
  if (next.status === "published" && !next.steps.length) throw badRequest("Add at least one step before publishing.");
  await deps.db.update(tours).set({ name: next.name, page: next.page, audience: next.audience, newDays: next.newDays, status: next.status, steps: JSON.stringify(next.steps), updatedAt: Date.now() })
    .where(and(eq(tours.orgId, a.orgId), eq(tours.id, id)));
  return getTour(deps, a, id);
}
export async function deleteTour(deps: Deps, a: Actor, id: string): Promise<{ ok: true }> {
  await assertOn(deps, a.orgId); assertManager(a);
  await own(deps, a, id);
  await deps.db.delete(tourProgress).where(and(eq(tourProgress.orgId, a.orgId), eq(tourProgress.key, id)));
  await deps.db.delete(tours).where(and(eq(tours.orgId, a.orgId), eq(tours.id, id)));
  return { ok: true };
}
/** Show tours again for one person: forget their progress for one tour, or for every tour (the checklist stays). */
export async function resetProgress(deps: Deps, a: Actor, userId: string, tourId?: string | null): Promise<{ ok: true; cleared: number }> {
  await assertOn(deps, a.orgId); assertManager(a);
  const m = await deps.db.select({ id: members.id }).from(members).where(and(eq(members.organizationId, a.orgId), eq(members.userId, userId))).get();
  if (!m) throw notFound("Person");
  const keys = tourId ? [tourId] : null;
  if (tourId && !tourId.startsWith("builtin:")) await own(deps, a, tourId);
  const where = and(eq(tourProgress.orgId, a.orgId), eq(tourProgress.userId, userId), keys ? inArray(tourProgress.key, keys) : ne(tourProgress.key, CHECKLIST));
  const before = await deps.db.select({ n: sql<number>`count(*)` }).from(tourProgress).where(where).get();
  await deps.db.delete(tourProgress).where(where);
  return { ok: true, cleared: before?.n ?? 0 };
}
