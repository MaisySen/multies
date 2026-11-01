import { describe, expect, it } from "vitest";
import { metaFor, NOT_FOUND_META } from "../src/web/components/seo-meta";

describe("R92 public booking page meta", () => {
  it("names booking, poll, event and ticket pages instead of not found", () => {
    for (const path of ["/book/acme", "/book/poll/abc123", "/book/event/launch-night", "/book/ticket/t1?c=XYZ".split("?")[0]]) {
      const m = metaFor(path);
      expect(m.title).toBe("Booking | Multies");
      expect(m.title).not.toBe(NOT_FOUND_META.title);
      expect(m.noindex).toBe(true);
    }
  });
  it("still answers not found for unknown paths", () => {
    expect(metaFor("/nope-r92")).toEqual(NOT_FOUND_META);
    expect(metaFor("/book")).toEqual(NOT_FOUND_META);
  });
});
