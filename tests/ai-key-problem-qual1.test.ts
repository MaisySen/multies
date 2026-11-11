/**
 * QUAL1 (audit rows 12 and 14): the workspace's own AI key was refused by the provider, yet Settings showed a green
 * "Connected", Team AI said "Ready on your Anthropic key" and POST /api/ai/summary answered a bare 502. Now a 401 or
 * 403 (and an empty account or a model that is gone) is noted on the stored key with the time, the moment it happens
 * on any AI call; a call that works or a passed test clears it; every status shows it; the AI routes answer 409 with
 * their own code and plain words; and built-in AI stands in, inside the free meter, saying so.
 */
import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { verifiedDomain } from "./priv1a-world";
import { deliverInbound } from "@/server/services/mail/delivery";
import { aiKeys } from "@/server/db/schema";
import { askAi } from "@/server/services/tools/ai-meter";
import { AI_PROVIDER_INFO } from "@/server/services/ai/providers";
import { aiKeyProblemText } from "@/shared/ai-connect-ai2";

const ANT = "sk-ant-api03-" + "a".repeat(40) + "WXYZ";
const ANT2 = "sk-ant-api03-" + "c".repeat(40) + "QRST";

type Answer = (url: string, init?: RequestInit) => Response;
const goodAnthropic: Answer = (url, init) => {
  const h = new Headers(init?.headers);
  if (url.includes("api.anthropic.com/v1/models")) return h.get("x-api-key") ? Response.json({ data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] }) : new Response("missing", { status: 401 });
  if (url.includes("api.anthropic.com/v1/messages")) return Response.json({ content: [{ type: "text", text: '{"summary":"Maria wants to move this week.","actionItems":["Reply"]}' }] });
  return new Response("not found", { status: 404 });
};
const refused: Answer = () => new Response('{"type":"error","error":{"type":"authentication_error","message":"SECRET_BODY invalid x-api-key"}}', { status: 401 });

