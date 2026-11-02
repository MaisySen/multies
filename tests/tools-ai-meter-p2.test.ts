/**
 * Tools P2 H3: the AI meter. The global stop (8,000 units a day, 80% of the free 10,000) and the workspace share are reserved in D1
 * before deps.ai.run is ever called; concurrent reservations cannot pass the cap.
 */
import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import {
  askAi, aiUsage, reserveRow, estimateUnits, unitsFor, GLOBAL_DAILY_UNITS, GLOBAL_ROW, AI_DAILY_UNITS, CHAT_MODEL, TRANSLATE_MODEL, TRANSLATE_LLM,
  FREE_LIMIT_MESSAGE, MAX_UNITS_PER_CALL, pruneAiUsage,
} from "@/server/services/tools/ai-meter";
import { dayOf } from "@/server/services/tools/usage";

async function setup() {
  const ctx = await makeTestApp({});
  const c = new Client(ctx.app);
  await c.signup(undefined, "Ada Lovelace", "Acme");
  const me = await c.get("/api/account/me");
  const orgId = (me.body as { organization?: { id: string } }).organization?.id ?? "";
  return { ...ctx, c, orgId };
}

function fakeAi(reply: (model: string, input: Record<string, unknown>) => unknown = () => ({ response: "ok", usage: { prompt_tokens: 50, completion_tokens: 10 } })) {
  return { run: vi.fn(async (model: string, input: Record<string, unknown>) => reply(model, input)) };
}

const rowUnits = async (db: Awaited<ReturnType<typeof setup>>["db"], day: string, org: string) =>
  Number((await db.all<{ units: number }>(sql`select units from ai_usage_daily where day = ${day} and org_id = ${org}`))[0]?.units ?? 0);

