/**
 * R24.2 Workload in the public API (v1): GET /workload. A read, so read only keys can call it.
 * It reads tasks the way GET /tasks does: the key's workspace only.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { getWorkload } from "../services/suite/workload";
import { parseCapacity, workloadQuery } from "./workload";
import { capacityList, setCapacity } from "../services/suite/workload-capacity";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;

export function registerWorkloadRoutes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "get", path: "/workload", tags: ["Tasks"], summary: "Workload per person per week", security: [{ bearerAuth: [] }],
    description: "Open tasks and their estimates per person (and an Unassigned row) per week. Query: from (a date; the week that holds it, Monday first), weeks (1 to 12, default 4), projectId (repeat for several), sprintId, person (member:<id>, agent:<id> or none; repeat), unit (points or hours), capacity (per person per week; default 20 points or 40 hours), tz (an IANA zone; default the key's workspace zone). A task sits in the week of its due date, or of its start date when it has no due date; open tasks due before the range are in overdue. Each cell: count, points, hours, noEstimate, load (in unit), over, near, tasks. At most 2,000 tasks are read; truncated: true says the answer was cut.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: { query: z.object({}).passthrough() as any },
    responses: { 200: json("The workload."), 401: err("Missing or invalid API key."), 404: err("A project or sprint that is not in this workspace."), 422: err("Validation failed.") },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (c) => c.json(await getWorkload(c.var.deps, actor(c), workloadQuery(c.req.queries() as Record<string, string[]>)) as any, 200) as any);

  api.openapi(createRoute({
    method: "get", path: "/workload/capacity", tags: ["Tasks"], summary: "Weekly capacity per person", security: [{ bearerAuth: [] }],
    description: "Each person's stored weekly capacity in points and hours (null means the default: 20 points or 40 hours). The workload read uses these unless the request passes capacity.",
    responses: { 200: json("Defaults and one entry per person."), 401: err("Missing or invalid API key.") },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (c) => c.json(await capacityList(c.var.deps, actor(c)) as any, 200) as any);

  api.openapi(createRoute({
    method: "put", path: "/workload/capacity", tags: ["Tasks"], summary: "Set a person's weekly capacity", security: [{ bearerAuth: [] }],
    description: "Body: { person: member:<id> or agent:<id>, points?, hours? }. A number above 0 sets it, null clears it back to the default, a field left out stays as it is. Owners and admins can set anyone's; a member their own. Read only keys are refused.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: { body: { content: { "application/json": { schema: z.object({}).passthrough() as any } } } },
    responses: { 200: json("The stored capacity."), 401: err("Missing or invalid API key."), 403: err("Read only key, or someone else's capacity without admin rights."), 404: err("A person not in this workspace."), 422: err("Validation failed.") },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (c) => c.json(await setCapacity(c.var.deps, actor(c), parseCapacity(await c.req.json().catch(() => ({})))) as any, 200) as any);
}
