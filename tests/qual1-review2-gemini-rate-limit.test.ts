/**
 * QUAL1 second review of PR 20: Gemini answers its per-minute free-tier rate limit with HTTP 429 RESOURCE_EXHAUSTED and the words
 * "You exceeded your current quota ... head to .../gemini-api/docs/rate-limits", naming a PerMinute quota.
 * NO_CREDIT matches "exceeded your current quota" before the 429 rule, so a passing rate limit marks a working Gemini key
 * "no credit left" (and, with AI_KEY_FALLBACK=on, sends the text to built-in AI). docs/api.md says rate limits are never
 * noted on the key.
 */
import { describe, it, expect } from "vitest";
import { AiProviderError, keyProblemOf, mapFailure } from "@/server/services/ai/providers";

const GEMINI_RPM_429 = JSON.stringify([{ error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }] } }]);

describe("QUAL1 second review: a Gemini per-minute rate limit is a rate limit, not an empty account", () => {
  it("a live call does not mark the key", () => {
    const err = new AiProviderError("gemini", 429, GEMINI_RPM_429.slice(0, 300));
    expect(keyProblemOf(err), "Gemini 429 RESOURCE_EXHAUSTED per-minute limit must not be noted as no_credit").toBeNull();
  });
  it("the connection test calls it rate_limited", () => {
    expect(mapFailure(429, GEMINI_RPM_429)).toBe("rate_limited");
  });
});
