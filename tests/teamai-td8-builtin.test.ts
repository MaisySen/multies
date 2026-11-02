/** TD8 Team AI with free built in AI (owner decision 2 Nov): a workspace with no key of its own runs on the existing built in
 * AI through askAi (the single shared meter with its hard cap, reserved before the call, never billed) under a per workspace
 * daily limit of free runs; its own key bypasses both; the AI switch off means no call at all. */
import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { GLOBAL_DAILY_UNITS, GLOBAL_ROW, STRONG_CHAT_MODEL } from "@/server/services/tools/ai-meter";
import { FREE_LIMIT_REPLY } from "@/shared/teamai-td8";

const FAKE_KEY = ["unit", "test", "placeholder", "only"].join("-");

async function setup(env: Record<string, string> = {}) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => { calls.push(String(input)); return Response.json({ choices: [{ message: { content: "Own key draft" } }], data: [] }); }) as typeof fetch;
  const ctx = await makeTestApp({ TEAMAI_TD8: "on", ASK_TD1: "on", ...env }, { fetch: f });
  const run = vi.fn(async () => ({ response: "Built in draft", usage: { prompt_tokens: 50, completion_tokens: 20 } }));
  ctx.deps.ai = { run } as unknown as typeof ctx.deps.ai;
  const admin = new Client(ctx.app);
  await admin.signup("ada@acme.io", "Ada Lovelace", "Acme");
  const set = await admin.post("/api/team-ai/instructions", { name: "Standup", body: "Write a standup summary", shared: true });
  const tryIt = async () => (await admin.post(`/api/team-ai/instructions/${set.body.id}/run`)).body;
  const providerCalls = () => calls.filter((u) => /openai|anthropic|groq|openrouter/.test(u) && !u.endsWith("/models")).length;
  const meterRows = () => ctx.deps.db.all<{ org_id: string; units: number }>(sql`select org_id, units from ai_usage_daily where org_id <> ${GLOBAL_ROW}`);
  return { ctx, admin, run, tryIt, providerCalls, meterRows };
}

describe("TD8 built in AI fallback", () => {
  it("no key: runs on built in AI through the shared meter, never a provider key", async () => {
    const t = await setup();
    const st = (await t.admin.get("/api/team-ai/state")).body.ai;
    expect(st).toMatchObject({ on: true, key: false, source: "built_in", freeUsed: 0, freeLimit: 50, freePeriod: "day" });
    expect(await t.tryIt()).toMatchObject({ status: "done", result: "Built in draft" });
    expect(t.run).toHaveBeenCalledTimes(1);
    // The strongest rated model on the existing binding.
    expect((t.run.mock.calls[0] as unknown[])[0]).toBe(STRONG_CHAT_MODEL);
    expect(t.providerCalls()).toBe(0);
    expect((await t.meterRows()).length).toBe(1);
    expect((await t.admin.get("/api/team-ai/state")).body.ai.freeUsed).toBe(1);
  });

  it("the workspace daily free limit refuses with the friendly message and makes no call", async () => {
    const t = await setup({ TEAMAI_FREE_DAILY_CALLS: "2" });
    expect((await t.tryIt()).status).toBe("done");
    expect((await t.tryIt()).status).toBe("done");
    const third = await t.tryIt();
    expect(third).toMatchObject({ status: "skipped", reason: "free_limit" });
    expect(third.reasonText).toMatch(/Free AI limit for this workspace reached\. Add your own AI key/);
    expect(t.run).toHaveBeenCalledTimes(2);
    // In a channel the assistant says so in the thread with a fixed line and still makes no call.
    const g = (await t.admin.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
    await t.admin.post(`/api/chat/channels/${g.id}/messages`, { body: "@assistant what is due?" });
    const { drainPending, takePending } = await import("@/server/services/teamai-td8");
    await drainPending(t.ctx.deps, takePending());
    const replies = await t.ctx.deps.db.all<{ body: string }>(sql`select body from chat_messages where body = ${FREE_LIMIT_REPLY}`);
    expect(replies.length).toBe(1);
    expect(t.run).toHaveBeenCalledTimes(2);
  });

  it("a weekly limit carries over to the next day and resets on Monday", async () => {
    const t = await setup({ TEAMAI_FREE_DAILY_CALLS: "2", TEAMAI_FREE_PERIOD: "week" });
    let now = Date.UTC(2026, 10, 2, 10, 0); // Monday
    t.ctx.deps.now = () => new Date(now);
    expect((await t.tryIt()).status).toBe("done");
    expect((await t.tryIt()).status).toBe("done");
    now = Date.UTC(2026, 10, 3, 10, 0); // Tuesday, same week
    expect((await t.admin.get("/api/team-ai/state")).body.ai).toMatchObject({ freeUsed: 2, freeLimit: 2, freePeriod: "week" });
    expect(await t.tryIt()).toMatchObject({ status: "skipped", reason: "free_limit" });
    now = Date.UTC(2026, 10, 9, 10, 0); // next Monday
    expect((await t.tryIt()).status).toBe("done");
    expect(t.run).toHaveBeenCalledTimes(3);
  });

  it("the shared cap spent refuses with no call and gives the free run back", async () => {
    const t = await setup();
    const day = new Date(t.ctx.deps.now()).toISOString().slice(0, 10);
    await t.ctx.deps.db.run(sql`insert into ai_usage_daily (day, org_id, units, calls) values (${day}, ${GLOBAL_ROW}, ${GLOBAL_DAILY_UNITS}, 1)
      on conflict (day, org_id) do update set units = ${GLOBAL_DAILY_UNITS}`);
    expect(await t.tryIt()).toMatchObject({ status: "skipped", reason: "free_limit" });
    expect(t.run).not.toHaveBeenCalled();
    expect(t.providerCalls()).toBe(0);
    expect((await t.admin.get("/api/team-ai/state")).body.ai.freeUsed).toBe(0);
  });

  it("own key bypasses the meter and the free limit", async () => {
    const t = await setup({ TEAMAI_FREE_DAILY_CALLS: "0" });
    expect((await t.admin.call("PUT", "/api/ai/key", { provider: "openai", apiKey: FAKE_KEY })).status).toBe(200);
    expect((await t.admin.get("/api/team-ai/state")).body.ai).toMatchObject({ source: "own_key", key: true });
    expect(await t.tryIt()).toMatchObject({ status: "done", result: "Own key draft" });
    expect(await t.tryIt()).toMatchObject({ status: "done" });
    expect(t.providerCalls()).toBe(2);
    expect(t.run).not.toHaveBeenCalled();
    expect((await t.meterRows()).length).toBe(0);
  });

  it("AI switch off: no built in call and no provider call", async () => {
    const t = await setup();
    expect((await t.admin.call("PUT", "/api/ai-trust", { enabled: false })).status).toBe(200);
    expect(await t.tryIt()).toMatchObject({ status: "skipped", reason: "ai_off" });
    expect(t.run).not.toHaveBeenCalled();
    expect(t.providerCalls()).toBe(0);
    expect((await t.meterRows()).length).toBe(0);
  });
});
