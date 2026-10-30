import { describe, expect, it } from "vitest";
import { COMPRESS_LEVELS, COMPRESS_LEVEL_LABEL, toolDef } from "@/shared/tools";
import { defaultsFor } from "@/web/components/tools/tool-fields";
import { THUMB_MAX_BYTES } from "@/web/components/tools/pdf-thumb";

describe("R70 compress levels", () => {
  it("offers Light, Balanced and Smallest, Balanced by default, mapped to the engine's levels", () => {
    const opt = toolDef("compress").options.find((o) => o.name === "level");
    expect(opt?.kind).toBe("choice");
    expect(opt?.default).toBe("medium");
    expect(opt?.choices?.map((c) => [c.value, c.label])).toEqual([["light", "Light"], ["medium", "Balanced"], ["strong", "Smallest"]]);
    expect(defaultsFor(toolDef("compress")).level).toBe("medium");
  });
  it("every level says what to expect in plain words, with no dashes", () => {
    for (const l of COMPRESS_LEVELS) {
      expect(l.hint.length).toBeGreaterThan(20);
      expect(l.hint).not.toMatch(/[\u2013\u2014]| - /);
    }
    expect(COMPRESS_LEVELS.find((l) => l.value === "light")?.hint).toMatch(/about the same size/);
    expect(COMPRESS_LEVEL_LABEL("strong")).toBe("Smallest");
    expect(COMPRESS_LEVEL_LABEL(undefined)).toBe("Balanced");
  });
  it("draws result thumbnails only for files a phone can fetch twice without pain", () => {
    expect(THUMB_MAX_BYTES).toBe(15 * 1024 * 1024);
  });
});
