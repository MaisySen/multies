import { describe, expect, it } from "vitest";
import { capFor, FREE_MEETING_MINUTES, liveMinutes, minutesState, participantMinutes, resetsOn, usedUpMessage } from "../src/server/services/suite/meeting-minutes-r34";
import { endedCallMinutes } from "../src/server/services/suite/calls";
import { minutesBannerText, minutesUsageLine } from "../src/web/pages/app/work/call-minutes-r34";

const now = new Date("2026-10-26T13:00:00Z");

describe("meeting minute cap (R34, MB-171)", () => {
  it("free workspaces get 1,000 participant-minutes, paid none, an operator override wins (0 blocks)", () => {
    expect(FREE_MEETING_MINUTES).toBe(1000);
    expect(capFor("starter", null)).toBe(1000);
    expect(capFor("pro", null)).toBeNull();
    expect(capFor("business", undefined)).toBeNull();
    expect(capFor("pro", 5000)).toBe(5000);
    expect(capFor("starter", 0)).toBe(0);
  });
  it("warns at 80%, in the last 5 minutes, and when used up", () => {
    expect(minutesState(799, 1000, now).warn).toBeNull();
    expect(minutesState(800, 1000, now)).toMatchObject({ warn: "eighty", remaining: 200, percent: 80 });
    expect(minutesState(995, 1000, now)).toMatchObject({ warn: "last_minutes", remaining: 5 });
    expect(minutesState(1000, 1000, now)).toMatchObject({ warn: "used_up", remaining: 0, percent: 100 });
    expect(minutesState(1400, 1000, now).remaining).toBe(0);
    expect(minutesState(0, 0, now).warn).toBe("used_up");
    expect(resetsOn(now)).toBe("2026-11-01");
    expect(resetsOn(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });
  it("counts participant-minutes: each person from first to last sighting, at least one minute each", () => {
    const t0 = now.getTime();
    expect(participantMinutes([{ first: t0, last: t0 + 30 * 60_000 }, { first: t0 + 10 * 60_000, last: t0 + 30 * 60_000 }])).toBe(50);
    expect(participantMinutes([{ first: t0, last: t0 + 5_000 }])).toBe(1);
    expect(participantMinutes([])).toBe(0);
    expect(Math.round(liveMinutes([t0 - 10 * 60_000, t0 - 5 * 60_000, null], t0))).toBe(15);
  });
  it("a call this isolate never saw counts its length since it started, capped at 6 hours, for one person", () => {
    const people = new Map([["a", { first: now.getTime() - 20 * 60_000, last: now.getTime() }], ["b", { first: now.getTime() - 20 * 60_000, last: now.getTime() - 10 * 60_000 }]]);
    expect(endedCallMinutes({ startsAt: new Date(now.getTime() - 3600_000) }, people, now.getTime())).toBe(30);
    expect(endedCallMinutes({ startsAt: new Date(now.getTime() - 25 * 60_000) }, undefined, now.getTime())).toBe(25);
    expect(endedCallMinutes({ startsAt: new Date(now.getTime() - 48 * 3600_000) }, new Map(), now.getTime())).toBe(360);
  });
  it("says plainly why a new call is refused and when calls come back", () => {
    expect(usedUpMessage({ cap: 1000, period: "2026-10", resetsOn: "2026-11-01" })).toBe("This workspace has used its 1,000 free call minutes for October. Calls start again on 1 November, or an owner can upgrade the plan.");
    expect(usedUpMessage({ cap: 0, period: "2026-10", resetsOn: "2026-11-01" })).toMatch(/switched off/);
  });
  it("the in-call banner and the meetings page line", () => {
    expect(minutesBannerText(null)).toBeNull();
    expect(minutesBannerText({ used: 100, cap: 1000, warn: null, period: "2026-10", resetsOn: "2026-11-01" })).toBeNull();
    expect(minutesBannerText({ used: 800, cap: 1000, percent: 80, remaining: 200, warn: "eighty", period: "2026-10", resetsOn: "2026-11-01" })).toBe("80% of this month's 1,000 free call minutes used.");
    expect(minutesBannerText({ used: 996, cap: 1000, remaining: 4, warn: "last_minutes", period: "2026-10", resetsOn: "2026-11-01" })).toMatch(/^4 free call minutes left this month/);
    expect(minutesBannerText({ used: 999, cap: 1000, remaining: 1, warn: "last_minutes", period: "2026-10", resetsOn: "2026-11-01" })).toMatch(/^1 free call minute left/);
    expect(minutesBannerText({ used: 1000, cap: 1000, remaining: 0, warn: "used_up", period: "2026-10", resetsOn: "2026-11-01" })).toMatch(/This call can finish/);
    expect(minutesUsageLine({ used: 320, cap: 1000, period: "2026-10", resetsOn: "2026-11-01" })).toBe("320 of 1,000 free call minutes used in October. Resets 1 November.");
    expect(minutesUsageLine({ used: 320, cap: null, period: "2026-10", resetsOn: "2026-11-01" })).toBeNull();
  });
});
