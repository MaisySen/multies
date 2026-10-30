import { previewLine, replyAllCc, splitQuoted } from "@/lib/quote";
import { meetingDays } from "@/lib/meetings";
import { pushRecent, RECENT_MAX } from "@/lib/recent-search";

describe("R36 thread helpers", () => {
  it("folds the quoted tail after an On ... wrote: line", () => {
    const r = splitQuoted("Thanks, paid today.\n\nOn Tue, 27 Oct 2026 at 9:00, Li Chen <li@x.com> wrote:\n> Is it paid?\n> Li");
    expect(r.body).toBe("Thanks, paid today.");
    expect(r.quoted).toMatch(/^On Tue.*wrote:\nIs it paid\?\nLi$/);
  });
  it("folds a trailing run of > lines, and leaves plain mail alone", () => {
    expect(splitQuoted("Yes.\n> old line\n>\n> more").quoted).toBe("old line\n\nmore");
    expect(splitQuoted("Just one message.")).toEqual({ body: "Just one message.", quoted: null });
    expect(splitQuoted("> all quoted")).toEqual({ body: "> all quoted", quoted: null });
    expect(splitQuoted(null)).toEqual({ body: "", quoted: null });
  });
  it("previews the first words only", () => {
    expect(previewLine("Hi Mia,\n\nCould we bump the order?\nOn Mon, x wrote:\n> old")).toBe("Hi Mia, Could we bump the order?");
    expect(previewLine("a".repeat(200), 20)).toHaveLength(20);
  });
  it("Reply all copies everyone else once, never me or the person replied to", () => {
    const m = { to: [{ address: "me@co.com" }, { address: "Ann@x.com" }], cc: [{ address: "ann@x.com" }, { address: "bob@y.com" }, { address: "sam@z.com" }] };
    expect(replyAllCc(m, "sam@z.com", ["ME@co.com"])).toEqual(["Ann@x.com", "bob@y.com"]);
  });
});

describe("R36 meetings and search helpers", () => {
  it("groups meetings by day, Today first", () => {
    const now = new Date(2026, 9, 27, 9, 0).getTime();
    const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).toISOString();
    const days = meetingDays([{ startsAt: at(29, 10) }, { startsAt: at(27, 15) }, { startsAt: at(28, 9) }, { startsAt: at(27, 11) }], now);
    expect(days.map((d) => d.label.slice(0, 8))).toEqual(["Today", "Tomorrow", days[2].label.slice(0, 8)]);
    expect(days[0].today).toBe(true);
    expect(days[0].items.map((m) => new Date(m.startsAt).getHours())).toEqual([11, 15]);
  });
  it("keeps recent searches newest first, no repeats, capped", () => {
    let r: string[] = [];
    for (const q of ["invoice", "bas", "Invoice", "x", "a1", "a2", "a3", "a4", "a5"]) r = pushRecent(r, q);
    expect(r[0]).toBe("a5");
    expect(r).toHaveLength(RECENT_MAX);
    expect(r.filter((x) => x.toLowerCase() === "invoice")).toHaveLength(1);
    expect(r).not.toContain("x");
  });
});
