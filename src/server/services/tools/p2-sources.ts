/**
 * Tools P2 (H5): where a shared or signed file comes from: an upload, a finished Tools result (its download
 * token) or a mail attachment the person can see (the same mailbox scope as mail itself).
 */
import { and, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { HttpError, notFound } from "../../lib/errors";
import { attachments, messages } from "../../db/schema";
import { attachmentBytes } from "../mail/store";
import { mailboxScope } from "../team";
import { readToken } from "./tokens";
import { engineJobOutput } from "./engine-run";
import { isToolOp, toolDef } from "@/shared/tools";
import { KEPT_FILE_MAX_BYTES } from "@/shared/share-sign";

export interface SourceFile { bytes: Uint8Array; name: string; contentType: string; messageId?: string }

const tooBig = () => new HttpError(413, "too_large", "Files can be up to 25 MB here.");

export async function fromToolResult(deps: Deps, auth: AuthContext, token: string): Promise<SourceFile> {
  const key = deps.config.tools.tokenKey;
  if (!key) throw notFound("Page");
  const t = await readToken(key, token, "d", deps.now().getTime());
  if (!t || t.w !== auth.orgId) throw new HttpError(404, "not_found", "This result has expired. Run the tool again.");
  const bytes = await engineJobOutput(deps, auth.orgId, auth.userId, t.j);
  if (!bytes) throw new HttpError(404, "not_found", "This result has expired. Run the tool again.");
  if (bytes.byteLength > KEPT_FILE_MAX_BYTES) throw tooBig();
  return { bytes, name: t.n, contentType: isToolOp(t.o) ? toolDef(t.o).contentType : "application/octet-stream" };
}

export async function fromAttachment(deps: Deps, auth: AuthContext, id: string): Promise<SourceFile> {
  const row = await deps.db.select({ a: attachments, mailboxId: messages.mailboxId }).from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(eq(attachments.id, id), eq(messages.orgId, auth.orgId))).get();
  const scope = row ? await mailboxScope(deps.db, auth) : null;
  if (!row || (scope && !scope.includes(row.mailboxId))) throw notFound("Attachment");
  if (row.a.sizeBytes > KEPT_FILE_MAX_BYTES) throw tooBig();
  const bytes = await attachmentBytes(row.a, deps.bodyStore);
  if (!bytes) throw new HttpError(422, "tool_input", "That attachment is not stored, so it cannot be used here.");
  return { bytes: new Uint8Array(bytes), name: row.a.filename, contentType: row.a.contentType || "application/octet-stream", messageId: row.a.messageId };
}

/** Reads a multipart upload (25 MB at most); its "file" field comes out through fileOfForm. */
export async function readUploadForm(req: Request): Promise<FormData> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > KEPT_FILE_MAX_BYTES + 64 * 1024) throw tooBig();
  const fd = await req.formData().catch(() => null);
  if (!fd) throw new HttpError(400, "bad_request", "Choose a file.");
  return fd;
}

export async function fileOfForm(fd: FormData): Promise<SourceFile> {
  const f = fd.get("file");
  if (!f || typeof f === "string") throw new HttpError(400, "bad_request", "Choose a file.");
  if (f.size > KEPT_FILE_MAX_BYTES) throw tooBig();
  return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name || "file", contentType: f.type || "application/octet-stream" };
}

export const isPdf = (b: Uint8Array) => b.byteLength > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
