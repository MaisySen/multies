import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { Calc, FErr, SHEET_CAPS, addr, colIndex, colName, display, inputOf, parseInput, shiftFormula, type Workbook } from "../src/shared/office-r113/sheet";
import { readCsv, readXlsx, writeCsv, writeXlsx } from "../src/shared/office-r113/xlsx";
import { readDocx, writeDocx, imageSize, type PMNode } from "../src/shared/office-r113/docx";
import { readPptxOutline } from "../src/shared/office-r113/pptx";
import { OfficeError, OFFICE_CAPS } from "../src/shared/office-r113/xml";

function book(cells: Record<string, string>, more: Record<string, Record<string, string>> = {}): Workbook {
  const mk = (name: string, cs: Record<string, string>) => ({ name, cells: new Map(Object.entries(cs).map(([a, raw]) => [a, parseInput(raw)])), rowCount: 50, colCount: 12 });
  return { sheets: [mk("Sheet1", cells), ...Object.entries(more).map(([n, cs]) => mk(n, cs))] };
}
const val = (wb: Workbook, a: string, si = 0) => { const c = new Calc(wb); const m = /^([A-Z]+)(\d+)$/.exec(a)!; return c.value(si, Number(m[2]) - 1, colIndex(m[1])); };

describe("R113 formulas", () => {
  const wb = book({ A1: "1", A2: "2", A3: "3", A4: "hello", B1: "=SUM(A1:A3)", B2: "=AVERAGE(A1:A3)", B3: "=MIN(A1:A3)", B4: "=MAX(A1:A3)", B5: "=COUNT(A1:A4)", B6: "=COUNTA(A1:A4)",
    B7: '=IF(A1>0,"yes","no")', B8: "=IF(A1>5,1)", B9: "=A1+A2*A3", B10: "=(A1+A2)*A3", B11: "=-2^2", B12: "=2^3^2", B13: "=50%", B14: '=A4&" world"', B15: "=1/0",
    B16: "=NOPE(1)", B17: "=Other!A1*2", B18: "='Other'!A1:A2", B19: "=SUM(Other!A1:A2)", B20: "=C20", C20: "=B20", B21: "=ROUND(2.345,2)", B22: "=ABS(-4)", B23: "=AND(TRUE,A1=1)", B24: "=OR(FALSE,0)", B25: "=NOT(A1)",
    B26: "=SUM(A:A)", B27: "=$A$1+A$2", B28: "=A4+1", B29: "=Missing!A1", B30: '="a"<"B"', B31: "=1=1", B32: "=SUM(A1,A2,5)", B33: "=AVERAGE(A4)", B34: "=CONCAT(A1:A2,\"x\")", B35: "=1+", B36: "=SUM(B15,1)" },
    { Other: { A1: "10", A2: "20" } });
  it.each([["B1", 6], ["B2", 2], ["B3", 1], ["B4", 3], ["B5", 3], ["B6", 4], ["B7", "yes"], ["B8", false], ["B9", 7], ["B10", 9], ["B11", 4], ["B12", 64], ["B13", 0.5],
    ["B14", "hello world"], ["B17", 20], ["B19", 30], ["B21", 2.35], ["B22", 4], ["B23", true], ["B24", false], ["B25", false], ["B26", 6], ["B27", 3], ["B30", true], ["B31", true], ["B32", 8], ["B34", "12x"]])("%s works out", (a, want) => {
    expect(val(wb, a as string)).toEqual(want);
  });
  it.each([["B15", "#DIV/0!"], ["B16", "#NAME?"], ["B18", "#VALUE!"], ["B20", "#CYCLE!"], ["B28", "#VALUE!"], ["B29", "#REF!"], ["B33", "#DIV/0!"], ["B35", "#VALUE!"], ["B36", "#DIV/0!"]])("%s shows %s", (a, code) => {
    const v = val(wb, a as string); expect(v).toBeInstanceOf(FErr); expect(display(v)).toBe(code);
  });
  it("caps big ranges and deep nesting", () => {
    const big = book({ A1: `=SUM(A2:CV${SHEET_CAPS.rows})` });
    expect(display(val(big, "A1"))).toBe("#VALUE!");
    const deep = book({ A1: "=" + "(".repeat(80) + "1" + ")".repeat(80) });
    expect(display(val(deep, "A1"))).toBe("#VALUE!");
  });
  it("reads typed entries and shows them back", () => {
    expect(parseInput("12.5")).toEqual({ v: 12.5 }); expect(parseInput("=A1")).toEqual({ f: "A1" }); expect(parseInput("'=A1")).toEqual({ v: "=A1" });
    expect(parseInput("true")).toEqual({ v: true }); expect(parseInput("")).toEqual({}); expect(parseInput("007a")).toEqual({ v: "007a" });
    expect(inputOf({ f: "SUM(A1:A2)" })).toBe("=SUM(A1:A2)"); expect(inputOf({ v: 45658, date: true })).toBe("2025-01-01");
    expect(display(0.1 + 0.2)).toBe("0.3"); expect(colName(0)).toBe("A"); expect(colName(27)).toBe("AB"); expect(colIndex("AB")).toBe(27); expect(addr(9, 2)).toBe("C10");
  });
  it("moves relative refs of shared formulas", () => {
    expect(shiftFormula("A1*2+$B$1+SUM(C1:C3)", 2, 1)).toBe("B3*2+$B$1+SUM(D3:D5)");
    expect(shiftFormula('"A1"&LOG10(A1)', 1, 0)).toBe('"A1"&LOG10(A2)');
    expect(shiftFormula("A1", -1, 0)).toBe("#REF!");
  });
});

