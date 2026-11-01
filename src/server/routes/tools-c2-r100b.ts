/**
 * R100b Tools C2 routes (feature tools_c2): the link preview with its image proxy, and image links
 * (/api/img/doc/:id and /api/img/file/:id). Everything here needs a signed in member of the workspace.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError, notFound } from "../lib/errors";
import { UnsafeUrlError } from "../lib/safe-fetch";
import { activeToolFeatures } from "../services/tools/features";
import { fetchLinkPreview, fetchPreviewImage, PREVIEW_TTL_S } from "../services/tools/link-preview-r100b";
import { fileRow, imageCacheKey, IMAGE_TTL_S, MinuteCap, readSourceImage, transformImage } from "../services/tools/image-links-r100b";
import { ImageParamError, parseImageParams, type ImageSource } from "../../shared/image-links";

const previewCap = new MinuteCap(30);
const proxyCap = new MinuteCap(120);
const imageCap = new MinuteCap(90);

function featureOn(c: Context<AppEnv>) {
  const deps = c.var.deps;
  if (!deps.config.tools.enabled || !activeToolFeatures(deps).includes("tools_c2")) throw notFound("Page");
}

function capped(cap: MinuteCap, c: Context<AppEnv>) {
  if (!cap.take(`${c.var.auth.orgId}:${c.var.auth.userId}`)) {
    c.header("retry-after", "60");
    throw new HttpError(429, "rate_limited", "That is a lot at once. Wait a minute and try again.");
  }
}

const edgeCache = (): Cache | null => (typeof caches !== "undefined" && (caches as unknown as { default?: Cache }).default) || null;

async function cached(key: string, make: () => Promise<Response>, ttl: number, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  const cache = edgeCache();
  const req = new Request(key);
  if (cache) {
    const hit = await cache.match(req);
    if (hit) { const r = new Response(hit.body, hit); r.headers.set("x-cache", "hit"); return r; }
  }
  const res = await make();
  if (cache && res.status === 200) {
    const copy = res.clone();
    const stored = new Response(copy.body, copy);
    stored.headers.set("cache-control", `public, max-age=${ttl}`); // the edge copy only; the key holds the workspace
    const put = cache.put(req, stored).catch(() => {});
    if (waitUntil) waitUntil(put); else await put;
  }
  return res;
}

const waitUntilOf = (c: Context<AppEnv>) => { try { return c.executionCtx.waitUntil.bind(c.executionCtx); } catch { return undefined; } };

const imageHeaders = (type: string, privateTtl: number) => ({
  "content-type": type, "x-content-type-options": "nosniff", "content-disposition": "inline",
  "cache-control": `private, max-age=${privateTtl}`, "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
});

const PreviewBody = z.object({ url: z.string().trim().min(1).max(2048) });

export function toolsC2Routes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .post("/link-preview", async (c) => {
      featureOn(c);
      const { url } = await parseBody(c, PreviewBody);
      capped(previewCap, c);
      const key = `https://preview-cache.multies.internal/v1?u=${encodeURIComponent(url.trim())}`;
      const res = await cached(key, async () => {
        try {
          return Response.json(await fetchLinkPreview(c.var.deps.fetch, url));
        } catch (e) {
          if (e instanceof UnsafeUrlError) return Response.json({ error: { code: "preview_failed", message: e.message } }, { status: 422 });
          throw e;
        }
      }, PREVIEW_TTL_S, waitUntilOf(c));
      res.headers.set("cache-control", "private, no-store");
      return res;
    })
    .get("/link-preview/image", async (c) => {
      featureOn(c);
      const u = c.req.query("u") ?? "";
      if (!u || u.length > 2048) throw new HttpError(422, "validation_failed", "Missing picture address.");
      capped(proxyCap, c);
      const key = `https://preview-cache.multies.internal/v1/img?u=${encodeURIComponent(u)}`;
      return cached(key, async () => {
        try {
          const img = await fetchPreviewImage(c.var.deps.fetch, u);
          return new Response(img.bytes as BodyInit, { headers: imageHeaders(img.contentType, 3600) });
        } catch (e) {
          if (e instanceof UnsafeUrlError) return Response.json({ error: { code: "preview_failed", message: e.message } }, { status: 422 });
          throw e;
        }
      }, PREVIEW_TTL_S, waitUntilOf(c));
    });
}

export function imageLinkRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/:source/:id", async (c) => {
      featureOn(c);
      const source = c.req.param("source");
      if (source !== "doc" && source !== "file") throw notFound("Image");
      let params;
      try { params = parseImageParams(new URL(c.req.url).searchParams); } catch (e) {
        if (e instanceof ImageParamError) throw new HttpError(422, "validation_failed", e.message);
        throw e;
      }
      const { deps, auth } = c.var;
      const id = c.req.param("id");
      const key = imageCacheKey(source as ImageSource, id, params, auth);
      const cache = edgeCache();
      if (cache) {
        const hit = await cache.match(new Request(key));
        if (hit) {
          // a cached answer still needs the person's access today (a member may lose a mailbox)
          await readAccess(c, source as ImageSource, id);
          const r = new Response(hit.body, { status: 200, headers: imageHeaders(hit.headers.get("content-type") ?? "image/png", 3600) });
          r.headers.set("x-cache", "hit");
          return r;
        }
      }
      capped(imageCap, c);
      const src = await readSourceImage(deps, auth, source as ImageSource, id);
      const out = await transformImage(deps, auth, src, params);
      const res = new Response(out.bytes as BodyInit, { headers: imageHeaders(out.contentType, 3600) });
      if (cache) {
        const stored = new Response(out.bytes as BodyInit, { headers: { "content-type": out.contentType, "cache-control": `public, max-age=${IMAGE_TTL_S}` } });
        const put = cache.put(new Request(key), stored).catch(() => {});
        const wu = waitUntilOf(c);
        if (wu) wu(put); else await put;
      }
      return res;
    });
}

/** A cheap access check for a cache hit: doc images live under the workspace key; attachments need the mailbox scope. */
async function readAccess(c: Context<AppEnv>, source: ImageSource, id: string) {
  if (source === "doc") return; // the cache key already carries the workspace, and doc images are workspace wide
  await fileRow(c.var.deps, c.var.auth, id);
}
