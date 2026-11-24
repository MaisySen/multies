import { describe, it, expect } from "vitest";

/**
 * Round 2 (PR 20 leftover): the mail assistant's "key refused" banner stayed after the key worked again, until a reload.
 * A good answer on the workspace's own key (no stand-in) while the banner shows now reads the AI status again.
 */
describe("Mail assistant: the key problem banner clears on the next good answer", () => {
  it("reads the AI status again only for an answer on the own key while the banner shows", async () => {
    const { keyWorksAgain } = await import("@/web/pages/app/webmail");
    expect(keyWorksAgain(true, { })).toBe(true);
    expect(keyWorksAgain(true, { fallback: { reason: "key_refused", message: "Built in AI wrote this" } })).toBe(false);
    expect(keyWorksAgain(false, {})).toBe(false);
    expect(keyWorksAgain(true, undefined)).toBe(false);
  });
});
