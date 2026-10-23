import { Hono } from "hono";
import { and, desc, eq, lt } from "drizzle-orm";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { deliveries } from "../db/schema";

export function deliveryRoutes() {
  return new Hono<AppEnv>().use("*", requireAuth).get("/", async (c) => {
    const direction = c.req.query("direction");
    const before = c.req.query("before");
    const rows = await c.var.deps.db.select().from(deliveries).where(and(
      eq(deliveries.orgId, c.var.auth.orgId),
      direction === "inbound" || direction === "outbound" ? eq(deliveries.direction, direction) : undefined,
      before ? lt(deliveries.createdAt, new Date(before)) : undefined,
    )).orderBy(desc(deliveries.createdAt)).limit(Math.min(Number(c.req.query("limit") ?? 50), 200));
    return c.json({ deliveries: rows });
  });
}
