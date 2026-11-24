import type { Address } from "@/shared/mail";

/**
 * Wave 3 (M4): a message's stored to, cc or bcc list as the API documents it, [{ address, name? }]. Rows hold a JSON
 * list of objects, but older rows and some imports hold plain strings ("a@b.io"), a single object, or text that isn't
 * JSON. A string becomes { address }, an object keeps its address and a text name, anything without an address is
 * dropped, and text that doesn't parse is an empty list (a 500 on the whole read before).
 */
export function parseAddressList(raw: string | null | undefined): Address[] {
  if (!raw) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return []; }
  const items = Array.isArray(v) ? v : v && (typeof v === "object" || typeof v === "string") ? [v] : [];
  const out: Address[] = [];
  for (const x of items) {
    if (typeof x === "string") { if (x.trim()) out.push({ address: x.trim() }); continue; }
    if (!x || typeof x !== "object") continue;
    const { address, name } = x as { address?: unknown; name?: unknown };
    if (typeof address !== "string" || !address.trim()) continue;
    out.push(typeof name === "string" && name ? { address: address.trim(), name } : { address: address.trim() });
  }
  return out;
}
