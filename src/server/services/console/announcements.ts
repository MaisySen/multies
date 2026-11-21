/**
 * OPS1: the in-app announcement (console section "Announcements"). One announcement at a time, stored as JSON in
 * app_settings under ANNOUNCEMENT_KEY, so there is no migration and a publish or clear is one D1 write.
 *
 * Reads: getAnnouncement is for the console (always reads the row). publicAnnouncement is for /api/config, which
 * every page load hits, so it keeps the row in memory per isolate for ANNOUNCEMENT_CACHE_MS and never writes.
 * A publish or clear in this isolate refreshes that copy at once; other isolates catch up within the TTL.
 *
 * publishAnnouncement and clearAnnouncement return { before, after } for the platform audit row; the route wraps
 * them in operatorAction (services/console/audit.ts) with a reason.
 */
import { eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { appSettings } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { zodToHttp } from "../../lib/errors";
import { announcementInput, ANNOUNCEMENT_AUDIENCES, ANNOUNCEMENT_TONES, isAnnouncementActive, toPublicAnnouncement, type Announcement, type PublicAnnouncement } from "@/shared/announcement";

export const ANNOUNCEMENT_KEY = "announcement";
export const ANNOUNCEMENT_CACHE_MS = 30_000;

/** Who made the change (the signed in operator). */
export interface AnnouncementActor { userId: string; email?: string | null }

export interface AnnouncementChange { before: Announcement | null; after: Announcement | null }

type Db = Deps["db"];
const cache = new WeakMap<Db, { at: number; value: Announcement | null }>();

/** A stored row read back defensively: anything malformed counts as no announcement. */
function parseStored(raw: string | undefined | null): Announcement | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Announcement>;
    if (!v || typeof v.id !== "string" || typeof v.text !== "string") return null;
    if (!ANNOUNCEMENT_TONES.includes(v.tone as never) || !ANNOUNCEMENT_AUDIENCES.includes(v.audience as never)) return null;
    return {
      id: v.id, text: v.text, tone: v.tone!, audience: v.audience!,
      linkLabel: v.linkLabel ?? null, linkUrl: v.linkUrl ?? null,
      startsAt: v.startsAt ?? null, endsAt: v.endsAt ?? null,
      dismissible: v.dismissible !== false,
      updatedBy: typeof v.updatedBy === "string" ? v.updatedBy : "",
      updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
    };
  } catch {
    return null;
  }
}

async function readRow(db: Db): Promise<Announcement | null> {
  const row = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, ANNOUNCEMENT_KEY)).get();
  return parseStored(row?.value);
}

/** The stored announcement (live, scheduled or ended), or null. For the console. */
export async function getAnnouncement(deps: Pick<Deps, "db" | "now">): Promise<Announcement | null> {
  const value = await readRow(deps.db);
  cache.set(deps.db, { at: deps.now().getTime(), value });
  return value;
}

/** Validates and stores a new announcement, replacing any current one. Throws a 422 HttpError on bad input. */
export async function publishAnnouncement(deps: Pick<Deps, "db" | "now">, input: unknown, actor: AnnouncementActor): Promise<AnnouncementChange> {
  const r = announcementInput.safeParse(input);
  if (!r.success) throw zodToHttp(r.error);
  const v = r.data;
  const before = await readRow(deps.db);
  const now = deps.now();
  const after: Announcement = {
    id: newId("ann"),
    text: v.text, tone: v.tone, audience: v.audience,
    linkLabel: v.linkLabel ?? null, linkUrl: v.linkUrl ?? null,
    startsAt: v.startsAt ?? null, endsAt: v.endsAt ?? null,
    dismissible: v.dismissible,
    updatedBy: actor.userId, updatedAt: now.toISOString(),
  };
  const value = JSON.stringify(after);
  await deps.db.insert(appSettings).values({ key: ANNOUNCEMENT_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  cache.set(deps.db, { at: now.getTime(), value: after });
  return { before, after };
}

/** Removes the announcement. A clear with nothing stored writes nothing and returns { before: null, after: null }. */
export async function clearAnnouncement(deps: Pick<Deps, "db" | "now">, _actor: AnnouncementActor): Promise<AnnouncementChange> {
  const before = await readRow(deps.db);
  if (before) await deps.db.delete(appSettings).where(eq(appSettings.key, ANNOUNCEMENT_KEY));
  cache.set(deps.db, { at: deps.now().getTime(), value: null });
  return { before, after: null };
}

/**
 * The announcement for /api/config: only the public fields, and only while its window is open (audience is left
 * to the client, which knows the viewer's role). Cached per isolate; never writes.
 */
export async function publicAnnouncement(deps: Pick<Deps, "db" | "now">, now: Date = deps.now()): Promise<PublicAnnouncement | null> {
  const hit = cache.get(deps.db);
  let value: Announcement | null;
  if (hit && now.getTime() - hit.at >= 0 && now.getTime() - hit.at < ANNOUNCEMENT_CACHE_MS) value = hit.value;
  else {
    value = await readRow(deps.db);
    cache.set(deps.db, { at: now.getTime(), value });
  }
  return value && isAnnouncementActive(value, now) ? toPublicAnnouncement(value) : null;
}

/** Test helper: forget the in-memory copy for this database. */
export function resetAnnouncementCache(deps: Pick<Deps, "db">) {
  cache.delete(deps.db);
}
