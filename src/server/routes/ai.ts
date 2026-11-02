import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../context";
import { randomToken } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import { DbRateLimitStore } from "../lib/rate-limit";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { AI_PROVIDERS, AI_PROVIDER_INFO, BYO_AI_MESSAGE, aiKeyStatus, deleteAiKey, draftReply, invoiceChase, saveAiKey, summariseThread, triageMessage } from "../services/ai";
import { LEGACY_AI_PROVIDERS } from "../services/ai/providers";
import { AI2_PROVIDERS, AI2_PROVIDER_CARDS } from "../../shared/ai-connect-ai2";

const MessageRef = z.object({ messageId: z.string().min(1) });

const KeyInput = z.object({
  provider: z.enum(LEGACY_AI_PROVIDERS),
  apiKey: z.string().min(16).max(400),
  model: z.string().trim().max(120).optional(),
});

// AI2: connect with a pasted key (provider optional: the key's format can name it), a model and a model test.
const ConnectInput = z.object({
  apiKey: z.string().min(1).max(600),
  provider: z.enum(AI2_PROVIDERS).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).optional(),
});
const ModelInput = z.object({ model: z.string().trim().min(1).max(120) });
const TestInput = z.object({ model: z.string().trim().min(1).max(120).optional() });
const ListInput = z.object({ refresh: z.boolean().optional() });

/** AI2: 10 provider calls a minute per workspace (list, test, connect, sign in), shared by every isolate. */
const AI2_PER_MINUTE = 10;
async function ai2Limit(c: Context<AppEnv>) {
  const store = new DbRateLimitStore(() => c.var.deps.db);
  store.init({ windowMs: 60_000 });
  const { totalHits } = await store.increment(`ai2:${c.var.auth.orgId}`);
  if (totalHits > AI2_PER_MINUTE) {
    c.header("retry-after", "60");
    throw new HttpError(429, "rate_limited", "Too many requests. Try again in a minute.");
  }
}

const NONCE_COOKIE = "mm_ai_oauth";
const NONCE_PATH = "/api/ai/oauth";
const connect = () => import("../services/ai/connect-ai2");

/**
 * The AI assistant in the app. It runs on the workspace's own AI key (bring your own AI);
 * Multies never pays for model calls. Admins add, change or remove the key.
 */
