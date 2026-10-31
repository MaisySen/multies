import { describe, it, expect } from "vitest";
import {
  alertAllowed, applyDeliveryPatch, defaultDelivery, inQuietHours, isPaused, localParts, nextDigestAt, pauseUntil, readDelivery, zonedInstant, DeliveryPatch,
  type Delivery,
} from "@/shared/notification-centre";

const SYD = "Australia/Sydney";
const quiet = (over: Partial<Delivery["quiet"]> = {}, tz = SYD): Delivery => ({ ...defaultDelivery(tz), quiet: { enabled: true, start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6], allowUrgent: false, ...over } });
// Sydney is UTC+11 (daylight saving) on 2026-11-01.
const syd = (local: string) => zonedInstant(SYD, +local.slice(0, 4), +local.slice(5, 7), +local.slice(8, 10), +local.slice(11, 13), +local.slice(14, 16));

describe("R97 quiet hours", () => {
  it("covers a period that crosses midnight, in the person's own zone", () => {
    const d = quiet();
    expect(inQuietHours(syd("2026-11-02T23:30"), d)).toBe(true);
    expect(inQuietHours(syd("2026-11-03T06:59"), d)).toBe(true);
    expect(inQuietHours(syd("2026-11-03T07:00"), d)).toBe(false);
    expect(inQuietHours(syd("2026-11-03T21:59"), d)).toBe(false);
    // The same instant is mid afternoon in London, so a London zone is not quiet.
    expect(inQuietHours(syd("2026-11-03T02:00"), { ...d, timezone: "Europe/London" })).toBe(false);
  });
  it("uses the day the period starts for the morning part", () => {
    // Weeknights only (Mon to Fri start days). Saturday 01:00 belongs to Friday night; Sunday 01:00 to Saturday night.
    const d = quiet({ days: [1, 2, 3, 4, 5] });
    expect(localParts(syd("2026-11-07T01:00"), SYD).weekday).toBe(6);
    expect(inQuietHours(syd("2026-11-07T01:00"), d)).toBe(true);
    expect(inQuietHours(syd("2026-11-08T01:00"), d)).toBe(false);
    expect(inQuietHours(syd("2026-11-07T23:00"), d)).toBe(false);
  });
  it("handles a same day period, no days, equal times and switched off", () => {
    const day = quiet({ start: "12:00", end: "13:00" });
    expect(inQuietHours(syd("2026-11-03T12:30"), day)).toBe(true);
    expect(inQuietHours(syd("2026-11-03T13:00"), day)).toBe(false);
    expect(inQuietHours(syd("2026-11-03T23:30"), quiet({ days: [] }))).toBe(false);
    expect(inQuietHours(syd("2026-11-03T23:30"), quiet({ start: "09:00", end: "09:00" }))).toBe(false);
    expect(inQuietHours(syd("2026-11-03T23:30"), quiet({ enabled: false }))).toBe(false);
  });
  it("lets mentions and approvals through only when allowed", () => {
    const at = syd("2026-11-03T23:30");
    expect(alertAllowed(at, quiet(), "mention")).toBe(false);
    expect(alertAllowed(at, quiet({ allowUrgent: true }), "mention")).toBe(true);
    expect(alertAllowed(at, quiet({ allowUrgent: true }), "approval")).toBe(true);
    expect(alertAllowed(at, quiet({ allowUrgent: true }), "comment")).toBe(false);
    expect(alertAllowed(syd("2026-11-03T10:00"), quiet(), "comment")).toBe(true);
  });
});

