import { describe, it, expect } from "vitest";
import { holdEnter } from "@/web/components/command-palette";

describe("R67 search Enter waits for fresh results (MB-254)", () => {
  it("holds Enter only while results for the typed words are loading", () => {
    expect(holdEnter({ search: "password reset", loading: true, typed: false, page: null })).toBe(true);
    expect(holdEnter({ search: "password reset", loading: false, typed: false, page: null })).toBe(false);
    expect(holdEnter({ search: "", loading: true, typed: false, page: null })).toBe(false);
    expect(holdEnter({ search: "done MB-1", loading: true, typed: true, page: null })).toBe(false);
    expect(holdEnter({ search: "ann", loading: true, typed: false, page: "task:assignee" })).toBe(false);
  });
});
