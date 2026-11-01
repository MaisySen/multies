/**
 * R113: small helpers over fflate (zip) and fast-xml-parser (XML), both MIT and already in the app.
 * Unzipping is bounded: only the parts we read, each and all together under a cap (guards zip bombs).
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

export const OFFICE_CAPS = {
  editBytes: 10 * 1024 * 1024,
  csvBytes: 5 * 1024 * 1024,
  slideBytes: 20 * 1024 * 1024,
  unzippedBytes: 60 * 1024 * 1024,
  imageBytes: 2 * 1024 * 1024,
  imagesBytes: 8 * 1024 * 1024,
} as const;

export class OfficeError extends Error {
  constructor(public readonly code: "not_office" | "too_big" | "broken", message: string) { super(message); }
}

export type Parts = Record<string, Uint8Array>;
/** Reads the zip parts `want` accepts, refusing more than the unzipped cap. */
export function unzipParts(bytes: Uint8Array, want: (name: string) => boolean): Parts {
  let total = 0;
  try {
    return unzipSync(bytes, {
      filter: (f) => {
        if (!want(f.name)) return false;
        total += f.originalSize;
        if (total > OFFICE_CAPS.unzippedBytes) throw new OfficeError("too_big", "This file unpacks to more than we can open here.");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof OfficeError) throw e;
    throw new OfficeError("broken", "This file could not be read. It may be damaged or not a real Office file.");
  }
}
export const zipParts = (parts: Record<string, string | Uint8Array>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])), { level: 6 });
export const text = (u?: Uint8Array) => (u ? strFromU8(u) : "");

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", trimValues: false, parseTagValue: false, parseAttributeValue: false, processEntities: true, htmlEntities: false });
export type XNode = Record<string, unknown>;
export function parseXml(src: string): XNode[] {
  try { return parser.parse(src) as XNode[]; } catch { throw new OfficeError("broken", "This file could not be read. It may be damaged."); }
}
export const tagOf = (n: XNode): string => Object.keys(n).find((k) => k !== ":@") ?? "";
export const kids = (n: XNode): XNode[] => { const v = n[tagOf(n)]; return Array.isArray(v) ? (v as XNode[]) : []; };
export const attr = (n: XNode, name: string): string | undefined => { const a = n[":@"] as Record<string, string> | undefined; return a?.[name]; };
export const isText = (n: XNode) => tagOf(n) === "#text";
export const textOf = (n: XNode): string => (isText(n) ? String(n["#text"] ?? "") : kids(n).map(textOf).join(""));
/** First child (or self) with this tag, depth first. */
export function find(nodes: XNode[], tag: string): XNode | undefined {
  for (const n of nodes) { if (tagOf(n) === tag) return n; const f = find(kids(n), tag); if (f) return f; }
  return undefined;
}
export function findAll(nodes: XNode[], tag: string, out: XNode[] = []): XNode[] {
  for (const n of nodes) { if (tagOf(n) === tag) out.push(n); else findAll(kids(n), tag, out); }
  return out;
}
export const child = (n: XNode, tag: string) => kids(n).find((k) => tagOf(k) === tag);
export const children = (n: XNode, tag: string) => kids(n).filter((k) => tagOf(k) === tag);
// eslint-disable-next-line no-control-regex -- strips characters XML 1.0 cannot carry
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;")).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
/** Rels file: id to target, resolved against the folder the part sits in. */
export function readRels(src: string, base: string): Map<string, { target: string; type: string; external: boolean }> {
  const out = new Map<string, { target: string; type: string; external: boolean }>();
  for (const r of findAll(parseXml(src), "Relationship")) {
    const id = attr(r, "Id"); const t = attr(r, "Target") ?? ""; if (!id) continue;
    const external = attr(r, "TargetMode") === "External";
    out.set(id, { target: external ? t : resolvePath(base, t), type: attr(r, "Type") ?? "", external });
  }
  return out;
}
export function resolvePath(base: string, t: string): string {
  if (t.startsWith("/")) return t.slice(1);
  const parts = base.split("/").filter(Boolean);
  for (const seg of t.split("/")) { if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg); }
  return parts.join("/");
}
export const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
