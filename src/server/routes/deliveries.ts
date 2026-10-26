import { Hono } from "hono";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { AppEnv } from "../context";
import { z } from "zod";
import { pageQuery, parseQuery, requireAuth } from "../middleware";
import { deliveries, mailboxes } from "../db/schema";
import { mailboxScope } from "../services/team";

export function deliveryRoutes() {
  return new Hono<AppEnv>().use("*", requireAuth).get("/", async (c) => {
    const { db } = c.var.deps;
    const { direction, before, limit } = parseQuery(c, pageQuery.extend({ direction: z.enum(["inbound", "outbound"]).optional() }));
    // Members only see deliveries to or from the mailboxes they were granted.
    const scope = await mailboxScope(db, c.var.auth);
    let addressFilter;
    if (scope) {
      const addrs = scope.length ? (await db.select({ a: mailboxes.address }).from(mailboxes).where(inArray(mailboxes.id, scope))).map((r) => r.a) : [];
      addressFilter = addrs.length ? or(inArray(deliveries.fromAddress, addrs), inArray(deliveries.toAddress, addrs)) : eq(deliveries.id, "-");
    }
    const rows = await db.select().from(deliveries).where(and(
      eq(deliveries.orgId, c.var.auth.orgId),
      direction ? eq(deliveries.direction, direction) : undefined,
      before ? lt(deliveries.createdAt, before) : undefined,
      addressFilter,
    )).orderBy(desc(deliveries.createdAt)).limit(limit);
    return c.json({ deliveries: rows });
  });
}
