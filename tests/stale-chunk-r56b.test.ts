import { describe, expect, it, vi } from "vitest";
import { isStaleChunkError, reloadForNewVersion } from "../src/web/lib/stale-chunk";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe("stale chunk recovery (R56b)", () => {
  it("knows the browsers' words for a missing page file", () => {
    expect(isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: https://multies.si/assets/domains-BVGcQtMd.js"))).toBe(true);
    expect(isStaleChunkError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleChunkError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isStaleChunkError(new Error("Cannot read properties of undefined"))).toBe(false);
  });
  it("reloads once, then not again inside 30 s, then again later", () => {
    const s = mem(); const reload = vi.fn();
    expect(reloadForNewVersion(s, 1_000, reload)).toBe(true);
    expect(reloadForNewVersion(s, 20_000, reload)).toBe(false);
    expect(reloadForNewVersion(s, 40_000, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
