/**
 * TD4: time to invoice API (signed in owners and admins; flags INVOICES_ENABLED and BILL_TD4; 404 when off or in the
 * client portal workspace, 403 for members). Money is integer cents.
 *   GET /api/bill-time/summary            Home card: unbilled hours and value per client
 *   GET /api/bill-time/projects           projects for the run picker
 *   GET /api/bill-time/preview?projectId&from&to&rounding
 *   PUT /api/bill-time/setup              client, currency, rounding and rates for a project
 *   POST /api/bill-time/runs              create a draft invoice and lock its time
 *   GET /api/bill-time/runs, GET /api/bill-time/runs/:id/export.csv
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { createRun, listRuns, preview, projectsWithTime, runCsv, saveSetup, summary } from "../services/invoices/bill-time-td4";
import { CURRENCIES } from "@/shared/invoices";
import { MAX_RATE_CENTS, MAX_RUN_ENTRIES, ROUNDINGS } from "@/shared/bill-time-td4";

const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rate = z.number().int().min(0).max(MAX_RATE_CENTS);
const rounding = z.number().int().refine((n) => (ROUNDINGS as readonly number[]).includes(n), "Pick a rounding from the list.");
const SetupBody = z.object({
  projectId: id, contactId: id.nullable().optional(), currency: z.enum(CURRENCIES).optional(), rateCents: rate.nullable().optional(), rounding: rounding.optional(),
  workspaceRateCents: rate.nullable().optional(),
  personRates: z.array(z.object({ personKey: z.string().max(100), rateCents: rate.nullable(), scope: z.enum(["project", "all"]) })).max(100).optional(),
}).strict();
const RunBody = z.object({ projectId: id, from: date, to: date, rounding, entryIds: z.array(id).min(1).max(MAX_RUN_ENTRIES), contactId: id.nullable().optional() }).strict();

const runs = new RateLimiter(20, 60_000); // billing runs per person per minute

export function billTimeRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { await next(); c.header("cache-control", "private, no-store"); })
    .get("/summary", async (c) => c.json(await summary(c.var.deps, c.var.auth)))
    .get("/projects", async (c) => c.json(await projectsWithTime(c.var.deps, c.var.auth)))
    .get("/preview", async (c) => {
      const q = z.object({ projectId: id, from: date, to: date, rounding: z.coerce.number().int().optional() }).safeParse(c.req.query());
      if (!q.success) throw new HttpError(422, "validation_failed", "Pick a project and a date range.");
      return c.json(await preview(c.var.deps, c.var.auth, q.data));
    })
    .put("/setup", async (c) => c.json(await saveSetup(c.var.deps, c.var.auth, await parseBody(c, SetupBody))))
    .get("/runs", async (c) => c.json(await listRuns(c.var.deps, c.var.auth)))
    .post("/runs", async (c) => {
      if (!runs.take(`${c.var.auth.orgId}:${c.var.auth.userId}`)) throw new HttpError(429, "rate_limited", "Too many billing runs at once. Wait a minute and try again.");
      return c.json(await createRun(c.var.deps, c.var.auth, await parseBody(c, RunBody)), 201);
    })
    .get("/runs/:id/export.csv", async (c) => {
      const r = await runCsv(c.var.deps, c.var.auth, id.parse(c.req.param("id")));
      return c.body(r.csv, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${r.name.replace(/[^A-Za-z0-9._-]/g, "")}"`, "Cache-Control": "no-store" });
    });
}
