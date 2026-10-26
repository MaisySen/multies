/**
 * R32: images in docs. An uploaded image is kept in the workspace's file storage (the body store)
 * under its own key, never in D1, and served back to members of the same workspace from
 * /api/doc-images/:id. Without file storage the upload answers 501 and the editor keeps a small
 * image inline in the doc instead. Only PNG, JPEG, GIF and WebP, checked by their first bytes, so
 * an SVG or an HTML page can never be stored as an "image".
 */
import type { Deps } from "../../context";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, sortableId, type SuiteActor } from "./common";
import { getDoc } from "./docs";

export const DOC_IMAGE_LIMIT = 5_000_000;
export const DOC_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const ID = /^dim_[A-Za-z0-9]{6,40}$/;

/** The image type from its first bytes, or null when it is not one we keep. */
export function sniffImageType(b: Uint8Array): (typeof DOC_IMAGE_TYPES)[number] | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

const keyOf = (orgId: string, id: string) => `doc-images/${orgId}/${id}`;

export async function addDocImage(deps: Deps, actor: SuiteActor, docId: string, bytes: Uint8Array) {
  assertWritable(actor);
  await getDoc(deps, actor.orgId, docId); // the doc must exist in this workspace
  const store = deps.bodyStore;
  if (!store) throw new HttpError(503, "uploads_unavailable", "This workspace has no file storage, so images stay inside the doc.");
  if (!bytes.length) throw new HttpError(422, "validation_failed", "That image is empty.");
  if (bytes.length > DOC_IMAGE_LIMIT) throw new HttpError(413, "file_too_large", "Images can be up to 5 MB.");
  const type = sniffImageType(bytes);
  if (!type) throw new HttpError(422, "unsupported_image", "Use a PNG, JPEG, GIF or WebP image.");
  const id = sortableId("dim", deps.now().getTime()).replace(/[^A-Za-z0-9_]/g, "");
  await store.put(keyOf(actor.orgId, id), bytes, type);
  return { id, src: `/api/doc-images/${id}`, contentType: type, sizeBytes: bytes.length };
}

export async function readDocImage(deps: Deps, orgId: string, id: string) {
  if (!ID.test(id) || !deps.bodyStore) throw notFound("Image");
  const bytes = await deps.bodyStore.get(keyOf(orgId, id));
  const type = bytes && sniffImageType(bytes);
  if (!bytes || !type) throw notFound("Image");
  return { bytes, contentType: type };
}
