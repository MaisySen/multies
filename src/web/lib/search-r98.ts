/**
 * R98 search (SEARCH_R98): filters, typed filter words, the instant title index (MiniSearch, MIT) and the server search
 * with typo tolerance. The index lives in memory for this tab only (never in storage), keyed by the signed in person and
 * workspace, and is refreshed from /api/search/index when the menu opens and it is older than five minutes. A refresh
 * changes only what changed (add, replace, remove), so items someone lost access to drop out on the next refresh.
 */
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import MiniSearch from "minisearch";
import { api } from "@/web/lib/api";
import { SEARCH_MIN_CHARS, useDebounced, type SearchGroup, type SearchItem } from "@/web/lib/search";

export type R98Type = "mail" | "tasks" | "docs" | "chat" | "contacts" | "deals" | "attachments" | "files" | "notes";
export type TypeChoice = "all" | "mail" | "tasks" | "docs" | "chat" | "contacts" | "files" | "notes";
export type DateChoice = "any" | "today" | "7d" | "30d" | "year" | "custom";

export interface Filters {
  type: TypeChoice;
  person: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  date: DateChoice;
  /** For "custom" (typed after: and before:), YYYY-MM-DD. */
  from?: string | null;
  to?: string | null;
}
export const NO_FILTERS: Filters = { type: "all", person: null, project: null, date: "any" };
export const hasFilters = (f: Filters) => f.type !== "all" || !!f.person || !!f.project || f.date !== "any";

/** The chips, in order, with the Alt+number that picks each. Notes only where the CRM timeline is on. */
export const TYPE_CHOICES: { id: TypeChoice; label: string }[] = [
  { id: "all", label: "All" }, { id: "mail", label: "Mail" }, { id: "tasks", label: "Tasks" }, { id: "docs", label: "Docs" },
  { id: "chat", label: "Chat" }, { id: "contacts", label: "Contacts" }, { id: "files", label: "Files" }, { id: "notes", label: "Notes" },
];
export const DATE_LABEL: Record<DateChoice, string> = { any: "Any time", today: "Today", "7d": "Past 7 days", "30d": "Past 30 days", year: "Past year", custom: "Custom dates" };

/** Server types for a chip ("contacts" also brings deals, "mail" also brings attachment text). */
export function serverTypes(t: TypeChoice): R98Type[] | null {
  if (t === "all") return null;
  if (t === "contacts") return ["contacts", "deals"];
  if (t === "mail") return ["mail", "attachments"];
  return [t];
}

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** The from and to days a date choice means, in the person's own calendar. */
export function dateRange(f: Pick<Filters, "date" | "from" | "to">, now = new Date()): { from: string | null; to: string | null } {
  const back = (days: number) => { const d = new Date(now); d.setDate(d.getDate() - days); return day(d); };
  switch (f.date) {
    case "today": return { from: day(now), to: day(now) };
    case "7d": return { from: back(6), to: day(now) };
    case "30d": return { from: back(29), to: day(now) };
    case "year": return { from: back(364), to: day(now) };
    case "custom": return { from: f.from ?? null, to: f.to ?? null };
    default: return { from: null, to: null };
  }
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_WORDS: Record<string, TypeChoice> = { mail: "mail", email: "mail", emails: "mail", task: "tasks", tasks: "tasks", doc: "docs", docs: "docs", chat: "chat", message: "chat", messages: "chat", contact: "contacts", contacts: "contacts", file: "files", files: "files", note: "notes", notes: "notes" };

/**
 * Filter words typed in the box: type:docs, from:sam (or by:), in:ops (a project name or key), after:2026-10-01,
 * before:2026-10-31. Each one found becomes a chip and leaves the words. A word that matches nobody stays a problem
 * to show ("No person called x").
 */
export function parseFilterWords(text: string, people: { id: string; name: string; email?: string | null }[], projects: { id: string; name: string; key: string }[]): { text: string; filters: Partial<Filters>; problems: string[] } {
  const filters: Partial<Filters> = {};
  const problems: string[] = [];
  const rest = text.replace(/(^|\s)(type|from|by|in|project|after|before):("[^"]*"|\S*)/gi, (whole, lead: string, key: string, raw: string) => {
    const value = raw.replace(/^"|"$/g, "").trim();
    if (!value) return whole;
    const k = key.toLowerCase();
    if (k === "type") {
      const t = TYPE_WORDS[value.toLowerCase()];
      if (t) filters.type = t; else problems.push(`No type called ${value}`);
    } else if (k === "from" || k === "by") {
      const v = norm(value);
      const p = people.find((x) => norm(x.name) === v || norm(x.email ?? "") === v) ?? people.find((x) => norm(x.name).split(/\s+/).some((w) => w.startsWith(v)) || norm(x.email ?? "").startsWith(v));
      if (p) filters.person = { id: p.id, name: p.name }; else problems.push(`No person called ${value}`);
    } else if (k === "in" || k === "project") {
      const v = norm(value);
      const p = projects.find((x) => norm(x.key) === v || norm(x.name) === v) ?? projects.find((x) => norm(x.name).startsWith(v));
      if (p) filters.project = { id: p.id, name: p.name }; else problems.push(`No project called ${value}`);
    } else if (DAY.test(value) && !Number.isNaN(Date.parse(value))) {
      filters.date = "custom";
      if (k === "after") filters.from = value; else filters.to = value;
    } else problems.push(`Use a date like 2026-10-31 after ${k}:`);
    return lead;
  });
  return { text: rest.replace(/\s+/g, " ").trim(), filters, problems };
}