async function setup(env: Record<string, string> = {}) {
  const calls: string[] = [];
  let answer: Answer = goodAnthropic;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push(String(input)); return answer(String(input), init); }) as typeof fetch;
  const ctx = await makeTestApp({ AI_CONNECT_AI2: "on", TEAMAI_TD8: "on", ASK_TD1: "on", ...env }, { fetch: fetchImpl });
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Ada Owner", "Acme");
  const domainId = await verifiedDomain(ctx, c, "acme.io");
  const box = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox;
  await deliverInbound(ctx.deps, {
    envelopeFrom: "maria@blueharbor.example", rcptTo: "hello@acme.io", sizeBytes: 500, via: "test",
    email: { messageId: "<q1@blueharbor.example>", from: { address: "maria@blueharbor.example", name: "Maria" }, to: [{ address: "hello@acme.io" }], cc: [], subject: "Moving our team",
      text: "Hi,\n\nCan we move this week? Please let me know.\n\nMaria", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
  const messageId = (await c.get(`/api/mail/messages?mailboxId=${box.id}&folder=inbox`)).body.messages[0].id as string;
  const connected = await c.post("/api/ai/connect", { apiKey: ANT });
  expect(connected.status).toBe(200);
  const orgId = (await c.get("/api/account/me")).body.organization.id as string;
  const keyRow = () => ctx.deps.db.select().from(aiKeys).get();
  const clearLimits = () => ctx.deps.db.run(sql`delete from api_rate_limits`);
  return { ...ctx, c, calls, messageId, orgId, keyRow, clearLimits, setAnswer: (f: Answer) => { answer = f; } };
}

const noSecret = (x: unknown) => { const s = JSON.stringify(x); expect(s).not.toContain(ANT); expect(s).not.toContain("SECRET_BODY"); };
const REFUSED = aiKeyProblemText("key_refused", "Anthropic");

describe("a refused AI key is noted, shown and explained (QUAL1, rows 12 and 14)", () => {
  it("a 401 on Summarise is noted on the key with the time; the route answers 409 ai_key_refused in plain words; status shows it", async () => {
    const t = await setup();
    t.setAnswer(refused);
    const r = await t.c.post("/api/ai/summary", { messageId: t.messageId });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "ai_key_refused", message: REFUSED, details: { fix: "/app/settings#ai" } });
    noSecret(r.body);
    const row = await t.keyRow();
    expect(row?.problem).toBe("key_refused");
    expect(row?.problemAt).toBeInstanceOf(Date);
    const s = (await t.c.get("/api/ai/status")).body;
    expect(s).toMatchObject({ connected: true, provider: "anthropic", problem: "key_refused", problemMessage: REFUSED });
    expect(typeof s.problemAt).toBe("string");
    // Draft a reply and Sort it answer the same way.
    for (const path of ["/api/ai/draft", "/api/ai/triage"]) {
      const x = await t.c.post(path, { messageId: t.messageId });
      expect(x.status, path).toBe(409);
      expect(x.body.error.code, path).toBe("ai_key_refused");
    }
  });

  it("a call that works again clears the note, and only a change of state writes", async () => {
    const t = await setup();
    t.setAnswer(refused);
    await t.c.post("/api/ai/summary", { messageId: t.messageId });
    const at = (await t.keyRow())?.problemAt?.getTime();
    // Refused again: no new write (the time stays the first refusal's).
    await new Promise((r) => setTimeout(r, 5));
    await t.c.post("/api/ai/summary", { messageId: t.messageId });
    expect((await t.keyRow())?.problemAt?.getTime()).toBe(at);
    t.setAnswer(goodAnthropic);
    const ok = await t.c.post("/api/ai/summary", { messageId: t.messageId });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ summary: "Maria wants to move this week.", provider: "anthropic" });
    expect(ok.body.fallback).toBeUndefined();
    expect(await t.keyRow()).toMatchObject({ problem: null, problemAt: null });
    expect((await t.c.get("/api/ai/status")).body.problem).toBeUndefined();
  });

  it("Test connection notes a refusal and a passed test clears it", async () => {
    const t = await setup();
    t.setAnswer(refused);
    const bad = await t.c.post("/api/ai/test", {});
    expect(bad.body).toMatchObject({ ok: false, code: "key_refused" });
    expect((await t.keyRow())?.problem).toBe("key_refused");
    await t.clearLimits();
    t.setAnswer(goodAnthropic);
    expect((await t.c.post("/api/ai/test", {})).body.ok).toBe(true);
    expect((await t.keyRow())?.problem).toBeNull();
  });

  it("an empty account and a model that is gone are noted with their own codes; picking another model clears the model note", async () => {
    const t = await setup();
    t.setAnswer(() => new Response('{"error":{"message":"Your credit balance is too low"}}', { status: 400 }));
    const credit = await t.c.post("/api/ai/summary", { messageId: t.messageId });
    expect(credit.status).toBe(409);
    expect(credit.body.error.code).toBe("ai_no_credit");
    expect((await t.keyRow())?.problem).toBe("no_credit");
    t.setAnswer(() => new Response('{"error":{"message":"model: claude-3-5-haiku-latest"}}', { status: 404 }));
    const gone = await t.c.post("/api/ai/summary", { messageId: t.messageId });
    expect(gone.body.error.code).toBe("ai_model_unavailable");
    expect((await t.keyRow())?.problem).toBe("model_unavailable");
    expect((await t.c.put("/api/ai/model", { model: "claude-sonnet-5-5" })).status).toBe(200);
    expect((await t.keyRow())?.problem).toBeNull();
  });

  it("a passing failure (a 500 or a rate limit) is not noted and stays a 502 with plain words", async () => {
    const t = await setup();
    t.setAnswer(() => new Response("SECRET_BODY overloaded", { status: 529 }));
    const r = await t.c.post("/api/ai/summary", { messageId: t.messageId });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("ai_provider_error");
    noSecret(r.body);
    expect((await t.keyRow())?.problem).toBeNull();
  });

  it("a new key clears the note, and a late refusal of the old key never marks the new one", async () => {
    const t = await setup();
    t.setAnswer(refused);
    await t.c.post("/api/ai/summary", { messageId: t.messageId });
    const { keyFor } = await import("@/server/services/ai/keys");
    const oldKey = await keyFor(t.deps, t.orgId);
    t.setAnswer(goodAnthropic);
    expect((await t.c.post("/api/ai/connect", { apiKey: ANT2 })).status).toBe(200);
    expect((await t.keyRow())?.problem).toBeNull();
    t.setAnswer(refused);
    await expect(oldKey!.provider.complete({ system: "s", user: "u" })).rejects.toThrow();
    expect((await t.keyRow())?.problem).toBeNull();
  });

  it("the model list says the key was refused, notes it, and keeps no cached copy", async () => {
    const t = await setup();
    t.setAnswer(refused);
    const m = await t.c.post("/api/ai/models", { refresh: true });
    expect(m.body).toMatchObject({ live: false, problem: "key_refused" });
    expect(m.body.note).toMatch(/refused this key/);
    expect((await t.keyRow())?.problem).toBe("key_refused");
    const before = t.calls.length;
    t.setAnswer(goodAnthropic);
    await t.clearLimits();
    const again = await t.c.post("/api/ai/models", {});
    expect(t.calls.length).toBeGreaterThan(before);
    expect(again.body).toMatchObject({ live: true, note: null });
  });
});

