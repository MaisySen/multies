/**
 * R24.2 Workload in the web app (cookie session): GET /api/workload. A read only view; moving a
 * task from it is the normal task update. The same service backs GET /api/v1/workload and the
 * get_workload MCP tool.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { getWorkload, MAX_WEEKS, type WorkloadQuery } from "../services/suite/workload";
import { capacityList, MAX_CAPACITY, setCapacity } from "../services/suite/workload-capacity";

const id = z.string().min(1).max(64);
export const WorkloadParams = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Use a date like 2026-11-02.").max(40).optional(),
  weeks: z.coerce.number().int().min(1).max(MAX_WEEKS).optional(),
  projectId: z.array(id).max(50).optional(),
  sprintId: id.optional(),
  person: z.array(z.string().regex(/^(member|agent):[A-Za-z0-9_-]+$|^none$/)).max(50).optional(),
  unit: z.enum(["points", "hours"]).optional(),
  capacity: z.coerce.number().positive().max(10_000).optional(),
  tz: z.string().max(64).optional(),
});

/** Reads the query (projectId and person repeat, or come comma separated) into the service's shape. */
export function workloadQuery(raw: Record<string, string | string[] | undefined>): WorkloadQuery {
  const many = (...keys: string[]) => {
    const vals = keys.flatMap((k) => { const v = raw[k]; return v === undefined ? [] : Array.isArray(v) ? v : [v]; });
    const out = vals.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
    return out.length ? out : undefined;
  };
  const one = (k: string) => { const v = raw[k]; return Array.isArray(v) ? v[0] : v; };
  const r = WorkloadParams.safeParse({
    from: one("from"), weeks: one("weeks"), projectId: many("projectId", "projectId[]", "projectIds"), sprintId: one("sprintId"),
    person: many("person", "person[]", "people"), unit: one("unit"), capacity: one("capacity"), tz: one("tz") ?? one("timeZone"),
  });
  if (!r.success) throw new HttpError(422, "validation_failed", r.error.issues[0]?.message ?? "Check the query.", r.error.issues);
  const q = r.data;
  return { from: q.from, weeks: q.weeks, projectIds: q.projectId, sprintId: q.sprintId, people: q.person, unit: q.unit, capacity: q.capacity, tz: q.tz };
}

const capNum = z.number().positive().max(MAX_CAPACITY).nullable().optional();
export const CapacityBody = z.object({
  person: z.string().regex(/^(member|agent):[A-Za-z0-9_-]+$/, "Say who: member:<id> or agent:<id>."),
  points: capNum, hours: capNum,
}).refine((b) => b.points !== undefined || b.hours !== undefined, "Give points, hours or both (null clears one).");

export function parseCapacity(body: unknown) {
  const r = CapacityBody.safeParse(body);
  if (!r.success) throw new HttpError(422, "validation_failed", r.error.issues[0]?.message ?? "Check the capacity.", r.error.issues);
  return r.data;
}

export function workloadRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await getWorkload(c.var.deps, c.var.auth, workloadQuery(c.req.queries() as Record<string, string[]>))))
    // Stored weekly capacity per person: owners and admins set anyone's, a member their own.
    .get("/capacity", async (c) => c.json(await capacityList(c.var.deps, c.var.auth)))
    .put("/capacity", async (c) => c.json(await setCapacity(c.var.deps, c.var.auth, parseCapacity(await c.req.json().catch(() => ({}))))));
}
