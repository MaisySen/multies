import { describe, it, expect } from "vitest";
import { readContacts, parseIcsEvents } from "@/server/services/data-move/formats";

/**
 * QUAL1 (Semgrep regex_dos sample): the import email check, /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/, backtracks
 * quadratically on a long value that fails near its end ("a@" + 100,000 dots + " x" took about 4 seconds before
 * QUAL1). The server runs it on every email in an uploaded contacts or calendar file. No address is longer than
 * 254 characters, so longer values are skipped before the pattern runs.
 */
const long = "a@" + ".".repeat(100_000) + " x";

describe("an imported file with a huge email value is read quickly", () => {
  it("contacts CSV: the row is skipped in well under a second", () => {
    const t = performance.now();
    const r = readContacts(`name,email\nSam,${long}\nAna,ana@example.com\n`);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.contacts.map((c) => c.email)).toEqual(["ana@example.com"]);
    expect(r.skipped).toBe(1);
  });

  it("vCard: the card is skipped in well under a second", () => {
    const t = performance.now();
    const r = readContacts(["BEGIN:VCARD", "FN:Sam", `EMAIL:${long}`, "END:VCARD", "BEGIN:VCARD", "FN:Ana", "EMAIL:ana@example.com", "END:VCARD"].join("\r\n"));
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.contacts.map((c) => c.email)).toEqual(["ana@example.com"]);
  });

  it("calendar: a huge attendee is dropped in well under a second", () => {
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:1", "DTSTART:20261112T010000Z", "DTEND:20261112T020000Z", "SUMMARY:Plan",
      `ATTENDEE:mailto:${long}`, "ATTENDEE:mailto:ana@example.com", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const t = performance.now();
    const r = parseIcsEvents(ics);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.events[0].invitees).toEqual(["ana@example.com"]);
  });

  it("an address of up to 254 characters still imports", () => {
    const ok = "a".repeat(64) + "@" + "b".repeat(180) + ".com";
    expect(ok.length).toBeLessThanOrEqual(254);
    expect(readContacts(`email\n${ok}\n`).contacts.map((c) => c.email)).toEqual([ok]);
  });
});
