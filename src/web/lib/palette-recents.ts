/**
 * R36: what the command menu shows on an empty query. The last things opened from the menu (records and pages)
 * and the last commands run, kept on this device only (localStorage), newest first, no duplicates. No server
 * write: recents never cost a database write.
 */
export type RecentKind = "item" | "command";
export interface Recent { kind: RecentKind; id: string; label: string; url?: string; hint?: string; at: number }

const KEY = "multies-palette-recents";
/** Up to 5 of each kind: enough to be useful, short enough that the empty menu still fits one screen. */
export const RECENT_LIMIT = 5;

function read(): Recent[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((r): r is Recent => !!r && typeof r === "object" && typeof (r as Recent).id === "string" && typeof (r as Recent).label === "string" && ((r as Recent).kind === "item" || (r as Recent).kind === "command")) : [];
  } catch { return []; }
}

function write(list: Recent[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full or blocked: recents are a nicety */ }
}

/** Puts one entry on top of its kind, dropping an older copy and anything past the limit. */
export function pushRecent(list: Recent[], entry: Omit<Recent, "at">, now = Date.now()): Recent[] {
  const next = [{ ...entry, at: now }, ...list.filter((r) => !(r.kind === entry.kind && r.id === entry.id))];
  const items = next.filter((r) => r.kind === "item").slice(0, RECENT_LIMIT);
  const commands = next.filter((r) => r.kind === "command").slice(0, RECENT_LIMIT);
  return [...items, ...commands].sort((a, b) => b.at - a.at);
}

export function recordRecent(entry: Omit<Recent, "at">) { write(pushRecent(read(), entry)); }
export function readRecents(kind: RecentKind): Recent[] { return read().filter((r) => r.kind === kind); }
export function clearRecents() { write([]); }

/** A short label for a content URL when the result had no title to hand (e.g. "/app/docs/abc" -> "Doc"). */
export function hintForUrl(url: string): string {
  const seg = url.replace(/^\/app\//, "").split(/[/?#]/)[0];
  const names: Record<string, string> = { mail: "Mail", tasks: "Task", docs: "Doc", chat: "Chat", contacts: "Contact", deals: "Deal", meetings: "Meeting", forms: "Form", domains: "Domain" };
  return names[seg] ?? "Page";
}
