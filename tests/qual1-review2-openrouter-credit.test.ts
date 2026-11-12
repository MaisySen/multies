/**
 * QUAL1 second review of PR 20: OpenRouter's real out-of-credit answer (HTTP 402) reads "This request requires more credits, or
 * fewer max_tokens ...". keyProblemOf runs CONTENT_REFUSAL (which matches "max_tokens") before the 402 rule, so the
 * key is never marked no_credit and the route falls through to the "content rules" 502.
 */
import { describe, it, expect } from "vitest";
import { AiProviderError, keyProblemOf, mapFailure } from "@/server/services/ai/providers";
import { providerFailureError } from "@/server/services/ai";

const OPENROUTER_402 = JSON.stringify({ error: { message: "This request requires more credits, or fewer max_tokens. You requested up to 400 tokens, but can only afford 12. To increase, visit https://openrouter.ai/settings/credits and add more credits", code: 402 } });

describe("QUAL1 second review: an out-of-credit 402 that mentions max_tokens", () => {
  it("the connection test calls it no_credit", () => {
    expect(mapFailure(402, OPENROUTER_402)).toBe("no_credit");
  });
  it("a live call marks the key no_credit too (same provider answer)", () => {
    const err = new AiProviderError("openrouter", 402, OPENROUTER_402.slice(0, 300));
    expect(keyProblemOf(err), "OpenRouter 402 'requires more credits' must be no_credit").toBe("no_credit");
  });
  it("and the person is not told the content rules stopped it", () => {
    const err = new AiProviderError("openrouter", 402, OPENROUTER_402.slice(0, 300));
    expect(providerFailureError(err).message).not.toMatch(/content rules/);
  });
});
