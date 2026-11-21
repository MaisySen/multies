/** OPS1: the console's shared list helper (services/console/listing.ts): limits, whitelisted sorts, keyset cursors, search. */
import { describe, expect, it } from "vitest";
import { and } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import { platformAuditLogs } from "@/server/db/schema";
import { decodeCursor, encodeCursor, listParams, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from "@/server/services/console/listing";

const opts = {
  id: platformAuditLogs.id,
  sort: { createdAt: platformAuditLogs.createdAt, action: platformAuditLogs.action },
  defaultSort: "createdAt:desc" as const,
  search: [platformAuditLogs.action, platformAuditLogs.reason],
};

describe("console listing helper", () => {
  it("limits: default 50, at most 200, junk falls back", () => {
    expect(listParams({}, opts).limit).toBe(LIST_DEFAULT_LIMIT);
    expect(listParams({ limit: "500" }, opts).limit).toBe(LIST_MAX_LIMIT);
    expect(listParams({ limit: "7" }, opts)).toMatchObject({ limit: 7, take: 8 });
    expect(listParams({ limit: "-3" }, opts).limit).toBe(LIST_DEFAULT_LIMIT);
    expect(listParams({ limit: "abc" }, opts).limit).toBe(LIST_DEFAULT_LIMIT);
  });

  it("sorts only by whitelisted fields", () => {
    expect(listParams({ sort: "action:asc" }, opts)).toMatchObject({ sortField: "action", sortDir: "asc" });
    expect(listParams({ sort: "action" }, opts)).toMatchObject({ sortField: "action", sortDir: "desc" });
    expect(listParams({ sort: "reason:asc" }, opts)).toMatchObject({ sortField: "createdAt", sortDir: "desc" });
    expect(listParams({ sort: "__proto__:asc" }, opts)).toMatchObject({ sortField: "createdAt" });
    expect(listParams({ q: `  ${"x".repeat(150)} ` }, opts).q).toHaveLength(100);
  });

  it("cursors round trip dates, numbers and text; junk is a 400", () => {
    const d = new Date("2026-11-21T10:00:00Z");
    expect(decodeCursor(encodeCursor(d, "a1"))).toEqual({ sort: d, id: "a1" });
    expect(decodeCursor(encodeCursor(42, "a2"))).toEqual({ sort: 42, id: "a2" });
    expect(decodeCursor(encodeCursor("Zoë", "a3"))).toEqual({ sort: "Zoë", id: "a3" });
    expect(() => decodeCursor("not-a-cursor")).toThrow(/out of date/);
    expect(() => decodeCursor(btoa(JSON.stringify({ v: 1, t: "d" })))).toThrow();
  });

  it("pages every row once, with ties on the sort field, in both directions, and searches", async () => {
    const { db } = await makeTestApp();
    const same = new Date("2026-11-20T00:00:00Z");
    const rows = Array.from({ length: 23 }, (_, i) => ({
      id: `paud_${String(i).padStart(2, "0")}`, action: i % 2 ? "workspace.suspended" : "user.deleted",
      reason: i === 5 ? "Needle in here" : null, createdAt: i < 10 ? same : new Date(same.getTime() + i * 1000),
    }));
    await db.insert(platformAuditLogs).values(rows);
    const walk = async (query: Record<string, string>) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let n = 0; n < 20; n++) {
        const p = listParams({ ...query, ...(cursor ? { cursor } : {}) }, opts);
        const got = await db.select().from(platformAuditLogs).where(and(p.where)).orderBy(...p.orderBy).limit(p.take);
        const page = p.page(got, (r) => ({ sort: p.sortField === "action" ? r.action : r.createdAt, id: r.id }));
        expect(page.items.length).toBeLessThanOrEqual(p.limit);
        seen.push(...page.items.map((r) => r.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return seen;
    };
    const desc = await walk({ limit: "4" });
    expect(desc).toHaveLength(23);
    expect(new Set(desc).size).toBe(23);
    expect(desc[0]).toBe("paud_22");
    const asc = await walk({ limit: "5", sort: "createdAt:asc" });
    expect(asc).toEqual([...desc].reverse());
    const byAction = await walk({ limit: "3", sort: "action:asc" });
    expect(new Set(byAction).size).toBe(23);
    expect(await walk({ q: "needle" })).toEqual(["paud_05"]);
  });
});
