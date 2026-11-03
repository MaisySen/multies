import { describe, it, expect } from "vitest";
import { dayLabel, findNextStep, localDay, parseWhen } from "@/shared/crm-td10";
import { whenInZone } from "@/shared/teamai-td8";
import { askOrder } from "@/server/services/search-r98";

/** POL2: HQ MB-344 (relative days in the person's zone), MB-330 (day label), MB-329 (one clock), MB-324 (search ask order). */
describe("next weekday in the person's zone (HQ MB-344)", () => {
  const SYD = "Australia/Sydney";
  // Tuesday 3 Nov 2026, 9:30 AM in Sydney is Monday 2 Nov 22:30 UTC.
  const tueMorningSydney = new Date("2026-11-02T22:30:00Z");
  it("reads the local day, not the UTC day", () => {
    expect(localDay(tueMorningSydney, SYD).toISOString().slice(0, 10)).toBe("2026-11-03");
    expect(localDay(tueMorningSydney).toISOString().slice(0, 10)).toBe("2026-11-02");
    expect(localDay(tueMorningSydney, "Not/AZone").toISOString().slice(0, 10)).toBe("2026-11-02");
  });
  it("next Tuesday said on a Tuesday is a week away, never today", () => {
    expect(parseWhen("let's talk next Tuesday", tueMorningSydney, SYD)).toEqual({ due: "2026-11-10", when: "Tuesday" });
    expect(parseWhen("call me on Tuesday", tueMorningSydney, SYD)?.due).toBe("2026-11-10");
  });
  it("tomorrow and today follow the local day", () => {
    expect(parseWhen("I'll call tomorrow", tueMorningSydney, SYD)?.due).toBe("2026-11-04");
    expect(parseWhen("call later today", tueMorningSydney, SYD)?.due).toBe("2026-11-03");
  });
  it("crosses the week end: Friday saying Monday, Sunday saying next week", () => {
    const friEvening = new Date("2026-11-06T08:00:00Z"); // Fri 6 Nov 7 PM Sydney
    expect(parseWhen("meet Monday", friEvening, SYD)?.due).toBe("2026-11-09");
    const sunMorning = new Date("2026-11-07T21:00:00Z"); // Sun 8 Nov 8 AM Sydney, still Saturday in UTC
    expect(parseWhen("follow up next week", sunMorning, SYD)?.due).toBe("2026-11-09");
    expect(parseWhen("follow up next week", sunMorning)?.due).toBe("2026-11-09"); // Saturday in UTC: also Monday
    expect(parseWhen("chat on Saturday", sunMorning, SYD)?.due).toBe("2026-11-14");
  });
  it("crosses the year end", () => {
    const nye = new Date("2026-12-31T14:00:00Z"); // Fri 1 Jan 2027 1 AM Sydney
    expect(parseWhen("call tomorrow", nye, SYD)?.due).toBe("2027-01-02");
    expect(parseWhen("call tomorrow", nye)?.due).toBe("2027-01-01");
  });
  it("findNextStep passes the zone through", () => {
    expect(findNextStep("Hi. Let's talk next Tuesday about the quote.", tueMorningSydney, SYD)?.due).toBe("2026-11-10");
  });
});

describe("labels (HQ MB-330, MB-329)", () => {
  it("shows a day for people, never YYYY-MM-DD", () => {
    expect(dayLabel("2026-11-05")).toMatch(/Thu.*5.*Nov/);
    expect(dayLabel("soon")).toBe("soon");
    expect(dayLabel(undefined)).toBe("");
  });
  it("puts the next run on the workspace clock and names the zone only when the viewer's differs", () => {
    const at = "2026-11-02T22:00:00Z"; // 9:00 AM Sydney
    const same = whenInZone(at, "Australia/Sydney", "Australia/Sydney");
    expect(same).toMatch(/9:00/);
    expect(same).not.toMatch(/AEDT|GMT/);
    const other = whenInZone(at, "Australia/Sydney", "Europe/London");
    expect(other).toMatch(/9:00/);
    expect(other).toMatch(/AEDT|GMT\+11/);
    expect(whenInZone(null, "UTC")).toBe("");
    expect(whenInZone(at, "Bad/Zone", "UTC")).toMatch(/10:00/);
  });
});

describe("search asks the quick groups first (HQ MB-324)", () => {
  it("contacts before mail, unknown last, nothing dropped", () => {
    const asked = askOrder(["mail", "tasks", "docs", "chat", "contacts", "deals", "attachments", "files", "notes"] as const);
    expect(asked[0]).toBe("contacts");
    expect(asked.indexOf("contacts")).toBeLessThan(asked.indexOf("mail"));
    expect([...asked].sort()).toEqual(["attachments", "chat", "contacts", "deals", "docs", "files", "mail", "notes", "tasks"]);
    expect(askOrder(["zzz", "mail"])).toEqual(["mail", "zzz"]);
  });
});
