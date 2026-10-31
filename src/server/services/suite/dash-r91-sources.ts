/**
 * R91 data sources: an uploaded CSV, or a public CSV link (a published sheet), refreshed hourly, daily or by
 * hand. Caps: 1 MB, 5,000 rows, 30 columns. A link must be https, a public host (no private, loopback or
 * link local addresses, no credentials, standard port), and every redirect is checked the same way, at most
 * 3. Rows are kept as capped JSON on the row and the question builder groups and measures them in the worker.
 */
import Papa from "papaparse";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../../context";
import { dashboardSources } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { isPublicHost } from "../../lib/ssrf";
import type { SuiteActor } from "./common";
import { personOf } from "./dashboards";
import type { SourceColumn } from "./dash-r91-question";

export const MAX_BYTES = 1_000_000;
export const MAX_ROWS = 5_000;
export const MAX_COLS = 30;
export const MAX_SOURCES = 20;
export const SOURCES_PER_PASS = 3;
const REFRESH_MS = { hourly: 3_600_000, daily: 86_400_000 } as const;

export const SourceInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("csv"), name: z.string().trim().min(1).max(80), csv: z.string().max(MAX_BYTES + 1000) }).strict(),
  z.object({ kind: z.literal("url"), name: z.string().trim().min(1).max(80), url: z.string().trim().max(2000), refresh: z.enum(["manual", "hourly", "daily"]).default("daily") }).strict(),
]);

const bad = (m: string) => new HttpError(422, "validation_failed", m);

/** Checks a CSV link and turns a sheet share link into its CSV export. Throws 422 in plain words. */
export function checkCsvUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw bad("Enter the full link, starting with https://"); }
  if (u.protocol !== "https:") throw bad("The link must start with https://");
  if (u.username || u.password) throw bad("Links with a user name or password can't be used.");
  if (u.port && u.port !== "443") throw bad("The link must use the standard https port.");
  if (!isPublicHost(u.hostname) || /(^|\.)(local|internal|localhost|lan|home|corp)$/i.test(u.hostname)) throw bad("The link must point to a public address.");
  const sheet = u.hostname === "docs.google.com" && u.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (sheet && !u.pathname.includes("/export") && !u.pathname.includes("/pub")) {
    const gid = u.searchParams.get("gid") ?? (u.hash.match(/gid=(\d+)/)?.[1] ?? "0");
    return `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv&gid=${gid}`;
  }
  return u.toString();
}

type Cell = string | number | null;
/** Parses CSV text with a header row; infers number and date columns. */
export function parseCsv(text: string): { columns: SourceColumn[]; rows: Cell[][] } {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw bad("The file is bigger than 1 MB.");
  const res = Papa.parse<string[]>(text.replace(/^\ufeff/, ""), { skipEmptyLines: true });
  const all = res.data.filter((r) => Array.isArray(r));
  if (all.length < 2) throw bad("The file needs a header row and at least one row of data.");
  const header = all[0]!.map((h, i) => (h ?? "").trim().slice(0, 60) || `Column ${i + 1}`);
  if (header.length > MAX_COLS) throw bad(`Up to ${MAX_COLS} columns.`);
  if (all.length - 1 > MAX_ROWS) throw bad(`Up to ${MAX_ROWS.toLocaleString("en-AU")} rows.`);
  const names = header.map((h, i) => (header.indexOf(h) === i ? h : `${h} ${i + 1}`));
  const body = all.slice(1).map((r) => names.map((_, i) => ((r[i] ?? "").trim().slice(0, 500))));
  const isNum = (s: string) => /^-?[$]?[\d,]*\.?\d+%?$/.test(s);
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/.test(s) && Number.isFinite(Date.parse(s));
  const columns: SourceColumn[] = names.map((name, i) => {
    const vals = body.map((r) => r[i]!).filter((s) => s !== "");
    const kind = vals.length && vals.every(isNum) ? "number" : vals.length && vals.every(isDate) ? "date" : "text";
    return { name, kind };
  });
  const rows = body.map((r) => r.map((s, i) => (s === "" ? null : columns[i]!.kind === "number" ? Number(s.replace(/[$,%]/g, "")) : s)));
  return { columns, rows };
}

/** Reads a CSV link with the checks above, a 10 second limit and the size cap. */
export async function fetchCsv(deps: Deps, raw: string): Promise<string> {
  let url = checkCsvUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    let res: Response;
    try { res = await deps.fetch(url, { redirect: "manual", signal: ctl.signal, headers: { accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" } }); }
    catch { clearTimeout(timer); throw bad("The link didn't answer in time. Check it opens without signing in."); }
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get("location");
      if (!loc || hop === 3) throw bad("The link redirects too many times.");
      url = checkCsvUrl(new URL(loc, url).toString());
      continue;
    }
    if (!res.ok) { clearTimeout(timer); throw bad(res.status === 401 || res.status === 403 ? "The link needs a sign in. Publish the sheet or share it with anyone who has the link." : "The link didn't return a file."); }
    const type = res.headers.get("content-type") ?? "";
    if (/html/i.test(type)) { clearTimeout(timer); throw bad("The link opened a web page, not a CSV file. Use the sheet's CSV or publish link."); }
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) { clearTimeout(timer); throw bad("The file is bigger than 1 MB."); }
    const reader = res.body?.getReader();
    if (!reader) { clearTimeout(timer); return await res.text(); }
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); clearTimeout(timer); throw bad("The file is bigger than 1 MB."); }
      chunks.push(value);
    }
    clearTimeout(timer);
    const all = new Uint8Array(size); let o = 0; for (const c of chunks) { all.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(all);
  }
  throw bad("The link redirects too many times.");
}

