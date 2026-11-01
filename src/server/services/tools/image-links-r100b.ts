/**
 * R100b image links: resize, crop, smart crop and format a workspace image by URL params (/api/img/doc/:id,
 * /api/img/file/:id). Only the caller's own workspace: doc images by the workspace key, mail attachments by
 * the caller's mailbox scope. The work runs on the document engine (op image-transform); answers are cached at
 * the edge per workspace (per person for attachments, whose access is per mailbox) and canonical params.
 */
import { and, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { HttpError, notFound } from "../../lib/errors";
import { attachments, messages } from "../../db/schema";
import { attachmentBytes } from "../mail/store";
import { mailboxScope } from "../team";
import { readDocImage } from "../suite/doc-images-r32";
import { engineJobOutput, engineJobState, submitEngineJob } from "./engine-run";
import { canonicalImageQuery, engineImageOptions, IMAGE_SOURCE_MAX_BYTES, type ImageParams, type ImageSource } from "../../../shared/image-links";
import { imageTypeOf } from "./link-preview-r100b";

export type ImageAuth = Pick<AuthContext, "userId" | "orgId" | "role">;
export const IMAGE_TTL_S = 7 * 24 * 3600;
const ENGINE_DEADLINE_MS = 25_000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** One cache key per workspace (and per person for attachments) and canonical params. Never shared across workspaces. */
export function imageCacheKey(source: ImageSource, id: string, p: ImageParams, auth: ImageAuth): string {
  const who = source === "file" ? `${auth.orgId}/${auth.userId}` : auth.orgId;
  return `https://img-cache.multies.internal/v1/${encodeURIComponent(who)}/${source}/${encodeURIComponent(id)}?${canonicalImageQuery(p)}`;
}

/** The source bytes, only when the caller may see them; the same 404 for missing and not yours. */
export async function readSourceImage(deps: Deps, auth: ImageAuth, source: ImageSource, id: string): Promise<{ bytes: Uint8Array; contentType: string; name: string }> {
  if (!ID.test(id)) throw notFound("Image");
  if (source === "doc") {
    const img = await readDocImage(deps, auth.orgId, id);
    return { bytes: img.bytes, contentType: img.contentType, name: `${id}.${img.contentType.split("/")[1]}` };
  }
  const row = await fileRow(deps, auth, id);
  if (row.a.sizeBytes > IMAGE_SOURCE_MAX_BYTES) throw new HttpError(413, "file_too_large", "Images up to 20 MB can be changed here.");
  const bytes = await attachmentBytes(row.a, deps.bodyStore);
  if (!bytes) throw notFound("Image");
  const type = imageTypeOf(bytes);
  if (!type || type === "image/avif") throw new HttpError(422, "unsupported_image", "Only PNG, JPEG, GIF and WebP pictures can be changed here.");
  return { bytes, contentType: type, name: (row.a.filename || "image").replace(/[\r\n"\\/]/g, "_").slice(0, 120) };
}

/** The attachment row when the caller's mailbox scope covers it (one bounded read by primary key). */
export async function fileRow(deps: Deps, auth: ImageAuth, id: string) {
  if (!ID.test(id)) throw notFound("Image");
  const scope = await mailboxScope(deps.db, auth);
  const row = await deps.db.select({ a: attachments, mailboxId: messages.mailboxId }).from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(eq(attachments.id, id), eq(messages.orgId, auth.orgId))).get();
  if (!row || (scope && !scope.includes(row.mailboxId))) throw notFound("Image");
  return row;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

/** Runs image-transform on the engine and waits for it (25 s at most). */
export async function transformImage(deps: Deps, auth: ImageAuth, src: { bytes: Uint8Array; contentType: string; name: string }, p: ImageParams): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (src.bytes.byteLength > IMAGE_SOURCE_MAX_BYTES) throw new HttpError(413, "file_too_large", "Images up to 20 MB can be changed here.");
  const name = src.name.replace(/\.[A-Za-z0-9]{1,5}$/, "") + (EXT[src.contentType] ?? ".png");
  const jobId = await submitEngineJob(deps, auth.orgId, auth.userId, "image-transform", [{ name, type: src.contentType, bytes: src.bytes }], engineImageOptions(p));
  const deadline = Date.now() + ENGINE_DEADLINE_MS;
  for (let wait = 250; ; wait = Math.min(wait * 1.6, 1500)) {
    const s = await engineJobState(deps, auth.orgId, auth.userId, jobId);
    if (s.status === "done") break;
    if (s.status === "failed") throw new HttpError(422, "tool_input", s.error || "This picture could not be changed.");
    if (s.status === "expired") throw new HttpError(503, "tools_unavailable", "Tools are warming up. Try again in a few seconds.");
    if (Date.now() + wait > deadline) throw new HttpError(504, "tools_slow", "That took too long. Try a smaller size.");
    await sleep(wait);
  }
  const out = await engineJobOutput(deps, auth.orgId, auth.userId, jobId);
  const type = out && imageTypeOf(out);
  if (!out || !type) throw new HttpError(503, "tools_unavailable", "Tools are warming up. Try again in a few seconds.");
  return { bytes: out, contentType: type };
}

/** Per person, per isolate: a soft cap so one page cannot queue hundreds of engine jobs. */
export class MinuteCap {
  private hits = new Map<string, { n: number; until: number }>();
  constructor(private limit: number) {}
  take(key: string, now = Date.now()): boolean {
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.until <= now) this.hits.delete(k);
    const cur = this.hits.get(key);
    if (!cur || cur.until <= now) { this.hits.set(key, { n: 1, until: now + 60_000 }); return true; }
    cur.n++;
    return cur.n <= this.limit;
  }
}
