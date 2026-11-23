/**
 * QUAL1 review (defect 3, audit rows 12 and 14): the mail Translate button (POST /api/translate, R116) goes through the
 * Tools door askAi, but its service (services/translate-r116.ts) dropped both the fallback note and the key problem:
 *  - with the stand-in on, built-in AI translated the mail (another processor than the one the workspace chose) and
 *    nothing in the answer said so;
 *  - without it, a refused key answered 502 ai_failed "The translation failed. Try again in a moment.", where the other
 *    AI routes answer 409 ai_key_refused with the plain sentence and the fix link.
 * The document tools' Ask and Translate (routes/tools-ai.ts aiFail) answered 503 ai_error for the same refusal; they
 * now share the one 409 (aiRefusalError).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { makeTestApp, Client } from "./helpers";
import { aiKeys } from "@/server/db/schema";
import { clearTranslateCache } from "@/server/services/translate-r116";
import { aiRefusalError } from "@/server/services/tools/ai-meter";
import { aiKeyProblemText } from "@/shared/ai-connect-ai2";

const ANT = "sk-ant-api03-" + "a".repeat(40) + "WXYZ";
type Answer = (url: string, init?: RequestInit) => Response;
const good: Answer = (url, init) => {
  const h = new Headers(init?.headers);
  if (url.includes("api.anthropic.com/v1/models")) return h.get("x-api-key") ? Response.json({ data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] }) : new Response("missing", { status: 401 });
  if (url.includes("api.anthropic.com/v1/messages")) return Response.json({ content: [{ type: "text", text: '["NE Hello"]' }] });
  return new Response("not found", { status: 404 });
};
const refused: Answer = () => new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 });
const TEXT = "Please send the invoice for this week, thanks.";

async function setup(env: Record<string, string> = {}) {
  clearTranslateCache();
  let answer: Answer = good;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => answer(String(input), init)) as typeof fetch;
  const ctx = await makeTestApp({ AI_CONNECT_AI2: "on", TRANSLATE_R116: "on", ASK_TD1: "on", ...env }, { fetch: fetchImpl });
  const builtinCalls: unknown[] = [];
  ctx.deps.ai = {
    async run(_model: string, input: unknown) {
      builtinCalls.push(input);
      const msgs = (input as { messages?: { role: string; content: string }[] }).messages;
      if (msgs) {
        const arr = JSON.parse(msgs.find((m) => m.role === "user")!.content) as string[];
        return { response: JSON.stringify(arr.map((s) => `BUILTIN ${s}`)), usage: { prompt_tokens: 100, completion_tokens: 50 } };
      }
      return { translated_text: "BUILTIN" };
    },
  } as never;
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Ada Owner", "Acme");
  expect((await c.post("/api/ai/connect", { apiKey: ANT })).status).toBe(200);
  return { ...ctx, c, builtinCalls, setAnswer: (f: Answer) => { answer = f; } };
}

describe("mail Translate on a refused workspace key (QUAL1 review)", () => {
  beforeEach(() => clearTranslateCache());

  it("default: the workspace agent translates, the answer says the key was skipped, and the key stays marked", async () => {
    const t = await setup();
    t.setAnswer(refused);
    const r = await t.c.post("/api/translate", { texts: [TEXT], target: "ne" });
    expect(r.status).toBe(200);
    expect(t.builtinCalls.length).toBeGreaterThan(0);
    expect(r.body.fallback).toMatchObject({ reason: "key_refused" });
    expect((await t.deps.db.select().from(aiKeys).get())?.problem).toBe("key_refused");
  });

  it("without built-in AI: the same 409, not 502 'try again'", async () => {
    const t = await setup({ AI_KEY_FALLBACK: "on" });
    t.deps.ai = undefined;
    t.setAnswer(refused);
    const r = await t.c.post("/api/translate", { texts: [TEXT], target: "ne" });
    expect({ status: r.status, code: r.body.error?.code }).toEqual({ status: 409, code: "ai_key_refused" });
  });

  it("with the stand-in on: built-in AI translates and the answer says so, also when served again from the cache", async () => {
    const t = await setup({ AI_KEY_FALLBACK: "on" });
    t.setAnswer(refused);
    const r = await t.c.post("/api/translate", { texts: [TEXT], target: "ne" });
    expect(r.status).toBe(200);
    expect(t.builtinCalls.length).toBeGreaterThan(0);
    expect((await t.deps.db.select().from(aiKeys).get())?.problem).toBe("key_refused");
    expect(r.body.fallback).toMatchObject({ reason: "key_refused" });
    expect(r.body.fallback.message).toMatch(/^Built-in AI wrote this because Anthropic refused/);
    const again = await t.c.post("/api/translate", { texts: [TEXT], target: "ne" });
    expect(again.body).toMatchObject({ cached: true, fallback: { reason: "key_refused" } });
  });

  it("a working key's answer carries no fallback", async () => {
    const t = await setup({ AI_KEY_FALLBACK: "on" });
    const r = await t.c.post("/api/translate", { texts: [TEXT], target: "ne" });
    expect(r.status).toBe(200);
    expect(r.body.fallback).toBeUndefined();
    expect(t.builtinCalls).toHaveLength(0);
  });
});

describe("the document tools' Ask and Translate share the 409 for a refused key (QUAL1 review)", () => {
  it("aiRefusalError turns a key problem into 409 ai_<problem> with the fix link, and leaves other refusals alone", () => {
    const e = aiRefusalError({ ok: false, reason: "error", message: "Anthropic refused your workspace's AI key.", problem: "key_refused" });
    expect(e).toMatchObject({ status: 409, code: "ai_key_refused", details: { fix: "/app/settings#ai" } });
    expect(aiRefusalError({ ok: false, reason: "error", message: "Try again." })).toBeNull();
    expect(aiRefusalError({ ok: false, reason: "limit", message: "Limit." })).toBeNull();
    expect(aiRefusalError({ ok: true, source: "free", text: "", texts: [], units: 0 })).toBeNull();
  });

  it("POST /api/tools/ai/ask on a refused key answers 409 ai_key_refused with the fix link (was 503 ai_error)", async () => {
    // A fake document engine (signed like tests/tools-ai-routes-p2.test.ts); any other host, here the workspace's
    // provider, answers 401 as a provider refusing the key does.
    const ENGINE_KEY = "k".repeat(40);
    const env = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: ENGINE_KEY, TOOLS_TOKEN_KEY: "t".repeat(40), TOOLS_FEATURES: "all" };
    const jobs = new Map<string, { ws: string; op: string }>();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host !== "engine.test") return new Response('{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}', { status: 401 });
      const h = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const want = createHmac("sha256", ENGINE_KEY).update(["v1", method, url.pathname + url.search, h.get("x-multies-ts"), h.get("x-multies-nonce"), h.get("x-multies-ws"), h.get("x-multies-user"), h.get("x-multies-max-bytes"), h.get("content-length") ?? "0"].join("\n")).digest("hex");
      if (h.get("x-multies-sig") !== want) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (method === "POST" && url.pathname === "/internal/v1/jobs") {
        const id = (Math.random().toString(16).slice(2) + "0000000000000000").slice(0, 16) + "cafe";
        jobs.set(id, { ws: h.get("x-multies-ws")!, op: url.searchParams.get("op")! });
        return Response.json({ id, status: "queued" }, { status: 202 });
      }
      const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
      const job = m ? jobs.get(m[1]) : undefined;
      if (!job) return Response.json({ error: "not_found" }, { status: 404 });
      if (!m![2]) return Response.json({ id: m![1], op: job.op, status: "done", output: { bytes: 10 } });
      return Response.json({ pages: [{ page: 1, text: "Clause 7. The bond is $4,000." }] });
    }) as typeof fetch;
    const ctx = await makeTestApp(env, { fetch: fetchImpl });
    const run = vi.fn(async () => ({ response: "- Built in", usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    ctx.deps.ai = { run } as never;
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Ada Lovelace", "Acme");
    expect((await c.put("/api/ai/key", { provider: "openai", apiKey: "sk-test-0123456789abcdefWXYZ" })).status).toBeLessThan(300);
    const fd = new FormData();
    fd.append("file", new Blob(["%PDF-1.4\n"], { type: "application/pdf" }), "lease.pdf");
    const up = await ctx.app.request("/api/tools/ai/read/upload?feature=ask", { method: "POST", headers: { cookie: c.cookie, host: "localhost", "x-multies-upload": "1" }, body: fd });
    const token = ((await up.json()) as { token: string }).token;
    const r = await c.post("/api/tools/ai/ask", { token, question: "How much is the bond?" });
    expect({ status: r.status, error: r.body.error }).toMatchObject({
      status: 409, error: { code: "ai_key_refused", message: aiKeyProblemText("key_refused", "OpenAI"), details: { fix: "/app/settings#ai" } },
    });
    expect(run).not.toHaveBeenCalled(); // default: the document goes to no other processor
  });
});
