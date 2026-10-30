/**
 * R43 imports that finish after the page closes. The uploaded file is kept until the run ends, so the scheduled pass
 * can run the remaining steps on its own:
 *  - tasks, calendar, contacts, docs and workspace imports already send the whole file with every step, so the step
 *    that does not finish keeps that request's input (one put) and nothing changes in the page;
 *  - a mail archive (.mbox) keeps its messages in parts of about 2 MB (base64 lines), uploaded by the page after the
 *    first batch; the run counts as kept only once every part is in.
 * Storage is Workers KV (free plan: 1 GB stored, 1,000 writes and 100,000 reads a day, 25 MiB a value). Every value
 * expires on its own after KEEP_DAYS, and the file is deleted as soon as the run is done, undone, cancelled or failed.
 * The store is an interface so an R2 bucket can take over without touching the importers.
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { dataMoves } from "../../db/schema";
import { HttpError, forbidden, notFound } from "../../lib/errors";

export interface ImportFileStore {
  readonly name: string;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/** Days a kept file lives at most (the value's own expiry; the run deletes it sooner when it ends). */
export const KEEP_DAYS = 7;
const KEEP_TTL = KEEP_DAYS * 24 * 3600;
/** Largest kept input for one-file imports (the step body itself is capped at 8 MB of content). */
export const KEEP_MAX_CHARS = 9_000_000;
/** A mail archive is kept only up to this size; bigger ones still run while the page is open. */
export const MBOX_KEEP_MAX_MB = 100;
/** Size of one kept mail part and how many parts a run may have (100 MB in 2 MB parts, with room for base64). */
export const MBOX_PART_CHARS = 2_000_000;
export const MBOX_MAX_PARTS = 80;

type KV = { put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>; get(k: string, t: "text"): Promise<string | null>; delete(k: string): Promise<void> };

export function kvImportFileStore(kv: unknown): ImportFileStore {
  const k = kv as KV;
  return {
    name: "kv",
    put: (key, value, ttl) => k.put(key, value, { expirationTtl: Math.max(60, ttl) }),
    get: (key) => k.get(key, "text"),
    delete: (key) => k.delete(key),
  };
}

/** Tests and local runs without a binding. */
export class MemoryImportFileStore implements ImportFileStore {
  readonly name = "memory";
  data = new Map<string, string>();
  async put(key: string, value: string) { this.data.set(key, value); }
  async get(key: string) { return this.data.get(key) ?? null; }
  async delete(key: string) { this.data.delete(key); }
}

type Row = typeof dataMoves.$inferSelect;
export const keyOf = (m: Pick<Row, "orgId" | "id">) => `move/${m.orgId}/${m.id}`;
const partKey = (prefix: string, i: number) => `${prefix}/${i}`;

export interface MboxMeta { mailboxId: string; folder?: string; starts: number[] }

/**
 * Keeps the input of a one-file import whose step stopped part way (once per run). Not essential to the step: a failed
 * put only means the run waits for its page, as before, so errors are logged and swallowed.
 */
export async function keepImportInput(deps: Deps, m: Row, input: Record<string, unknown>) {
  if (!deps.importFiles || m.fileKey || m.kind !== "import" || m.source.startsWith("mail:")) return false;
  const { moveId: _drop, ...rest } = input;
  const value = JSON.stringify(rest);
  if (value.length > KEEP_MAX_CHARS) return false;
  const key = keyOf(m);
  try {
    await deps.importFiles.put(key, value, KEEP_TTL);
    // Essential write: the run row says its file is kept, so the scheduled pass can finish it.
    await deps.db.update(dataMoves).set({ fileKey: key, fileParts: 1, fileExpiresAt: new Date(deps.now().getTime() + KEEP_TTL * 1000) }).where(eq(dataMoves.id, m.id));
    return true;
  } catch (err) {
    deps.log?.warn("data_move.keep_failed", { moveId: m.id, error: err });
    return false;
  }
}

/** Deletes a run's kept file and clears the row. Safe to call for a run with nothing kept. */
export async function dropKeptFile(deps: Deps, m: Pick<Row, "id" | "fileKey" | "fileParts" | "source">) {
  if (!m.fileKey) return;
  try {
    if (deps.importFiles) {
      if (m.source === "mail:mbox") for (let i = 0; i < (m.fileParts ?? 0); i++) await deps.importFiles.delete(partKey(m.fileKey, i));
      else await deps.importFiles.delete(m.fileKey);
    }
  } catch (err) { deps.log?.warn("data_move.drop_failed", { moveId: m.id, error: err }); }
  // Essential write: the row no longer points at a file (the values also expire on their own).
  await deps.db.update(dataMoves).set({ fileKey: null, fileParts: null, fileMeta: null, fileExpiresAt: null }).where(eq(dataMoves.id, m.id));
}

