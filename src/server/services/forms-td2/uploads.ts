import { inIds } from "@/server/lib/sql-chunks";
/**
 * TD2 (FORMS_TD2): files and signatures sent with a public form, and the images a form shows.
 *
 * Bytes go to the existing file storage (blobsFor: the files database, no new binding) under "fu/<org>/<id>".
 * Limits are enforced here, never trusted from the page: the field's size cap under a hard 10 MB, the type read
 * from the bytes, uploads per sender and per form, and form files kept per workspace. Nothing here logs a file
 * name or answer; errors carry only a code.
 */
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { driveItems, formUploads, forms } from "../../db/schema";
import { hmacSha256Hex } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { isUpload, MULTI_SEPARATOR, UPLOAD_ID, type LogicField } from "@/shared/form-logic";
import { allowedKinds, cleanFileName, FILE_KINDS, fieldMaxBytes, fieldMaxFiles, formatBytes, sniffType, UPLOAD_LIMITS } from "@/shared/forms-td2";
import { blobsFor, currentBytes } from "../suite/drive-r101";
import { featureOn, featureVariesByWorkspace } from "../console/flags"; // OPS1 feature flags

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** fu_ plus 24 random letters and digits (about 143 bits): knowing the id is the only way to use an upload. */
export function newUploadId(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return `fu_${Array.from(b, (x) => ALNUM[x % 62]).join("")}`;
}
const blobKey = (orgId: string, id: string) => `fu/${orgId}/${id}`;
export const senderHash = async (deps: Deps, ip: string) => (await hmacSha256Hex(deps.config.appSecret, `form:${ip}`)).slice(0, 32);

async function liveForm(deps: Deps, slug: string) {
  // OPS1 feature flags: on for the form's workspace (no read at all while it is off everywhere, as before).
  if (!featureOn(deps, "formsTd2") && !featureVariesByWorkspace(deps, "formsTd2")) throw notFound("Form");
  const f = await deps.db.select().from(forms).where(and(eq(forms.slug, slug.toLowerCase()), isNull(forms.deletedAt))).get();
  if (!f || !f.enabled || !featureOn(deps, "formsTd2", f.orgId)) throw notFound("Form");
  return f;
}

/** Removes uploads that were never sent with an answer (older than a day), a few at a time. */
export async function sweepPending(deps: Deps, formId: string, limit = 20) {
  const before = new Date(deps.now().getTime() - UPLOAD_LIMITS.pendingMs);
  const old = await deps.db.select().from(formUploads).where(and(eq(formUploads.formId, formId), isNull(formUploads.submissionId), lt(formUploads.createdAt, before))).limit(limit).all();
  await removeUploads(deps, old);
}

async function removeUploads(deps: Deps, rows: (typeof formUploads.$inferSelect)[]) {
  if (!rows.length) return;
  const blobs = blobsFor(deps);
  for (const r of rows) await blobs.delete(blobKey(r.orgId, r.id), Number(r.parts));
  await deps.db.delete(formUploads).where(inIds(formUploads.id, rows.map((r) => r.id)));
}

export interface UploadIn { slug: string; fieldId: string; name: string; bytes: Uint8Array; ip: string }

