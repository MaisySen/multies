/**
 * Round 7 of the suite in the app (cookie session): time tracking, forms, reports and
 * meetings, plus the public pages' endpoints (a form anyone can fill in, a meeting guest
 * link). The same services back the REST API (v1-suite.ts) and the MCP tools.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAdmin, requireAuth } from "../middleware";
import { addEntry, deleteEntry, listEntries, runningTimer, startTimer, stopTimer, timesheet, updateEntry } from "../services/suite/time";
import { createForm, deleteForm, getForm, listForms, publicForm, submitForm, updateForm } from "../services/suite/forms";
import { dashboard } from "../services/suite/reports";
import { createMeeting, getMeeting, guestInfo, guestJoin, joinMeeting, listMeetings, meetingIcs, meetingsEnabled, sendInvites, updateMeeting } from "../services/suite/meetings";
import { organizations } from "../db/schema";
import { eq } from "drizzle-orm";

export const TimeStart = z.object({ taskId: z.string().min(1), note: z.string().max(500).optional() });
export const TimeStop = z.object({ entryId: z.string().optional() });
export const TimeEntryCreate = z.object({
  taskId: z.string().nullable().optional(), projectId: z.string().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), startedAt: z.string().optional(),
  minutes: z.number().positive().max(1440), note: z.string().max(500).optional(), billable: z.boolean().optional(),
  person: z.string().regex(/^(member|agent):[A-Za-z0-9_-]+$/).optional(),
});
export const TimeEntryPatch = z.object({ minutes: z.number().positive().max(1440).optional(), note: z.string().max(500).optional(), billable: z.boolean().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export const TimeQuery = z.object({ from: z.string().optional(), to: z.string().optional(), person: z.string().optional(), projectId: z.string().optional(), taskId: z.string().optional() });

const Field = z.object({ id: z.string().max(40).optional(), label: z.string().min(1).max(120), type: z.enum(["text", "email", "textarea", "phone", "select", "number", "date"]), required: z.boolean().optional(), options: z.array(z.string().max(120)).max(50).optional(), placeholder: z.string().max(120).optional() });
export const FormCreate = z.object({
  name: z.string().trim().min(1).max(120), description: z.string().max(2000).optional(), target: z.enum(["task", "contact"]).optional(),
  projectId: z.string().nullable().optional(), assigneeId: z.string().nullable().optional(), fields: z.array(Field).min(1).max(30).optional(),
  successMessage: z.string().max(500).optional(), enabled: z.boolean().optional(),
  triage: z.boolean().optional(),
});
export const FormPatch = FormCreate.partial();

const Source = z.object({ type: z.enum(["thread", "task", "contact"]), id: z.string().min(1) });
/** A weekly series: { interval: 1 | 2, days: ["mo", "we"], until: "YYYY-MM-DD" | count, timezone }, or an RRULE string. Null makes it a one off. */
export const MeetingRecurrence = z.union([
  z.string().max(200),
  z.object({
    interval: z.number().int().min(1).max(2).optional(),
    days: z.array(z.enum(["mo", "tu", "we", "th", "fr", "sa", "su"])).max(7).optional(),
    until: z.string().max(10).nullable().optional(),
    count: z.number().int().min(1).max(520).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
  }),
]).nullable();
export const MeetingCreate = z.object({
  recurrence: MeetingRecurrence.optional(),
  title: z.string().max(200).optional(), startsAt: z.string().optional(), durationMin: z.number().int().min(5).max(480).optional(),
  source: Source.optional(), invitees: z.array(z.string().max(254)).max(50).optional(), sendInvites: z.boolean().optional(), mailboxId: z.string().optional(),
});
export const MeetingPatch = z.object({ recurrence: MeetingRecurrence.optional(), title: z.string().max(200).optional(), startsAt: z.string().optional(), durationMin: z.number().int().min(5).max(480).optional(), status: z.enum(["scheduled", "ended", "cancelled"]).optional(), invitees: z.array(z.string().max(254)).max(50).optional() });
export const ReportQuery = z.object({ projectId: z.string().optional(), days: z.coerce.number().int().min(1).max(366).optional() });

async function orgTimeZone(c: { var: AppEnv["Variables"] }) {
  const o = await c.var.deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, c.var.auth.orgId)).get();
  return o?.tz ?? "UTC";
}

