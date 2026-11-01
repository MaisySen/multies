/**
 * R113: XLSX and CSV in and out for the sheet editor (basic fidelity: values, formulas, dates, column widths;
 * styles, charts, merged cells and comments are not kept, and the editor says so).
 */
import Papa from "papaparse";
import { SHEET_CAPS, addr, colName, parseAddr, parseInput, shiftFormula, Calc, FErr, type Cell, type Sheet, type Workbook } from "./sheet";
import { OfficeError, attr, child, children, esc, find, findAll, isZip, kids, parseXml, readRels, text, textOf, unzipParts, zipParts, type XNode } from "./xml";

export interface LoadedBook { wb: Workbook; notes: string[]; overCap: string | null }

const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export function readXlsx(bytes: Uint8Array): LoadedBook {
  if (!isZip(bytes)) throw new OfficeError("not_office", "This is not an Excel workbook (.xlsx).");
  const parts = unzipParts(bytes, (n) => n.startsWith("xl/") && (n.endsWith(".xml") || n.endsWith(".rels")) && !n.startsWith("xl/media/"));
  const wbXml = parts["xl/workbook.xml"];
  if (!wbXml) throw new OfficeError("broken", "This workbook could not be read. It may be damaged.");
  const notes = new Set<string>();
  const rels = readRels(text(parts["xl/_rels/workbook.xml.rels"]), "xl");
  const shared: string[] = [];
  const ss = parts["xl/sharedStrings.xml"];
  if (ss) for (const si of findAll(parseXml(text(ss)), "si")) shared.push(findAll(kids(si), "t").filter((t) => !inPhonetic(si, t)).map(textOf).join(""));
  const dateStyles = readDateStyles(text(parts["xl/styles.xml"]));
  const sheetsEl = findAll(parseXml(text(wbXml)), "sheet");
  if (sheetsEl.length > SHEET_CAPS.sheets) notes.add(`Only the first ${SHEET_CAPS.sheets} sheets open here.`);
  const wb: Workbook = { sheets: [] };
  let overCap: string | null = null; let filled = 0;
  for (const s of sheetsEl.slice(0, SHEET_CAPS.sheets)) {
    const rid = attr(s, "r:id") ?? attr(s, "id"); const rel = rid ? rels.get(rid) : undefined;
    const name = attr(s, "name") ?? `Sheet${wb.sheets.length + 1}`;
    const sheet: Sheet = { name, cells: new Map(), rowCount: 1, colCount: 1 };
    wb.sheets.push(sheet);
    const src = rel ? parts[rel.target] : undefined;
    if (!src) { notes.add("Charts and other non grid sheets are not shown."); continue; }
    const doc = parseXml(text(src));
    const sharedF = new Map<string, { f: string; r: number; c: number }>();
    for (const col of findAll(doc, "col")) {
      const min = Number(attr(col, "min")), max = Number(attr(col, "max")), w = Number(attr(col, "width"));
      if (w > 0 && max - min < 200) for (let i = min; i <= max && i <= SHEET_CAPS.cols; i++) (sheet.colWidths ??= {})[i - 1] = Math.round(w * 7 + 5);
    }
    if (find(doc, "mergeCell")) notes.add("Merged cells open as separate cells.");
    if (find(doc, "conditionalFormatting")) notes.add("Conditional formatting is not kept.");
    if (find(doc, "drawing")) notes.add("Charts and pictures are not shown and are not kept when you save.");
    let maxR = 0, maxC = 0;
    const data = find(doc, "sheetData");
    for (const row of data ? children(data, "row") : []) {
      for (const c of children(row, "c")) {
        const ref = attr(c, "r"); const a = ref ? parseAddr(ref) : null; if (!a) continue;
        if (a.r >= SHEET_CAPS.rows || a.c >= SHEET_CAPS.cols) { overCap ??= `This sheet is bigger than ${SHEET_CAPS.rows.toLocaleString("en")} rows or ${SHEET_CAPS.cols} columns, so it opens view only with the first part shown.`; continue; }
        if (++filled > SHEET_CAPS.cells) { overCap ??= `This workbook has more than ${SHEET_CAPS.cells.toLocaleString("en")} filled cells, so it opens view only with the first part shown.`; break; }
        const t = attr(c, "t") ?? "n"; const fEl = child(c, "f"); const vEl = child(c, "v");
        const cell: Cell = {};
        const raw = vEl ? textOf(vEl) : "";
        if (t === "s") cell.v = shared[Number(raw)] ?? "";
        else if (t === "inlineStr") { const is = child(c, "is"); cell.v = is ? findAll(kids(is), "t").map(textOf).join("") : ""; }
        else if (t === "str") cell.v = raw;
        else if (t === "b") cell.v = raw === "1";
        else if (t === "e") cell.v = raw;
        else if (raw !== "") { const n = Number(raw); cell.v = Number.isFinite(n) ? n : raw; }
        const st = Number(attr(c, "s") ?? "0");
        if (dateStyles.has(st) && typeof cell.v === "number") cell.date = true;
        if (fEl) {
          const ft = attr(fEl, "t"); const si = attr(fEl, "si"); const body = textOf(fEl);
          if (ft === "array") notes.add("Array formulas show their saved values.");
          if (ft === "shared" && si != null) {
            if (body) { sharedF.set(si, { f: body, r: a.r, c: a.c }); cell.f = body; }
            else { const base = sharedF.get(si); if (base) cell.f = shiftFormula(base.f, a.r - base.r, a.c - base.c); }
          } else if (body && ft !== "array") cell.f = body;
        }
        if (cell.v === undefined && cell.f == null) continue;
        sheet.cells.set(addr(a.r, a.c), cell);
        maxR = Math.max(maxR, a.r); maxC = Math.max(maxC, a.c);
      }
    }
    sheet.rowCount = Math.min(SHEET_CAPS.rows, Math.max(maxR + 21, 50));
    sheet.colCount = Math.min(SHEET_CAPS.cols, Math.max(maxC + 3, 12));
  }
  if (!wb.sheets.length) wb.sheets.push({ name: "Sheet1", cells: new Map(), rowCount: 50, colCount: 12 });
  if (parts["xl/styles.xml"]) notes.add("Colours, fonts and borders are not kept.");
  return { wb, notes: [...notes], overCap };
}
function inPhonetic(si: XNode, t: XNode): boolean {
  for (const rph of findAll(kids(si), "rPh")) if (findAll(kids(rph), "t").includes(t)) return true;
  return false;
}
function readDateStyles(src: string): Set<number> {
  const out = new Set<number>(); if (!src) return out;
  const doc = parseXml(src); const custom = new Set<number>();
  for (const nf of findAll(doc, "numFmt")) {
    const code = (attr(nf, "formatCode") ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
    if (/[dy]|m{1,4}(?![^;]*[hs])/i.test(code) && !/^[#0.,%\s]+$/.test(code)) custom.add(Number(attr(nf, "numFmtId")));
  }
  const xfs = find(doc, "cellXfs");
  children(xfs ?? {}, "xf").forEach((xf, i) => { const id = Number(attr(xf, "numFmtId") ?? "0"); if (DATE_IDS.has(id) || custom.has(id)) out.add(i); });
  return out;
}

/** Writes a workbook as XLSX: formulas kept with their worked out values; dates keep a date format. */
export function writeXlsx(wb: Workbook): Uint8Array {
  const calc = new Calc(wb);
  const sheetXml = wb.sheets.map((sh, si) => {
    const rows = new Map<number, { c: number; xml: string }[]>();
    for (const [a, cell] of sh.cells) {
      const p = parseAddr(a); if (!p) continue;
      const s = cell.date ? ' s="1"' : "";
      let x: string;
      if (cell.f != null) {
        const v = calc.value(si, p.r, p.c);
        const f = `<f>${esc(cell.f)}</f>`;
        x = v instanceof FErr ? `<c r="${a}" t="e"${s}>${f}<v>${v.code}</v></c>`
          : typeof v === "number" ? `<c r="${a}"${s}>${f}<v>${v}</v></c>`
          : typeof v === "boolean" ? `<c r="${a}" t="b"${s}>${f}<v>${v ? 1 : 0}</v></c>`
          : `<c r="${a}" t="str"${s}>${f}<v>${esc(String(v ?? ""))}</v></c>`;
      } else if (typeof cell.v === "number") x = `<c r="${a}"${s}><v>${cell.v}</v></c>`;
      else if (typeof cell.v === "boolean") x = `<c r="${a}" t="b"><v>${cell.v ? 1 : 0}</v></c>`;
      else if (cell.v == null || cell.v === "") continue;
      else x = `<c r="${a}" t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.v))}</t></is></c>`;
      (rows.get(p.r) ?? rows.set(p.r, []).get(p.r)!).push({ c: p.c, xml: x });
    }
    const body = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([r, cs]) => `<row r="${r + 1}">${cs.sort((a, b) => a.c - b.c).map((c) => c.xml).join("")}</row>`).join("");
    const cols = sh.colWidths && Object.keys(sh.colWidths).length
      ? `<cols>${Object.entries(sh.colWidths).sort((a, b) => Number(a[0]) - Number(b[0])).map(([c, px]) => `<col min="${Number(c) + 1}" max="${Number(c) + 1}" width="${Math.max(1, Math.round(((px - 5) / 7) * 100) / 100)}" customWidth="1"/>`).join("")}</cols>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${cols}<sheetData>${body}</sheetData></worksheet>`;
  });
  const names = uniqueSheetNames(wb.sheets.map((s) => s.name));
  const parts: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetXml.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetXml.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheetXml.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  };
  sheetXml.forEach((x, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = x; });
  return zipParts(parts);
}
function uniqueSheetNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((n, i) => {
    const base = (n || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || `Sheet${i + 1}`; let out = base; let k = 2;
    while (seen.has(out.toLowerCase())) { out = `${base.slice(0, 28)} ${k++}`; }
    seen.add(out.toLowerCase()); return out;
  });
}

/** CSV in: one sheet; numbers and TRUE/FALSE read as such, "=" starts a formula. */
export function readCsv(src: string, name = "Sheet1"): LoadedBook {
  const res = Papa.parse<string[]>(src.replace(/^\uFEFF/, ""), { skipEmptyLines: false });
  const rows = res.data as string[][];
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  const sheet: Sheet = { name, cells: new Map(), rowCount: 50, colCount: 12 };
  let overCap: string | null = null; let maxC = 0; let filled = 0;
  for (let r = 0; r < rows.length; r++) {
    if (r >= SHEET_CAPS.rows) { overCap = `This file has more than ${SHEET_CAPS.rows.toLocaleString("en")} rows, so it opens view only with the first ${SHEET_CAPS.rows.toLocaleString("en")} shown.`; break; }
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      if (c >= SHEET_CAPS.cols) { overCap ??= `This file has more than ${SHEET_CAPS.cols} columns, so it opens view only with the first ${SHEET_CAPS.cols} shown.`; break; }
      if (row[c] === "") continue;
      if (++filled > SHEET_CAPS.cells) { overCap ??= `This file has more than ${SHEET_CAPS.cells.toLocaleString("en")} filled cells, so it opens view only with the first part shown.`; break; }
      const cell = parseInput(row[c]);
      if (cell.v === undefined && cell.f == null) continue;
      sheet.cells.set(addr(r, c), cell); maxC = Math.max(maxC, c);
    }
  }
  sheet.rowCount = Math.min(SHEET_CAPS.rows, Math.max(rows.length + 20, 50));
  sheet.colCount = Math.min(SHEET_CAPS.cols, Math.max(maxC + 3, 12));
  return { wb: { sheets: [sheet] }, notes: ["CSV keeps values only: formulas are saved as their results and only the first sheet is saved."], overCap };
}

/** CSV out: the first sheet's worked out values, trailing empty rows and columns dropped. */
export function writeCsv(wb: Workbook, si = 0): string {
  const sh = wb.sheets[si]; const calc = new Calc(wb);
  let maxR = -1, maxC = -1;
  for (const a of sh.cells.keys()) { const p = parseAddr(a); if (p) { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c); } }
  const rows: string[][] = [];
  for (let r = 0; r <= maxR; r++) {
    const row: string[] = [];
    for (let c = 0; c <= maxC; c++) {
      const cell = sh.cells.get(addr(r, c));
      const v = cell ? calc.value(si, r, c) : null;
      row.push(v instanceof FErr ? v.code : v == null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? String(Number(v.toPrecision(15))) : v);
    }
    rows.push(row);
  }
  return Papa.unparse(rows, { newline: "\r\n" }) + (rows.length ? "\r\n" : "");
}
export { colName };
