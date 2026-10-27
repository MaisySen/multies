/**
 * Round 21 (R21.1): sprints per project for the web app (cookie session). The same services back
 * the public API (v1-sprints.ts) and MCP (mcp-r21-sprints.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { PageQuery, splitIds } from "./page-query-r46";
import {
  addToSprint, backlog, backlogPage, completeSprint, createSprint, deleteSprint, getSprint, listSprints, MAX_SPRINT_TASKS, removeFromSprint, setEstimateUnit, startSprint, updateSprint,
} from "../services/suite/sprints";
import { HttpError } from "../lib/errors";

const dateish = z.string().max(40);
// startDate and endDate are accepted as other names for startAt and endAt (MB-54).
const dateAliases = { startDate: dateish.optional(), endDate: dateish.optional() };
export const SprintCreate = z.object({ projectId: z.string().min(1).max(64), name: z.string().max(80).optional(), goal: z.string().max(2000).optional(), startAt: dateish.optional(), endAt: dateish.optional(), ...dateAliases });
export const SprintPatch = z.object({ name: z.string().max(80).optional(), goal: z.string().max(2000).optional(), startAt: dateish.optional(), endAt: dateish.optional(), ...dateAliases, version: z.number().int().optional() });
export const SprintComplete = z.object({ carryOver: z.enum(["next", "backlog"]).optional(), carry_over: z.enum(["next", "backlog"]).optional(), timeZone: z.string().max(64).optional() });
export const SprintTasks = z.object({ taskIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_SPRINT_TASKS) });
export const EstimateUnit = z.object({ projectId: z.string().min(1).max(64), unit: z.enum(["points", "hours"]) });

const projectParam = (v: string | undefined) => {
  if (!v) throw new HttpError(422, "validation_failed", "Pass projectId.");
  return v;
};

export function sprintRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await listSprints(c.var.deps, c.var.auth, projectParam(c.req.query("projectId")))))
    .get("/backlog", async (c) => {
      const projectId = projectParam(c.req.query("projectId"));
      // R46 (MB-234): paged=1 then cursor reads the whole backlog page by page; ids=a,b refreshes the tasks the change feed names.
      const q = parseQuery(c, z.object({ projectId: z.string(), ...PageQuery }));
      if (q.paged || q.ids !== undefined) return c.json(await backlogPage(c.var.deps, c.var.auth, projectId, { cursor: q.cursor, ids: splitIds(q.ids) }));
      return c.json({ tasks: await backlog(c.var.deps, c.var.auth, projectId) });
    })
    .post("/", async (c) => {
      const b = await parseBody(c, SprintCreate);
      return c.json({ sprint: await createSprint(c.var.deps, c.var.auth, b.projectId, b) }, 201);
    })
    .put("/estimate-unit", async (c) => {
      const b = await parseBody(c, EstimateUnit);
      return c.json(await setEstimateUnit(c.var.deps, c.var.auth, b.projectId, b.unit));
    })
    .get("/:id", async (c) => c.json(await getSprint(c.var.deps, c.var.auth, c.req.param("id"), { timeZone: c.req.query("timeZone") })))
    .patch("/:id", async (c) => c.json({ sprint: await updateSprint(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, SprintPatch)) }))
    .delete("/:id", async (c) => c.json(await deleteSprint(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/start", async (c) => c.json({ sprint: await startSprint(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/:id/complete", async (c) => {
      const b = await parseBody(c, SprintComplete);
      return c.json(await completeSprint(c.var.deps, c.var.auth, c.req.param("id"), { carryOver: b.carryOver ?? b.carry_over, timeZone: b.timeZone }));
    })
    .post("/:id/tasks", async (c) => c.json(await addToSprint(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, SprintTasks)).taskIds)))
    .post("/:id/tasks/remove", async (c) => c.json(await removeFromSprint(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, SprintTasks)).taskIds)));
}