/** A public upload for one file or signature question. Answers 404, 413, 415 or 429 with plain words. */
export async function receiveUpload(deps: Deps, u: UploadIn) {
  const f = await liveForm(deps, u.slug);
  const field = (JSON.parse(f.fields) as LogicField[]).find((x) => x.id === u.fieldId && isUpload(x.type));
  if (!field) throw notFound("Question");
  const max = fieldMaxBytes(field);
  if (!u.bytes.length) throw new HttpError(422, "file_empty", "That file is empty.");
  if (u.bytes.length > max) throw new HttpError(413, "file_too_large", `Files can be up to ${formatBytes(max)} here.`);
  const kinds = allowedKinds(field);
  const sniffed = sniffType(u.bytes, field.type === "signature" ? "signature.png" : u.name);
  if (!sniffed || !kinds.includes(sniffed.kind) || (field.type === "signature" && sniffed.type !== "image/png")) {
    const allowed = FILE_KINDS.filter((k) => kinds.includes(k.id)).map((k) => k.hint).join(", ");
    throw new HttpError(422, "file_type", field.type === "signature" ? "The signature couldn't be read. Please sign again." : `This file type isn't accepted here. You can send: ${allowed}.`);
  }
  const now = deps.now();
  const ipHash = await senderHash(deps, u.ip);
  const [mine, all, kept] = await Promise.all([
    deps.db.select({ n: sql<number>`count(*)` }).from(formUploads).where(and(eq(formUploads.formId, f.id), eq(formUploads.ipHash, ipHash), gte(formUploads.createdAt, new Date(now.getTime() - UPLOAD_LIMITS.senderWindowMs)))).get(),
    deps.db.select({ n: sql<number>`count(*)` }).from(formUploads).where(and(eq(formUploads.formId, f.id), gte(formUploads.createdAt, new Date(now.getTime() - UPLOAD_LIMITS.formWindowMs)))).get(),
    deps.db.select({ n: sql<number>`coalesce(sum(${formUploads.size}), 0)` }).from(formUploads).where(eq(formUploads.orgId, f.orgId)).get(),
  ]);
  if (Number(mine?.n ?? 0) >= UPLOAD_LIMITS.perSender) throw new HttpError(429, "rate_limited", "That's a lot of files. Please try again in a few minutes.");
  if (Number(all?.n ?? 0) >= UPLOAD_LIMITS.perForm) throw new HttpError(429, "rate_limited", "This form is getting a lot of files right now. Please try again later.");
  if (Number(kept?.n ?? 0) + u.bytes.length > UPLOAD_LIMITS.workspaceBytes) throw new HttpError(413, "storage_full", "This form can't take more files right now. Please contact its owner.");
  await sweepPending(deps, f.id);
  const id = newUploadId();
  const name = field.type === "signature" ? "signature.png" : cleanFileName(u.name, sniffed.ext);
  const parts = await blobsFor(deps).put(blobKey(f.orgId, id), u.bytes, sniffed.type);
  await deps.db.insert(formUploads).values({ id, orgId: f.orgId, formId: f.id, fieldId: field.id, kind: field.type === "signature" ? "signature" : "file", name, contentType: sniffed.type, size: u.bytes.length, parts, ipHash, createdAt: now });
  return { id, name, size: u.bytes.length, type: sniffed.type };
}

/** The upload ids in one answer. */
export const idsIn = (text: string | undefined) => (text ?? "").split(MULTI_SEPARATOR).map((x) => x.trim()).filter((x) => UPLOAD_ID.test(x));

/**
 * Ties every upload answer to the submission, atomically per id: each must be this form's, for that question,
 * from this sender, and not already used. Any miss puts back what was taken and refuses the answer.
 */
export async function attachUploads(deps: Deps, formId: string, fields: LogicField[], answers: Record<string, string>, ipHash: string, submissionId: string) {
  const wanted: { id: string; field: string }[] = [];
  for (const f of fields) if (isUpload(f.type) && answers[f.id]) {
    const ids = idsIn(answers[f.id]);
    if (ids.length > fieldMaxFiles(f)) throw new HttpError(400, "validation_failed", `"${f.label}" takes up to ${fieldMaxFiles(f)} files.`, { field: f.id, fields: { [f.id]: `"${f.label}" takes up to ${fieldMaxFiles(f)} files.` } });
    for (const id of ids) wanted.push({ id, field: f.id });
  }
  if (!wanted.length) return 0;
  const taken: string[] = [];
  for (const w of wanted) {
    const r = await deps.db.update(formUploads).set({ submissionId })
      .where(and(eq(formUploads.id, w.id), eq(formUploads.formId, formId), eq(formUploads.fieldId, w.field), eq(formUploads.ipHash, ipHash), isNull(formUploads.submissionId))).returning({ id: formUploads.id });
    if (!r.length) {
      if (taken.length) await deps.db.update(formUploads).set({ submissionId: null }).where(and(inIds(formUploads.id, taken), eq(formUploads.submissionId, submissionId)));
      const label = fields.find((x) => x.id === w.field)?.label ?? "the file";
      const msg = `Please add "${label}" again.`;
      throw new HttpError(400, "validation_failed", msg, { field: w.field, fields: { [w.field]: msg } });
    }
    taken.push(w.id);
  }
  return taken.length;
}

/** Puts uploads back to unsent when saving the answer failed after they were tied to it. */
export async function releaseUploads(deps: Deps, submissionId: string) {
  await deps.db.update(formUploads).set({ submissionId: null }).where(eq(formUploads.submissionId, submissionId));
}

