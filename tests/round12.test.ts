import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { buildIcs } from "@/server/services/suite/meetings";
import { transitionsInYear, vtimezone, zoneOffsetMin } from "@/server/services/suite/vtimezone";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

describe("VTIMEZONE in the .ics", () => {
  it("writes yearly STANDARD and DAYLIGHT rules for a zone with daylight saving", () => {
    expect(zoneOffsetMin(new Date("2026-01-10T00:00:00Z"), "Australia/Sydney")).toBe(660);
    expect(transitionsInYear(2025, "Australia/Sydney").map((t) => [t.at.toISOString(), t.from, t.to])).toEqual([["2025-04-05T16:00:00.000Z", 660, 600], ["2025-10-04T16:00:00.000Z", 600, 660]]);
    const lines = vtimezone("Australia/Sydney", new Date("2026-10-26T00:00:00Z"));
    expect(lines).toEqual(["BEGIN:VTIMEZONE", "TZID:Australia/Sydney",
      "BEGIN:STANDARD", "DTSTART:20250406T030000", "TZOFFSETFROM:+1100", "TZOFFSETTO:+1000", "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:20251005T020000", "TZOFFSETFROM:+1000", "TZOFFSETTO:+1100", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU", "END:DAYLIGHT", "END:VTIMEZONE"]);
    expect(vtimezone("Europe/London", new Date("2026-06-01T00:00:00Z"))).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU");
    expect(vtimezone("America/New_York", new Date("2026-06-01T00:00:00Z"))).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU");
  });

  it("writes one STANDARD part for a zone without daylight saving, and nothing for an unknown zone", () => {
    expect(vtimezone("Asia/Kathmandu", new Date("2026-06-01T00:00:00Z"))).toEqual(["BEGIN:VTIMEZONE", "TZID:Asia/Kathmandu", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0545", "TZOFFSETTO:+0545", "END:STANDARD", "END:VTIMEZONE"]);
    expect(vtimezone("Mars/Base", new Date())).toEqual([]);
  });

  it("puts the VTIMEZONE before the event in a series .ics, and leaves one-off meetings in UTC", async () => {
    const now = new Date("2026-10-24T00:00:00Z");
    const base = { id: "mtg_1", title: "Review", startsAt: new Date("2026-10-25T23:00:00Z"), durationMin: 30 };
    const opts = { organizer: { address: "a@acme.io" }, invitees: [], guestUrl: "https://x.test/m/t", now };
    const series = buildIcs({ ...base, recurrence: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", recurrenceTz: "Australia/Sydney" }, opts);
    expect(series.indexOf("BEGIN:VTIMEZONE")).toBeGreaterThan(0);
    expect(series.indexOf("BEGIN:VTIMEZONE")).toBeLessThan(series.indexOf("BEGIN:VEVENT"));
    expect(series).toContain("TZID:Australia/Sydney\r\n");
    expect(series).toContain("DTSTART;TZID=Australia/Sydney:20261026T100000");
    expect(buildIcs(base, opts)).not.toContain("VTIMEZONE");

    const made = await c.post("/api/meetings", { title: "Weekly product review", startsAt: "2026-10-25T23:00:00.000Z", durationMin: 45, recurrence: { days: ["mo"], timezone: "Australia/Sydney" } });
    const res = await ctx.app.request(`/api/meetings/${made.body.meeting.id}/ics`, { headers: { host: "localhost", cookie: c.cookie } });
    const text = await res.text();
    expect(text).toContain("BEGIN:VTIMEZONE");
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU");
  });
});
