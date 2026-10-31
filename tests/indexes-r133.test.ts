import { describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import { mailSchedules, projectStatuses } from "@/server/db/schema";

/** R133: two read paths scanned their whole table (0113 adds the indexes). */
type Client = { prepare: (s: string) => { all: (...a: unknown[]) => { detail: string }[] } };
async function plan(q: { toSQL: () => { sql: string; params: unknown[] } }, client: Client) {
  const s = q.toSQL();
  return client.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.params.map((p) => (p instanceof Date ? p.getTime() : p))).map((r) => r.detail).join(" | ");
}

describe("R133 indexes", () => {
  it("reads a workspace's statuses through the org index, never a table scan", async () => {
    const { db } = await makeTestApp();
    const client = (db as unknown as { $client: Client }).$client;
    const p = await plan(db.select().from(projectStatuses).where(eq(projectStatuses.orgId, "org_1")), client);
    expect(p).toContain("project_statuses_org_idx");
    expect(p).not.toMatch(/SCAN project_statuses(?! USING)/);
  });

  it("reads a thread's snoozes and reminders through the thread index, never a table scan", async () => {
    const { db } = await makeTestApp();
    const client = (db as unknown as { $client: Client }).$client;
    const q = db.select().from(mailSchedules)
      .where(and(eq(mailSchedules.mailboxId, "mbx_1"), eq(mailSchedules.threadId, "thr_1"), inArray(mailSchedules.kind, ["snooze", "remind"])));
    const p = await plan(q, client);
    expect(p).toContain("mail_schedules_thread_idx");
    expect(p).not.toMatch(/SCAN mail_schedules(?! USING)/);
  });
});