/** What a task's notes say for an upload answer: how many files, never their names. */
export const uploadSummary = (f: Pick<LogicField, "type">, text: string) => {
  const n = idsIn(text).length;
  return f.type === "signature" ? "Signed" : `${n} file${n === 1 ? "" : "s"} (open the response to see ${n === 1 ? "it" : "them"})`;
};

/** The files of some responses (signed in, this workspace only), for the responses table. */
export async function filesFor(deps: Deps, orgId: string, formId: string, submissionIds: string[]) {
  if (!featureOn(deps, "formsTd2", orgId) || !submissionIds.length) return {} as Record<string, { id: string; name: string; size: number; type: string; kind: string; fieldId: string }[]>;
  const rows = await deps.db.select().from(formUploads).where(and(eq(formUploads.orgId, orgId), eq(formUploads.formId, formId), inIds(formUploads.submissionId, submissionIds.slice(0, 200)))).all();
  const out: Record<string, { id: string; name: string; size: number; type: string; kind: string; fieldId: string }[]> = {};
  for (const r of rows) (out[r.submissionId!] ??= []).push({ id: r.id, name: r.name, size: r.size, type: r.contentType, kind: r.kind, fieldId: r.fieldId });
  return out;
}

/** One uploaded file for a signed in member of the form's workspace (anyone else: not found). */
export async function openUpload(deps: Deps, orgId: string, formId: string, uploadId: string) {
  if (!featureOn(deps, "formsTd2", orgId) || !UPLOAD_ID.test(uploadId)) throw notFound("File");
  const r = await deps.db.select().from(formUploads).where(and(eq(formUploads.id, uploadId), eq(formUploads.orgId, orgId), eq(formUploads.formId, formId))).get();
  if (!r || !r.submissionId) throw notFound("File");
  return { name: r.name, type: r.contentType, size: r.size, stream: blobsFor(deps).read(blobKey(r.orgId, r.id), Number(r.parts), r.size) };
}

/** Deletes one response and its files (form editors). */
export async function deleteResponse(deps: Deps, orgId: string, formId: string, submissionId: string) {
  const { formSubmissions } = await import("../../db/schema");
  const s = await deps.db.select({ id: formSubmissions.id }).from(formSubmissions).where(and(eq(formSubmissions.id, submissionId), eq(formSubmissions.orgId, orgId), eq(formSubmissions.formId, formId))).get();
  if (!s) throw notFound("Response");
  const files = await deps.db.select().from(formUploads).where(and(eq(formUploads.orgId, orgId), eq(formUploads.submissionId, submissionId))).all();
  await removeUploads(deps, files);
  await deps.db.delete(formSubmissions).where(eq(formSubmissions.id, submissionId));
  return { ok: true, files: files.length };
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Every image block must name an image file in this workspace's Files. */
export async function checkFormImages(deps: Deps, orgId: string, fields: LogicField[]) {
  const ids = [...new Set(fields.filter((f) => f.type === "image" && f.imageId).map((f) => f.imageId!))];
  if (!ids.length) return;
  const rows = await deps.db.select({ id: driveItems.id, kind: driveItems.kind, contentType: driveItems.contentType, trashedAt: driveItems.trashedAt }).from(driveItems).where(and(eq(driveItems.orgId, orgId), inIds(driveItems.id, ids))).all();
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    if (!r || r.kind !== "file" || r.trashedAt || !IMAGE_TYPES.includes(r.contentType ?? "")) throw new HttpError(422, "validation_failed", "An image block needs a PNG, JPEG, GIF or WebP image from Files.");
  }
}

/** The image of one image block on a public form (only images the form itself names). */
export async function formImage(deps: Deps, slug: string, fieldId: string) {
  const f = await liveForm(deps, slug);
  const block = (JSON.parse(f.fields) as LogicField[]).find((x) => x.id === fieldId && x.type === "image" && x.imageId);
  if (!block) throw notFound("Image");
  const file = await currentBytes(deps, f.orgId, block.imageId!);
  if (!file) throw notFound("Image");
  const sniffed = sniffType(file.bytes, file.name);
  if (!sniffed || sniffed.kind !== "images") throw notFound("Image");
  return { bytes: file.bytes, type: sniffed.type };
}
