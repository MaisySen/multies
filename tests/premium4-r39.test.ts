import { describe, expect, it } from "vitest";
import { domainSteps, initials, NOTIFICATION_FILTER_KEY, readStoredFilter, recordPill, RECORD_PILL_LABELS, usageRing } from "../src/web/lib/premium4-r39";

// R39 premium pass 4: the rules behind the billing rings, domain stepper, record pills and sticky filter chips.
describe("usageRing", () => {
  it("colours by how full: brand to 70 %, amber to 90 %, red above", () => {
    expect(usageRing(0, 3)).toEqual({ pct: 0, tone: "brand", over: false });
    expect(usageRing(2, 3).tone).toBe("brand");
    expect(usageRing(8, 10).tone).toBe("warn");
    expect(usageRing(10, 10)).toEqual({ pct: 100, tone: "bad", over: false });
  });
  it("caps at 100 and flags going over; a zero limit with use is full", () => {
    expect(usageRing(5, 3)).toEqual({ pct: 100, tone: "bad", over: true });
    expect(usageRing(1, 0).pct).toBe(100);
    expect(usageRing(0, 0).pct).toBe(0);
  });
});

describe("recordPill", () => {
  it("says Verified, Wrong value, Pending or Check this in plain words", () => {
    expect(recordPill(undefined)).toBe("pending");
    expect(recordPill({ status: "pass", found: ["x"] })).toBe("verified");
    expect(recordPill({ status: "fail", found: [] })).toBe("pending");
    expect(recordPill({ status: "fail", found: ["v=spf1 -all"] })).toBe("wrong");
    expect(recordPill({ status: "error", found: [] })).toBe("pending");
    expect(recordPill({ status: "warn", found: ["x"] })).toBe("warning");
    expect(Object.values(RECORD_PILL_LABELS)).toEqual(["Verified", "Pending", "Wrong value", "Check this"]);
  });
});

describe("domainSteps", () => {
  it("names the first step not done as the next one", () => {
    expect(domainSteps({ status: "pending", passing: 1, required: 4, mailboxes: 0 }).current).toBe(1);
    expect(domainSteps({ status: "pending", passing: 4, required: 4, mailboxes: 0 }).current).toBe(2);
    expect(domainSteps({ status: "verified", passing: 4, required: 4, mailboxes: 0 }).current).toBe(3);
    const done = domainSteps({ status: "verified", passing: 4, required: 4, mailboxes: 2 });
    expect(done.current).toBe(-1);
    expect(done.steps.map((s) => s.label)).toEqual(["Add domain", "Add DNS records", "Verified", "First mailbox"]);
  });
  it("a verified domain counts its records as in even before the next check", () => {
    expect(domainSteps({ status: "verified", passing: 0, required: 4, mailboxes: 1 }).steps.every((s) => s.done)).toBe(true);
  });
});

describe("initials and the sticky filter", () => {
  it("takes up to two initials", () => {
    expect(initials("Priya Shah")).toBe("PS");
    expect(initials("ada")).toBe("A");
    expect(initials("  Mary Ann Lee ")).toBe("MA");
    expect(initials(null)).toBe("?");
  });
  it("reads a stored filter only when it is one of the chips", () => {
    const store = (v: string | null) => ({ getItem: (k: string) => (k === NOTIFICATION_FILTER_KEY ? v : null) });
    const chips = ["all", "mention", "approval"] as const;
    expect(readStoredFilter(chips, "all", store("mention"))).toBe("mention");
    expect(readStoredFilter(chips, "all", store("bogus"))).toBe("all");
    expect(readStoredFilter(chips, "all", store(null))).toBe("all");
    expect(readStoredFilter(chips, "all", { getItem: () => { throw new Error("blocked"); } })).toBe("all");
    expect(readStoredFilter(chips, "all", null)).toBe("all");
  });
});
