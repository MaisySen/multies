/**
 * QUAL1 review (defect 2, audit row 14): keyProblemOf used to read every 401 or 403 as "the key was refused" and any
 * body with "credit" or "billing" as "no credit". On a live call the request text comes from outside (an inbound mail,
 * a form answer), and OpenRouter answers 403 when its moderation flags that text, on a working key. That 403 marked
 * the key refused (or out of credit: the body says "No credits were charged"), answered 409, could send the flagged
 * mail to built-in AI, and the next clean mail cleared it, so an outside sender decided what Settings showed, with
 * one ai_keys write per flip. Now only failures about the key, its credit or its model count; the request's own
 * content (moderation, guardrails, too long) and rate limits never do.
 * The provider bodies below follow each provider's documented error shape; the exact words are illustrative.
 */
import { describe, it, expect, vi } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { verifiedDomain } from "./priv1a-world";
import { deliverInbound } from "@/server/services/mail/delivery";
import { aiKeys } from "@/server/db/schema";
import { AiProviderError, keyProblemOf, mapFailure } from "@/server/services/ai/providers";

const OR_KEY = "sk-or-v1-" + "0123456789abcdef".repeat(4);
const MODERATED = JSON.stringify({ error: { code: 403, message: "openai/gpt-4o-mini requires moderation on OpenAI. Your input was flagged for \"harassment\". No credits were charged.", metadata: { reasons: ["harassment"], flagged_input: "...", provider_name: "OpenAI", model_slug: "openai/gpt-4o-mini" } } });
const GUARDRAIL = '{"error":{"code":403,"message":"Request blocked by a guardrail on this key"}}';
const CONTEXT = '{"error":{"message":"This model\'s maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages.","type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}';
const GROQ_RATE = '{"error":{"message":"Rate limit reached for model `llama-3.1-8b-instant` in organization `org_x` on tokens per minute (TPM): Limit 6000, Used 5000, Requested 2000. Please try again in 10s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}';
const err = (provider: "openrouter" | "openai" | "anthropic" | "groq" | "gemini" | "custom", status: number, body: string) => new AiProviderError(provider, status, body.slice(0, 300));

describe("only failures about the key, its credit or its model are noted on the key (QUAL1 review)", () => {
  it("the request's own content is never the key's problem", () => {
    expect(keyProblemOf(err("openrouter", 403, MODERATED))).toBeNull();
    expect(keyProblemOf(err("openrouter", 403, GUARDRAIL))).toBeNull();
    expect(keyProblemOf(err("custom", 400, CONTEXT))).toBeNull();
    expect(keyProblemOf(err("openai", 400, CONTEXT))).toBeNull();
  });

  it("rate limits are passing, even with a billing link in the answer", () => {
    expect(keyProblemOf(err("groq", 429, GROQ_RATE))).toBeNull();
    expect(mapFailure(429, GROQ_RATE)).toBe("rate_limited"); // the connection test no longer says "no credit" either
  });

  it("a 403 that names nothing about the key is passing on a live call", () => {
    expect(keyProblemOf(err("custom", 403, ""))).toBeNull();
    expect(keyProblemOf(err("custom", 403, "<html>Request blocked</html>"))).toBeNull();
  });

  it("real key, credit and model answers still count", () => {
    expect(keyProblemOf(err("anthropic", 401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'))).toBe("key_refused");
    expect(keyProblemOf(err("anthropic", 403, '{"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}'))).toBe("key_refused");
    expect(keyProblemOf(err("gemini", 400, '[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]'))).toBe("key_refused");
    expect(keyProblemOf(err("openai", 429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}'))).toBe("no_credit");
    expect(keyProblemOf(err("anthropic", 400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'))).toBe("no_credit");
    expect(keyProblemOf(err("openrouter", 402, '{"error":{"code":402,"message":"Insufficient credits"}}'))).toBe("no_credit");
    expect(keyProblemOf(err("openai", 404, '{"error":{"message":"The model `gpt-9` does not exist or you do not have access to it.","code":"model_not_found"}}'))).toBe("model_unavailable");
    expect(keyProblemOf(err("groq", 400, '{"error":{"message":"The model `llama-3.1-70b-versatile` has been decommissioned and is no longer supported.","code":"model_decommissioned"}}'))).toBe("model_unavailable");
    expect(keyProblemOf(err("openrouter", 400, '{"error":{"code":400,"message":"openai/gpt-9.1 is not a valid model ID"}}'))).toBe("model_unavailable");
  });

  it("a flagged inbound mail neither marks a working OpenRouter key nor goes to built-in AI, and costs no writes", async () => {
    let flagged = false;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/models")) return Response.json({ data: [{ id: "openai/gpt-4o-mini", name: "GPT-4o mini" }] });
      if (url.endsWith("/api/v1/key")) return Response.json({ data: { label: "x" } });
      if (url.endsWith("/chat/completions")) {
        return flagged ? new Response(MODERATED, { status: 403 })
          : Response.json({ choices: [{ message: { content: '{"summary":"A short note.","actionItems":[]}' } }] });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    // The stand-in is on here, so "no built-in AI call" proves the classification, not the default.
    const ctx = await makeTestApp({ AI_CONNECT_AI2: "on", ASK_TD1: "on", AI_KEY_FALLBACK: "on" }, { fetch: fetchImpl });
    const builtin = vi.fn(async () => ({ response: '{"summary":"Built in.","actionItems":[]}', usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    ctx.deps.ai = { run: builtin } as never;
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Ada Owner", "Acme");
    const domainId = await verifiedDomain(ctx, c, "acme.io");
    const box = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox;
    expect((await c.post("/api/ai/connect", { apiKey: OR_KEY })).status).toBe(200);
    await deliverInbound(ctx.deps, {
      envelopeFrom: "mallory@outside.example", rcptTo: "hello@acme.io", sizeBytes: 500, via: "test",
      email: { messageId: "<m1@outside.example>", from: { address: "mallory@outside.example" }, to: [{ address: "hello@acme.io" }], cc: [], subject: "hello",
        text: "Text the provider's moderation flags.", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const messageId = (await c.get(`/api/mail/messages?mailboxId=${box.id}&folder=inbox`)).body.messages[0].id as string;
    const key = () => ctx.deps.db.select().from(aiKeys).get();

    // Count the writes to ai_keys (UPDATE statements).
    const client = (ctx.db as unknown as { $client: { prepare: (q: string) => unknown } }).$client;
    const prepare = client.prepare.bind(client);
    let keyUpdates = 0;
    client.prepare = (q: string) => { if (/^\s*update\s+"?ai_keys"?/i.test(q)) keyUpdates++; return prepare(q); };

    const states: (string | null)[] = [];
    for (const f of [true, false, true, false]) {
      flagged = f;
      await c.post("/api/ai/summary", { messageId });
      states.push((await key())?.problem ?? null);
    }
    flagged = true;
    const r = await c.post("/api/ai/summary", { messageId });
    const seen = {
      status: r.status, code: r.body.error?.code ?? null, provider: r.body.provider ?? null, problem: (await key())?.problem ?? null,
      builtinCalls: builtin.mock.calls.length, flips: states, keyUpdates,
    };
    expect(seen).toEqual({ status: 502, code: "ai_provider_error", provider: null, problem: null, builtinCalls: 0, flips: [null, null, null, null], keyUpdates: 0 });
    // Plain words that do not blame the key or promise a retry will work.
    expect(r.body.error.message).toBe("OpenRouter would not answer this request (status 403). It may be too long, or the provider's content rules stopped it.");
    expect(JSON.stringify(r.body)).not.toContain("harassment");
  });
});
