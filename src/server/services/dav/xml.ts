/**
 * R99: the small XML reader and writer the CalDAV and CardDAV server needs. Request bodies from calendar and
 * contacts apps are short (a PROPFIND or REPORT names a few properties and hrefs), so a tolerant reader that
 * resolves namespaces is enough; no XML library is pulled into the Worker. Entities are decoded, comments,
 * processing instructions and DOCTYPE are skipped (no entity expansion, so no billion laughs).
 */

export const NS = {
  dav: "DAV:",
  cal: "urn:ietf:params:xml:ns:caldav",
  card: "urn:ietf:params:xml:ns:carddav",
  cs: "http://calendarserver.org/ns/",
  apple: "http://apple.com/ns/ical/",
} as const;

export interface XmlNode { ns: string; name: string; children: XmlNode[]; text: string }

/** Largest request body the reader accepts (a multiget of a few hundred hrefs fits easily). */
export const MAX_XML_BYTES = 512 * 1024;

const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, e: string) => {
  if (e === "lt") return "<"; if (e === "gt") return ">"; if (e === "amp") return "&"; if (e === "quot") return '"'; if (e === "apos") return "'";
  const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
});

/** Parses an XML document into a tree with resolved namespaces. Returns null for an empty or broken body. */
export function parseXml(src: string): XmlNode | null {
  if (!src.trim() || src.length > MAX_XML_BYTES) return null;
  const s = src.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  const root: XmlNode = { ns: "", name: "#root", children: [], text: "" };
  const stack: { node: XmlNode; scope: Map<string, string> }[] = [{ node: root, scope: new Map([["", ""]]) }];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let steps = 0;
  while ((m = re.exec(s))) {
    if (++steps > 50_000) return null;
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.node.text += m[1]; continue; }
    if (m[6] !== undefined) { top.node.text += decode(m[6]); continue; }
    const [, , close, qname, attrs, selfClose] = m;
    if (close) {
      if (stack.length <= 1) return null;
      stack.pop();
      continue;
    }
    const scope = new Map(top.scope);
    for (const a of (attrs ?? "").matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = decode(a[2] ?? a[3] ?? "");
      if (a[1] === "xmlns") scope.set("", value);
      else if (a[1].startsWith("xmlns:")) scope.set(a[1].slice(6), value);
    }
    const colon = qname.indexOf(":");
    const prefix = colon < 0 ? "" : qname.slice(0, colon);
    const node: XmlNode = { ns: scope.get(prefix) ?? "", name: colon < 0 ? qname : qname.slice(colon + 1), children: [], text: "" };
    top.node.children.push(node);
    if (!selfClose) stack.push({ node, scope });
  }
  if (stack.length !== 1) return null;
  return root.children[0] ?? null;
}

export const child = (n: XmlNode | null | undefined, ns: string, name: string) => n?.children.find((c) => c.ns === ns && c.name === name) ?? null;
export const children = (n: XmlNode | null | undefined, ns: string, name: string) => n?.children.filter((c) => c.ns === ns && c.name === name) ?? [];
/** Every descendant with this name, depth first. */
export function descendants(n: XmlNode | null | undefined, ns: string, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of n?.children ?? []) { if (c.ns === ns && c.name === name) out.push(c); descendants(c, ns, name, out); }
  return out;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const PREFIX: Record<string, string> = { [NS.dav]: "d", [NS.cal]: "c", [NS.card]: "card", [NS.cs]: "cs", [NS.apple]: "a" };
const DECL = Object.entries(PREFIX).map(([ns, p]) => `xmlns:${p}="${ns}"`).join(" ");

/** A property name as `{ns}name`, the way requests and responses refer to it. */
export const key = (ns: string, name: string) => `{${ns}}${name}`;

/** One element: `{DAV:}href` with inner XML (already escaped) or nothing. Unknown namespaces get their own declaration. */
export function el(k: string, inner = ""): string {
  const close = k.indexOf("}");
  const ns = k.slice(1, close), name = k.slice(close + 1);
  const p = PREFIX[ns];
  if (p) return inner ? `<${p}:${name}>${inner}</${p}:${name}>` : `<${p}:${name}/>`;
  const decl = ns ? ` xmlns="${esc(ns)}"` : "";
  return inner ? `<${name}${decl}>${inner}</${name}>` : `<${name}${decl}/>`;
}

export interface PropStat { found: [string, string][]; missing: string[] }

/** One <d:response> for an href, with a 200 propstat for the found properties and a 404 one for the rest. */
export function response(href: string, ps: PropStat): string {
  const parts = [`<d:href>${esc(href)}</d:href>`];
  if (ps.found.length) parts.push(`<d:propstat><d:prop>${ps.found.map(([k, v]) => el(k, v)).join("")}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`);
  if (ps.missing.length) parts.push(`<d:propstat><d:prop>${ps.missing.map((k) => el(k)).join("")}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`);
  return `<d:response>${parts.join("")}</d:response>`;
}

/** A response that only states a status (a removed member in a sync report, an unknown href in a multiget). */
export const statusResponse = (href: string, status: string) => `<d:response><d:href>${esc(href)}</d:href><d:status>HTTP/1.1 ${status}</d:status></d:response>`;

export function multistatusDoc(responses: string[], extra = ""): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${DECL}>${responses.join("")}${extra}</d:multistatus>`;
}

/** A DAV:error body (RFC 4918 16) with one precondition element. */
export function errorDoc(k: string, message?: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:error ${DECL}>${el(k)}${message ? `<d:responsedescription>${esc(message)}</d:responsedescription>` : ""}</d:error>`;
}
