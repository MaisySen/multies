import { describe, expect, it } from "vitest";
import { openSqlite } from "@/server/db/node";
import { migrate } from "@/server/db";
import { pruneRateLimits } from "@/server/lib/rate-limit";

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
});
