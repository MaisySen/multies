import { describe, expect, it } from "vitest";
import { isStaleChunkError } from "../src/web/lib/stale-chunk";

describe("stale chunk words (R56b, R73)", () => {
  it("knows the browsers' words for a missing page file", () => {
    expect(isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: https://multies.si/assets/domains-BVGcQtMd.js"))).toBe(true);
    expect(isStaleChunkError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleChunkError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isStaleChunkError(new Error("Unable to preload CSS for /assets/docs-x.css"))).toBe(true);
    expect(isStaleChunkError(new Error("Cannot read properties of undefined"))).toBe(false);
  });
});
