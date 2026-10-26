import { describe, expect, it } from "vitest";
import { buildMessage, classifyFolder, labelFor, makeToken, manualChecklist, parseImap, parseSeeds, refineGmail, report } from "../scripts/placement-check";

/** R34 (MB-170): the inbox placement check script, everything but the network. */
describe("placement check (R34, MB-170)", () => {
  it("reads seeds from the environment, labels them by provider and picks up per seed IMAP logins", () => {
    const seeds = parseSeeds({ PLACEMENT_SEEDS: "me+seed@gmail.com, outlook=x@outlook.com,y@yahoo.co.uk", PLACEMENT_IMAP_GMAIL: "imap.gmail.com:993:me@gmail.com:app:pass:with:colons" });
    expect(seeds.map((s) => s.label)).toEqual(["gmail", "outlook", "yahoo"]);
    expect(seeds[0].imap).toEqual({ host: "imap.gmail.com", port: 993, user: "me@gmail.com", pass: "app:pass:with:colons" });
    expect(seeds[1].imap).toBeUndefined();
    expect(parseSeeds({})).toEqual([]);
    expect(labelFor("a@icloud.com")).toBe("icloud");
  });
  it("refuses bad input in plain words", () => {
    expect(() => parseSeeds({ PLACEMENT_SEEDS: "not-an-address" })).toThrow(/not an email address/);
    expect(() => parseSeeds({ PLACEMENT_SEEDS: "a@gmail.com,b@gmail.com" })).toThrow(/share the label/);
    expect(() => parseImap("host:abc:user:pass")).toThrow(/host:port:user:pass/);
  });
  it("reads a seeds file kept outside the repo", () => {
    const seeds = parseSeeds({ PLACEMENT_SEEDS_FILE: "/secret/seeds.json" }, () => JSON.stringify([{ address: "q@outlook.com", imap: { host: "outlook.office365.com", port: 993, user: "q", pass: "p" } }]));
    expect(seeds).toEqual([{ label: "outlook", address: "q@outlook.com", imap: { host: "outlook.office365.com", port: 993, user: "q", pass: "p" } }]);
  });
  it("builds one plain test mail with the token in the subject and a header", () => {
    const token = makeToken(() => Buffer.from("0102030405", "hex"));
    expect(token).toBe("MPC-0102030405");
    const m = buildMessage("Multies <check@multies.si>", ["a@gmail.com"], token, new Date("2026-10-26T13:00:00Z"));
    expect(m.subject).toBe("Multies placement check MPC-0102030405");
    expect(m.headers["X-Multies-Placement"]).toBe(token);
    expect(m.text).toContain("2026-10-26 13:00 UTC");
    expect(m.html).not.toMatch(/<img|tracking/i);
  });
  it("tells Inbox from Spam and Promotions by special use, name and Gmail labels", () => {
    expect(classifyFolder("INBOX")).toBe("inbox");
    expect(classifyFolder("[Gmail]/Spam", "\\Junk")).toBe("spam");
    expect(classifyFolder("Junk Email")).toBe("spam");
    expect(classifyFolder("Bulk")).toBe("spam");
    expect(classifyFolder("Archive")).toBe("other");
    expect(refineGmail("inbox", ["\\Inbox", "\\Promotions"])).toBe("promotions");
    expect(refineGmail("inbox", ["\\Important"])).toBe("inbox");
    expect(refineGmail("spam", ["\\Promotions"])).toBe("spam");
  });
  it("reports per seed, exits 0 only when every checked seed is in the inbox, and lists the manual checks", () => {
    const a = { label: "gmail", address: "a@gmail.com" }, b = { label: "outlook", address: "b@outlook.com" };
    expect(report([{ seed: a, placement: "inbox", folder: "INBOX" }, { seed: b, placement: "manual" }]).code).toBe(0);
    const bad = report([{ seed: a, placement: "inbox" }, { seed: b, placement: "spam", folder: "Junk Email" }]);
    expect(bad.code).toBe(1);
    expect(bad.text).toContain("1 of 2 checked seeds in the inbox.");
    expect(report([{ seed: a, placement: "manual" }]).text).toContain("nothing was checked automatically");
    const list = manualChecklist([b], "MPC-1");
    expect(list).toContain('search for "MPC-1"');
    expect(list).toContain("outlook: b@outlook.com");
    expect(manualChecklist([], "MPC-1")).toBe("");
  });
});