describe("R113 xlsx and csv", () => {
  it("round trips values, formulas, dates and sheets", () => {
    const wb = book({ A1: "Item", B1: "Cost", A2: "Pens", B2: "2.5", A3: "Paper", B3: "4", B4: "=SUM(B2:B3)", C1: "TRUE", D1: "x & <y> \"z\"" }, { "My sheet": { A1: "=Sheet1!B4*2" } });
    wb.sheets[0].cells.set("E1", { v: 45658, date: true });
    wb.sheets[0].colWidths = { 0: 120 };
    const back = readXlsx(writeXlsx(wb)).wb;
    expect(back.sheets.map((s) => s.name)).toEqual(["Sheet1", "My sheet"]);
    expect(back.sheets[0].cells.get("B4")).toMatchObject({ f: "SUM(B2:B3)", v: 6.5 });
    expect(back.sheets[0].cells.get("C1")).toEqual({ v: true });
    expect(back.sheets[0].cells.get("D1")).toEqual({ v: 'x & <y> "z"' });
    expect(back.sheets[0].cells.get("E1")).toMatchObject({ v: 45658, date: true });
    expect(back.sheets[0].colWidths?.[0]).toBe(120);
    expect(val(back, "A1", 1)).toBe(13);
  });
  it("reads shared strings and shared formulas", () => {
    const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1</v></c><c r="C1"><f t="shared" ref="C1:C2" si="0">B1*2</f><v>2</v></c></row><row r="2"><c r="B2"><v>5</v></c><c r="C2"><f t="shared" si="0"/><v>10</v></c></row></sheetData></worksheet>`;
    const bytes = zipSync({ "xl/workbook.xml": strToU8(`<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`), "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="x"/></Relationships>`), "xl/worksheets/sheet1.xml": strToU8(sheet), "xl/sharedStrings.xml": strToU8(`<sst><si><t xml:space="preserve"> Total </t></si></sst>`) });
    const { wb } = readXlsx(bytes);
    expect(wb.sheets[0].cells.get("A1")).toEqual({ v: " Total " });
    expect(wb.sheets[0].cells.get("C2")?.f).toBe("B2*2");
    expect(val(wb, "C2")).toBe(10);
  });
  it("opens over cap files view only with a plain reason", () => {
    const rows = Array.from({ length: SHEET_CAPS.rows + 5 }, (_, i) => `${i},x`).join("\n");
    const r = readCsv(rows); expect(r.overCap).toMatch(/5,000 rows/); expect(r.wb.sheets[0].rowCount).toBe(SHEET_CAPS.rows);
    const wide = readCsv(Array.from({ length: 120 }, (_, i) => String(i)).join(",")); expect(wide.overCap).toMatch(/100 columns/);
  });
  it("round trips csv with quotes and keeps values for formulas", () => {
    const r = readCsv('name,note,n\r\n"Smith, J","said ""hi""\nthere",3\r\nx,,=C2*2\r\n');
    expect(r.wb.sheets[0].cells.get("B2")).toEqual({ v: 'said "hi"\nthere' });
    const out = writeCsv(r.wb);
    expect(out).toBe('name,note,n\r\n"Smith, J","said ""hi""\nthere",3\r\nx,,6\r\n');
    expect(r.notes[0]).toMatch(/values only/);
  });
  it("refuses files that are not workbooks", () => {
    expect(() => readXlsx(strToU8("hello"))).toThrow(OfficeError);
  });
});

const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEUlEQVR4nGP8z8DAwMDAxAAADg0BBd7nlEAAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
const src = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;
const sample: PMNode = { type: "doc", content: [
  { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] },
  { type: "paragraph", content: [{ type: "text", text: "Bold ", marks: [{ type: "bold" }] }, { type: "text", text: "italic", marks: [{ type: "italic" }] }, { type: "text", text: " under", marks: [{ type: "underline" }] }, { type: "text", text: " gone", marks: [{ type: "strike" }] }, { type: "hardBreak" }, { type: "text", text: "site", marks: [{ type: "link", attrs: { href: "https://example.com/a?b=1&c=2" } }] }] },
  { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one a" }] }] }] }] }, { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] }] },
  { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] }, { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] }] },
  { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] },
  { type: "codeBlock", content: [{ type: "text", text: "a = 1\nb = 2" }] },
  { type: "horizontalRule" },
  { type: "table", content: [
    { type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 1, rowspan: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }] }, { type: "tableHeader", attrs: { colspan: 1, rowspan: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "Qty" }] }] }] },
    { type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 2, rowspan: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "wide" }] }] }] }] },
  { type: "image", attrs: { src } },
  { type: "paragraph", content: [{ type: "text", text: "tab\there" }] },
] };

