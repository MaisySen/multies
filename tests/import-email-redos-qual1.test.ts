import { describe, it, expect } from "vitest";
import { readContacts, parseIcsEvents, isEmail } from "@/server/services/data-move/formats";

/**
 * QUAL1 (Semgrep regex_dos sample): the import email check, /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/, backtracks
 * quadratically on a long value that fails near its end ("a@" + 100,000 dots + " x" took about 4 seconds before
 * QUAL1). The server runs it on every email in an uploaded contacts or calendar file. No address is longer than
 * 254 characters, so longer values are skipped. Review 2 (12 Nov 2026): the cap bounds each value, not the file, and
 * a 253 character value still cost about 31,000 steps, so an 8 MB file of them took about a second. The check is now
 * a plain scan that accepts exactly what the pattern did.
 */
const OLD_EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const BAD_253 = "a@" + ".".repeat(250) + "<";
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

  it("40,000 values of 253 characters that fail at the end are checked in well under a second", () => {
    expect(BAD_253.length).toBe(253);
    const t = performance.now();
    let accepted = 0;
    for (let k = 0; k < 40_000; k++) if (isEmail(BAD_253)) accepted++;
    expect(performance.now() - t).toBeLessThan(300);
    expect(accepted).toBe(0);
  });

  it("calendar: a 2 MB file of such attendees is read in well under a second", () => {
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:1", "DTSTART:20261112T010000Z", "DTEND:20261112T020000Z", "SUMMARY:Plan",
      ...Array.from({ length: 8000 }, () => `ATTENDEE:mailto:${BAD_253}`), "ATTENDEE:mailto:ana@example.com", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const t = performance.now();
    const r = parseIcsEvents(ics);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.events[0].invitees).toEqual(["ana@example.com"]);
  });

  it("the check accepts exactly what the old pattern did, on 100,000 random short values", () => {
    let seed = 20261112;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const parts = ["a", "b", ".", ".", "@", "@", " ", "\t", "<", ">", '"', "'", "-", String.fromCharCode(0xa0), String.fromCharCode(0x2028), "x.y", "a@b.c"];
    let addresses = 0;
    for (let k = 0; k < 100_000; k++) {
      let s = "";
      for (let n = Math.floor(rnd() * 10); n > 0; n--) s += parts[Math.floor(rnd() * parts.length)];
      const want = OLD_EMAIL.test(s);
      if (want) addresses++;
      expect([s, isEmail(s)]).toEqual([s, want]);
    }
    expect(addresses).toBeGreaterThan(1000);
    expect(["ana@example.com", "a.b@c.d", "a@b.c.", "a@.bc", "a@b..c", "@b.c", "a@@b.c", "a@b", "a b@c.d"].map(isEmail)).toEqual([true, true, true, false, true, false, false, false, false]);
  });

  it("an address of up to 254 characters still imports", () => {
    const ok = "a".repeat(64) + "@" + "b".repeat(180) + ".com";
    expect(ok.length).toBeLessThanOrEqual(254);
    expect(readContacts(`email\n${ok}\n`).contacts.map((c) => c.email)).toEqual([ok]);
  });
});
