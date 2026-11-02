/**
 * TD1 Ask v2 (flag ASK_TD1): meaning search, coverage ("what the answer could not see") and "Ask about this".
 *
 * Meaning search is free: the question's words are widened with simple stems and a small list of business words that
 * mean the same thing, on top of the R98 keyword search (which stays the base). Only when AI is on for the workspace AND
 * its own key offers embeddings (OpenAI) is the already permission filtered pool re ranked by meaning, on that key.
 * Nothing is indexed or stored; any failure keeps keyword order. The platform's built in AI is never used for this.
 *
 * Privacy: every candidate comes from R98's permission scoped group queries. No item text, question or answer is ever
 * logged or sent to error reports from here (only counts and status codes).
 */
import { eq } from "drizzle-orm";
import type { Deps } from "../context";
import { aiKeys } from "../db/schema";
import { decryptSecret } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import type { SuiteActor } from "./suite/common";
import { retrieveR98, retrieveRefsR98, type RetrievedR98 } from "./search-r98";
import type { SearchViewer } from "./search";
import { aiAllowed } from "./ai-trust-td1";
import { assertPerson, keywordsOf } from "./ask-r110";
import { meetingNotes } from "./suite/meeting-notes";
import type { AboutKind, AskCoverage } from "@/shared/ask-td1";

export const POOL_MAX = 24;
export const SOURCES_MAX = 6;
/** Characters of each source the AI reads (the same as R110). */
export const SOURCE_READ_CHARS = 1_000;
const RANK_CHARS = 400;
const EMBED_TIMEOUT_MS = 4_000;

/** Words that mean the same thing at work. Each group widens to its other members. */
export const SAME_MEANING: string[][] = [
  ["invoice", "bill", "invoices", "bills"], ["client", "customer", "clients", "customers"], ["meeting", "call", "meetings", "calls"],
  ["quote", "proposal", "estimate", "quotes", "proposals"], ["task", "todo", "tasks", "todos"], ["deal", "opportunity", "deals", "opportunities"],
  ["payment", "paid", "pay", "payments"], ["deadline", "due"], ["contract", "agreement", "contracts", "agreements"],
  ["staff", "employee", "employees"], ["price", "cost", "fee", "pricing", "costs", "fees"], ["refund", "refunds", "chargeback"],
  ["booking", "appointment", "reservation", "bookings", "appointments"], ["issue", "problem", "bug", "issues", "problems", "bugs"],
  ["buy", "purchase", "order", "purchases", "orders"], ["email", "mail", "emails"], ["phone", "mobile"], ["address", "location"],
  ["holiday", "leave", "vacation"], ["supplier", "vendor", "suppliers", "vendors"], ["sales", "revenue"], ["hire", "recruit", "hiring"],
];

/** A plain stem: "invoicing" -> "invoic", "meetings" -> "meeting". Short words stay as they are. */
export function stemOf(w: string): string {
  for (const end of ["ing", "ed", "es", "s", "ly"]) if (w.length - end.length >= 4 && w.endsWith(end)) return w.slice(0, -end.length);
  return w;
}

/** Extra words to try beside the question's own: same meaning words and stems, never the original words, at most 4. */
export function widenWords(question: string): string[] {
  const words = keywordsOf(question);
  const extra: string[] = [];
  const push = (x: string) => { if (x.length > 2 && !words.includes(x) && !extra.includes(x)) extra.push(x); };
  for (const w of words) {
    for (const g of SAME_MEANING) if (g.includes(w)) for (const x of g) if (stemOf(x) !== stemOf(w)) push(x);
    const st = stemOf(w);
    if (st !== w) push(st);
  }
  return extra.slice(0, 4);
}

export interface Retrieval { sources: RetrievedR98[]; coverage: AskCoverage }

const key = (x: { type: string; id: string }) => `${x.type}:${x.id}`;

/** The workspace's own OpenAI key when AI is on and it has one; null otherwise (never the platform's AI). */
async function embeddingKey(deps: Deps, orgId: string): Promise<string | null> {
  if (!(await aiAllowed(deps, orgId))) return null;
  const row = await deps.db.select({ provider: aiKeys.provider, keyEnc: aiKeys.keyEnc }).from(aiKeys).where(eq(aiKeys.orgId, orgId)).get();
  if (!row || row.provider !== "openai") return null;
  return decryptSecret(deps.config.appSecret, row.keyEnc);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Re ranks the pool by meaning on the workspace's own key. Returns null (keep keyword order) on any failure. */
export async function rankByMeaning(deps: Deps, apiKey: string, question: string, pool: RetrievedR98[]): Promise<RetrievedR98[] | null> {
  if (pool.length < 2) return null;
  try {
    const res = await (deps.fetch ?? fetch)("https://api.openai.com/v1/embeddings", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: [question.slice(0, 1_000), ...pool.map((s) => s.body.slice(0, RANK_CHARS) || s.title)] }),
    });
    if (!res.ok) { deps.log?.warn?.("ask_td1.rank_failed", { status: res.status }); return null; }
    const data = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    const vecs = new Map((data.data ?? []).map((d) => [d.index, d.embedding]));
    const q = vecs.get(0);
    if (!q || vecs.size !== pool.length + 1) return null;
    return pool.map((s, i) => ({ s, sim: cosine(q, vecs.get(i + 1)!) })).sort((a, b) => b.sim - a.sim).map((x) => x.s);
  } catch (err) {
    deps.log?.warn?.("ask_td1.rank_failed", { status: err instanceof Error ? err.name : "error" });
    return null;
  }
}

