/** R32: upload and read doc images (cookie session). Service: services/suite/doc-images-r32.ts. */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { fromB64 } from "../lib/crypto";
import { addDocImage, readDocImage } from "../services/suite/doc-images-r32";

const Upload = z.object({
  docId: z.string().min(1).max(80), filename: z.string().trim().max(200).optional(), contentType: z.string().max(100).optional(),
  contentBase64: z.string().min(1).max(7_000_000),
});

export function docImageRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .post("/", async (c) => {
      const b = await parseBody(c, Upload);
      let bytes: Uint8Array;
      try { bytes = fromB64(b.contentBase64); } catch { throw new HttpError(422, "validation_failed", "The image content must be base64."); }
      return c.json(await addDocImage(c.var.deps, c.var.auth, b.docId, bytes), 201);
    })
    .get("/:id", async (c) => {
      const img = await readDocImage(c.var.deps, c.var.auth.orgId, c.req.param("id"));
      return new Response(img.bytes as BodyInit, {
        headers: {
          "content-type": img.contentType, "content-length": String(img.bytes.length), "content-disposition": "inline",
          "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
    });
}
