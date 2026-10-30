/**
 * Small input checks written without regular expressions, so request input never meets a
 * backtracking pattern (the security scan flags regex on user input).
 */
const between = (c: number, lo: string, hi: string) => c >= lo.charCodeAt(0) && c <= hi.charCodeAt(0);
const isAlnum = (c: number) => between(c, "a", "z") || between(c, "A", "Z") || between(c, "0", "9");

/** "#a1b2c3" */
export function isHexColour(v: string | null | undefined): v is string {
  if (!v || v.length !== 7 || v[0] !== "#") return false;
  for (let i = 1; i < 7; i++) { const c = v.charCodeAt(i); if (!(between(c, "0", "9") || between(c, "a", "f") || between(c, "A", "F"))) return false; }
  return true;
}

/** "2026-10-23", and a real calendar date. */
export function isIsoDate(v: string): boolean {
  if (v.length !== 10 || v[4] !== "-" || v[7] !== "-") return false;
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) if (!between(v.charCodeAt(i), "0", "9")) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** True when the text starts with a URL scheme such as "https:" or "mailto:". */
export function hasScheme(v: string): boolean {
  const colon = v.indexOf(":");
  if (colon < 1 || colon > 32) return false;
  if (!between(v.toLowerCase().charCodeAt(0), "a", "z")) return false;
  for (let i = 1; i < colon; i++) { const c = v.charCodeAt(i); if (!(isAlnum(c) || v[i] === "+" || v[i] === "." || v[i] === "-")) return false; }
  return true;
}

/** Letters, digits, "_" and "-", within a length range. */
export function isSafeToken(v: string, min = 1, max = 64): boolean {
  if (v.length < min || v.length > max) return false;
  for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if (!(isAlnum(c) || v[i] === "_" || v[i] === "-")) return false; }
  return true;
}

/** A plain shape check: one "@", something before it, a dot in the domain, no spaces. */
export function looksLikeEmail(v: string): boolean {
  if (v.length > 254) return false;
  const at = v.indexOf("@");
  if (at < 1 || at !== v.lastIndexOf("@")) return false;
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) <= 32) return false;
  const domain = v.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

/** "type/subtype" made of word characters, ".", "+" and "-". */
export function isMimeType(v: string): boolean {
  if (!v || v.length > 100) return false;
  const slash = v.indexOf("/");
  if (slash < 1 || slash === v.length - 1 || slash !== v.lastIndexOf("/")) return false;
  for (let i = 0; i < v.length; i++) { if (i === slash) continue; const c = v.charCodeAt(i); if (!(isAlnum(c) || "_.+-".includes(v[i]!))) return false; }
  return true;
}
