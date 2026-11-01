/**
 * R113: a plain outline of a PowerPoint deck (each slide's title and text), used when the engine cannot draw the
 * slides. Read only.
 */
import { OfficeError, attr, child, findAll, isZip, kids, parseXml, readRels, tagOf, text, textOf, unzipParts, type XNode } from "./xml";

export interface SlideOutline { title: string; lines: string[] }

export function readPptxOutline(bytes: Uint8Array): SlideOutline[] {
  if (!isZip(bytes)) throw new OfficeError("not_office", "This is not a PowerPoint deck (.pptx).");
  const parts = unzipParts(bytes, (n) => n === "ppt/presentation.xml" || n === "ppt/_rels/presentation.xml.rels" || /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const pres = parts["ppt/presentation.xml"];
  if (!pres) throw new OfficeError("broken", "This deck could not be read. It may be damaged.");
  const rels = readRels(text(parts["ppt/_rels/presentation.xml.rels"]), "ppt");
  const out: SlideOutline[] = [];
  for (const id of findAll(parseXml(text(pres)), "p:sldId").slice(0, 500)) {
    const rel = rels.get(attr(id, "r:id") ?? ""); const src = rel ? parts[rel.target] : undefined;
    if (!src) continue;
    let title = ""; const lines: string[] = [];
    for (const sp of findAll(parseXml(text(src)), "p:sp")) {
      const ph = findAll(kids(sp), "p:ph")[0]; const type = ph ? attr(ph, "type") ?? "" : "";
      const paras = findAll(kids(sp), "a:p").map((p) => findAll(kids(p), "a:t").map(textOf).join("").trim()).filter(Boolean);
      if (!paras.length) continue;
      if (!title && (type === "title" || type === "ctrTitle")) title = paras.join(" ");
      else lines.push(...paras);
    }
    out.push({ title: title || (lines.shift() ?? ""), lines: lines.slice(0, 60) });
  }
  return out;
}
void child; void tagOf; void (null as unknown as XNode);
