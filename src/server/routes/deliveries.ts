import { Hono } from "hono";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { deliveries, mailboxes } from "../db/schema";
import { mailboxScope } from "../services/team";

export function deliveryRoutes() {
  return new Hono<AppEnv>().use("*", requireAuth).get("/", async (c) => {
    const { db } = c.var.deps;
    const direction = c.req.query("direction");
    const before = c.req.query("before");
    // Members only see deliveries to or from the mailboxes they were granted.
    const scope = await mailboxScope(db, c.var.auth);
    let addressFilter;
    if (scope) {
      const addrs = scope.length ? (await db.select({ a: mailboxes.address }).from(mailboxes).where(inArray(mailboxes.id, scope))).map((r) => r.a) : [];
      addressFilter = addrs.length ? or(inArray(deliveries.fromAddress, addrs), inArray(deliveries.toAddress, addrs)) : eq(deliveries.id, "-");
    }
    const rows = await db.select().from(deliveries).where(and(
      eq(deliveries.orgId, c.var.auth.orgId),
      direction === "inbound" || direction === "outbound" ? eq(deliveries.direction, direction) : undefined,
      before ? lt(deliveries.createdAt, new Date(before)) : undefined,
      addressFilter,
    )).orderBy(desc(deliveries.createdAt)).limit(Math.min(Number(c.req.query("limit") ?? 50), 200));
    return c.json({ deliveries: rows });
  });
}
