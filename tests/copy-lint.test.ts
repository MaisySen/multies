import { describe, it, expect } from "vitest";
import { findIssues } from "../scripts/check-copy";

describe("copy lint", () => {
  it("flags em and en dashes in any file", () => {
    expect(findIssues("src/server/x.ts", "// one \u2014 two")).toHaveLength(1);
    expect(findIssues("README.md", "pages 1\u20132")).toHaveLength(1);
    expect(findIssues("src/server/x.ts", "a - b, c: d")).toHaveLength(0);
  });
  it("flags stock marketing phrases only in user-facing copy", () => {
    expect(findIssues("src/web/pages/landing.tsx", "A seamless way to Unlock email")[0]).toMatchObject({ rule: "slop", text: "seamless" });
    expect(findIssues("README.md", "Built to be cutting-edge")).toHaveLength(1);
    expect(findIssues("src/server/services/team.ts", "a robust retry")).toHaveLength(0);
    expect(findIssues("src/web/pages/x.tsx", "Mail lands in 2 seconds")).toHaveLength(0);
  });
});