/** Reads one kept file (one-file imports). */
export async function readKeptInput(deps: Deps, m: Row): Promise<Record<string, unknown> | null> {
  if (!deps.importFiles || !m.fileKey) return null;
  const v = await deps.importFiles.get(m.fileKey);
  if (!v) return null;
  try { return JSON.parse(v) as Record<string, unknown>; } catch { return null; }
}

/** The kept messages from index `from`, at most `n` (mail archives). Reads one part, two at a part boundary. */
export async function readKeptMessages(deps: Deps, m: Row, from: number, n: number): Promise<string[] | null> {
  if (!deps.importFiles || !m.fileKey) return null;
  const meta = parseMeta(m.fileMeta);
  if (!meta) return null;
  const out: string[] = [];
  let idx = from;
  while (out.length < n) {
    let p = -1;
    for (let i = 0; i < meta.starts.length; i++) if (meta.starts[i] <= idx) p = i;
    if (p < 0 || p >= (m.fileParts ?? 0)) break;
    const v = await deps.importFiles.get(partKey(m.fileKey, p));
    if (v === null) return null;
    const lines = v.length ? v.split("\n") : [];
    const local = idx - meta.starts[p];
    if (local >= lines.length) break;
    const take = lines.slice(local, local + (n - out.length));
    out.push(...take);
    idx += take.length;
    if (p === meta.starts.length - 1 && local + take.length >= lines.length) break;
  }
  return out;
}

export function parseMeta(s: string | null | undefined): MboxMeta | null {
  try { const j = s ? JSON.parse(s) as MboxMeta : null; return j && Array.isArray(j.starts) ? j : null; } catch { return null; }
}

/**
 * POST /api/data-moves/mbox/:id/keep?part=i&parts=n (body { lines }: the part's messages as base64, one a line). The last part
 * also carries starts (the first message index of each part) and the mailbox and folder; only then is the run marked
 * kept. One JSON string, so parsing up to 2 MB of mail stays cheap.
 */
export async function keepMboxPart(deps: Deps, actor: { orgId: string; role?: string | null }, id: string, q: { part: number; parts: number; starts?: number[]; mailboxId?: string; folder?: string }, body: string) {
  if (actor.role !== "owner" && actor.role !== "admin") throw forbidden("Only workspace owners and admins can import mail.");
  if (!deps.importFiles) return { kept: false, reason: "off" as const };
  const { part, parts } = q;
  if (!Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || parts > MBOX_MAX_PARTS || part < 0 || part >= parts) throw new HttpError(422, "validation_failed", "Send parts numbered from 0, at most 80.");
  if (body.length > MBOX_PART_CHARS * 1.5) throw new HttpError(413, "too_large", "That part is too big.");
  const m = await deps.db.select().from(dataMoves).where(and(eq(dataMoves.id, id), eq(dataMoves.orgId, actor.orgId))).get();
  if (!m || m.source !== "mail:mbox") throw notFound("Import");
  if (m.status !== "running") return { kept: false, reason: "ended" as const };
  const prefix = keyOf(m);
  await deps.importFiles.put(partKey(prefix, part), body, KEEP_TTL);
  if (part < parts - 1) return { kept: false, reason: "more" as const };
  const starts = (q.starts ?? []).filter((n) => Number.isInteger(n) && n >= 0);
  if (starts.length !== parts || !q.mailboxId) throw new HttpError(422, "validation_failed", "The last part needs starts and the mailbox.");
  const meta: MboxMeta = { mailboxId: q.mailboxId.slice(0, 64), folder: q.folder?.slice(0, 100), starts };
  // Essential write: the run is kept only now that every part is in.
  await deps.db.update(dataMoves).set({ fileKey: prefix, fileParts: parts, fileMeta: JSON.stringify(meta), fileExpiresAt: new Date(deps.now().getTime() + KEEP_TTL * 1000) }).where(and(eq(dataMoves.id, m.id), eq(dataMoves.status, "running")));
  return { kept: true, reason: null };
}
