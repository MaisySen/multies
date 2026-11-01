import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** R30: recording and transcripts shipped in R23.2, so the Meetings copy must not say otherwise. */
describe("Meetings copy reflects recording (R30)", () => {
  const read = (p: string) => readFileSync(new URL(`../src/web/pages/${p}`, import.meta.url), "utf8");
  it("the Meetings header names recording and transcripts", () => {
    const src = read("app/work/meetings.tsx");
    expect(src).not.toContain("No recordings or transcripts");
    expect(src).not.toContain("Nothing is recorded");
    expect(src).toContain("Record a call to get a transcript and summary");
    expect(src).toContain("you see a banner while it is on");
  });
  it("the landing page no longer says nothing is recorded", () => {
    // W1: the meetings words moved to the Meetings area page (shared/marketing-areas.ts), linked from the landing grid.
    const src = read("landing.tsx") + readFileSync("src/shared/marketing-areas.ts", "utf8");
    expect(src).not.toContain("Nothing is recorded");
    expect(src).toContain("Record a call for a transcript and summary");
  });
});
