import { describe, expect, it } from "vitest";
import { metaFor, NOT_FOUND_META } from "../src/web/components/seo-meta";

describe("R114 public webinar page meta", () => {
  it("names registration, attendee and replay pages instead of not found", () => {
    for (const path of ["/w/Ab12Cd34", "/w/a/token123", "/w/a/token123/replay"]) {
      const m = metaFor(path);
      expect(m.title).toBe("Webinar | Multies");
      expect(m.noindex).toBe(true);
    }
  });
  it("still answers not found for unknown paths", () => {
    expect(metaFor("/w")).toEqual(NOT_FOUND_META);
    expect(metaFor("/webinar-nope")).toEqual(NOT_FOUND_META);
  });
});
