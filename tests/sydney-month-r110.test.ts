import { describe, it, expect } from "vitest";
import { sydneyMonth } from "../e2e/support/sydney-month";

/** R110 (lead steer): the calendar-sync-r23 e2e built events in the UTC month while the page shows Sydney time. */
describe("sydneyMonth (calendar-sync-r23 e2e)", () => {
  it("is the Sydney month near a month boundary, not the UTC one", () => {
    expect(sydneyMonth(new Date("2026-10-31T14:00:00Z"))).toEqual({ y: 2026, m: 10 }); // 1 Nov 01:00 in Sydney
    expect(sydneyMonth(new Date("2026-12-31T13:30:00Z"))).toEqual({ y: 2027, m: 0 }); // New Year in Sydney
    expect(sydneyMonth(new Date("2026-11-15T03:00:00Z"))).toEqual({ y: 2026, m: 10 });
    expect(sydneyMonth(new Date("2026-06-30T13:59:00Z"))).toEqual({ y: 2026, m: 5 }); // 23:59 AEST, still June
  });
});
