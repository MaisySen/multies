import { describe, expect, it, vi } from "vitest";
import { nodeBuiltinAi } from "@/server/services/ai/node-builtin";

describe("Node workspace agent", () => {
  it("is not wired when this server has no Workers AI token", () => {
    expect(nodeBuiltinAi({})).toBeUndefined();
    expect(nodeBuiltinAi({ CLOUDFLARE_ACCOUNT_ID: "acct" })).toBeUndefined();
    expect(nodeBuiltinAi({ CLOUDFLARE_API_TOKEN: "tok" })).toBeUndefined();
  });

  it("calls the public Workers AI API when an account and token are set", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ result: { response: "From Workers AI" } }),
    );
    const ai = nodeBuiltinAi({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(ai).toBeDefined();
    const r = await ai!.run("model", { messages: [] }) as { response: string };
    expect(r.response).toBe("From Workers AI");
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/run/model");
  });

  it("throws when Workers AI rejects the call", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    const ai = nodeBuiltinAi({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" }, fetchImpl as unknown as typeof fetch);
    await expect(ai!.run("model", { messages: [] })).rejects.toThrow(/could not answer/i);
  });
});
