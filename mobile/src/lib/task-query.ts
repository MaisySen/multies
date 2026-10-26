import { ApiError } from "@/api/errors";
import type { KV } from "./kv";

/** Tappable starters for the query box. Each is one term of the task query language. */
export const QUERY_SUGGESTIONS: { term: string; label: string }[] = [
  { term: "assignee:me", label: "Mine" },
  { term: "due:<7d", label: "Due this week" },
  { term: "label:bug", label: "Bugs" },
  { term: "status:doing", label: "Doing" },
];

const MAX = 500;

/** Splits a query into terms, keeping quoted words together. */
export function queryTerms(q: string): string[] {
  return q.match(/-?[^\s"]*"[^"]*"?|\S+/g) ?? [];
}

export function hasTerm(q: string, term: string): boolean {
  return queryTerms(q).some((t) => t.toLowerCase() === term.toLowerCase());
}

/** Adds the term, or takes it out when it is already there. */
export function toggleTerm(q: string, term: string): string {
  const terms = queryTerms(q);
  const at = terms.findIndex((t) => t.toLowerCase() === term.toLowerCase());
  if (at >= 0) terms.splice(at, 1);
  else terms.push(term);
  return terms.join(" ");
}

/** The query as sent: one line, single spaces, at most 500 characters. */
export function normaliseQuery(q: string): string {
  return q.replace(/\s+/g, " ").trim().slice(0, MAX);
}

/**
 * Plain words for a query the server refused. A bad_query 400 carries the 1 based character where
 * it went wrong; the message says which part of the query that is.
 */
export function queryErrorText(err: unknown, q: string): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status !== 400) return null;
  const base = (err.message || "That search didn't work.").replace(/\s+$/, "");
  const pos = Number(err.details?.position);
  if (!Number.isFinite(pos) || pos < 1) return base;
  const near = q.slice(pos - 1).split(/\s+/)[0];
  return near ? `${base} Check "${near}" (character ${pos}).` : `${base} (character ${pos}).`;
}

export const LAST_QUERY_KEY = "pref:tasks:last-query";

export async function loadLastQuery(store: KV): Promise<string> {
  try { return (await store.get(LAST_QUERY_KEY)) ?? ""; } catch { return ""; }
}

export async function saveLastQuery(store: KV, q: string): Promise<void> {
  const v = normaliseQuery(q);
  try { if (v) await store.set(LAST_QUERY_KEY, v); else await store.remove(LAST_QUERY_KEY); } catch { /* best effort */ }
}
