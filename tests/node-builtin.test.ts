import { describe, expect, it, vi } from "vitest";
import { nodeBuiltinAi } from "@/server/services/ai/node-builtin";

describe("Node workspace agent", () => {
  it("answers from the request when this server has no Workers AI token", async () => {
    const ai = nodeBuiltinAi({});
    const r = await ai.run("@cf/meta/llama-3.1-8b-instruct-fp8-fast", { messages: [{ role: "user", content: "Please summarise the move." }] }) as { response: string };
    expect(r.response).toContain("summarise the move");
  });

  it("calls the public Workers AI API when an account and token are set", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ result: { response: "From Workers AI" } }));
    const ai = nodeBuiltinAi({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" }, fetchImpl as unknown as typeof fetch);
    const r = await ai.run("model", { messages: [] }) as { response: string };
    expect(r.response).toBe("From Workers AI");
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/run/model");
  });
});