describe("built-in AI stands in for a refused key, and says so (QUAL1, row 14)", () => {
  const fakeAi = () => ({ run: vi.fn(async () => ({ response: '{"summary":"Built in summary.","actionItems":[]}', usage: { prompt_tokens: 40, completion_tokens: 8 } })) });

  it("Summarise answers from built-in AI with a fallback note, without calling the refused key twice", async () => {
    const t = await setup();
    const ai = fakeAi();
    t.deps.ai = ai as unknown as typeof t.deps.ai;
    t.setAnswer(refused);
    const before = t.calls.filter((u) => u.includes("/v1/messages")).length;
    const r = await t.c.post("/api/ai/summary", { messageId: t.messageId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ summary: "Built in summary.", provider: "builtin", fallback: { reason: "key_refused" } });
    expect(r.body.fallback.message).toMatch(/^Built-in AI wrote this because Anthropic refused your workspace's AI key\./);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(t.calls.filter((u) => u.includes("/v1/messages")).length - before).toBe(1);
    expect((await t.keyRow())?.problem).toBe("key_refused");
  });

  it("AI_KEY_FALLBACK=off keeps the plain 409 instead", async () => {
    const t = await setup({ AI_KEY_FALLBACK: "off" });
    const ai = fakeAi();
    t.deps.ai = ai as unknown as typeof t.deps.ai;
    t.setAnswer(refused);
    const r = await t.c.post("/api/ai/summary", { messageId: t.messageId });
    expect(r.status).toBe(409);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("the Tools door (askAi) falls through to the free service with a note, and never shows the provider's words", async () => {
    const t = await setup();
    const ai = fakeAi();
    t.deps.ai = ai as unknown as typeof t.deps.ai;
    t.setAnswer(refused);
    const r = await askAi(t.deps, t.orgId, { task: "chat", system: "s", user: "u" });
    expect(r).toMatchObject({ ok: true, source: "free", fallback: { reason: "key_refused" } });
    // Without built-in AI the refusal is plain words, not the provider's body.
    t.deps.ai = undefined;
    const plain = await askAi(t.deps, t.orgId, { task: "chat", system: "s", user: "u" });
    expect(plain).toEqual({ ok: false, reason: "error", message: REFUSED });
    noSecret(plain);
  });

  it("Team AI is not 'Ready on your key' while it is refused: built-in AI runs and the answer says so", async () => {
    const t = await setup();
    const ai = { run: vi.fn(async () => ({ response: "Built in draft", usage: { prompt_tokens: 50, completion_tokens: 20 } })) };
    t.deps.ai = ai as unknown as typeof t.deps.ai;
    expect((await t.c.get("/api/team-ai/state")).body.ai).toMatchObject({ key: true, source: "own_key" });
    t.setAnswer(refused);
    const set = await t.c.post("/api/team-ai/instructions", { name: "Standup", body: "Write a standup summary", shared: true });
    const run = (await t.c.post(`/api/team-ai/instructions/${set.body.id}/run`)).body;
    expect(run.status).toBe("done");
    expect(run.result).toMatch(/^Built in draft\n\nBuilt-in AI wrote this because Anthropic refused/);
    const st = (await t.c.get("/api/team-ai/state")).body.ai;
    expect(st).toMatchObject({ key: true, source: "built_in", keyProblem: "key_refused", keyProblemMessage: REFUSED });
    // No built-in AI here: nothing can run, the run says why in plain words.
    t.deps.ai = undefined;
    expect((await t.c.get("/api/team-ai/state")).body.ai).toMatchObject({ source: "none", keyProblem: "key_refused" });
    const failed = (await t.c.post(`/api/team-ai/instructions/${set.body.id}/run`)).body;
    expect(failed).toMatchObject({ status: "failed", reason: "key_refused" });
    expect(failed.reasonText).toMatch(/refused the workspace's AI key/);
  });

  it("names the provider in every message", () => {
    expect(REFUSED).toBe(`${AI_PROVIDER_INFO.anthropic.name} refused your workspace's AI key. An admin can paste a new key in Settings, AI.`);
  });
});