describe("R97 pause", () => {
  it("presets end at the right time and tomorrow means 8 AM local", () => {
    const now = syd("2026-11-03T21:15");
    expect(pauseUntil(now, "1h", SYD).getTime() - now.getTime()).toBe(3600_000);
    expect(pauseUntil(now, "3h", SYD).getTime() - now.getTime()).toBe(3 * 3600_000);
    expect(pauseUntil(now, "tomorrow", SYD).toISOString()).toBe(syd("2026-11-04T08:00").toISOString());
  });
  it("a pause holds even urgent alerts and ends by itself", () => {
    const now = syd("2026-11-03T10:00");
    const d = applyDeliveryPatch(defaultDelivery(SYD), { pause: "1h" }, now);
    expect(isPaused(now, d)).toBe(true);
    expect(alertAllowed(now, d, "mention")).toBe(false);
    expect(isPaused(new Date(now.getTime() + 3600_001), d)).toBe(false);
    expect(applyDeliveryPatch(d, { pause: "resume" }, now).pausedUntil).toBeNull();
  });
});

describe("R97 digest clock", () => {
  it("daily: later today, else tomorrow, in local time", () => {
    const d = { ...defaultDelivery(SYD), digest: { frequency: "daily" as const, time: "08:00", weekday: 1 } };
    expect(nextDigestAt(syd("2026-11-03T07:59"), d)?.toISOString()).toBe(syd("2026-11-03T08:00").toISOString());
    expect(nextDigestAt(syd("2026-11-03T08:00"), d)?.toISOString()).toBe(syd("2026-11-04T08:00").toISOString());
  });
  it("weekly: the chosen weekday", () => {
    const d = { ...defaultDelivery(SYD), digest: { frequency: "weekly" as const, time: "17:30", weekday: 5 } };
    const at = nextDigestAt(syd("2026-11-03T09:00"), d)!; // Tuesday
    expect(localParts(at, SYD)).toMatchObject({ weekday: 5, hour: 17, minute: 30, day: 6 });
  });
  it("off means no clock", () => {
    expect(nextDigestAt(new Date(), defaultDelivery(SYD))).toBeNull();
  });
  it("keeps local 8 AM across a daylight saving change", () => {
    // Sydney moves to UTC+11 on Sunday 4 Oct 2026; 8 AM local is 22:00 UTC before and 21:00 UTC after.
    const d = { ...defaultDelivery(SYD), digest: { frequency: "daily" as const, time: "08:00", weekday: 1 } };
    expect(nextDigestAt(new Date("2026-10-02T20:00:00Z"), d)?.toISOString()).toBe("2026-10-02T22:00:00.000Z");
    expect(nextDigestAt(new Date("2026-10-03T23:00:00Z"), d)?.toISOString()).toBe("2026-10-04T21:00:00.000Z");
  });
});

describe("R97 stored settings", () => {
  it("reads broken or partial JSON safely and fills from the profile zone", () => {
    expect(readDelivery("not json", "Asia/Kathmandu").timezone).toBe("Asia/Kathmandu");
    expect(readDelivery(null, "Not/AZone").timezone).toBe("Australia/Sydney");
    const r = readDelivery(JSON.stringify({ timezone: "Bad/Zone", quiet: { start: "25:00" }, digest: { frequency: "weekly" } }), "Europe/London");
    expect(r.timezone).toBe("Europe/London");
    expect(r.quiet.start).toBe("22:00");
    expect(r.digest.frequency).toBe("weekly"); // a valid group is kept; a group with a bad field falls back as a whole
  });
  it("validates patches", () => {
    expect(DeliveryPatch.safeParse({ quiet: { start: "7pm" } }).success).toBe(false);
    expect(DeliveryPatch.safeParse({ timezone: "Mars/Base" }).success).toBe(false);
    expect(DeliveryPatch.safeParse({ digest: { frequency: "hourly" } }).success).toBe(false);
    expect(DeliveryPatch.safeParse({ other: 1 }).success).toBe(false);
    expect(DeliveryPatch.safeParse({ quiet: { days: [1, 1, 3] }, pause: "3h" }).success).toBe(true);
  });
  it("dedupes and sorts days", () => {
    expect(applyDeliveryPatch(defaultDelivery(SYD), { quiet: { days: [5, 1, 1] } }, new Date()).quiet.days).toEqual([1, 5]);
  });
});
