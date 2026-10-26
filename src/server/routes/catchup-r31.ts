/**
 * R31: catch-up in the app (cookie session). GET /api/catchup?type=channel|task|doc&id=...&visit=1 answers the digest
 * since the last visit (and records this visit, at most once a minute); POST /api/catchup/visit marks the item caught
 * up now; POST /api/catchup/summary writes a summary on the workspace's own AI key.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import type { SuiteActor } from "../services/suite/common";
import { CATCHUP_TYPES, getCatchup, recordVisit, summariseSince } from "../services/suite/catchup";

export const CatchupQuery = z.object({ type: z.enum(CATCHUP_TYPES), id: z.string().min(1).max(80), visit: z.string().optional() });
export const CatchupVisitBody = z.object({ type: z.enum(CATCHUP_TYPES), id: z.string().min(1).max(80), force: z.boolean().optional() });
export const CatchupItemBody = z.object({ type: z.enum(CATCHUP_TYPES), id: z.string().min(1).max(80) });

export function catchupRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const q = parseQuery(c, CatchupQuery);
      return c.json({ catchup: await getCatchup(c.var.deps, c.var.auth as unknown as SuiteActor, q.type, q.id, { visit: q.visit === "1" || q.visit === "true" }) });
    })
    .post("/visit", async (c) => {
      const b = await parseBody(c, CatchupVisitBody);
      return c.json(await recordVisit(c.var.deps, c.var.auth as unknown as SuiteActor, b.type, b.id, { force: b.force ?? true }));
    })
    .post("/summary", async (c) => {
      const b = await parseBody(c, CatchupItemBody);
      return c.json(await summariseSince(c.var.deps, c.var.auth as unknown as SuiteActor, b.type, b.id));
    });
}
