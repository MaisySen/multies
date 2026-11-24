import { describe, expect, it, vi } from "vitest";
import { nodeBuiltinAi } from "@/server/services/ai/node-builtin";

const ON = { BUILTIN_AI: "workers-ai", WORKERS_AI_ACCOUNT_ID: "acct", WORKERS_AI_API_TOKEN: "tok" };
const MODEL = "@cf/meta/llama-3.1-8b-instruct";

describe("Node workspace agent", () => {
  it("is not wired when this server has no Workers AI token", () => {
    expect(nodeBuiltinAi({})).toBeUndefined();
    expect(nodeBuiltinAi({ BUILTIN_AI: "workers-ai", WORKERS_AI_ACCOUNT_ID: "acct" })).toBeUndefined();
    expect(nodeBuiltinAi({ BUILTIN_AI: "workers-ai", WORKERS_AI_API_TOKEN: "tok" })).toBeUndefined();
  });

  it("never turns itself on from the D1 import token (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)", () => {
    expect(nodeBuiltinAi({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" })).toBeUndefined();
    expect(nodeBuiltinAi({ BUILTIN_AI: "workers-ai", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" })).toBeUndefined();
  });

  it("stays off until the operator sets BUILTIN_AI=workers-ai, even with its own account and token", () => {
    expect(nodeBuiltinAi({ WORKERS_AI_ACCOUNT_ID: "acct", WORKERS_AI_API_TOKEN: "tok" })).toBeUndefined();
    expect(nodeBuiltinAi({ ...ON, BUILTIN_AI: "off" })).toBeUndefined();
  });

  it("calls the documented Workers AI path with the model's slashes kept", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ success: true, errors: [], result: { response: "From Workers AI" } }),
    );
    const ai = nodeBuiltinAi(ON, fetchImpl as unknown as typeof fetch);
    expect(ai).toBeDefined();
    const r = await ai!.run(MODEL, { messages: [] }) as { response: string };
    expect(r.response).toBe("From Workers AI");
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/meta/llama-3.1-8b-instruct");
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer tok");
  });

  it("refuses a model id that would leave the ai/run path", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ success: true, result: { response: "x" } }));
    const ai = nodeBuiltinAi(ON, fetchImpl as unknown as typeof fetch);
    for (const bad of ["@cf/../../tokens", "@cf/meta/x?y=1", "@cf//x", "@cf/meta/x#y"]) {
      await expect(ai!.run(bad, { messages: [] })).rejects.toThrow(/could not answer/i);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when Workers AI rejects the call", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    const ai = nodeBuiltinAi(ON, fetchImpl as unknown as typeof fetch);
    await expect(ai!.run(MODEL, { messages: [] })).rejects.toThrow(/could not answer/i);
  });

  it("treats success:false with errors and no result as an error, not an answer", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ success: false, errors: [{ code: 5007, message: "No such model" }], messages: [] }));
    const ai = nodeBuiltinAi(ON, fetchImpl as unknown as typeof fetch);
    await expect(ai!.run(MODEL, { messages: [] })).rejects.toThrow(/could not answer/i);
  });

  it("treats a 200 with no result as an error", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ success: true, errors: [] }));
    const ai = nodeBuiltinAi(ON, fetchImpl as unknown as typeof fetch);
    await expect(ai!.run(MODEL, { messages: [] })).rejects.toThrow(/could not answer/i);
  });
});
