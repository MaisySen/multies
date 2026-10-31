import { describe, expect, it } from "vitest";
import { TOOL_FEATURES, parseToolFeatures } from "@/shared/tool-features";
import { MemoryToolFileStore } from "../src/server/services/tools/p2-bindings";

describe("Tools P2 feature flags", () => {
  it("parses a comma list and ignores unknown ids", () => {
    expect(parseToolFeatures("editor, share,nope")).toEqual(["editor", "share"]);
    expect(parseToolFeatures("")).toEqual([]);
    expect(parseToolFeatures(undefined)).toEqual([]);
  });
  it("all turns every feature on", () => {
    expect(parseToolFeatures("all")).toEqual([...TOOL_FEATURES]);
    expect(TOOL_FEATURES.length).toBe(27); // R88: file_requests, secrets
  });
});

describe("memory tool file store", () => {
  it("keeps a file until its expiry", async () => {
    let now = 1_000_000;
    const s = new MemoryToolFileStore(() => now);
    await s.put("a", new Uint8Array([1, 2, 3]), { ttlSeconds: 120, metadata: { name: "x.pdf" } });
    expect((await s.get("a"))?.metadata).toEqual({ name: "x.pdf" });
    now += 121_000;
    expect(await s.get("a")).toBeNull();
  });
});
