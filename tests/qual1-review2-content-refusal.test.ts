/**
 * QUAL1 second review of PR 20, defect (2): "Refused content now answers 502 'would not answer this request', with no write and no
 * stand-in." That holds for the mail assistant (services/ai/index.ts providerFailureError) but not for the paths that go
 * through the Tools door askAi (mail Translate, Tools Ask and Translate): runOwnKey (services/tools/ai-meter.ts) answers
 * every non-key failure with "... could not answer just now. Try again in a minute.", and the routes add "Try again in a
 * moment" (502 ai_failed) or 503 ai_error. A request the provider refuses for its own text fails the same way every time.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { clearTranslateCache } from "@/server/services/translate-r116";
import { askAi } from "@/server/services/tools/ai-meter";

const ANT = "sk-ant-api03-" + "a".repeat(40) + "WXYZ";
const TOO_LONG = '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}';

describe("QUAL1 second review: a provider refusing the request's own text is never 'try again'", () => {
  it("mail Translate and the Tools door say the provider would not answer this request", async () => {
    clearTranslateCache();
    let refuse = false;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/models")) return Response.json({ data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] });
      return refuse ? new Response(TOO_LONG, { status: 400 }) : Response.json({ content: [{ type: "text", text: '["x"]' }] });
    }) as typeof fetch;
    const ctx = await makeTestApp({ AI_CONNECT_AI2: "on", TRANSLATE_R116: "on", ASK_TD1: "on" }, { fetch: fetchImpl });
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Ada Owner", "Acme");
    expect((await c.post("/api/ai/connect", { apiKey: ANT })).status).toBe(200);
    const orgId = (await c.get("/api/account/me")).body.organization.id as string;
    refuse = true;

    const direct = await askAi(ctx.deps, orgId, { task: "chat", system: "s", user: "a very long document" });
    const r = await c.post("/api/translate", { texts: ["Please send the invoice for this week, thanks."], target: "ne" });
    const seen = { door: direct.ok ? null : direct.message, route: r.body.error?.message };
    expect(seen.door, "askAi tells the person to retry a request the provider refused for its content").not.toMatch(/Try again/);
    expect(seen.route).toMatch(/would not answer this request/);
  });
});
