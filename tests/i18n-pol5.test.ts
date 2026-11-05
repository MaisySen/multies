import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { enableI18n, setLanguage, t } from "@/web/i18n";
import { minutesBannerText, minutesUsageLine } from "../src/web/pages/app/work/call-minutes-r34";
import { ne as ne2 } from "@/web/i18n/w2/ne";

/** POL5 (MB-363): the last English on Meetings and the shared Copy button follow Nepali and Hindi. */
const DEVANAGARI = /[\u0900-\u097F]/;
const m = { used: 3, cap: 1000, period: "2026-11", resetsOn: "2026-12-01" };

describe("POL5 MB-363", () => {
  afterEach(async () => { await setLanguage("en"); enableI18n(false); });
  it("stays English exactly as before with the language layer off", () => {
    enableI18n(false);
    expect(minutesUsageLine({ used: 320, cap: 1000, period: "2026-10", resetsOn: "2026-11-01" })).toBe("320 of 1,000 free call minutes used in October. Resets 1 November.");
    expect(t("meetings.upcoming")).toBe("Upcoming");
    expect(t("meetings.guest_count", { count: 1 })).toBe("1 guest");
    expect(t("meetings.guest_count", { count: 2 })).toBe("2 guests");
    expect(t("common.copy")).toBe("Copy");
    expect(t("common.copy_aria")).toBe("Copy to clipboard");
  });
  for (const lang of ["ne", "hi"] as const) {
    it(`reads ${lang} on Meetings and the Copy button`, async () => {
      enableI18n(true);
      await setLanguage(lang, { remember: false });
      for (const k of ["meetings.upcoming", "meetings.earlier", "meetings.video_off", "meetings.empty_body", "common.copy", "common.copied", "common.copy_aria", "calendar.app_password_copied"]) {
        const s = t(k);
        expect(s, k).toMatch(DEVANAGARI);
        expect(s, k).not.toMatch(/[A-Za-z]{3,}/);
      }
      expect(t("meetings.guest_count", { count: 1 })).toMatch(DEVANAGARI);
      const line = minutesUsageLine(m)!;
      expect(line).toMatch(DEVANAGARI);
      expect(line).not.toMatch(/free call|Resets|November|December/);
      for (const warn of ["eighty", "last_minutes", "used_up"] as const) expect(minutesBannerText({ ...m, warn, remaining: 4, percent: 80 })).toMatch(DEVANAGARI);
    });
  }
  it("uses one Nepali word for workspace in both waves", () => {
    expect(JSON.stringify(ne2)).not.toContain("कार्यक्षेत्र");
  });
  it("leaves no hard coded English on the meetings list and the Copy button", () => {
    const meetings = readFileSync("src/web/pages/app/work/meetings.tsx", "utf8");
    expect(meetings).not.toMatch(/"Upcoming"|"Earlier"|"guests"|switched on for this workspace|Start one now/);
    const misc = readFileSync("src/web/components/ui/misc.tsx", "utf8");
    expect(misc).not.toMatch(/"Copied"|label = "Copy"/);
  });
});