describe("R113 docx", () => {
  const back = readDocx(writeDocx(sample)).doc.content!;
  const t = (n: PMNode | undefined): string => (n?.text ?? "") + (n?.content ?? []).map(t).join("");
  it("keeps headings and marks", () => {
    expect(back[0]).toEqual({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] });
    const marks = back[1].content!.map((x) => [x.type, x.text, (x.marks ?? []).map((m) => m.type).join()]);
    expect(marks).toEqual([["text", "Bold ", "bold"], ["text", "italic", "italic"], ["text", " under", "underline"], ["text", " gone", "strike"], ["hardBreak", undefined, ""], ["text", "site", "link"]]);
    expect(back[1].content![5].marks![0].attrs).toEqual({ href: "https://example.com/a?b=1&c=2" });
  });
  it("keeps nested bullet and numbered lists", () => {
    expect(back[2].type).toBe("bulletList");
    expect(back[2].content!.length).toBe(2);
    expect(back[2].content![0].content![1].type).toBe("bulletList");
    expect(t(back[2].content![0].content![1])).toBe("one a");
    expect(back[3].type).toBe("orderedList"); expect(t(back[3])).toBe("firstsecond");
  });
  it("keeps quotes, code, dividers, tables, images and tabs", () => {
    expect(back[4]).toMatchObject({ type: "blockquote" }); expect(t(back[4])).toBe("quoted");
    expect(back[5]).toEqual({ type: "codeBlock", content: [{ type: "text", text: "a = 1\nb = 2" }] });
    expect(back[6].type).toBe("horizontalRule");
    expect(back[7].type).toBe("table"); expect(back[7].content![0].content![0].type).toBe("tableHeader"); expect(back[7].content![1].content![0].attrs?.colspan).toBe(2);
    const img = back.find((b) => b.type === "image"); expect(String(img?.attrs?.src)).toBe(src); expect(img?.attrs?.width).toBe(2); expect(img?.attrs?.height).toBe(3);
    expect(t(back[back.length - 1])).toBe("tab\there");
  });
  it("names what it cannot keep", () => {
    const doc = `<w:document xmlns:w="w"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>red</w:t></w:r><w:del><w:r><w:t>old</w:t></w:r></w:del><w:ins><w:r><w:t> new</w:t></w:r></w:ins></w:p></w:body></w:document>`;
    const r = readDocx(zipSync({ "word/document.xml": strToU8(doc), "word/header1.xml": strToU8("<x/>"), "word/comments.xml": strToU8("<x/>") }));
    expect(r.doc.content![0].content![0].text).toBe("red new");
    expect(r.notes.join(" ")).toMatch(/Headers and footers/); expect(r.notes.join(" ")).toMatch(/Comments/); expect(r.notes.join(" ")).toMatch(/Tracked changes/); expect(r.notes.join(" ")).toMatch(/colours/); expect(r.notes.join(" ")).toMatch(/alignment/);
  });
  it("refuses non documents and zip bombs", () => {
    expect(() => readDocx(strToU8("plain"))).toThrow(/not a Word document/);
    const bomb = zipSync({ "word/document.xml": new Uint8Array(OFFICE_CAPS.unzippedBytes + 10) }, { level: 9 });
    try { readDocx(bomb); throw new Error("no"); } catch (e) { expect((e as OfficeError).code).toBe("too_big"); }
  });
  it("reads image sizes", () => { expect(imageSize(png)).toEqual({ w: 2, h: 3 }); });
  it("writes an empty doc that opens", () => { expect(readDocx(writeDocx({ type: "doc", content: [] })).doc.content).toEqual([{ type: "paragraph" }]); });
});

describe("R113 pptx outline", () => {
  it("lists slides in order with titles", () => {
    const slide = (title: string, body: string) => strToU8(`<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
    const bytes = zipSync({ "ppt/presentation.xml": strToU8(`<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships><Relationship Id="rId2" Target="slides/slide1.xml" Type="s"/><Relationship Id="rId3" Target="slides/slide2.xml" Type="s"/></Relationships>`),
      "ppt/slides/slide1.xml": slide("Intro", "Hello"), "ppt/slides/slide2.xml": slide("Agenda", "Point one") });
    expect(readPptxOutline(bytes)).toEqual([{ title: "Agenda", lines: ["Point one"] }, { title: "Intro", lines: ["Hello"] }]);
  });
});
