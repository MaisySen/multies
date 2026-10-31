import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { C128_TABLE, C128_STOP, CodeError, code128Values, code128Widths, codeBox, parsePageList, placeBox, qrRuns, stampCode, targetPages } from "../src/web/lib/pdf-c/codes";
import { markedWords, notesAsText, notesFromPage, pdfDate } from "../src/web/lib/pdf-c/annotations";

describe("R100 barcodes", () => {
  it("has a sound Code 128 table", () => {
    expect(C128_TABLE).toHaveLength(106);
    for (const p of C128_TABLE) expect([...p].reduce((a, b) => a + Number(b), 0)).toBe(11);
    expect(new Set(C128_TABLE).size).toBe(106);
    expect([...C128_STOP].reduce((a, b) => a + Number(b), 0)).toBe(13);
  });
  it("encodes text in set B and even digits in set C with the right check symbol", () => {
    expect(code128Values("PJJ123C")).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55]);
    expect(code128Values("123456")).toEqual([105, 12, 34, 56, (105 + 12 + 34 * 2 + 56 * 3) % 103]);
    const w = code128Widths("Hi");
    expect(w.reduce((a, b) => a + b, 0)).toBe(11 * 4 + 13);
  });
  it("explains what a barcode cannot hold", () => {
    expect(() => code128Values("")).toThrow(/Type what/);
    expect(() => code128Values("café")).toThrow(/cannot go in one/);
    expect(() => code128Values("x".repeat(81))).toThrow(/up to 80/);
  });
  it("makes QR runs", () => {
    const q = qrRuns("https://multies.si");
    expect(q.size).toBeGreaterThanOrEqual(21);
    expect(q.rows[0][0]).toEqual([0, 7]);
    expect(() => qrRuns("x".repeat(1300))).toThrow(/too long/);
  });
});

describe("R100 code placement", () => {
  it("places in the nine spots and from a dragged point", () => {
    expect(placeBox("top-left", 600, 800, 100, 100)).toEqual({ x: 24, y: 676 });
    expect(placeBox("bottom-right", 600, 800, 100, 100)).toEqual({ x: 476, y: 24 });
    expect(placeBox("center", 600, 800, 100, 100)).toEqual({ x: 250, y: 350 });
    expect(placeBox({ x: 0.5, y: 0.5 }, 600, 800, 100, 100)).toEqual({ x: 300, y: 300 });
    expect(placeBox({ x: 0.99, y: 0.99 }, 600, 800, 100, 100)).toEqual({ x: 500, y: 0 });
    expect(() => placeBox("top", 100, 100, 90, 90)).toThrow(/bigger than the page/);
  });
  it("checks sizes and pages", () => {
    expect(codeBox("qr", 96)).toEqual({ w: 96, h: 96 });
    expect(codeBox("code128", 180)).toEqual({ w: 180, h: 72 });
    expect(() => codeBox("qr", 10)).toThrow(/36 to 400/);
    expect(parsePageList("1, 3-5 7")).toEqual([1, 3, 4, 5, 7]);
    expect(() => parsePageList("2-1")).toThrow(/backwards/);
    expect(() => parsePageList("x")).toThrow(/not a page number/);
    expect(targetPages("all", 3)).toEqual([0, 1, 2]);
    expect(() => targetPages([4], 3)).toThrow(/page 4 is not there/);
  });
  it("stamps a QR and a barcode onto chosen pages", async () => {
    const d = await PDFDocument.create(); d.addPage([595, 842]); d.addPage([595, 842]);
    const bytes = await d.save();
    const out = await stampCode(bytes, { kind: "qr", text: "INV-2026-0042", pages: [2], spot: "bottom-right", size: 96 });
    const out2 = await stampCode(out, { kind: "code128", text: "INV-2026-0042", pages: "all", spot: "top", size: 180, label: true });
    const doc = await PDFDocument.load(out2);
    expect(doc.getPageCount()).toBe(2);
    expect(out2.byteLength).toBeGreaterThan(bytes.byteLength + 2000);
    await expect(stampCode(new TextEncoder().encode("junk"), { kind: "qr", text: "x", pages: "all", spot: "top", size: 96 })).rejects.toThrow(CodeError);
  });
});

describe("R100 read comments", () => {
  it("reads PDF dates with offsets", () => {
    expect(pdfDate("D:20261101093000+11'00'")?.toISOString()).toBe("2026-10-31T22:30:00.000Z");
    expect(pdfDate("D:2026")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(pdfDate(42)).toBeNull();
  });
  it("turns annotations into notes with marked words and reply counts", () => {
    const items = [{ str: "Total due", transform: [1, 0, 0, 1, 100, 500], width: 50, height: 12 }, { str: "elsewhere", transform: [1, 0, 0, 1, 400, 100], width: 50, height: 12 }];
    expect(markedWords([95, 495, 200, 515], items)).toBe("Total due");
    const notes = notesFromPage(2, [
      { subtype: "Highlight", rect: [95, 495, 200, 515], titleObj: { str: "Ana" }, contentsObj: { str: "Check this" }, id: "7R", modificationDate: "D:20261101000000Z" },
      { subtype: "Text", inReplyTo: "7R", contentsObj: { str: "Done" } },
      { subtype: "Link" },
      { subtype: "Text", contentsObj: { str: "" } },
    ], items);
    expect(notes).toEqual([{ page: 2, kind: "highlight", author: "Ana", date: new Date(Date.UTC(2026, 10, 1)), text: "Check this", marked: "Total due", replies: 1 }]);
    expect(notesAsText("a.pdf", notes)).toContain('Page 2, Highlight, Ana, 2026-11-01\n  Marked: "Total due"\n  Check this');
  });
});
