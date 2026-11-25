/** W4 (Semgrep): ids that reach links, request ids and decoy codes come from crypto.getRandomValues. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomFloat, randomId, randomUuid } from "@/shared/random";
import { randomPreview } from "@/shared/reporting-r112";
import { newIdempotencyKey } from "@/web/lib/api";

afterEach(() => vi.restoreAllMocks());

describe("shared random", () => {
  it("randomId draws from the alphabet, at the asked length, without bias from rejected bytes", () => {
    expect(randomId(12)).toMatch(/^[0-9a-z]{12}$/);
    expect(randomId(5, "ab")).toMatch(/^[ab]{5}$/);
    // 36 letters: bytes 252..255 would favour 0..3, so they are dropped and drawn again.
    const seq = [255, 252, 0, 1, 253, 35];
    let i = 0;
    const fake = (n: number) => Uint8Array.from({ length: n }, () => seq[i++ % seq.length]!);
    expect(randomId(4, undefined, fake)).toBe("01z0");
  });

  it("uses crypto.getRandomValues and never Math.random", () => {
    const math = vi.spyOn(Math, "random");
    const gv = vi.spyOn(globalThis.crypto, "getRandomValues");
    randomId(10); randomBytes(4); randomFloat(); randomPreview(); newIdempotencyKey();
    expect(gv).toHaveBeenCalled();
    expect(math).not.toHaveBeenCalled();
  });

  it("throws when the platform has no secure source instead of falling back", () => {
    vi.stubGlobal("crypto", undefined);
    try {
      expect(() => randomBytes(4)).toThrow(/secure random/);
      expect(() => randomId(4)).toThrow(/secure random/);
    } finally { vi.unstubAllGlobals(); }
  });

  it("randomFloat is in [0, 1) and randomUuid is a v4 uuid", () => {
    for (let k = 0; k < 50; k++) { const f = randomFloat(); expect(f).toBeGreaterThanOrEqual(0); expect(f).toBeLessThan(1); }
    expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
