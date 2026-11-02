/**
 * TD2 (FORMS_TD2): Forms pro paths.
 *   POST   /api/public/forms/:slug/uploads?field=   raw bytes (x-multies-upload: 1, x-file-name), no sign in
 *   GET    /api/public/forms/:slug/images/:fieldId  an image block's picture, no sign in
 *   GET    /api/forms/:id/uploads/:uploadId         a response's file, workspace members only
 *   DELETE /api/forms/:id/responses/:sid            deletes a response and its files, admins
 * All answer 404 with the flag off. File names and bytes are never logged.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import { requireAdmin, requireAuth } from "../middleware";
import { HttpError, notFound } from "../lib/errors";
import { MAX_UPLOAD_BYTES } from "@/shared/forms-td2";
import { deleteResponse, formImage, openUpload, receiveUpload } from "../services/forms-td2/uploads";

/** Reads the raw body with a hard cap, so a huge upload never sits in memory whole. */
async function readCapped(c: Context<AppEnv>, cap: number): Promise<Uint8Array> {
  if (c.req.header("x-multies-upload") !== "1") throw new HttpError(400, "bad_request", "Upload from the form page.");
  const tooBig = () => new HttpError(413, "file_too_large", "Files can be up to 10 MB here.");
  if (Number(c.req.header("content-length") ?? "0") > cap) throw tooBig();
  const body = c.req.raw.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) { await reader.cancel().catch(() => undefined); throw tooBig(); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const ch of chunks) { out.set(ch, at); at += ch.length; }
  return out;
}

const fileName = (c: Context<AppEnv>) => { try { return decodeURIComponent(c.req.header("x-file-name") ?? "").slice(0, 300); } catch { return ""; } };
const FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
const INLINE = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function formsTd2PublicRoutes() {
  return new Hono<AppEnv>()
    // Handlers check the flag themselves: a "*" middleware here would run for every /api/public path.
    .post("/forms/:slug/uploads", async (c) => {
      if (!c.var.deps.config.formsTd2) throw notFound("Form");
      const bytes = await readCapped(c, MAX_UPLOAD_BYTES);
      const out = await receiveUpload(c.var.deps, { slug: c.req.param("slug"), fieldId: (c.req.query("field") ?? "").slice(0, 40), name: fileName(c), bytes, ip: c.var.ip });
      return c.json(out, 201);
    })
    .get("/forms/:slug/images/:fieldId", async (c) => {
      if (!c.var.deps.config.formsTd2) throw notFound("Form");
      const img = await formImage(c.var.deps, c.req.param("slug"), c.req.param("fieldId"));
      return new Response(img.bytes.slice(), { headers: {
        "content-type": img.type, "content-length": String(img.bytes.length), "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff", "content-security-policy": FILE_CSP, "cross-origin-resource-policy": "same-origin",
      } });
    });
}

export function formsTd2Routes() {
  return new Hono<AppEnv>()
    .get("/:id/uploads/:uploadId", requireAuth, async (c) => {
      if (!c.var.deps.config.formsTd2) throw notFound("Form");
      const f = await openUpload(c.var.deps, c.var.auth.orgId, c.req.param("id"), c.req.param("uploadId"));
      const inline = c.req.query("inline") === "1" && INLINE.includes(f.type);
      const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
      return new Response(f.stream, { headers: {
        "content-type": inline || INLINE.includes(f.type) ? f.type : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "content-length": String(f.size), "cache-control": "private, no-store", "x-content-type-options": "nosniff",
        "content-security-policy": FILE_CSP, "cross-origin-resource-policy": "same-origin",
      } });
    })
    .delete("/:id/responses/:sid", requireAuth, requireAdmin, async (c) => { if (!c.var.deps.config.formsTd2) throw notFound("Form"); return c.json(await deleteResponse(c.var.deps, c.var.auth.orgId, c.req.param("id"), c.req.param("sid"))); });
}
