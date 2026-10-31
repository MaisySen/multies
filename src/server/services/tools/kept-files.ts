/**
 * Tools P2 (H5): files kept past one engine job (share links, signing requests) in KV with their own expiry
 * (deps.toolFiles, no R2). Every kept file has a row in tool_files, so live bytes per workspace and in total
 * are capped from D1: the reservation is one INSERT ... SELECT whose WHERE holds both caps, so two uploads at
 * once cannot pass a cap together. KV drops the value at its expiry on its own; the cron pass removes rows
 * past expiry (pruneKeptFiles).
 */
import { sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { HttpError, planLimit } from "../../lib/errors";
import { newId, randomToken, sha256Hex, safeEqual } from "../../lib/crypto";
import { KEPT_FILE_CAP, KEPT_FILE_GLOBAL_CAP, KEPT_FILE_MAX_BYTES, type KeptUsage } from "@/shared/share-sign";
import { isPlanId, type PlanId } from "@/shared/plans";

export type KeptKind = "share" | "sign_source" | "sign_final" | "sign_image" | "request_file" | "secret";

const mbText = (n: number) => (n >= 1024 * 1024 * 1024 ? `${Math.round(n / (1024 * 1024 * 1024))} GB` : `${Math.round(n / (1024 * 1024))} MB`);

export function keptStore(deps: Deps) {
  if (!deps.toolFiles) throw new HttpError(503, "tools_unavailable", "File storage is not set up on this deployment.");
  return deps.toolFiles;
}

async function planOf(deps: Deps, orgId: string): Promise<PlanId> {
  const r = await deps.db.get<{ plan: string }>(sql`select plan from organizations where id = ${orgId}`);
  return r && isPlanId(r.plan) ? r.plan : "starter";
}

/** Live kept bytes for a workspace and its plan's cap (one read). */
export async function keptUsage(deps: Deps, orgId: string): Promise<KeptUsage> {
  const now = deps.now().getTime();
  const r = await deps.db.get<{ plan: string; b: number | null }>(sql`select o.plan as plan,
    (select sum(bytes) from tool_files where org_id = o.id and expires_at > ${now} and deleted_at is null) as b
    from organizations o where o.id = ${orgId}`);
  const plan = r && isPlanId(r.plan) ? r.plan : "starter";
  return { bytes: Number(r?.b ?? 0), cap: KEPT_FILE_CAP[plan] };
}

/**
 * Reserves room for one file and stores it. Throws a plain plan limit when the workspace or the whole
 * account is full. Returns the file id (its KV key is "kept/<id>").
 */
export async function keepFile(deps: Deps, orgId: string, kind: KeptKind, bytes: Uint8Array, ttlSeconds: number, metadata?: Record<string, string>): Promise<string> {
  const store = keptStore(deps);
  if (bytes.byteLength > KEPT_FILE_MAX_BYTES) throw new HttpError(413, "too_large", "Files can be up to 25 MB here.");
  const now = deps.now().getTime();
  const until = now + Math.max(60, Math.floor(ttlSeconds)) * 1000;
  const id = await reserveKept(deps, orgId, kind, bytes.byteLength, ttlSeconds);
  try {
    await store.put(`kept/${id}`, bytes, { ttlSeconds: Math.ceil((until - now) / 1000), metadata });
  } catch (err) {
    await deps.db.run(sql`update tool_files set deleted_at = ${now} where id = ${id}`);
    throw err;
  }
  return id;
}

/**
 * R88: reserves room for a file that arrives in chunks (a file request upload). The row is the ledger of live bytes,
 * so the caps hold while the chunks come in. Throws the same plain plan limit as keepFile.
 */
export async function reserveKept(deps: Deps, orgId: string, kind: KeptKind, size: number, ttlSeconds: number): Promise<string> {
  const cap = KEPT_FILE_CAP[await planOf(deps, orgId)];
  const id = newId("kf");
  const now = deps.now().getTime();
  const until = now + Math.max(60, Math.floor(ttlSeconds)) * 1000;
  const r = await deps.db.run(sql`insert into tool_files (id, org_id, kind, bytes, expires_at, created_at)
    select ${id}, ${orgId}, ${kind}, ${size}, ${until}, ${now}
    where coalesce((select sum(bytes) from tool_files where org_id = ${orgId} and expires_at > ${now} and deleted_at is null), 0) + ${size} <= ${cap}
      and coalesce((select sum(bytes) from tool_files where expires_at > ${now} and deleted_at is null), 0) + ${size} <= ${KEPT_FILE_GLOBAL_CAP}`);
  if (!changesOf(r)) {
    const u = await keptUsage(deps, orgId);
    if (u.bytes + size > u.cap) throw planLimit(`Your workspace can keep ${mbText(u.cap)} of shared and signing files at once. Remove an old link or wait for one to expire.`);
    throw new HttpError(503, "storage_full", "File storage is full right now. Try again later or send the file as an attachment.");
  }
  return id;
}

/** R88: one chunk of a reserved file (KV key "kept/<id>.<n>"), with the file's own expiry. */
export async function putKeptChunk(deps: Deps, id: string, n: number, bytes: Uint8Array, untilMs: number): Promise<void> {
  const ttl = Math.max(60, Math.ceil((untilMs - deps.now().getTime()) / 1000));
  await keptStore(deps).put(`kept/${id}.${n}`, bytes, { ttlSeconds: ttl });
}

export async function readKeptChunk(deps: Deps, id: string, n: number): Promise<Uint8Array | null> {
  const f = await keptStore(deps).get(`kept/${id}.${n}`);
  return f ? new Uint8Array(f.bytes) : null;
}

/** R88: deletes a chunked file's chunks and frees its bytes. */
export async function dropKeptChunks(deps: Deps, orgId: string, id: string, chunks: number): Promise<void> {
  const store = keptStore(deps);
  await Promise.all(Array.from({ length: chunks }, (_, n) => store.delete(`kept/${id}.${n}`).catch(() => undefined)));
  await deps.db.run(sql`update tool_files set deleted_at = ${deps.now().getTime()} where id = ${id} and org_id = ${orgId}`);
}

/** R88: the edge's region guess (state or province), never the address. Null off Cloudflare. */
export function regionOf(req: Request): string | null {
  const cf = (req as unknown as { cf?: { region?: unknown } }).cf;
  const r = typeof cf?.region === "string" ? cf.region.trim() : "";
  return r && r.length <= 60 && !/[<>"]/.test(r) ? r : null;
}

/** R88: link previewers and crawlers (chat apps unfurling a link) do not count as a view. */
export function isPreviewer(ua: string | null | undefined): boolean {
  if (!ua) return true;
  return /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|skype|embedly|iframely|outlook|curl|wget|python|okhttp|go-http|headless/i.test(ua);
}

export async function readKeptFile(deps: Deps, id: string): Promise<Uint8Array | null> {
  const f = await keptStore(deps).get(`kept/${id}`);
  return f ? new Uint8Array(f.bytes) : null;
}

/** Deletes kept files now (revoke, cancel). Missing ids are fine. */
export async function dropKeptFiles(deps: Deps, orgId: string, ids: (string | null | undefined)[]): Promise<void> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return;
  const store = keptStore(deps);
  await Promise.all(list.map((id) => store.delete(`kept/${id}`).catch(() => undefined)));
  const now = deps.now().getTime();
  for (const id of list) await deps.db.run(sql`update tool_files set deleted_at = ${now} where id = ${id} and org_id = ${orgId}`);
}

/** Cron: rows past their expiry (KV already dropped the values). One write, no read. */
export async function pruneKeptFiles(deps: Deps): Promise<void> {
  const cut = deps.now().getTime() - 86_400_000;
  await deps.db.run(sql`delete from tool_files where expires_at < ${cut}`);
}

export function changesOf(r: unknown): number {
  const x = r as { changes?: number; meta?: { changes?: number } };
  return Number(x?.changes ?? x?.meta?.changes ?? 0);
}

// ---------------------------------------------------------------------------
// Public tokens (share links, signing links): 32 random bytes, only their SHA-256 is stored.
// ---------------------------------------------------------------------------
export function newPublicToken(): { token: string; hash: Promise<string> } {
  const token = randomToken(32);
  return { token, hash: sha256Hex(token) };
}

/** A token's shape before any lookup (43 base64url characters). */
export const tokenShapeOk = (t: string) => /^[A-Za-z0-9_-]{43}$/.test(t);

export async function tokenHash(t: string): Promise<string> { return sha256Hex(t); }

/** Constant time check of a looked up row's hash against the presented token's hash. */
export const hashMatches = (stored: string | null | undefined, presented: string) => !!stored && safeEqual(stored, presented);

/** The edge's country guess for a request (two letters), never the address itself. */
export function countryOf(h: Headers | { header(name: string): string | undefined }): string | null {
  const v = (h instanceof Headers ? h.get("cf-ipcountry") : h.header("cf-ipcountry")) ?? "";
  const c = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : null;
}

/** "Chrome on Windows": a browser family and a system family, nothing more of the user agent. */
export function agentFamily(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const b = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|wget|python|bot|spider|crawl/i.test(ua) ? "Script or bot" : "Other browser";
  const o = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return o ? `${b} on ${o}` : b;
}