/** The query string for /api/search with these filters. */
export function searchUrl(q: string, f: Filters, strict = false): string {
  const p = new URLSearchParams({ q });
  const types = serverTypes(f.type);
  if (types) p.set("types", types.join(","));
  if (f.person) p.set("person", f.person.id);
  if (f.project) p.set("project", f.project.id);
  const r = dateRange(f);
  if (r.from) p.set("from", r.from);
  if (r.to) p.set("to", r.to);
  if (strict) p.set("strict", "1");
  return `/search?${p.toString()}`;
}

export interface R98Result { query: string; groups: (SearchGroup & { type: R98Type; items: (SearchItem & { type: R98Type; match?: "exact" | "typo" })[] })[]; tookMs: number; partial: boolean; corrected?: string }

/** Server search with filters: debounced, two characters or a filter, cached for a minute. */
export function useSearchR98(raw: string, f: Filters, enabled: boolean, strict: boolean) {
  const q = useDebounced(raw.trim(), 180);
  const on = enabled && q.length >= SEARCH_MIN_CHARS;
  const url = searchUrl(q, f, strict);
  const res = useQuery({ queryKey: ["search-r98", url], enabled: on, staleTime: 60_000, placeholderData: keepPreviousData, retry: false, queryFn: () => api.get<R98Result>(url) });
  const typing = raw.trim() !== q && raw.trim().length >= SEARCH_MIN_CHARS;
  return { query: q, active: on, loading: on && (res.isFetching || typing), data: on ? res.data : undefined, error: on ? res.error : null, retry: () => void res.refetch() };
}

// ---------------------------------------------------------------- the instant index

export interface IndexEntry { type: R98Type | "projects" | "channels"; id: string; title: string; subtitle: string; url: string; at: string | null; projectId?: string | null; personId?: string | null; keys?: string }
const FRESH_MS = 5 * 60_000;

interface Store { owner: string; mini: MiniSearch<IndexEntry>; byKey: Map<string, IndexEntry>; loadedAt: number; buildMs: number; loading: Promise<void> | null }
let store: Store | null = null;
const listeners = new Set<() => void>();
const keyOf = (e: Pick<IndexEntry, "type" | "id">) => `${e.type}:${e.id}`;

