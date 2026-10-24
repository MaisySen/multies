import { describe, expect, it } from "vitest";
import { isoToZonedInput, setDisplayTimeZone, zonedDateTime, zonedInputToIso } from "@/web/lib/format";

// Meeting times follow the workspace's zone and name it, whatever the browser's zone (dogfood F6).
describe("workspace zone times", () => {
  it("reads a wall clock time in the workspace zone, across daylight saving", () => {
    expect(zonedInputToIso("2026-10-26T10:00", "Australia/Sydney")).toBe("2026-10-25T23:00:00.000Z");
    expect(zonedInputToIso("2026-07-06T10:00", "Australia/Sydney")).toBe("2026-07-06T00:00:00.000Z");
    expect(zonedInputToIso("2026-07-06T10:00", "America/New_York")).toBe("2026-07-06T14:00:00.000Z");
    expect(zonedInputToIso("2026-10-26T10:00", "UTC")).toBe("2026-10-26T10:00:00.000Z");
  });

  it("round trips to the input value and names the zone", () => {
    expect(isoToZonedInput("2026-10-25T23:00:00.000Z", "Australia/Sydney")).toBe("2026-10-26T10:00");
    setDisplayTimeZone("Australia/Sydney");
    const label = zonedDateTime("2026-10-25T23:00:00.000Z");
    expect(label).toContain("10:00");
    expect(label).toMatch(/AEDT|GMT\+11/);
  });
});