describe("Tools P2 AI meter", () => {
  it("estimates units high and from the published per model rates", () => {
    expect(unitsFor(CHAT_MODEL, 1_000_000, 0)).toBe(Math.ceil(4119 * 1.3));
    expect(unitsFor(TRANSLATE_MODEL, 0, 1_000_000)).toBe(Math.ceil(31050 * 1.3));
    const small = estimateUnits({ task: "chat", system: "s", user: "hello", maxTokens: 100 });
    const big = estimateUnits({ task: "chat", system: "s", user: "hello ".repeat(2000), maxTokens: 100 });
    expect(big).toBeGreaterThan(small);
    // Devanagari counts more tokens per character than English.
    expect(estimateUnits({ task: "translate", texts: ["नमस्ते संसार"], target: "en" })).toBeGreaterThan(estimateUnits({ task: "translate", texts: ["hello world!"], target: "ne" }));
  });

  it("runs a free call, reserves first and settles to the reported usage", async () => {
    const { deps, db, orgId } = await setup();
    const ai = fakeAi();
    deps.ai = ai;
    const r = await askAi(deps, orgId, { task: "chat", system: "Be brief.", user: "Say ok", maxTokens: 50 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("free");
    expect(r.text).toBe("ok");
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.run.mock.calls[0][0]).toBe(CHAT_MODEL);
    const day = dayOf(deps.now());
    const want = unitsFor(CHAT_MODEL, 50, 10);
    expect(await rowUnits(db, day, orgId)).toBe(want);
    expect(await rowUnits(db, day, GLOBAL_ROW)).toBe(want);
    const u = await aiUsage(deps, orgId);
    expect(u).toMatchObject({ units: want, cap: AI_DAILY_UNITS.starter, calls: 1, ownKey: false, globalReached: false, plan: "starter" });
  });

  it("the global stop blocks the call before deps.ai.run is invoked", async () => {
    const { deps, db, orgId } = await setup();
    const ai = fakeAi();
    deps.ai = ai;
    const day = dayOf(deps.now());
    await db.run(sql`insert into ai_usage_daily (day, org_id, units, calls) values (${day}, ${GLOBAL_ROW}, ${GLOBAL_DAILY_UNITS - 2}, 1)`);
    const r = await askAi(deps, orgId, { task: "chat", system: "x", user: "y".repeat(300), maxTokens: 200 });
    expect(r).toEqual({ ok: false, reason: "limit", message: FREE_LIMIT_MESSAGE });
    expect(ai.run).not.toHaveBeenCalled();
    // The workspace reservation was given back and the global row did not move.
    expect(await rowUnits(db, day, orgId)).toBe(0);
    expect(await rowUnits(db, day, GLOBAL_ROW)).toBe(GLOBAL_DAILY_UNITS - 2);
    expect((await aiUsage(deps, orgId)).globalReached).toBe(true);
  });

  it("the workspace share blocks the call before deps.ai.run is invoked", async () => {
    const { deps, db, orgId } = await setup();
    const ai = fakeAi();
    deps.ai = ai;
    const day = dayOf(deps.now());
    await db.run(sql`insert into ai_usage_daily (day, org_id, units, calls) values (${day}, ${orgId}, ${AI_DAILY_UNITS.starter}, 9)`);
    const r = await askAi(deps, orgId, { task: "chat", system: "x", user: "y" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("workspace_limit");
    expect(ai.run).not.toHaveBeenCalled();
    expect(await rowUnits(db, day, GLOBAL_ROW)).toBe(0);
  });

  it("concurrent reservations cannot pass 8,000 (80% of the free 10,000)", async () => {
    const { deps, db } = await setup();
    const day = dayOf(deps.now());
    const results = await Promise.all(Array.from({ length: 64 }, () => reserveRow(deps, day, GLOBAL_ROW, 300, GLOBAL_DAILY_UNITS)));
    expect(results.filter(Boolean).length).toBe(26);
    expect(await rowUnits(db, day, GLOBAL_ROW)).toBe(7800);
    expect(await reserveRow(deps, day, GLOBAL_ROW, 300, GLOBAL_DAILY_UNITS)).toBe(false);
    expect(await rowUnits(db, day, GLOBAL_ROW)).toBe(7800);
    expect(GLOBAL_DAILY_UNITS).toBeLessThanOrEqual(8_000);
  });

  it("concurrent askAi calls from many workspaces stop at the global cap and never call the AI past it", async () => {
    const { deps, db, orgId } = await setup();
    // Business share (4,000) so the workspace share does not stop it first; the global row starts near the cap.
    await db.run(sql`update organizations set plan = 'business' where id = ${orgId}`);
    const day = dayOf(deps.now());
    await db.run(sql`insert into ai_usage_daily (day, org_id, units, calls) values (${day}, ${GLOBAL_ROW}, ${GLOBAL_DAILY_UNITS - 1000}, 1)`);
    const ai = fakeAi(() => ({ response: "x" })); // no usage reported: settles to an estimate
    deps.ai = ai;
    const req = { task: "chat" as const, system: "s", user: "u".repeat(30000), maxTokens: 400 };
    const est = estimateUnits(req);
    const rs = await Promise.all(Array.from({ length: 40 }, () => askAi(deps, orgId, req)));
    const ok = rs.filter((r) => r.ok).length;
    expect(40 * est).toBeGreaterThan(1000);
    expect(ok).toBeGreaterThanOrEqual(Math.floor(1000 / est));
    expect(ok).toBeLessThan(40);
    expect(ai.run).toHaveBeenCalledTimes(ok);
    expect(await rowUnits(db, day, GLOBAL_ROW)).toBeLessThanOrEqual(GLOBAL_DAILY_UNITS);
  });

  it("refuses one oversized request and an absent AI service plainly", async () => {
    const { deps, orgId } = await setup();
    const r1 = await askAi(deps, orgId, { task: "chat", system: "s", user: "x" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("unavailable");
    deps.ai = fakeAi();
    const huge = { task: "chat" as const, system: "s", user: "word ".repeat(400_000) };
    expect(estimateUnits(huge)).toBeGreaterThan(MAX_UNITS_PER_CALL);
    const r2 = await askAi(deps, orgId, huge);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("too_big");
    expect((deps.ai as ReturnType<typeof fakeAi>).run).not.toHaveBeenCalled();
  });

  it("keeps the reservation when the AI call fails", async () => {
    const { deps, db, orgId } = await setup();
    deps.ai = { run: vi.fn(async () => { throw new Error("boom"); }) };
    const req = { task: "chat" as const, system: "s", user: "hello" };
    const r = await askAi(deps, orgId, req);
    expect(r.ok).toBe(false);
    expect(await rowUnits(db, dayOf(deps.now()), GLOBAL_ROW)).toBe(estimateUnits(req));
  });

  it("translates in one reservation for the batch, falling back line by line when the group answer is not a JSON array", async () => {
    const { deps, db, orgId } = await setup();
    const ai = fakeAi((_m, input) => ({ translated_text: `[${String(input.target_lang)}] ${String(input.text)}` }));
    deps.ai = ai;
    const r = await askAi(deps, orgId, { task: "translate", texts: ["Hello", "", "Thank you"], target: "ne" });
    expect(r.ok && r.texts).toEqual(["[ne] Hello", "", "[ne] Thank you"]);
    expect(ai.run).toHaveBeenCalledTimes(3);
    expect(ai.run.mock.calls[0][0]).toBe(TRANSLATE_LLM);
    expect(ai.run.mock.calls[1][0]).toBe(TRANSLATE_MODEL);
    const calls = await db.all<{ calls: number }>(sql`select calls from ai_usage_daily where org_id = ${GLOBAL_ROW}`);
    expect(calls[0].calls).toBe(1);
  });

  it("translates a group in one call on the instruct model when it answers a JSON array", async () => {
    const { deps, orgId } = await setup();
    const ai = fakeAi((m, input) => {
      if (m !== TRANSLATE_LLM) throw new Error("line model should not run");
      const lines = JSON.parse(String((input.messages as { content: string }[])[1].content)) as string[];
      return { response: JSON.stringify(lines.map((l) => `ne:${l}`)), usage: { prompt_tokens: 50, completion_tokens: 20 } };
    });
    deps.ai = ai;
    const r = await askAi(deps, orgId, { task: "translate", texts: ["Hello", "", "Thank you"], target: "ne" });
    expect(r.ok && r.texts).toEqual(["ne:Hello", "", "ne:Thank you"]);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(r.ok && r.units).toBe(unitsFor(TRANSLATE_LLM, 50, 20));
  });

  it("uses the workspace's own key first and does not meter it", async () => {
    const seen: string[] = [];
    const ctx = await makeTestApp({}, {
      fetch: (async (input: string | URL | Request) => {
        seen.push(String(input));
        return Response.json({ choices: [{ message: { content: "own answer" } }] });
      }) as typeof fetch,
    });
    const c = new Client(ctx.app);
    await c.signup(undefined, "Ada Lovelace", "Acme");
    const me = await c.get("/api/account/me");
    const orgId = (me.body as { organization?: { id: string } }).organization?.id ?? "";
    const put = await c.put("/api/ai/key", { provider: "groq", apiKey: "gsk_" + "x".repeat(40) });
    expect(put.status).toBeLessThan(300);
    const ai = fakeAi();
    ctx.deps.ai = ai;
    const r = await askAi(ctx.deps, orgId, { task: "chat", system: "s", user: "q" });
    expect(r.ok && r.source).toBe("own_key");
    expect(r.ok && r.text).toBe("own answer");
    expect(ai.run).not.toHaveBeenCalled();
    expect(seen.some((u) => u.includes("groq"))).toBe(true);
    expect((await ctx.db.all(sql`select * from ai_usage_daily`)).length).toBe(0);
  });

  it("prunes rows older than 2 days", async () => {
    const { deps, db } = await setup();
    await db.run(sql`insert into ai_usage_daily (day, org_id, units, calls) values ('2020-01-01', '*', 5, 1)`);
    await reserveRow(deps, dayOf(deps.now()), GLOBAL_ROW, 5, GLOBAL_DAILY_UNITS);
    await pruneAiUsage(deps, deps.now());
    expect((await db.all(sql`select * from ai_usage_daily`)).length).toBe(1);
  });
});
