/**
 * OPS1: /api/console/jobs, Jobs and maintenance (the durable job queue and data moves across workspaces).
 *
 * GET  /stats                counts by status and by status and type, and how long the oldest due job has waited (jobs.read)
 * GET  /                     { items, nextCursor }: jobs by status (default dead), type, workspace; sort updatedAt,
 *                            createdAt, runAt or attempts (jobs.read). Payloads are shown as structure only.
 * GET  /data-moves           { items, nextCursor }: imports and exports by kind, status, workspace, days (jobs.read)
 * POST /replay               { ids, reason } replays the selected dead jobs, at most 500 (jobs.manage)
 * POST /replay-all           { reason } replays every dead job (jobs.manage)
 * POST /:id/replay           { reason } replays one dead job (jobs.manage)
 * POST /:id/mark-dead        { reason } stops a waiting job, or a running one whose lease ran out (jobs.manage)
 *
 * Every change takes a reason and writes a platform audit row (and the workspace's own row for a one-job change).
 * The data layer is services/console/jobs.ts; its { limit, cursor: { v, id }, sort } paging is mapped here to the
 * console's ?limit&cursor&sort=field:dir and { items, nextCursor }.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context";
import { parseBody, parseQuery } from "../../middleware";
import { HttpError, notFound } from "../../lib/errors";
import { operatorSession, requireOperator } from "../../auth/operator";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import { decodeCursor, encodeCursor } from "../../services/console/listing";
import {
  DATA_MOVE_STATUSES, JOB_STATUSES, REPLAY_MAX, jobStatsByStatusAndType, jobTarget, listDataMoves, listJobsFiltered, markJobDead,
  replayAllDead, replayJob, replayJobsByIds, type ConsolePage, type ConsolePageResult, type SortDir,
} from "../../services/console/jobs";

/** The service's page from ?limit, ?cursor and ?sort=field:dir. A sort the list does not allow is the service's 422. */
function pageOf<F extends string>(c: Context<AppEnv>, defaultSort: `${F}:${SortDir}`): ConsolePage<F> {
  const q = c.req.query();
  const [field, dir] = (q.sort || defaultSort).split(":");
  let cursor: ConsolePage<F>["cursor"] = null;
  if (q.cursor) {
    const d = decodeCursor(q.cursor);
    cursor = { v: d.sort instanceof Date ? d.sort.getTime() : d.sort, id: d.id };
  }
  const limit = q.limit ? Number.parseInt(q.limit, 10) : Number.NaN;
  return { limit, cursor, sort: { field: field ?? "", dir: (dir || "desc") as SortDir } };
}

const pageOut = <T>(r: ConsolePageResult<T>) => ({ items: r.items, nextCursor: r.next ? encodeCursor(r.next.v, r.next.id) : null });

const id = z.string().trim().min(1).max(64);

const JobsQuery = z.object({
  status: z.enum(JOB_STATUSES, { message: "Pick a status: pending, running, done or dead." }).optional(),
  type: z.string().trim().max(100).optional(),
  workspace: z.string().trim().max(100).optional(),
}).passthrough();

const MovesQuery = z.object({
  status: z.enum(DATA_MOVE_STATUSES, { message: "That is not a data move status." }).optional(),
  kind: z.enum(["import", "export"], { message: "Kind is import or export." }).optional(),
  workspace: z.string().trim().max(100).optional(),
  days: z.coerce.number().int().min(1).max(90).optional(),
}).passthrough();

/** The job an action is about, or 404. */
async function targetOf(c: Context<AppEnv>) {
  const jobId = c.req.param("id") ?? "";
  const job = await jobTarget(c.var.deps, jobId);
  if (!job) throw notFound("Job");
  return job;
}

export function jobsRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/stats", requireOperator("jobs.read"), async (c) => {
      c.header("cache-control", "no-store");
      return c.json(await jobStatsByStatusAndType(c.var.deps));
    })
    .get("/data-moves", requireOperator("jobs.read"), async (c) => {
      const f = parseQuery(c, MovesQuery);
      c.header("cache-control", "no-store");
      const r = await listDataMoves(c.var.deps, { status: f.status, kind: f.kind, orgId: f.workspace || undefined, days: f.days }, pageOf(c, "createdAt:desc"));
      return c.json(pageOut(r));
    })
    .get("/", requireOperator("jobs.read"), async (c) => {
      const f = parseQuery(c, JobsQuery);
      c.header("cache-control", "no-store");
      const r = await listJobsFiltered(c.var.deps, { status: f.status ?? "dead", type: f.type || undefined, orgId: f.workspace || undefined }, pageOf(c, "updatedAt:desc"));
      return c.json(pageOut(r));
    })
    .post("/replay", requireOperator("jobs.manage"), async (c) => {
      const body = await parseBody(c, z.object({
        ids: z.array(id).min(1, "Pick at least one job.").max(REPLAY_MAX, `Replay at most ${REPLAY_MAX} jobs at a time.`),
        reason: reasonSchema,
      }));
      type R = Awaited<ReturnType<typeof replayJobsByIds>>;
      const r = await operatorAction(c, {
        action: "jobs.replayed", targetType: "job", reason: body.reason,
        metadata: { ids: body.ids.slice(0, 100), count: body.ids.length }, after: (x: R) => x,
      }, () => replayJobsByIds(c.var.deps, body.ids));
      return c.json(r);
    })
    .post("/replay-all", requireOperator("jobs.manage"), async (c) => {
      const body = await parseBody(c, z.object({ reason: reasonSchema }));
      type R = Awaited<ReturnType<typeof replayAllDead>>;
      const r = await operatorAction(c, {
        action: "jobs.replayed_all", targetType: "job", reason: body.reason, after: (x: R) => x,
      }, () => replayAllDead(c.var.deps));
      return c.json(r);
    })
    .post("/:id/replay", requireOperator("jobs.manage"), async (c) => {
      const body = await parseBody(c, z.object({ reason: reasonSchema }));
      const job = await targetOf(c);
      type R = Awaited<ReturnType<typeof replayJob>>;
      const r = await operatorAction(c, {
        action: "jobs.replayed", targetType: "job", targetId: job.id, orgId: job.orgId, reason: body.reason,
        before: { status: job.status, attempts: job.attempts }, after: (x: R) => ({ status: "pending", replayed: x.replayed }),
        metadata: { type: job.type }, workspaceAudit: !!job.orgId,
      }, () => replayJob(c.var.deps, job.id));
      return c.json(r);
    })
    .post("/:id/mark-dead", requireOperator("jobs.manage"), async (c) => {
      const body = await parseBody(c, z.object({ reason: reasonSchema }));
      const job = await targetOf(c);
      if (job.status === "dead") throw new HttpError(409, "job_dead", "This job has already failed for good.");
      type R = Awaited<ReturnType<typeof markJobDead>>;
      const r = await operatorAction(c, {
        action: "jobs.marked_dead", targetType: "job", targetId: job.id, orgId: job.orgId, reason: body.reason,
        before: { status: job.status }, after: (x: R) => ({ status: x.status }),
        metadata: { type: job.type }, workspaceAudit: !!job.orgId,
      }, () => markJobDead(c.var.deps, job.id));
      return c.json(r);
    });
}
