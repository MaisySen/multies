/**
 * R95 Tasks plus routes (cookie session; flag TASKS_PLUS_R95): /api/my-day and /api/timesheets.
 * The time CSV is GET /api/time/export.csv (suite-r7.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { notFound } from "../lib/errors";
import { addToDay, getDay, listSheets, planNextDay, removePlanItem, restorePlan, stepSheet, getSheet, tasksPlusOn, updatePlanItem } from "../services/suite/tasks-plus-r95";

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Minute = z.number().int().min(0).max(1440);
const DayQuery = z.object({ day: Ymd, tz: z.string().max(64).optional() });
const DayAdd = z.object({ day: Ymd, taskId: z.string().min(1).max(80), start: Minute.nullable().optional(), minutes: z.number().int().min(1).max(1440).optional() });
const DayPatch = z.object({ day: Ymd.optional(), start: Minute.nullable().optional(), minutes: z.number().int().min(1).max(1440).optional(), position: z.number().finite().optional() });
const DayOnly = z.object({ day: Ymd });
const Restore = z.object({ items: z.array(z.object({ id: z.string().min(1).max(80), taskId: z.string().min(1).max(80), day: Ymd, start: Minute.nullable(), minutes: z.number().int().min(1).max(1440) })).max(100) });
const SheetQuery = z.object({ week: Ymd, person: z.string().max(100).optional() });
const SheetList = z.object({ status: z.enum(["submitted", "approved", "returned"]).optional() });
const SheetStep = z.object({ week: Ymd, person: z.string().max(100).optional(), note: z.string().max(500).optional(), version: z.number().int().optional() });

const gate = async (c: { var: AppEnv["Variables"] }, next: () => Promise<void>) => { if (!tasksPlusOn(c.var.deps, c.var.auth.orgId)) throw notFound("Page"); await next(); };

export function myDayRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", gate)
    .get("/", async (c) => { const q = parseQuery(c, DayQuery); return c.json(await getDay(c.var.deps, c.var.auth, q.day, q.tz)); })
    .post("/", async (c) => c.json({ item: await addToDay(c.var.deps, c.var.auth, await parseBody(c, DayAdd)) }, 201))
    .post("/plan-tomorrow", async (c) => c.json(await planNextDay(c.var.deps, c.var.auth, (await parseBody(c, DayOnly)).day)))
    .post("/restore", async (c) => c.json(await restorePlan(c.var.deps, c.var.auth, (await parseBody(c, Restore)).items)))
    .patch("/:id", async (c) => c.json({ item: await updatePlanItem(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, DayPatch)) }))
    .delete("/:id", async (c) => c.json(await removePlanItem(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function timesheetRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", gate)
    .get("/", async (c) => c.json({ sheets: await listSheets(c.var.deps, c.var.auth, parseQuery(c, SheetList).status ?? "submitted") }))
    .get("/week", async (c) => { const q = parseQuery(c, SheetQuery); return c.json({ sheet: await getSheet(c.var.deps, c.var.auth, q.week, q.person) }); })
    .post("/submit", async (c) => c.json({ sheet: await stepSheet(c.var.deps, c.var.auth, "submit", await parseBody(c, SheetStep)) }))
    .post("/withdraw", async (c) => c.json({ sheet: await stepSheet(c.var.deps, c.var.auth, "withdraw", await parseBody(c, SheetStep)) }))
    .post("/approve", async (c) => c.json({ sheet: await stepSheet(c.var.deps, c.var.auth, "approve", await parseBody(c, SheetStep)) }))
    .post("/return", async (c) => c.json({ sheet: await stepSheet(c.var.deps, c.var.auth, "return", await parseBody(c, SheetStep)) }));
}
