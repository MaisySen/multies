import { describe, expect, it } from "vitest";
import { chipLabel } from "../src/web/pages/app/work/make-task";

// R50 (MB-238): the phone chip shows the title; its accessible name keeps the ref and status.
describe("R50 mail to task chip label", () => {
  it("names ref, title and status", () => {
    expect(chipLabel({ ref: "MB-12", title: "Send the quote", statusName: "To do" })).toBe("Task MB-12: Send the quote, To do");
  });
  it("says Untitled for an empty title", () => {
    expect(chipLabel({ ref: "MB-3", title: "", statusName: "Done" })).toBe("Task MB-3: Untitled, Done");
  });
});
