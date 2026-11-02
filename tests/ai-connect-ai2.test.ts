/**
 * AI2 (AI_CONNECT_AI2): connect AI properly. Provider detection, model list parsing per provider (fixtures), the
 * recommended pick and the curated fallback, plain error mapping, the SSRF guard for a custom server, the routes
 * (admin, CSRF, rate limit, no key ever returned), the one tap OpenRouter sign in (PKCE S256, one use state bound
 * to the person, workspace and browser, 10 minutes), and built-in AI under the hard daily cap.
 */
import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { cleanPastedKey, detectProvider, pickRecommended, AI2_CURATED_MODELS, AI2_RESULT_TEXT } from "@/shared/ai-connect-ai2";
import { checkBaseUrl, isBlockedIp, mapFailure, parseModels, s256, OAUTH_STATE_MS } from "@/server/services/ai/connect-ai2";
import { askBuiltin, BUILTIN_LIMIT_MESSAGE } from "@/server/services/ai/builtin-ai2";
import { GLOBAL_DAILY_UNITS, GLOBAL_ROW } from "@/server/services/tools/ai-meter";
import { dayOf } from "@/server/services/tools/usage";
import { aiKeys, aiOauthStates, auditLogs } from "@/server/db/schema";

const ANT = "sk-ant-api03-" + "a".repeat(40) + "WXYZ";
const OR_KEY = "sk-or-v1-" + "b".repeat(56);

describe("AI2 provider detection", () => {
  it("names the provider from the key format and cleans what a paste picks up", () => {
    expect(detectProvider(ANT)).toBe("anthropic");
    expect(detectProvider(OR_KEY)).toBe("openrouter");
    expect(detectProvider("gsk_" + "c".repeat(40))).toBe("groq");
    expect(detectProvider("AIzaSy" + "d".repeat(33))).toBe("gemini");
    expect(detectProvider("sk-proj-" + "e".repeat(40))).toBe("openai");
    expect(detectProvider("sk-" + "f".repeat(48))).toBe("openai");
    expect(detectProvider("sk-0123456789abcdef0123456789abcdef")).toBe("deepseek");
    expect(detectProvider("something-else-entirely-1234")).toBeNull();
    expect(detectProvider("sk-ant")).toBeNull();
    expect(cleanPastedKey(`  ${ANT}\n`)).toBe(ANT);
    expect(cleanPastedKey(`"${ANT.slice(0, 20)}\n${ANT.slice(20)}"`)).toBe(ANT);
  });
});

