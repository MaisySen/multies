/**
 * Round 2 (PR 20 leftover): catch up and the live meeting summary called the workspace's key directly
 * (providerFor().complete), not through askWorkspaceAi, so they skipped the AI routing every other AI path uses: with
 * AI_KEY_FALLBACK=on and a refused key, built-in AI never stood in there. They now go through askWorkspaceAi, so the
 * stand-in applies exactly where the deployment turned it on, and the answer says so (fallback).
 */
import { describe, it, expect, vi } from "vitest";
import { makeTestApp, Client } from "./helpers";

const ANT = "sk-ant-api03-" + "a".repeat(40) + "WXYZ";
const refused = () => new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 });
const good = (url: string, init?: RequestInit) => {
  const h = new Headers(init?.headers);
  if (url.includes("/v1/models")) return h.get("x-api-key") ? Response.json({ data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] }) : new Response("no", { status: 401 });
  if (url.includes("/v1/messages")) return Response.json({ content: [{ type: "text", text: "Sam renamed the plan." }] });
  return new Response("nf", { status: 404 });
};

async function setup(env: Record<string, string>) {
  let answer: (url: string, init?: RequestInit) => Response = good;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => answer(String(input), init)) as typeof fetch;
  const ctx = await makeTestApp({ AI_CONNECT_AI2: "on", ...env }, { fetch: fetchImpl });
  let clock = Date.now();
  ctx.deps.now = () => new Date((clock += 1000));
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  expect((await c.post("/api/ai/connect", { apiKey: ANT })).status).toBe(200);
  const invite = await c.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
  const m = new Client(ctx.app);
  await m.signup("mate@acme.io", "Sam Mate", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const doc = (await c.post("/api/docs", { title: "Plan" })).body.doc;
  await c.post("/api/catchup/visit", { type: "doc", id: doc.id });
  await m.patch(`/api/docs/${doc.id}`, { title: "Plan v2" });
  return { ctx, c, doc, setAnswer: (f: typeof answer) => { answer = f; } };
}

describe("Round 2: catch up goes through the workspace's AI routing", () => {
  it("AI_KEY_FALLBACK=on and a refused key: built-in AI writes the summary and says so", async () => {
    const t = await setup({ AI_KEY_FALLBACK: "on" });
    t.ctx.deps.ai = { run: vi.fn(async () => ({ response: "Built in catch up.", usage: { prompt_tokens: 20, completion_tokens: 5 } })) } as unknown as typeof t.ctx.deps.ai;
    t.setAnswer(refused);
    const r = await t.c.post("/api/catchup/summary", { type: "doc", id: t.doc.id });
    expect(r.status).toBe(200);
    expect(r.body.summary).toBe("Built in catch up.");
    expect(r.body.fallback).toMatchObject({ reason: "key_refused" });
  });

  it("with the stand-in off (the default) a refused key answers 409 ai_key_refused; a working key answers on the key", async () => {
    const t = await setup({});
    t.ctx.deps.ai = { run: vi.fn(async () => ({ response: "Should not run.", usage: { prompt_tokens: 1, completion_tokens: 1 } })) } as unknown as typeof t.ctx.deps.ai;
    const ok = await t.c.post("/api/catchup/summary", { type: "doc", id: t.doc.id });
    expect(ok.status).toBe(200);
    expect(ok.body.summary).toBe("Sam renamed the plan.");
    expect(ok.body.fallback).toBeUndefined();
    t.setAnswer(refused);
    const r = await t.c.post("/api/catchup/summary", { type: "doc", id: t.doc.id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("ai_key_refused");
  });
});
