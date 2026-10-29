import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers";
import { agentSentTodayQuery } from "@/server/services/agents";

/** R58 index study: the agent daily send count read every message in the database (SCAN messages). */
describe("R58 agent send count rides an index", () => {
  it("counts an agent's sent mail today through the workspace, folder and date index, never a table scan", async () => {
    const { db } = await makeTestApp();
    const client = (db as unknown as { $client: { prepare: (s: string) => { all: (...a: unknown[]) => { detail: string }[] } } }).$client;
    const q = agentSentTodayQuery(db, { id: "agt_1", orgId: "org_1" }, new Date()).toSQL();
    const params = q.params.map((p) => (p instanceof Date ? p.getTime() : p));
    const plan = client.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...params).map((r) => r.detail).join(" | ");
    expect(plan).toContain("messages_org_folder_date_idx (org_id=? AND folder=? AND date>?)");
    expect(plan).not.toMatch(/SCAN messages(?! USING)/);
  });
});
