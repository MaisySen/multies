import { describe, it, expect } from "vitest";
import { openSqlite } from "@/server/db/node";
import { migrate } from "@/server/db";

describe("migrations", () => {
  it("apply once and are idempotent", async () => {
    const db = openSqlite(":memory:");
    const first = await migrate(db);
    expect(first.length).toBeGreaterThan(0);
    expect(await migrate(db)).toEqual([]);
  });
});
