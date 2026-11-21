/**
 * OPS1: /api/console/announcements, the one in-app announcement.
 * GET    /api/console/announcements   { announcement, status, updatedByEmail } (announcements.read)
 *        status: "live" | "scheduled" | "ended" | null (none stored)
 * PUT    /api/console/announcements   { text, tone, audience, linkLabel, linkUrl, startsAt, endsAt, dismissible, reason }
 *        publishes, replacing any current one; audited as announcement.published (announcements.manage)
 * DELETE /api/console/announcements   { reason } removes it; audited as announcement.cleared; 404 when there is none
 *        (announcements.manage)
 *
 * The data layer is services/console/announcements.ts; validation is announcementInput (shared/announcement.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv, Deps } from "../../context";
import { users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { parseBody } from "../../middleware";
import { operatorSession, requireOperator } from "../../auth/operator";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import { clearAnnouncement, getAnnouncement, publishAnnouncement, type AnnouncementChange } from "../../services/console/announcements";
import { isAnnouncementActive, type Announcement } from "@/shared/announcement";

export type AnnouncementStatus = "live" | "scheduled" | "ended";

function statusOf(a: Announcement | null, now: Date): AnnouncementStatus | null {
  if (!a) return null;
  if (isAnnouncementActive(a, now)) return "live";
  return a.startsAt && Date.parse(a.startsAt) > now.getTime() ? "scheduled" : "ended";
}

async function emailOf(deps: Pick<Deps, "db">, userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const row = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get();
  return row?.email ?? null;
}

async function current(deps: Pick<Deps, "db" | "now">, a: Announcement | null) {
  return { announcement: a, status: statusOf(a, deps.now()), updatedByEmail: await emailOf(deps, a?.updatedBy) };
}

const reasonOnly = z.object({ reason: reasonSchema });

export function announcementsRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/", requireOperator("announcements.read"), async (c) => {
      c.header("cache-control", "no-store");
      return c.json(await current(c.var.deps, await getAnnouncement(c.var.deps)));
    })
    .put("/", requireOperator("announcements.manage"), async (c) => {
      // The reason is checked here; the rest of the body is validated (strictly) by the service.
      const raw = await parseBody(c, z.object({ reason: reasonSchema }).loose());
      const { reason, ...input } = raw as { reason: string } & Record<string, unknown>;
      const auth = c.var.auth;
      const r = await operatorAction(c, {
        action: "announcement.published", targetType: "announcement", targetId: (x: AnnouncementChange) => x.after?.id, reason,
        before: (x: AnnouncementChange) => x.before, after: (x: AnnouncementChange) => x.after,
      }, () => publishAnnouncement(c.var.deps, input, { userId: auth.userId, email: auth.email }));
      return c.json({ ok: true, ...(await current(c.var.deps, r.after)) });
    })
    .delete("/", requireOperator("announcements.manage"), async (c) => {
      const { reason } = await parseBody(c, reasonOnly);
      const auth = c.var.auth;
      await operatorAction(c, {
        action: "announcement.cleared", targetType: "announcement", targetId: (x: AnnouncementChange) => x.before?.id, reason,
        before: (x: AnnouncementChange) => x.before, after: null,
      }, async () => {
        // Nothing to remove: refuse before writing, so no audit row says something was removed.
        if (!(await getAnnouncement(c.var.deps))) throw new HttpError(404, "not_found", "There is no announcement to remove.");
        return clearAnnouncement(c.var.deps, { userId: auth.userId, email: auth.email });
      });
      return c.json({ ok: true, announcement: null, status: null, updatedByEmail: null });
    });
}