export function aiRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/status", async (c) => {
      const ai2 = !!c.var.deps.config.aiConnectAi2;
      return c.json({
        ...(await aiKeyStatus(c.var.deps, c.var.auth.orgId)),
        providers: (ai2 ? AI_PROVIDERS : LEGACY_AI_PROVIDERS).map((id) => AI_PROVIDER_INFO[id]),
        ...(ai2 ? { ai2: true, cards: AI2_PROVIDERS.map((id) => AI2_PROVIDER_CARDS[id]), builtin: await (await import("../services/ai/builtin-ai2")).builtinStatus(c.var.deps, c.var.auth.orgId) } : {}),
        mcp: { url: new URL("/api/v1/mcp", c.var.deps.config.appUrl).toString(), docs: "/agents" },
        message: BYO_AI_MESSAGE,
      });
    })
    .put("/key", requireAdmin, async (c) => {
      const b = await parseBody(c, KeyInput);
      // AI2: with built-in AI as the default, an unproven key must never replace it (MB-321), so this older save
      // goes through the same proof as /connect. Flag off: today's save exactly.
      if (!c.var.deps.config.aiConnectAi2) return c.json(await saveAiKey(c.var.deps, c.var.auth, b));
      await ai2Limit(c);
      return c.json(await (await connect()).connectWithKey(c.var.deps, c.var.auth, { apiKey: b.apiKey, provider: b.provider, model: b.model || undefined }));
    })
    .delete("/key", requireAdmin, async (c) => c.json(await deleteAiKey(c.var.deps, c.var.auth)))
    // AI2 (AI_CONNECT_AI2): every route below answers 404 while the flag is off.
    .use("/connect", ai2Only).use("/models", ai2Only).use("/model", ai2Only).use("/test", ai2Only).use("/oauth/*", ai2Only)
    .post("/connect", requireAdmin, async (c) => {
      const b = await parseBody(c, ConnectInput);
      await ai2Limit(c);
      return c.json(await (await connect()).connectWithKey(c.var.deps, c.var.auth, b));
    })
    .post("/models", requireAdmin, async (c) => {
      const b = await parseBody(c, ListInput);
      await ai2Limit(c);
      return c.json(await (await connect()).modelsForWorkspace(c.var.deps, c.var.auth.orgId, b));
    })
    .put("/model", requireAdmin, async (c) => c.json(await (await connect()).setModel(c.var.deps, c.var.auth, (await parseBody(c, ModelInput)).model)))
    .post("/test", requireAdmin, async (c) => {
      const b = await parseBody(c, TestInput);
      await ai2Limit(c);
      return c.json(await (await connect()).testConnection(c.var.deps, c.var.auth, b.model));
    })
    .get("/oauth/openrouter/start", requireAdmin, async (c) => {
      await ai2Limit(c);
      const nonce = randomToken(24);
      setCookie(c, NONCE_COOKIE, nonce, { path: NONCE_PATH, httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", maxAge: 10 * 60 });
      c.header("cache-control", "no-store");
      c.header("referrer-policy", "no-referrer");
      try {
        return c.redirect(await (await connect()).openRouterStart(c.var.deps, c.var.auth, nonce));
      } catch (err) {
        // TD1 switch off: back to Settings with the plain words, and no trip to the provider.
        if (err instanceof HttpError && err.code === "ai_off") return c.redirect(`/app/settings?${new URLSearchParams({ ai_error: err.message })}#ai`);
        throw err;
      }
    })
    .get("/oauth/openrouter/callback", requireAdmin, async (c) => {
      const nonce = getCookie(c, NONCE_COOKIE) ?? null;
      deleteCookie(c, NONCE_COOKIE, { path: NONCE_PATH });
      c.header("cache-control", "no-store");
      c.header("referrer-policy", "no-referrer");
      const back = (q: Record<string, string>) => `/app/settings?${new URLSearchParams(q)}#ai`;
      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!code || !state) return c.redirect(back({ ai_error: "The OpenRouter sign in was cancelled." }));
      try {
        await (await connect()).openRouterFinish(c.var.deps, c.var.auth, code, state, nonce);
        return c.redirect(back({ ai_connected: "openrouter" }));
      } catch (err) {
        return c.redirect(back({ ai_error: err instanceof HttpError ? err.message : "The sign in didn't finish. Try again." }));
      }
    })
    .post("/triage", async (c) => c.json(await triageMessage(c.var.deps, c.var.auth, (await parseBody(c, MessageRef)).messageId)))
    .post("/summary", async (c) => c.json(await summariseThread(c.var.deps, c.var.auth, (await parseBody(c, MessageRef)).messageId)))
    .post("/draft", async (c) => {
      const b = await parseBody(c, MessageRef.extend({ instructions: z.string().max(500).optional(), tone: z.enum(["friendly", "formal", "brief"]).optional() }));
      return c.json(await draftReply(c.var.deps, c.var.auth, b.messageId, b));
    })
    .post("/invoice-chase", async (c) => {
      const b = await parseBody(c, z.object({
        customerName: z.string().trim().min(1).max(100), invoiceNumber: z.string().trim().min(1).max(40),
        amount: z.number().positive().max(100_000_000), currency: z.string().length(3).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-14."),
        businessName: z.string().trim().min(1).max(100), stage: z.enum(["friendly", "firm", "final"]).optional(),
        paymentDetails: z.string().max(500).optional(), senderName: z.string().max(100).optional(),
      }));
      return c.json(invoiceChase(b, c.var.deps.now()));
    });
}

async function ai2Only(c: Context<AppEnv>, next: () => Promise<void>) {
  if (!c.var.deps.config.aiConnectAi2) return c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404);
  await next();
}
