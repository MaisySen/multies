import { describe, it, expect } from "vitest";
import { canRunNow } from "@/web/pages/app/teamai-td8";

/**
 * Round 2 (PR 20 leftover): Team AI's "Run now" was disabled whenever no AI source was ready, including when the reason
 * was a key problem, so an admin who had just fixed a refused key could not check it. It is now offered on a key problem.
 */
describe("Team AI Run now", () => {
  it("is offered with a source, and on a key problem even with none; never with AI off or no source and no problem", () => {
    expect(canRunNow({ on: true, source: "own_key" })).toBe(true);
    expect(canRunNow({ on: true, source: "built_in" })).toBe(true);
    expect(canRunNow({ on: true, source: "none", keyProblem: "ai_key_refused" })).toBe(true);
    expect(canRunNow({ on: true, source: "none" })).toBe(false);
    expect(canRunNow({ on: false, source: "own_key", keyProblem: "ai_key_refused" })).toBe(false);
  });
});
