/**
 * QUAL1 review (defect 4, audit row 14): when the provider refuses the workspace's own key and the deployment lets
 * built-in AI stand in (AI_KEY_FALLBACK=on), ask() returns `fallback`, but the forms AI draft
 * (POST /api/forms/td7/ai-draft, services/forms-td7/pro.ts) kept only `.text`, so the draft did not say built-in AI
 * wrote it. It now carries `fallback`, and by default a refused key answers 409 ai_key_refused with no other processor.
 */
import { describe, it, expect, vi } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { aiKeys } from "@/server/db/schema";

const ANT = "sk-ant-api03-" + "a".repeat(40) + "WXYZ";

async function setup(env: Record<string, string>) {
  let refused = false;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    if (url.includes("api.anthropic.com/v1/models")) return h.get("x-api-key") ? Response.json({ data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] }) : new Response("missing", { status: 401 });
    if (url.includes("api.anthropic.com/v1/messages")) return refused ? new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 }) : Response.json({ content: [{ type: "text", text: "OK" }] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const ctx = await makeTestApp({ FORMS_TD7: "on", AI_CONNECT_AI2: "on", ASK_TD1: "on", APP_URL: "http://localhost", ...env }, { fetch: fetchImpl });
  const answer = JSON.stringify({ name: "Volunteer signup", description: "Join us", fields: [{ label: "Your name", type: "text", required: true }] });
  const run = vi.fn(async () => ({ response: answer, usage: { prompt_tokens: 40, completion_tokens: 60 } }));
  ctx.deps.ai = { run } as never;
  const owner = new Client(ctx.app);
  await owner.signup("ada@acme.io", "Ada Lovelace", "Acme");
  expect((await owner.post("/api/ai/connect", { apiKey: ANT })).status).toBe(200);
  refused = true;
  return { ...ctx, owner, run };
}

describe("forms AI draft on a refused workspace key (QUAL1 review)", () => {
  it("with the stand-in on, says when built-in AI drafted the form in the key's place", async () => {
    const t = await setup({ AI_KEY_FALLBACK: "on" });
    const r = await t.owner.post("/api/forms/td7/ai-draft", { prompt: "A volunteer signup form" });
    expect(r.status).toBe(200);
    expect(t.run).toHaveBeenCalledTimes(1); // built-in AI wrote it
    expect((await t.deps.db.select().from(aiKeys).get())?.problem).toBe("key_refused");
    expect(r.body.draft.name).toBe("Volunteer signup");
    expect(r.body.fallback).toMatchObject({ reason: "key_refused" });
    expect(r.body.fallback.message).toMatch(/^Built-in AI wrote this because Anthropic refused/);
  });

  it("by default, the workspace agent drafts the form and the key stays marked", async () => {
    const t = await setup({});
    const r = await t.owner.post("/api/forms/td7/ai-draft", { prompt: "A volunteer signup form" });
    expect(r.status).toBe(200);
    expect(t.run).toHaveBeenCalled();
    expect(r.body.fallback).toMatchObject({ reason: "key_refused" });
    expect((await t.deps.db.select().from(aiKeys).get())?.problem).toBe("key_refused");
  });

  it("the form builder shows the note", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/web/pages/app/work/forms-td7/owner-td7.tsx", "utf8")).toContain("if (r.fallback) toast(r.fallback.message);");
  });
});
