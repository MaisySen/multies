import { describe, expect, it } from "vitest";
import { isKnownPage } from "../src/shared/known-routes";

// R36: the public MCP tool docs page answered 404 on the Worker because it was missing here
// (the local Node server and the e2e run did not catch it; the staging sitemap check did).
describe("known routes (R36)", () => {
  it("serves the MCP tool docs page", () => {
    expect(isKnownPage("/developers/mcp")).toBe(true);
    expect(isKnownPage("/developers/mcp/")).toBe(true);
  });
  it("keeps unknown developer paths a real 404", () => {
    expect(isKnownPage("/developers")).toBe(false);
    expect(isKnownPage("/developers/nope")).toBe(false);
  });
});
