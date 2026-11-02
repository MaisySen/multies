/**
 * M1: the web's global search on the phone (GET /api/search, server R98 when on). Types, chips and the query rules
 * mirror the web (src/server/services/search.ts and src/web/lib/search-r98.ts), so the phone finds the same things.
 * The server decides what the person can open; the phone only shows what it answers.
 */

export type SearchType = "mail" | "tasks" | "docs" | "chat" | "contacts" | "deals" | "attachments" | "files" | "notes";
export interface SearchItem { type: SearchType; id: string; title: string; subtitle: string; snippet: string; url: string; at: string | null; match?: "exact" | "typo" }
export interface SearchGroup { type: SearchType; label: string; items: SearchItem[] }
export interface SearchResult { query: string; groups: SearchGroup[]; tookMs: number; partial: boolean; corrected?: string }

/** The web's limits: two characters to search, the first 100 searched. */
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
/** Results per group: a few of each for All, more for one type (the server allows up to 20). */
export const LIMIT_ALL = 5;
export const LIMIT_ONE = 20;

/** The chips, in the web's order. Each shows only when the server answered that kind for this person. */
export type TypeChoice = "all" | "mail" | "tasks" | "docs" | "chat" | "contacts" | "files" | "notes";
export const TYPE_CHOICES: { id: TypeChoice; label: string }[] = [
  { id: "all", label: "All" }, { id: "mail", label: "Mail" }, { id: "tasks", label: "Tasks" }, { id: "docs", label: "Docs" },
  { id: "chat", label: "Chat" }, { id: "contacts", label: "Contacts" }, { id: "files", label: "Files" }, { id: "notes", label: "Notes" },
];

/** Server types for a chip, as on the web: Contacts also brings companies and deals, Mail also brings attachment text. */
export function serverTypes(t: TypeChoice): SearchType[] | null {
  if (t === "all") return null;
  if (t === "contacts") return ["contacts", "deals"];
  if (t === "mail") return ["mail", "attachments"];
  return [t];
}

/** The chip a result group belongs to. */
export function choiceOf(t: SearchType): TypeChoice {
  if (t === "deals") return "contacts";
  if (t === "attachments") return "mail";
  return t;
}

/**
 * Cleans a typed query the way the server does before searching: spaces collapsed, trimmed, the first 100 characters.
 * A long paste therefore searches the same words on the phone as on the web, and never sends more than the server reads.
 */
export function cleanQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_CHARS).trim();
}

export const canSearch = (q: string) => q.length >= SEARCH_MIN_CHARS;

/** The request path for /api/search. */
export function searchPath(q: string, choice: TypeChoice): string {
  const types = serverTypes(choice);
  const parts = [`q=${encodeURIComponent(q)}`];
  if (types) parts.push(`types=${types.join(",")}`);
  parts.push(`limit=${choice === "all" ? LIMIT_ALL : LIMIT_ONE}`);
  return `/search?${parts.join("&")}`;
}

/** The chips to show: All, the kinds the server answered for this query, and the one picked. */
export function visibleChoices(found: SearchType[], picked: TypeChoice): { id: TypeChoice; label: string }[] {
  const have = new Set<TypeChoice>(found.map(choiceOf));
  return TYPE_CHOICES.filter((c) => c.id === "all" || c.id === picked || have.has(c.id));
}

/** How many results each chip has in an All answer. */
export function countsByChoice(groups: SearchGroup[]): Partial<Record<TypeChoice, number>> {
  const out: Partial<Record<TypeChoice, number>> = {};
  for (const g of groups) { const c = choiceOf(g.type); out[c] = (out[c] ?? 0) + g.items.length; }
  return out;
}

export const TYPE_ICON: Record<SearchType, "mail" | "check-square" | "file-text" | "message-circle" | "user" | "dollar-sign" | "paperclip" | "hard-drive" | "edit-3"> = {
  mail: "mail", tasks: "check-square", docs: "file-text", chat: "message-circle", contacts: "user", deals: "dollar-sign", attachments: "paperclip", files: "hard-drive", notes: "edit-3",
};

/** Where the phone opens a result: its own screen when it has one, else the web page in the in-app browser. */
export type PhoneTarget =
  | { kind: "screen"; pathname: string; params: Record<string, string> }
  | { kind: "web"; path: string };

/**
 * Reads the result's web link (the server's `url`) and finds the phone screen for it. Mail opens the thread, tasks the
 * task, docs the doc reader, chat the channel, contacts the contact; anything else opens on the web.
 */
export function phoneTarget(item: Pick<SearchItem, "type" | "id" | "url">): PhoneTarget {
  const url = item.url || "";
  const [path, qs = ""] = url.split("?");
  const params = new Map(qs.split("&").filter(Boolean).map((p) => { const i = p.indexOf("="); return [decodeURIComponent(i < 0 ? p : p.slice(0, i)), decodeURIComponent(i < 0 ? "" : p.slice(i + 1))] as [string, string]; }));
  const seg = path.split("/").filter(Boolean); // ["app", "docs", id]
  const web: PhoneTarget = { kind: "web", path: url || "/app" };
  if (seg[0] !== "app") return web;
  const area = seg[1];
  const id = seg[2] ? decodeURIComponent(seg[2]) : "";
  if (area === "mail" && params.get("m")) return { kind: "screen", pathname: "/thread/[id]", params: { id: params.get("m")! } };
  if (area === "tasks" && params.get("task")) return { kind: "screen", pathname: "/task/[id]", params: { id: params.get("task")! } };
  if (area === "docs" && id) return { kind: "screen", pathname: "/doc/[id]", params: { id } };
  if (area === "chat" && id) return { kind: "screen", pathname: "/chat/[id]", params: { id } };
  // TODO(M1): /contact/[id] is built by the "work" part; the merge wires it.
  if (area === "contacts" && id) return { kind: "screen", pathname: "/contact/[id]", params: { id } };
  return web;
}

/** One line for a result's screen reader label. */
export function itemLabel(it: SearchItem, label: string): string {
  return [label, it.title, it.subtitle].filter(Boolean).join(", ");
}

/** A "Did you mean" line when the server fixed a typo. */
export function correctedLine(r: Pick<SearchResult, "query" | "corrected"> | undefined): string | null {
  return r?.corrected && r.corrected !== r.query ? `Showing results for "${r.corrected}"` : null;
}