describe("AI2 model lists", () => {
  it("parses each provider's list and keeps chat models only", () => {
    expect(parseModels("anthropic", { data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] })).toEqual([{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5" }]);
    expect(parseModels("openai", { data: [{ id: "gpt-6-luna" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "gpt-4o-realtime-preview" }, { id: "o4-mini" }] }).map((m) => m.id)).toEqual(["gpt-6-luna", "o4-mini"]);
    expect(parseModels("gemini", { models: [
      { name: "models/gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash Lite", supportedGenerationMethods: ["generateContent", "countTokens"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      { name: "models/imagen-4", supportedGenerationMethods: ["generateContent"] },
    ] })).toEqual([{ id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" }]);
    expect(parseModels("groq", { data: [{ id: "llama-3.1-8b-instant", active: true }, { id: "whisper-large-v3" }, { id: "old-model", active: false }] }).map((m) => m.id)).toEqual(["llama-3.1-8b-instant"]);
    expect(parseModels("mistral", { data: [{ id: "mistral-small-latest", capabilities: { completion_chat: true } }, { id: "mistral-embed", capabilities: { completion_chat: false } }, { id: "mistral-small-latest" }] }).map((m) => m.id)).toEqual(["mistral-small-latest"]);
    expect(parseModels("openrouter", { data: [{ id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5" }, { id: "x/image-gen", name: "Image", architecture: { output_modalities: ["image"] } }] }).map((m) => m.id)).toEqual(["anthropic/claude-haiku-5.5"]);
    expect(parseModels("deepseek", { data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }).length).toBe(2);
    // Junk never reaches the browser: odd ids are dropped, and a missing list is an empty one.
    expect(parseModels("custom", { data: [{ id: "<script>" }, { id: "ok-model" }, { id: 5 }] }).map((m) => m.id)).toEqual(["ok-model"]);
    expect(parseModels("custom", null)).toEqual([]);
  });

  it("recommends a small fast model: the newest stable match, else the first", () => {
    const ids = (a: string[]) => a.map((id) => ({ id, name: id }));
    expect(pickRecommended("anthropic", ids(["claude-opus-5-5", "claude-haiku-4-5", "claude-haiku-5-5", "claude-sonnet-5-5"]))).toBe("claude-haiku-5-5");
    expect(pickRecommended("openai", ids(["gpt-6.1-sol", "gpt-5.6-luna", "gpt-6-luna", "gpt-6-luna-pro"]))).toBe("gpt-6-luna");
    expect(pickRecommended("gemini", ids(["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-4-flash-lite-preview"]))).toBe("gemini-3.5-flash-lite");
    expect(pickRecommended("groq", ids(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]))).toBe("llama-3.1-8b-instant");
    expect(pickRecommended("custom", ids(["b-model", "a-model"]))).toBe("b-model");
    expect(pickRecommended("openai", [])).toBeNull();
    for (const [p, list] of Object.entries(AI2_CURATED_MODELS)) if (list.length) expect(pickRecommended(p as never, list)).toBe(list[0]!.id);
  });

  it("maps provider failures to plain words, reading the body only for a few words", () => {
    expect(mapFailure(401, "{}")).toBe("key_refused");
    expect(mapFailure(403, "forbidden")).toBe("key_refused");
    expect(mapFailure(402, "")).toBe("no_credit");
    expect(mapFailure(429, '{"error":{"code":"insufficient_quota"}}')).toBe("no_credit");
    expect(mapFailure(400, "Your credit balance is too low")).toBe("no_credit");
    expect(mapFailure(429, "slow down")).toBe("rate_limited");
    expect(mapFailure(404, "")).toBe("model_unavailable");
    expect(mapFailure(400, '{"error":{"message":"The model `x` does not exist"}}')).toBe("model_unavailable");
    expect(mapFailure(null)).toBe("unreachable");
    expect(mapFailure(500, "boom")).toBe("provider_error");
    expect(AI2_RESULT_TEXT.key_refused).toBe("That key was refused. Check it and paste it again.");
  });
});

describe("AI2 SSRF guard for a custom server", () => {
  it("blocks private, loopback, link local and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12::3", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "[::1]"]) expect(isBlockedIp(ip), ip).toBe(true);
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it("takes only a public https address, by name and by every address it resolves to", async () => {
    const pub = async () => ["93.184.216.34"];
    await expect(checkBaseUrl("https://api.example.com/v1/", pub)).resolves.toBe("https://api.example.com/v1");
    const bad = ["http://api.example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://[::1]/v1", "https://169.254.169.254/latest", "https://10.0.0.5/v1",
      "https://user:pw@api.example.com/v1", "https://api.example.com:8443/v1", "https://box.internal/v1", "https://printer.local/v1", "https://intranet/v1", "https://api.example.com/v1?x=1", "not a url", "file:///etc/passwd"];
    for (const u of bad) await expect(checkBaseUrl(u, pub), u).rejects.toMatchObject({ status: 400 });
    await expect(checkBaseUrl("https://rebind.example.com/v1", async () => ["93.184.216.34", "10.0.0.1"])).rejects.toMatchObject({ status: 400 });
    await expect(checkBaseUrl("https://nowhere.example.com/v1", async () => [])).rejects.toMatchObject({ status: 400 });
  });
});

type Call = { url: string; method: string; headers: Record<string, string>; body: string; redirect?: string };

async function setup(env: Record<string, string> = { AI_CONNECT_AI2: "on" }) {
  const calls: Call[] = [];
  let answer: (url: string, init?: RequestInit) => Response = (url) => {
    if (url.includes("api.anthropic.com/v1/models")) return Response.json({ data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }, { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] });
    if (url.includes("openrouter.ai/api/v1/models")) return Response.json({ data: [{ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5" }, { id: "openai/gpt-6-luna", name: "GPT 6 Luna" }] });
    if (url.includes("openrouter.ai/api/v1/auth/keys")) return Response.json({ key: OR_KEY });
    if (url.includes("api.anthropic.com/v1/messages")) return Response.json({ content: [{ type: "text", text: "OK" }] });
    if (url.includes("cloudflare-dns.com")) return Response.json({ Answer: [{ type: 1, data: "93.184.216.34" }] });
    if (url.includes("/chat/completions")) return Response.json({ choices: [{ message: { content: "OK" } }] });
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "my-model" }] });
    return new Response("not found", { status: 404 });
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? ""), redirect: init?.redirect });
    return answer(url, init);
  }) as typeof fetch;
  const ctx = await makeTestApp({ APP_URL: "https://app.example.com", ...env }, { fetch: fetchImpl });
  const c = new Client(ctx.app);
  await c.signup();
  const me = await c.get("/api/account/me");
  const orgId = (me.body as { organization?: { id: string } }).organization?.id ?? "";
  return { ...ctx, c, orgId, calls, setAnswer: (f: typeof answer) => { answer = f; } };
}

const noSecret = (x: unknown) => { const s = JSON.stringify(x); expect(s).not.toContain(ANT); expect(s).not.toContain(OR_KEY); expect(s).not.toContain("SECRET_BODY"); };

describe("AI2 routes", () => {
  it("flag off: the old screen's data and no new routes", async () => {
    const { c } = await setup({});
    const s = await c.get("/api/ai/status");
    expect(s.body.ai2).toBeUndefined();
    expect(s.body.providers.map((p: { id: string }) => p.id)).toEqual(["openai", "anthropic", "openrouter", "groq"]);
    for (const [m, p] of [["POST", "/api/ai/connect"], ["POST", "/api/ai/models"], ["POST", "/api/ai/test"], ["PUT", "/api/ai/model"], ["GET", "/api/ai/oauth/openrouter/start"]] as const) {
      expect((await c.call(m, p, m === "GET" ? undefined : { apiKey: ANT, model: "x" })).status, p).toBe(404);
    }
    expect((await c.put("/api/ai/key", { provider: "gemini", apiKey: "AIza" + "x".repeat(30) })).status).toBe(422);
  });

  it("connects with a pasted key: detects the provider, checks the key server side, saves the recommended model, never returns the key", async () => {
    const { c, calls, db, orgId } = await setup();
    const s0 = await c.get("/api/ai/status");
    expect(s0.body.ai2).toBe(true);
    expect(s0.body.cards.length).toBe(8);
    const r = await c.post("/api/ai/connect", { apiKey: `  ${ANT}\n` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ connected: true, provider: "anthropic", model: "claude-haiku-5-5", keyHint: "WXYZ", live: true });
    noSecret(r.body);
    const list = calls.find((x) => x.url.startsWith("https://api.anthropic.com/v1/models"))!;
    expect(list.headers["x-api-key"]).toBe(ANT);
    expect(list.redirect).toBe("manual");
    const row = await db.select().from(aiKeys).get();
    expect(row?.keyEnc).not.toContain(ANT);
    // The cached list answers without another provider call; a refresh reads it live again.
    const before = calls.length;
    const m = await c.post("/api/ai/models", {});
    expect(m.body).toMatchObject({ provider: "anthropic", recommended: "claude-haiku-5-5", live: true, current: "claude-haiku-5-5", note: null });
    expect(m.body.models.map((x: { id: string }) => x.id)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(calls.length).toBe(before);
    await c.post("/api/ai/models", { refresh: true });
    expect(calls.length).toBe(before + 1);
    noSecret(m.body);
    expect((await c.put("/api/ai/model", { model: "claude-sonnet-5-5" })).body).toEqual({ model: "claude-sonnet-5-5" });
    expect((await c.put("/api/ai/model", { model: "bad model <x>" })).status).toBe(400);
    expect((await c.get("/api/ai/status")).body.model).toBe("claude-sonnet-5-5");
    const actions = (await db.select({ a: auditLogs.action, m: auditLogs.metadata }).from(auditLogs).all()).filter((x) => String(x.a).startsWith("ai_key."));
    expect(actions.map((x) => x.a)).toEqual(expect.arrayContaining(["ai_key.saved", "ai_key.model_changed"]));
    noSecret(actions);
    expect(orgId).toBeTruthy();
  });

  it("a refused key is not saved and the reply is plain words, never the provider's body", async () => {
    const { c, setAnswer } = await setup();
    setAnswer(() => new Response('{"error":"SECRET_BODY invalid x-api-key"}', { status: 401 }));
    const r = await c.post("/api/ai/connect", { apiKey: ANT });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe(AI2_RESULT_TEXT.key_refused);
    noSecret(r.body);
    expect((await c.get("/api/ai/status")).body.connected).toBe(false);
    setAnswer(() => new Response("SECRET_BODY", { status: 402 }));
    expect((await c.post("/api/ai/connect", { apiKey: ANT })).body.error.message).toBe(AI2_RESULT_TEXT.no_credit);
    expect((await c.post("/api/ai/connect", { apiKey: "zz-not-a-known-format-123456" })).status).toBe(400);
  });

  it("falls back to the curated list when the live list cannot be read", async () => {
    const { c, setAnswer } = await setup();
    setAnswer(() => new Response("SECRET_BODY", { status: 503 }));
    const r = await c.post("/api/ai/connect", { apiKey: OR_KEY });
    expect(r.body).toMatchObject({ connected: true, provider: "openrouter", model: AI2_CURATED_MODELS.openrouter[0]!.id, live: false });
    const m = await c.post("/api/ai/models", {});
    expect(m.body.live).toBe(false);
    expect(m.body.note).toBe("Could not load the live list, showing common models.");
  });

  it("tests the connection with one tiny call and plain results", async () => {
    const { c, setAnswer, calls, db } = await setup();
    await c.post("/api/ai/connect", { apiKey: ANT });
    const ok = await c.post("/api/ai/test", {});
    expect(ok.body.ok).toBe(true);
    expect(ok.body.message).toMatch(/^Connected\. Replies in \d+\.\d s$/);
    const call = calls.find((x) => x.url === "https://api.anthropic.com/v1/messages")!;
    expect(JSON.parse(call.body).max_tokens).toBe(16);
    const cases: [number, string][] = [[401, AI2_RESULT_TEXT.key_refused], [402, AI2_RESULT_TEXT.no_credit], [404, AI2_RESULT_TEXT.model_unavailable], [429, AI2_RESULT_TEXT.rate_limited], [500, AI2_RESULT_TEXT.provider_error]];
    for (const [status, msg] of cases) {
      setAnswer(() => new Response('{"error":"SECRET_BODY"}', { status }));
      const r = await c.post("/api/ai/test", {});
      expect(r.body, String(status)).toMatchObject({ ok: false, message: msg, ms: null });
      noSecret(r.body);
      await db.run(sql`delete from api_rate_limits`);
    }
    const tested = (await db.select({ a: auditLogs.action }).from(auditLogs).all()).filter((x) => x.a === "ai_key.tested");
    expect(tested.length).toBe(6);
  });

  it("limits provider calls to 10 a minute per workspace, and blocks cross site posts", async () => {
    const { c } = await setup();
    await c.post("/api/ai/connect", { apiKey: ANT });
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await c.post("/api/ai/test", {})).status);
    expect(codes.filter((x) => x === 429).length).toBeGreaterThan(0);
    expect(codes.slice(0, 9).every((x) => x === 200)).toBe(true);
    const evil = await c.call("POST", "/api/ai/test", {}, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const signedOut = new Client((c as unknown as { app: never }).app);
    expect((await signedOut.post("/api/ai/models", {})).status).toBe(401);
  });

  it("a custom server: https public address only, calls never follow redirects", async () => {
    const { c, calls } = await setup();
    const bad = await c.post("/api/ai/connect", { apiKey: "my-own-server-key-123456", provider: "custom", baseUrl: "https://169.254.169.254/v1" });
    expect(bad.status).toBe(400);
    expect(calls.some((x) => x.url.includes("169.254"))).toBe(false);
    const ok = await c.post("/api/ai/connect", { apiKey: "my-own-server-key-123456", provider: "custom", baseUrl: "https://llm.example.com/v1/" });
    expect(ok.body).toMatchObject({ connected: true, provider: "custom", model: "my-model", baseHost: "llm.example.com" });
    await c.post("/api/ai/test", {});
    const chat = calls.find((x) => x.url === "https://llm.example.com/v1/chat/completions")!;
    expect(chat.redirect).toBe("manual");
  });
});

describe("AI2 one tap OpenRouter sign in", () => {
  async function start(ctx: Awaited<ReturnType<typeof setup>>) {
    const res = await ctx.app.request("/api/ai/oauth/openrouter/start", { headers: { cookie: ctx.c.cookie, host: "localhost" } });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    const nonce = /mm_ai_oauth=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
    return { loc, nonce };
  }
  const callback = (ctx: Awaited<ReturnType<typeof setup>>, q: Record<string, string>, nonce?: string) => ctx.app.request(`/api/ai/oauth/openrouter/callback?${new URLSearchParams(q)}`, {
    headers: { cookie: `${ctx.c.cookie}${nonce ? `; mm_ai_oauth=${nonce}` : ""}`, host: "localhost" },
  });

  it("uses PKCE S256 with an exact callback; the verifier stays on the server, encrypted", async () => {
    const ctx = await setup();
    const { loc, nonce } = await start(ctx);
    expect(loc.origin + loc.pathname).toBe("https://openrouter.ai/auth");
    expect(loc.searchParams.get("callback_url")).toBe("https://app.example.com/api/ai/oauth/openrouter/callback");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    const state = loc.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(30);
    expect(loc.toString()).not.toContain("verifier");
    const rows = await ctx.db.select().from(aiOauthStates).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.stateHash).not.toBe(state);
    const res = await callback(ctx, { code: "the-code", state }, nonce);
    expect(res.headers.get("location")).toBe("/app/settings?ai_connected=openrouter#ai");
    const ex = ctx.calls.find((x) => x.url === "https://openrouter.ai/api/v1/auth/keys")!;
    const body = JSON.parse(ex.body) as { code: string; code_verifier: string; code_challenge_method: string };
    expect(body.code).toBe("the-code");
    expect(body.code_challenge_method).toBe("S256");
    expect(await s256(body.code_verifier)).toBe(loc.searchParams.get("code_challenge"));
    const st = (await ctx.c.get("/api/ai/status")).body;
    expect(st).toMatchObject({ connected: true, provider: "openrouter", model: "anthropic/claude-haiku-5.5" });
    noSecret(st);
    // One use: the same state again is refused, and nothing is left behind.
    const again = await callback(ctx, { code: "the-code", state }, nonce);
    expect(again.headers.get("location")).toContain("ai_error=");
    expect((await ctx.db.select().from(aiOauthStates).all()).length).toBe(0);
  });

  it("refuses a bad state, another browser, another person and an expired start", async () => {
    const ctx = await setup();
    const a = await start(ctx);
    expect((await callback(ctx, { code: "x", state: "made-up-state-value-123" }, a.nonce)).headers.get("location")).toContain("ai_error=");
    const b = await start(ctx);
    expect((await callback(ctx, { code: "x", state: b.loc.searchParams.get("state")! }, "another-browser")).headers.get("location")).toContain("another+browser");
    const c2 = await start(ctx);
    ctx.deps.now = () => new Date(Date.now() + OAUTH_STATE_MS + 1000);
    expect((await callback(ctx, { code: "x", state: c2.loc.searchParams.get("state")! }, c2.nonce)).headers.get("location")).toContain("ai_error=");
    ctx.deps.now = () => new Date();
    const d = await start(ctx);
    const other = new Client(ctx.app);
    await other.signup();
    const res = await ctx.app.request(`/api/ai/oauth/openrouter/callback?${new URLSearchParams({ code: "x", state: d.loc.searchParams.get("state")! })}`, { headers: { cookie: `${other.cookie}; mm_ai_oauth=${d.nonce}`, host: "localhost" } });
    expect(res.headers.get("location")).toContain("ai_error=");
    expect((await callback(ctx, { error: "access_denied" }, d.nonce)).headers.get("location")).toContain("cancelled");
    expect(ctx.calls.some((x) => x.url.includes("/auth/keys"))).toBe(false);
    expect((await ctx.c.get("/api/ai/status")).body.connected).toBe(false);
  });
});

describe("AI2 built-in AI", () => {
  const fakeAi = () => ({ run: vi.fn(async () => ({ response: "Built in answer", usage: { prompt_tokens: 40, completion_tokens: 8 } })) });

  it("runs the assistant with no key, and the status shows it on with today's use", async () => {
    const ctx = await setup();
    const ai = fakeAi();
    ctx.deps.ai = ai;
    const r = await askBuiltin(ctx.deps, ctx.orgId, { system: "s", user: "u", maxTokens: 50 });
    expect(r).toEqual({ text: "Built in answer", provider: "builtin" });
    expect(ai.run).toHaveBeenCalledTimes(1);
    const s = (await ctx.c.get("/api/ai/status")).body;
    expect(s.builtin).toMatchObject({ available: true, active: true, paused: false, calls: 1 });
    await ctx.c.post("/api/ai/connect", { apiKey: ANT });
    expect((await ctx.c.get("/api/ai/status")).body.builtin.active).toBe(false);
  });

  it("makes no call once today's budget is spent, and says so plainly", async () => {
    const ctx = await setup();
    const ai = fakeAi();
    ctx.deps.ai = ai;
    const day = dayOf(ctx.deps.now());
    await ctx.db.run(sql`insert into ai_usage_daily (day, org_id, units, calls) values (${day}, ${GLOBAL_ROW}, ${GLOBAL_DAILY_UNITS - 1}, 1)`);
    await expect(askBuiltin(ctx.deps, ctx.orgId, { system: "s", user: "u" })).rejects.toMatchObject({ status: 429, message: BUILTIN_LIMIT_MESSAGE });
    expect(ai.run).not.toHaveBeenCalled();
    expect(GLOBAL_DAILY_UNITS).toBeLessThanOrEqual(8_000);
    const s = (await ctx.c.get("/api/ai/status")).body;
    expect(s.builtin).toMatchObject({ paused: true, message: BUILTIN_LIMIT_MESSAGE });
  });

  it("without the binding there is no built-in AI and nothing to call", async () => {
    const ctx = await setup();
    await expect(askBuiltin(ctx.deps, ctx.orgId, { system: "s", user: "u" })).rejects.toMatchObject({ status: 409 });
    expect((await ctx.c.get("/api/ai/status")).body.builtin).toMatchObject({ available: false, active: false });
  });
});