export function timeRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ entries: await listEntries(c.var.deps, c.var.auth, parseQuery(c, TimeQuery)) }))
    .get("/running", async (c) => c.json({ entry: await runningTimer(c.var.deps, c.var.auth) }))
    .get("/timesheet", async (c) => c.json(await timesheet(c.var.deps, c.var.auth, { ...parseQuery(c, TimeQuery), timeZone: await orgTimeZone(c) })))
    .post("/start", async (c) => c.json({ entry: await startTimer(c.var.deps, c.var.auth, await parseBody(c, TimeStart)) }, 201))
    .post("/stop", async (c) => c.json({ entry: await stopTimer(c.var.deps, c.var.auth, await parseBody(c, TimeStop)) }))
    .post("/", async (c) => c.json({ entry: await addEntry(c.var.deps, c.var.auth, await parseBody(c, TimeEntryCreate)) }, 201))
    .patch("/:id", async (c) => c.json({ entry: await updateEntry(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, TimeEntryPatch)) }))
    .delete("/:id", async (c) => c.json(await deleteEntry(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function formRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ forms: await listForms(c.var.deps, c.var.auth.orgId), turnstile: !!c.var.deps.config.turnstile }))
    .post("/", requireAdmin, async (c) => c.json({ form: await createForm(c.var.deps, c.var.auth, await parseBody(c, FormCreate)) }, 201))
    .get("/:id", async (c) => c.json(await getForm(c.var.deps, c.var.auth.orgId, c.req.param("id"))))
    .patch("/:id", requireAdmin, async (c) => c.json({ form: await updateForm(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, FormPatch)) }))
    .delete("/:id", requireAdmin, async (c) => c.json(await deleteForm(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function reportRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/dashboard", async (c) => c.json(await dashboard(c.var.deps, c.var.auth, parseQuery(c, ReportQuery))));
}

export function meetingRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const q = parseQuery(c, z.object({ upcoming: z.string().optional(), sourceType: z.enum(["thread", "task", "contact"]).optional(), sourceId: z.string().optional() }));
      return c.json({ meetings: await listMeetings(c.var.deps, c.var.auth, { upcoming: q.upcoming === "1" || q.upcoming === "true", sourceType: q.sourceType, sourceId: q.sourceId }), videoEnabled: meetingsEnabled(c.var.deps) });
    })
    .post("/", async (c) => c.json(await createMeeting(c.var.deps, c.var.auth, await parseBody(c, MeetingCreate)), 201))
    .get("/:id", async (c) => c.json({ meeting: await getMeeting(c.var.deps, c.var.auth, c.req.param("id")) }))
    .patch("/:id", async (c) => c.json({ meeting: await updateMeeting(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, MeetingPatch)) }))
    .get("/:id/ics", async (c) => new Response(await meetingIcs(c.var.deps, c.var.auth, c.req.param("id")), {
      headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": "attachment; filename=\"meeting.ics\"", "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    }))
    .post("/:id/invite", async (c) => c.json(await sendInvites(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, z.object({ mailboxId: z.string().optional() })))))
    .post("/:id/join", async (c) => c.json(await joinMeeting(c.var.deps, c.var.auth, c.req.param("id"))));
}

/** No sign-in: the public form page and the meeting guest page. */
export function publicRoutes() {
  return new Hono<AppEnv>()
    .get("/forms/:slug", async (c) => c.json({ form: await publicForm(c.var.deps, c.req.param("slug")) }))
    .post("/forms/:slug", async (c) => {
      const raw = (await c.req.json().catch(() => ({}))) as { answers?: Record<string, unknown>; turnstileToken?: string; website?: string; elapsedMs?: number };
      return c.json(await submitForm(c.var.deps, c.req.param("slug"), raw.answers ?? {}, { ip: c.var.ip, turnstileToken: raw.turnstileToken, honeypot: raw.website, elapsedMs: typeof raw.elapsedMs === "number" ? raw.elapsedMs : undefined }));
    })
    .get("/meetings/:token", async (c) => c.json({ meeting: await guestInfo(c.var.deps, c.req.param("token")) }))
    .post("/meetings/:token/join", async (c) => {
      const b = await parseBody(c, z.object({ name: z.string().max(60) }));
      return c.json(await guestJoin(c.var.deps, c.req.param("token"), b.name));
    });
}
