/**
 * B4: numeric character references past U+10FFFF (or not numbers at all) in text from outside made String.fromCodePoint
 * throw a RangeError: a CalDAV server's multistatus reply, an uploaded .xlsx for a work import, and a .docx or .xlsx
 * attachment being indexed. They now read as U+FFFD and the rest of the text survives.
 */
import { describe, it, expect } from "vitest";
import { strToU8, zipSync } from "fflate";
import { multistatus } from "@/server/services/suite/caldav";
import { xlsxRows } from "@/server/services/work-import/parse";
import { extractLocal } from "@/server/services/tools/attachment-index";
import { codePointText } from "@/server/lib/code-point";

const BAD = "a&#1114112;b&#x110000;c&#99999999999999999999;d";
const READ = "a�b�c�d";

describe("B4: out of range numeric references in outside XML", () => {
  it("a CalDAV multistatus href with one decodes instead of throwing", () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/cal/${BAD}/&#65;.ics</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    expect(multistatus(xml).map((r) => r.href)).toEqual([`/cal/${READ}/A.ics`]);
  });

  it("an .xlsx work import cell with one reads the rest of the sheet", () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${BAD}</t></is></c><c r="B1" t="inlineStr"><is><t>ok &#x1F642;</t></is></c></row></sheetData></worksheet>`;
    const b64 = Buffer.from(zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheet) })).toString("base64");
    expect(xlsxRows(b64)).toEqual([[READ, "ok \u{1F642}"]]);
  });

  it("an attachment with one is still indexed", () => {
    const docx = zipSync({ "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>${BAD}</w:t></w:r></w:p></w:body></w:document>`) });
    expect(extractLocal("a.docx", docx)).toContain(READ);
    const xlsx = zipSync({ "xl/sharedStrings.xml": strToU8(`<sst><si><t>${BAD}</t></si></sst>`) });
    expect(extractLocal("a.xlsx", xlsx)).toBe(READ);
  });

  it("valid code points pass through and invalid ones become U+FFFD", () => {
    expect(codePointText(65)).toBe("A");
    expect(codePointText(0x10ffff)).toBe("\u{10ffff}");
    for (const n of [0, -1, 0x110000, NaN, Infinity, 1.5, 0xd800, 0xdfff]) expect(codePointText(n)).toBe("�");
  });
});
