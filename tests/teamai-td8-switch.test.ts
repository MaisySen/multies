/** TD8 Team AI with TD1's real AI switch: an admin turning AI off stops every Team AI provider call (tries, routines,
 * chat answers) and the state says so; turning it back on resumes. */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";

const FAKE_KEY = ["unit", "test", "placeholder", "only"].join("-");

describe("TD8 and the TD1 AI switch", () => {
  it("AI off: no provider call anywhere in Team AI; on again: runs", async () => {
    const calls: string[] = [];
    const f = (async (input: RequestInfo | URL) => { calls.push(String(input)); return Response.json({ choices: [{ message: { content: "Draft text" } }], data: [] }); }) as typeof fetch;
    const ctx = await makeTestApp({ TEAMAI_TD8: "on", ASK_TD1: "on" }, { fetch: f });
    const admin = new Client(ctx.app);
    await admin.signup("ada@acme.io", "Ada Lovelace", "Acme");
    expect((await admin.call("PUT", "/api/ai/key", { provider: "openai", apiKey: FAKE_KEY })).status).toBe(200);
    const s = await admin.post("/api/team-ai/instructions", { name: "Standup", body: "Write a standup summary", shared: true });
    await admin.post("/api/team-ai/routines", { name: "Daily", instructionId: s.body.id, trigger: "daily", output: "draft" });
    expect((await admin.call("PUT", "/api/ai-trust", { enabled: false })).status).toBe(200);
    const before = calls.length;
    expect((await admin.get("/api/team-ai/state")).body.ai.on).toBe(false);
    expect((await admin.post(`/api/team-ai/instructions/${s.body.id}/run`)).body).toMatchObject({ status: "skipped", reason: "ai_off" });
    const g = (await admin.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
    await admin.post(`/api/chat/channels/${g.id}/messages`, { body: "@assistant hello" });
    await ctx.deps.db.run(sql`update teamai_routines set next_run_at = ${Date.now() - 1000}`);
    const { runTeamAiPass } = await import("@/server/services/teamai-td8");
    await runTeamAiPass(ctx.deps);
    const rows = await ctx.deps.db.all<{ status: string; reason: string }>(sql`select status, reason from teamai_runs`);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.status === "skipped" && r.reason === "ai_off")).toBe(true);
    expect(calls.length).toBe(before);
    expect((await admin.call("PUT", "/api/ai-trust", { enabled: true })).status).toBe(200);
    expect((await admin.post(`/api/team-ai/instructions/${s.body.id}/run`)).body.status).toBe("done");
    expect(calls.length).toBe(before + 1);
  });
});
