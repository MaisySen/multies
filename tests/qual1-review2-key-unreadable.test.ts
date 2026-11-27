/**
 * QUAL1 second review of PR 20: defect (1) claims the built-in stand-in is off unless AI_KEY_FALLBACK=on, "one check, keyFallbackOn,
 * decides it on every path". askAi (Tools Ask/Translate, mail Translate, Team AI's free path) still does
 * `keyFor(...).catch(() => null)`: when the saved key cannot be read (APP_SECRET rotated, a D1 read error), the
 * workspace is treated as having no key and its text goes to built-in AI, with no `fallback` note and nothing logged.
 */
import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { askAi } from "@/server/services/tools/ai-meter";

const ANT = "sk-ant-api03-" + "a".repeat(40) + "WXYZ";

describe("an unreadable saved key is marked, and the workspace agent answers", () => {
  it("askAi with a saved key that cannot be decrypted answers from built-in AI and says so", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/models")) return Response.json({ data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] });
      return Response.json({ content: [{ type: "text", text: "OK" }] });
    }) as typeof fetch;
    const ctx = await makeTestApp({ AI_CONNECT_AI2: "on", ASK_TD1: "on" }, { fetch: fetchImpl });
    const builtin = vi.fn(async () => ({ response: "Built in answer.", usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    ctx.deps.ai = { run: builtin } as never;
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Ada Owner", "Acme");
    expect((await c.post("/api/ai/connect", { apiKey: ANT })).status).toBe(200);
    const orgId = (await c.get("/api/account/me")).body.organization.id as string;
    // The key is saved, but this deployment can no longer decrypt it (APP_SECRET rotated).
    await ctx.deps.db.run(sql`update ai_keys set key_enc = 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA'`);
    const warn = vi.fn();
    ctx.deps.log = { ...(ctx.deps.log ?? {}), warn, info: () => {}, error: warn } as never;

    const r = await askAi(ctx.deps, orgId, { task: "chat", system: "s", user: "private workspace text" });
    expect(r.ok && r.source).toBe("free");
    expect(r.ok && r.fallback?.reason).toBe("key_refused");
    expect(builtin).toHaveBeenCalled();
  });
});
