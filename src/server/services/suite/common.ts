/**
 * Shared plumbing for the suite (tasks, projects, docs, contacts, automations).
 * One write path: every change saves the row, then an activity entry and a change entry,
 * so the timeline, the sync feed and webhooks all read the same truth.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { activity, changes } from "../../db/schema";
import { randomBytes } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import { emitEvent, type WebhookEvent } from "../developer/webhooks";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A sortable id: a millisecond timestamp in base 36, then 10 random characters. */
export function sortableId(prefix: string, now = Date.now()): string {
  const time = now.toString(36).padStart(9, "0");
  let rand = "";
  for (const b of randomBytes(10)) rand += ALPHABET[b % 36];
  return `${prefix}_${time}${rand}`;
}

/** Whoever is acting: a person in the app, a workspace API key, an agent key or the system (automations). */
export type SuiteActor = Pick<AuthContext, "orgId" | "userId" | "email" | "name"> & { role?: AuthContext["role"]; agentId?: string | null; apiKeyId?: string; scope?: "full" | "read"; system?: boolean };

export function actorOf(a: SuiteActor): { type: "member" | "agent" | "system"; id: string | null; name: string } {
  if (a.system) return { type: "system", id: null, name: a.name || "Automation" };
  if (a.agentId) return { type: "agent", id: a.agentId, name: a.name };
  return { type: "member", id: a.userId || null, name: a.name || a.email };
}

export const createdBy = (a: SuiteActor) => {
  const x = actorOf(a);
  return { createdByType: x.type, createdById: x.id };
};

/** Mailboxes this actor may read: null means all. Agents get their own; the system sees everything. */
export async function scopeOf(deps: Deps, a: SuiteActor): Promise<string[] | null> {
  if (a.system) return null;
  if (a.agentId) {
    const { scopeFor } = await import("../agents");
    return scopeFor(deps, { ...a, role: "admin", sessionId: "", agentId: a.agentId });
  }
  const { mailboxScope } = await import("../team");
  return mailboxScope(deps.db, { userId: a.userId, orgId: a.orgId, role: a.role ?? "member" });
}

export function assertWritable(a: SuiteActor) {
  if (a.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
}

export type EntityType = "task" | "project" | "doc" | "contact" | "company" | "deal" | "automation" | "comment" | "view" | "time_entry" | "form" | "meeting" | "custom_field" | "guest" | "file";

/** Records the activity entry and the change entry for one write. Never throws into the caller's write. */
export async function recordWrite(deps: Deps, a: SuiteActor, w: {
  entityType: EntityType; entityId: string; op: "create" | "update" | "delete"; version?: number;
  verb: string; data?: Record<string, unknown>; event?: WebhookEvent; eventData?: Record<string, unknown>;
}) {
  const actor = actorOf(a);
  try {
    await Promise.all([
      deps.db.insert(activity).values({
        id: sortableId("act", deps.now().getTime()), orgId: a.orgId, actorType: actor.type, actorId: actor.id, actorName: actor.name,
        verb: w.verb, entityType: w.entityType, entityId: w.entityId, data: JSON.stringify(w.data ?? {}), createdAt: deps.now(),
      }),
      deps.db.insert(changes).values({ orgId: a.orgId, entityType: w.entityType, entityId: w.entityId, op: w.op, version: w.version ?? 1, createdAt: deps.now() }),
    ]);
  } catch (err) {
    deps.reportError?.(err, { where: "recordWrite", entity: w.entityType });
  }
  if (w.event) await emitEvent(deps, a.orgId, w.event, { ...(w.eventData ?? {}), actor: { type: actor.type, id: actor.id, name: actor.name } });
}

export async function timeline(deps: Deps, orgId: string, entityType: EntityType, entityId: string, limit = 100) {
  const rows = await deps.db.select().from(activity)
    .where(and(eq(activity.orgId, orgId), eq(activity.entityType, entityType), eq(activity.entityId, entityId)))
    .orderBy(desc(activity.createdAt)).limit(limit);
  return rows.map((r) => ({ id: r.id, actor: { type: r.actorType, id: r.actorId, name: r.actorName }, verb: r.verb, data: JSON.parse(r.data) as Record<string, unknown>, at: r.createdAt.toISOString() }));
}

/** The sync feed: changes after a sequence number, oldest first. */
export async function changesSince(deps: Deps, orgId: string, since: number, limit = 500) {
  const rows = await deps.db.select().from(changes).where(and(eq(changes.orgId, orgId), gt(changes.seq, since))).orderBy(changes.seq).limit(limit);
  return { changes: rows.map((r) => ({ seq: r.seq, entity: r.entityType, id: r.entityId, op: r.op, version: r.version, at: r.createdAt.toISOString() })), cursor: rows.length ? rows[rows.length - 1].seq : since, more: rows.length === limit };
}

export const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
export const parseDate = (s: string | null | undefined): Date | null => {
  if (s === null || s === undefined || s === "") return null;
  // A plain date (2026-10-24) means that day, end of day is not assumed: midnight UTC of the date.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s);
  if (Number.isNaN(d.getTime())) throw new HttpError(422, "validation_failed", `Not a date: ${s}`);
  return d;
};