/** The pool of items the viewer can open that match the question, widened by meaning, and ranked. */
export async function meaningPool(deps: Deps, v: SearchViewer, orgId: string, question: string): Promise<{ pool: RetrievedR98[]; meaning: AskCoverage["meaning"] }> {
  const words = keywordsOf(question);
  if (!words.length) return { pool: [], meaning: "words" };
  const seen = new Map<string, RetrievedR98>();
  const add = (xs: RetrievedR98[], weight = 1) => { for (const x of xs) { const s = { ...x, score: x.score * weight }; const had = seen.get(key(x)); if (!had || had.score < s.score) seen.set(key(x), s); } };
  add(await retrieveR98(deps, v, words.join(" "), { limit: 12 }));
  if (words.length > 1) {
    const strong = [...words].sort((a, b) => b.length - a.length).slice(0, 2);
    for (const xs of await Promise.all(strong.map((w) => retrieveR98(deps, v, w, { limit: 6 })))) add(xs, 0.9);
  }
  let meaning: AskCoverage["meaning"] = "words";
  const extra = widenWords(question);
  if (extra.length) {
    const before = seen.size;
    for (const xs of await Promise.all(extra.map((w) => retrieveR98(deps, v, w, { limit: 6 })))) add(xs, 0.8);
    if (seen.size > before) meaning = "widened";
  }
  let pool = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, POOL_MAX);
  const apiKey = await embeddingKey(deps, orgId).catch(() => null);
  if (apiKey) {
    const ranked = await rankByMeaning(deps, apiKey, question, pool);
    if (ranked) { pool = ranked; meaning = "ranked"; }
  }
  return { pool, meaning };
}

/** Ask retrieval for TD1: the about item first (when given), then the best matches, with what was and was not read. */
export async function retrieveTd1(deps: Deps, v: SearchViewer, orgId: string, question: string, about: RetrievedR98 | null): Promise<Retrieval> {
  const { pool, meaning } = await meaningPool(deps, v, orgId, question);
  const rest = about ? pool.filter((x) => key(x) !== key(about)) : pool;
  const sources = [...(about ? [about] : []), ...rest].slice(0, SOURCES_MAX);
  return {
    sources,
    coverage: { matched: rest.length + (about ? 1 : 0), read: sources.length, trimmed: sources.filter((s) => s.body.length > SOURCE_READ_CHARS).length, meaning, about: !!about },
  };
}

/** Parses "tasks:abc" into a kind and id. */
export function parseAbout(raw: unknown): { kind: AboutKind; id: string } | null {
  const m = /^(tasks|docs|tables|deals|meetings|contacts):([A-Za-z0-9_-]{1,80})$/.exec(String(raw ?? ""));
  return m ? { kind: m[1] as AboutKind, id: m[2] } : null;
}

const NOT_FOUND = () => new HttpError(404, "not_found", "That item was not found, or you cannot open it.");

/** The item "Ask about this" scopes to, only when the asker can open it now. 404 otherwise (no hint it exists). */
export async function resolveAbout(deps: Deps, actor: SuiteActor, raw: unknown): Promise<RetrievedR98> {
  const a = parseAbout(raw);
  if (!a) throw new HttpError(422, "validation_failed", "That item cannot be asked about.");
  const v: SearchViewer = { kind: "actor", actor };
  if (a.kind === "meetings") {
    let docId: string | null = null, extra = "";
    try {
      const n = await meetingNotes(deps, actor, a.id);
      docId = n.doc?.id ?? null;
      extra = [n.meeting.title, n.summary ?? ""].filter(Boolean).join(". ");
    } catch { throw NOT_FOUND(); }
    if (!docId) throw new HttpError(422, "no_notes", "This meeting has no notes yet. Add notes, then ask.");
    const [hit] = await retrieveRefsR98(deps, v, [{ type: "docs", id: docId }]);
    if (!hit) throw NOT_FOUND();
    return { ...hit, body: `${extra} ${hit.body}`.trim().slice(0, 1_500) };
  }
  const type = a.kind === "tables" ? "docs" : a.kind;
  const [hit] = await retrieveRefsR98(deps, v, [{ type, id: a.id }]);
  if (!hit) throw NOT_FOUND();
  if (a.kind === "tables") return { ...hit, body: (await tableText(deps, actor, a.id).catch(() => "")) || hit.body };
  return hit;
}

/** A table's fields and first rows as plain text (the asker's own view of it). */
async function tableText(deps: Deps, actor: SuiteActor, docId: string): Promise<string> {
  const t = await import("./tables-r125");
  const viewer = { kind: "member" as const, actor };
  const detail = await t.tableDetail(deps, viewer, docId);
  const rows = (await t.listRows(deps, viewer, docId, { limit: 30 })) as unknown as { rows?: { cells?: Record<string, unknown> }[] };
  const fields = detail.fields ?? [];
  const cell = (x: unknown) => (Array.isArray(x) ? x.join(", ") : x == null ? "" : String(x));
  const lines = (rows.rows ?? []).map((r) => fields.map((f) => `${f.name}: ${cell(r.cells?.[f.id])}`.slice(0, 80)).join("; "));
  return `${detail.table.title ?? ""}\n${fields.map((f) => f.name).join(", ")}\n${lines.join("\n")}`.slice(0, 1_500);
}

/** GET /api/ask/search: meaning search across the items the viewer can open (no AI answer, no Ask cap used). */
export async function meaningSearch(deps: Deps, actor: SuiteActor, q: unknown) {
  assertPerson(actor);
  const query = String(q ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (query.length < 3) return { query, mode: "words" as const, items: [] };
  const v: SearchViewer = { kind: "actor", actor };
  const { pool, meaning } = await meaningPool(deps, v, actor.orgId, query);
  return { query, mode: meaning, items: pool.slice(0, 10).map(({ type, id, title, subtitle, url }) => ({ type, id, title, subtitle: subtitle ?? "", url })) };
}
