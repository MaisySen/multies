import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { areaFromPath, ANALYTICS_CLIENT_EVENTS } from "@/shared/product-analytics";
import { captureEvents, requestOptedOut, runAfterResponse } from "../services/product-analytics";

/** ANALYTICS-PH: the browser reports area and tool opens here (first party; the server hashes ids and drops the rest). */
const Body = z.object({
  events: z.array(z.object({ name: z.enum(ANALYTICS_CLIENT_EVENTS), path: z.string().max(200) })).max(20),
});

export function productAnalyticsRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .post("/events", async (c) => {
      const deps = c.var.deps;
      if (!deps.config.productAnalytics || requestOptedOut((n) => c.req.header(n))) return c.json({ accepted: 0 });
      const parsed = Body.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ accepted: 0 }, 400);
      const events = parsed.data.events.flatMap((e) => {
        const a = areaFromPath(e.path);
        return a ? [{ name: e.name, props: { area: a.area, ...(a.tool ? { tool: a.tool } : {}) } }] : [];
      });
      if (events.length) await runAfterResponse(c, captureEvents(deps, { orgId: c.var.auth.orgId, userId: c.var.auth.userId, events }));
      return c.json({ accepted: events.length });
    });
}
