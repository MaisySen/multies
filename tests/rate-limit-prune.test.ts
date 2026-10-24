import { describe, expect, it } from "vitest";
import { openSqlite } from "@/server/db/node";
import { migrate } from "@/server/db";
import { pruneRateLimits } from "@/server/lib/rate-limit";
import { isTransientDbError } from "@/server/services/maintenance";

describe("pruneRateLimits", () => {
  it("removes expired counters", async () => {
    const db = openSqlite(":memory:");
    await migrate(db);
    expect(await pruneRateLimits(db, Date.now())).toBe(true);
  });
  it("skips quietly when the table is not there yet (a preview database mid migration)", async () => {
    const db = openSqlite(":memory:");
    expect(await pruneRateLimits(db, Date.now())).toBe(false);
  });
  it("treats a busy or unmigrated database as transient in maintenance, and real query bugs as errors", () => {
    const wrap = (cause: unknown) => Object.assign(new Error("Failed query: update \"send_approvals\" set ..."), { cause });
    expect(isTransientDbError(wrap(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })))).toBe(true);
    expect(isTransientDbError(wrap(new Error("no such table: api_rate_limits")))).toBe(true);
    expect(isTransientDbError(wrap(new Error("D1_ERROR: Network connection lost.")))).toBe(true);
    expect(isTransientDbError(wrap(new Error("no such column: statuz")))).toBe(false);
  });
});