type Row = typeof dashboardSources.$inferSelect;
const parseJ = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
const present = (r: Row, me: string, admin: boolean) => ({ id: r.id, name: r.name, kind: r.kind, url: r.url, refresh: r.refresh, columns: parseJ<SourceColumn[]>(r.columns, []), rowCount: r.rowCount,
  refreshedAt: r.refreshedAt?.toISOString() ?? null, lastError: r.lastError, canManage: admin || r.createdBy === me });
const isAdmin = (a: SuiteActor) => a.role === "owner" || a.role === "admin";

export async function listSources(deps: Deps, actor: SuiteActor) {
  const rows = await deps.db.select().from(dashboardSources).where(eq(dashboardSources.orgId, actor.orgId)).orderBy(asc(dashboardSources.createdAt)).limit(MAX_SOURCES);
  return { sources: rows.map((r) => present(r, personOf(actor), isAdmin(actor))) };
}

export async function createSource(deps: Deps, actor: SuiteActor, input: z.infer<typeof SourceInput>) {
  const me = personOf(actor);
  if (!me) throw new HttpError(403, "forbidden", "Only a signed in member can add a data source.");
  const have = await deps.db.select({ id: dashboardSources.id }).from(dashboardSources).where(eq(dashboardSources.orgId, actor.orgId));
  if (have.length >= MAX_SOURCES) throw new HttpError(422, "too_many_sources", `A workspace can have up to ${MAX_SOURCES} data sources.`);
  const url = input.kind === "url" ? checkCsvUrl(input.url) : null;
  const parsed = parseCsv(input.kind === "csv" ? input.csv : await fetchCsv(deps, url!));
  const now = deps.now().getTime();
  const refresh = input.kind === "url" ? input.refresh : "manual";
  const row: typeof dashboardSources.$inferInsert = { id: newId("dsr"), orgId: actor.orgId, name: input.name, kind: input.kind, url, refresh, columns: JSON.stringify(parsed.columns), rows: JSON.stringify(parsed.rows),
    rowCount: parsed.rows.length, refreshedAt: new Date(now), nextRefreshAt: refresh === "manual" ? null : new Date(now + REFRESH_MS[refresh]), lastError: null, createdBy: me, createdAt: new Date(now) };
  await deps.db.insert(dashboardSources).values(row);
  return { source: present(row as Row, me, isAdmin(actor)) };
}

async function sourceRow(deps: Deps, actor: SuiteActor, id: string, manage = true) {
  const r = await deps.db.select().from(dashboardSources).where(and(eq(dashboardSources.orgId, actor.orgId), eq(dashboardSources.id, id))).get();
  if (!r) throw notFound("Data source");
  if (manage && !isAdmin(actor) && r.createdBy !== personOf(actor)) throw new HttpError(403, "forbidden", "Only the person who added it or an admin can change this data source.");
  return r;
}

async function refreshRow(deps: Deps, r: Row) {
  const now = deps.now().getTime();
  const next = r.refresh === "manual" ? null : new Date(now + REFRESH_MS[r.refresh]);
  try {
    const parsed = parseCsv(await fetchCsv(deps, r.url!));
    const patch = { columns: JSON.stringify(parsed.columns), rows: JSON.stringify(parsed.rows), rowCount: parsed.rows.length, refreshedAt: new Date(now), nextRefreshAt: next, lastError: null };
    await deps.db.update(dashboardSources).set(patch).where(eq(dashboardSources.id, r.id));
    return { ...r, ...patch };
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : "The link could not be read.";
    await deps.db.update(dashboardSources).set({ lastError: msg, nextRefreshAt: next }).where(eq(dashboardSources.id, r.id));
    if (!(e instanceof HttpError)) deps.reportError?.(e, { where: "dash_sources" });
    return { ...r, lastError: msg };
  }
}

export async function refreshSource(deps: Deps, actor: SuiteActor, id: string) {
  const r = await sourceRow(deps, actor, id, false);
  if (r.kind !== "url") throw bad("Upload the file again to update an uploaded source.");
  return { source: present(await refreshRow(deps, r), personOf(actor), isAdmin(actor)) };
}

export async function deleteSource(deps: Deps, actor: SuiteActor, id: string) {
  const r = await sourceRow(deps, actor, id);
  await deps.db.delete(dashboardSources).where(eq(dashboardSources.id, r.id));
  return { ok: true };
}

export async function runDueSources(deps: Deps) {
  const due = await deps.db.select().from(dashboardSources).where(and(isNotNull(dashboardSources.nextRefreshAt), lte(dashboardSources.nextRefreshAt, deps.now()))).orderBy(asc(dashboardSources.nextRefreshAt)).limit(SOURCES_PER_PASS);
  for (const r of due) if (r.kind === "url" && r.url) await refreshRow(deps, r);
  return { due: due.length };
}