function newMini() {
  return new MiniSearch<IndexEntry>({
    idField: "key", fields: ["title", "keys", "subtitle"], storeFields: [],
    extractField: (doc, field) => (field === "key" ? keyOf(doc) : String((doc as unknown as Record<string, unknown>)[field] ?? "")),
    processTerm: (t) => norm(t),
    searchOptions: { boost: { title: 3, keys: 2 }, prefix: true, fuzzy: (term) => (term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0), combineWith: "AND" },
  });
}

/** Applies a fresh list to the index: adds new items, replaces changed ones, removes the ones no longer there. */
export function applyIndex(s: Pick<Store, "mini" | "byKey">, items: IndexEntry[]): { added: number; changed: number; removed: number } {
  const next = new Map(items.map((e) => [keyOf(e), e]));
  let added = 0, changed = 0, removed = 0;
  for (const [k, old] of s.byKey) if (!next.has(k)) { s.mini.discard(k); s.byKey.delete(k); removed++; void old; }
  for (const [k, e] of next) {
    const old = s.byKey.get(k);
    if (!old) { s.mini.add(e); added++; }
    else if (old.title !== e.title || old.subtitle !== e.subtitle || old.keys !== e.keys || old.url !== e.url) { s.mini.replace(e); changed++; }
    s.byKey.set(k, e);
  }
  return { added, changed, removed };
}

/** Throws the index away (sign out, another workspace). */
export function dropIndex() { store = null; listeners.forEach((l) => l()); }

async function refresh(owner: string) {
  if (!store || store.owner !== owner) store = { owner, mini: newMini(), byKey: new Map(), loadedAt: 0, buildMs: 0, loading: null };
  const s = store;
  if (s.loading || Date.now() - s.loadedAt < FRESH_MS) return s.loading ?? undefined;
  s.loading = (async () => {
    try {
      const res = await api.get<{ items: IndexEntry[] }>("/search/index");
      if (store !== s) return;
      const t0 = performance.now();
      applyIndex(s, res.items);
      s.buildMs = Math.round(performance.now() - t0);
      s.loadedAt = Date.now();
    } catch { /* the server search still answers; try again next time the menu opens */ } finally { s.loading = null; listeners.forEach((l) => l()); }
  })();
  return s.loading;
}

/** Instant hits for the words in the box, filtered like the server search. Up to `limit`. */
export function instantHits(words: string, f: Filters, limit = 5, now = new Date()): IndexEntry[] {
  const s = store;
  if (!s || words.trim().length < SEARCH_MIN_CHARS) return [];
  const want = serverTypes(f.type);
  const r = dateRange(f, now);
  // Semgrep (QUAL1): MiniSearch's own search (tokens and a trie), not String.prototype.search, so no RegExp is built.
  const hits = s.mini.search(words.trim()); // nosemgrep: ajinabraham.njsscan.dos.regex_injection.regex_injection_dos
  const out: IndexEntry[] = [];
  for (const h of hits) {
    const e = s.byKey.get(String(h.id));
    if (!e) continue;
    if (want && !(want as string[]).includes(e.type)) continue;
    if (f.project && e.projectId !== f.project.id) continue;
    if (f.person && e.personId !== f.person.id) continue;
    if ((r.from || r.to) && (!e.at || (r.from && e.at.slice(0, 10) < r.from) || (r.to && e.at.slice(0, 10) > r.to))) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** Loads (or refreshes) the index while the menu is open; re-renders when it changes. `owner` is person and workspace. */
export function useInstantIndex(enabled: boolean, owner: string | null) {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => { if (enabled && owner) void refresh(owner); }, [enabled, owner]);
  return useMemo(() => ({ ready: !!store && store.owner === owner && store.loadedAt > 0, size: store?.byKey.size ?? 0 }), [owner, store?.loadedAt]); // eslint-disable-line react-hooks/exhaustive-deps
}

export const __test = { newMini, setStore: (s: Store | null) => { store = s; } };
