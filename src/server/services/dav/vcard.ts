/**
 * R99: vCard 3.0 for the CardDAV address book (RFC 6350 reading, 2426 writing: every phone and desktop
 * contacts app reads 3.0). One contact is one card; its UID is the contact id, or the UID the phone chose
 * when the phone made it.
 */
import { foldLine, icsUtc } from "../suite/ics-write";

export const vEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
export const vUnescape = (s: string) => s.replace(/\\([\\,;nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));

export interface CardContact { id: string; uid?: string | null; name: string; email: string; phone: string | null; title: string | null; notes: string; company?: string | null; updatedAt: Date }

/** Splits a display name into family and given names for N (the last word is the family name). */
export function nameParts(full: string): { family: string; given: string } {
  const words = full.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { family: "", given: words[0] ?? "" };
  return { family: words[words.length - 1], given: words.slice(0, -1).join(" ") };
}

export function buildVCard(c: CardContact): string {
  const fn = c.name.trim() || c.email;
  const n = nameParts(c.name.trim());
  const lines = [
    "BEGIN:VCARD", "VERSION:3.0", "PRODID:-//Multies//Contacts//EN", `UID:${vEscape(c.uid || c.id)}`,
    `FN:${vEscape(fn)}`, `N:${vEscape(n.family)};${vEscape(n.given)};;;`,
    `EMAIL;TYPE=INTERNET:${vEscape(c.email)}`,
    ...(c.phone ? [`TEL;TYPE=CELL:${vEscape(c.phone)}`] : []),
    ...(c.title ? [`TITLE:${vEscape(c.title)}`] : []),
    ...(c.company ? [`ORG:${vEscape(c.company)}`] : []),
    ...(c.notes ? [`NOTE:${vEscape(c.notes)}`] : []),
    `REV:${icsUtc(c.updatedAt)}`, "END:VCARD",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

export interface ParsedCard { uid: string | null; name: string; email: string | null; phone: string | null; title: string | null; notes: string | null }

/** Reads the fields Multies keeps from a vCard (3.0 or 4.0). Null when the body is not one vCard. */
export function parseVCard(text: string): ParsedCard | null {
  const lines = text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  let inside = 0, cards = 0;
  const props: { name: string; params: string; value: string }[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const i = raw.indexOf(":");
    if (i < 0) continue;
    const head = raw.slice(0, i), value = raw.slice(i + 1);
    const semi = head.indexOf(";");
    const name = (semi < 0 ? head : head.slice(0, semi)).replace(/^[^.]*\./, "").toUpperCase();
    if (name === "BEGIN" && value.trim().toUpperCase() === "VCARD") { inside++; cards++; continue; }
    if (name === "END" && value.trim().toUpperCase() === "VCARD") { inside--; continue; }
    if (inside === 1) props.push({ name, params: semi < 0 ? "" : head.slice(semi + 1).toUpperCase(), value });
  }
  if (cards !== 1 || inside !== 0) return null;
  const first = (n: string) => props.find((p) => p.name === n);
  // A preferred email or phone first, else the first one.
  const pick = (n: string) => props.find((p) => p.name === n && /PREF/.test(p.params)) ?? first(n);
  const fn = first("FN") ? vUnescape(first("FN")!.value).trim() : "";
  let name = fn;
  if (!name && first("N")) {
    const [family = "", given = ""] = first("N")!.value.split(/(?<!\\);/).map(vUnescape);
    name = [given, family].filter(Boolean).join(" ").trim();
  }
  const email = pick("EMAIL") ? vUnescape(pick("EMAIL")!.value).trim().replace(/^mailto:/i, "").toLowerCase() : null;
  const phone = pick("TEL") ? vUnescape(pick("TEL")!.value).trim().replace(/^tel:/i, "") : null;
  return {
    uid: first("UID") ? vUnescape(first("UID")!.value).trim().slice(0, 200) : null,
    name: name.slice(0, 200), email: email || null, phone: phone ? phone.slice(0, 60) : null,
    title: first("TITLE") ? vUnescape(first("TITLE")!.value).trim().slice(0, 200) : null,
    notes: first("NOTE") ? vUnescape(first("NOTE")!.value).slice(0, 10_000) : null,
  };
}
