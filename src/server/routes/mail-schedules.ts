import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { sendMessageSchema } from "@/shared/schemas";
import { HttpError } from "../lib/errors";
import { getOrg } from "../services/plans";
import {
  cancelSchedule, clearReturned, listSchedules, remindIfNoReply, rescheduleItem, runMailSchedules, scheduleSend, snoozeThread,
} from "../services/mail/schedules";

/** Round 20 (R20.3): snooze, send later and "remind me if no reply" for the web app. */
const when = {
  preset: z.enum(["later_today", "tomorrow", "next_week"]).optional(),
  /** An exact instant (ISO 8601). */
  at: z.string().max(40).optional(),
  /** A wall clock time in the person's own zone, "2026-11-01T09:00". */
  local: z.string().max(20).optional(),
};

export function mailScheduleRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const q = parseQuery(c, z.object({
        view: z.enum(["snoozed", "scheduled", "returned"]),
        mailboxId: z.string().max(64).optional().transform((v) => v || undefined),
      }));
      return c.json({ items: await listSchedules(c.var.deps, c.var.auth, q) });
    })
    .post("/snooze", async (c) => {
      const b = await parseBody(c, z.object({ messageId: z.string().min(1).max(64), ...when }));
      return c.json(await snoozeThread(c.var.deps, c.var.auth, { messageId: b.messageId }, b), 201);
    })
    .post("/send", async (c) => {
      const b = await parseBody(c, z.object({ message: sendMessageSchema, remindDays: z.number().int().min(1).max(60).optional(), ...when }));
      return c.json(await scheduleSend(c.var.deps, c.var.auth, b.message, b, { remindDays: b.remindDays }), 201);
    })
    .post("/remind", async (c) => {
      const b = await parseBody(c, z.object({ messageId: z.string().min(1).max(64), days: z.number().int().min(1).max(60) }));
      return c.json(await remindIfNoReply(c.var.deps, c.var.auth, b.messageId, b.days), 201);
    })
    .post("/opened", async (c) => {
      const b = await parseBody(c, z.object({ messageId: z.string().min(1).max(64) }));
      return c.json(await clearReturned(c.var.deps, c.var.auth, b.messageId));
    })
    .patch("/:id", async (c) => {
      const b = await parseBody(c, z.object(when));
      return c.json(await rescheduleItem(c.var.deps, c.var.auth, c.req.param("id"), b));
    })
    .delete("/:id", async (c) => c.json(await cancelSchedule(c.var.deps, c.var.auth, c.req.param("id"))))
    // Test clock: runs the pass for the caller's own demo workspace at a chosen time, so an end to end
    // test can watch a snooze come back. Only with DEMO_MODE on and only inside a demo workspace.
    .post("/test-clock", async (c) => {
      const { deps, auth } = c.var;
      const org = await getOrg(deps.db, auth.orgId);
      if (!deps.config.demoEnabled || !org.isDemo) throw new HttpError(404, "not_found", "Not found.");
      const b = await parseBody(c, z.object({ now: z.string().max(40) }));
      const now = new Date(b.now);
      if (Number.isNaN(now.getTime())) throw new HttpError(422, "bad_time", "That time isn't valid.");
      return c.json(await runMailSchedules(deps, { now, orgId: auth.orgId }));
    });
}
