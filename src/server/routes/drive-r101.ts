/**
 * R101 Files plus (FILES_PLUS_R101): the workspace drive and brand library on the Files page.
 *   GET    /api/drive/list?view=&folder=&q=&cursor=     a space, folder or view (team, mine, shared, starred, recent, trash, brand)
 *   GET    /api/drive/usage                             bytes used and the limits
 *   GET    /api/drive/tags                              brand library tags with counts
 *   POST   /api/drive/folders                           { space, parentId?, name }
 *   PUT    /api/drive/upload?space=&parent=&name=       raw bytes (x-multies-upload: 1), a new file
 *   GET    /api/drive/items/:id                         detail, versions, shares
 *   PATCH  /api/drive/items/:id                         { name?, tags?, note? }
 *   PUT    /api/drive/items/:id/content                 raw bytes: a new version
 *   GET    /api/drive/items/:id/content?v=&inline=1     the bytes (Range for video), inline only for safe types
 *   POST   /api/drive/items/:id/versions/:vid/restore
 *   PUT    /api/drive/items/:id/shares                  { shares: [{ userId, role }] } (owner, My files only)
 *   POST   /api/drive/move | trash | restore | delete | star    { ids, ... }
 *   GET    /api/drive/manifest?ids=a,b                  files under a selection with paths, for a zip made in the browser
 * Workspace session only (project guests have their own session and no drive). Every route checks access server side.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError, notFound } from "../lib/errors";
import { members } from "../db/schema";
import { and, eq } from "drizzle-orm";
import {
  addVersion, blobsFor, brandTags, createFolder, deleteForever, getDetail, listDrive, manifest, moveItems, openContent, restoreItems, restoreVersion, setShares, starItems, trashItems, updateItem, uploadFile, usage,
} from "../services/suite/drive-r101";
import { enqueue as docEnqueue } from "../services/suite/doc-inbox";
import { DRIVE_LIMITS, DRIVE_SPACES, inlineSafe, isDriveView, parseRange, type DriveSpace } from "@/shared/drive";

const Space = z.enum(DRIVE_SPACES);
const Ids = z.array(z.string().min(1).max(80)).min(1).max(DRIVE_LIMITS.bulk);
const FolderBody = z.object({ space: Space, parentId: z.string().max(80).nullable().optional(), name: z.string().max(400) }).strict();
const PatchBody = z.object({ name: z.string().max(400).optional(), tags: z.array(z.string().max(80)).max(40).optional(), note: z.string().max(2000).nullable().optional() }).strict();
const MoveBody = z.object({ ids: Ids, parentId: z.string().max(80).nullable(), space: Space.optional() }).strict();
const IdsBody = z.object({ ids: Ids }).strict();
const StarBody = z.object({ ids: Ids, on: z.boolean() }).strict();
const SharesBody = z.object({ shares: z.array(z.object({ userId: z.string().min(1).max(80), role: z.enum(["view", "edit"]) }).strict()).max(100) }).strict();

const actor = (c: Context<AppEnv>) => c.var.auth;

function on(c: Context<AppEnv>) {
  if (!c.var.deps.config.filesPlus) throw notFound("Page");
}

/** Reads a raw upload with a hard cap, so a huge body never sits in memory whole. */
async function readBody(c: Context<AppEnv>): Promise<Uint8Array> {
  if (c.req.header("x-multies-upload") !== "1") throw new HttpError(400, "bad_request", "Upload from the Files page.");
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > DRIVE_LIMITS.fileBytes) throw new HttpError(413, "file_too_large", `Files can be up to ${Math.round(DRIVE_LIMITS.fileBytes / (1024 * 1024))} MB here.`);
  const body = c.req.raw.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > DRIVE_LIMITS.fileBytes) { await reader.cancel(); throw new HttpError(413, "file_too_large", `Files can be up to ${Math.round(DRIVE_LIMITS.fileBytes / (1024 * 1024))} MB here.`); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const ch of chunks) { out.set(ch, at); at += ch.length; }
  return out;
}

const fileType = (c: Context<AppEnv>) => (c.req.header("content-type") ?? "").split(";")[0].trim();

export function driveRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { on(c); await next(); })
    .get("/list", async (c) => {
      const view = c.req.query("view") ?? "team";
      if (!isDriveView(view)) throw new HttpError(422, "validation_failed", "Unknown view.");
      const cursor = Number(c.req.query("cursor") ?? "0");
      return c.json(await listDrive(c.var.deps, actor(c), view, { folderId: c.req.query("folder") || null, q: c.req.query("q") ?? "", cursor: Number.isFinite(cursor) ? cursor : 0 }));
    })
    .get("/usage", async (c) => c.json(await usage(c.var.deps, actor(c).orgId)))
    .get("/tags", async (c) => c.json({ tags: await brandTags(c.var.deps, actor(c).orgId) }))
    .post("/folders", async (c) => c.json({ item: await createFolder(c.var.deps, actor(c), await parseBody(c, FolderBody)) }))
    .put("/upload", async (c) => {
      const space = (c.req.query("space") ?? "team") as DriveSpace;
      if (!(DRIVE_SPACES as readonly string[]).includes(space)) throw new HttpError(422, "validation_failed", "Unknown space.");
      const bytes = await readBody(c);
      const item = await uploadFile(c.var.deps, actor(c), { space, parentId: c.req.query("parent") || null, name: c.req.query("name") ?? "", contentType: fileType(c), bytes });
      // R102: a new upload joins Documents (read in the background, within the daily limit). Brand library files are not read.
      if (space !== "brand") await docEnqueue(c.var.deps, actor(c), { id: item.id, name: item.name, sizeBytes: item.sizeBytes, kind: "file" });
      return c.json({ item });
    })
    .get("/items/:id", async (c) => c.json(await getDetail(c.var.deps, actor(c), c.req.param("id"), { trashed: c.req.query("trashed") === "1" })))
    .patch("/items/:id", async (c) => c.json({ item: await updateItem(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, PatchBody)) }))
    .put("/items/:id/content", async (c) => {
      const bytes = await readBody(c);
      // R113: ?base=<version id> refuses a stale save (409); ?via=editor notes the version as saved in the editor.
      const via = c.req.query("via");
      const d = await addVersion(c.var.deps, actor(c), c.req.param("id"), { bytes, contentType: fileType(c), base: c.req.query("base") || null, note: via === "editor" ? "Saved in the editor" : null });
      // R102: a new version is read again (its fields a person corrected stay).
      if (d.item.space !== "brand") await docEnqueue(c.var.deps, actor(c), { id: d.item.id, name: d.item.name, sizeBytes: d.item.sizeBytes, kind: "file" });
      return c.json(d);
    })
    .get("/items/:id/content", async (c) => {
      const f = await openContent(c.var.deps, actor(c), c.req.param("id"), c.req.query("v") || undefined);
      const inline = c.req.query("inline") === "1" && inlineSafe(f.contentType);
      const range = parseRange(c.req.header("range"), f.size);
      const headers: Record<string, string> = {
        "content-type": inline ? f.contentType : (inlineSafe(f.contentType) ? f.contentType : "application/octet-stream"),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "x-content-type-options": "nosniff", "cache-control": "private, no-store", "accept-ranges": "bytes",
        "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        "cross-origin-resource-policy": "same-origin",
      };
      if (range === "invalid") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${f.size}` } });
      const blobs = blobsFor(c.var.deps);
      if (range) {
        return new Response(blobs.read(f.key, f.parts, f.size, range), { status: 206, headers: { ...headers, "content-range": `bytes ${range.start}-${range.end}/${f.size}`, "content-length": String(range.end - range.start + 1) } });
      }
      return new Response(blobs.read(f.key, f.parts, f.size), { status: 200, headers: { ...headers, "content-length": String(f.size) } });
    })
    .post("/items/:id/versions/:vid/restore", async (c) => c.json(await restoreVersion(c.var.deps, actor(c), c.req.param("id"), c.req.param("vid"))))
    .put("/items/:id/shares", async (c) => {
      const body = await parseBody(c, SharesBody);
      const { deps } = c.var;
      const rows = await deps.db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, actor(c).orgId))).limit(2000).all();
      return c.json(await setShares(deps, actor(c), c.req.param("id"), body.shares, new Set(rows.map((r) => r.userId))));
    })
    .post("/move", async (c) => c.json(await moveItems(c.var.deps, actor(c), await parseBody(c, MoveBody))))
    .post("/trash", async (c) => c.json(await trashItems(c.var.deps, actor(c), (await parseBody(c, IdsBody)).ids)))
    .post("/restore", async (c) => c.json(await restoreItems(c.var.deps, actor(c), (await parseBody(c, IdsBody)).ids)))
    .post("/delete", async (c) => c.json(await deleteForever(c.var.deps, actor(c), (await parseBody(c, IdsBody)).ids)))
    .post("/star", async (c) => { const b = await parseBody(c, StarBody); return c.json(await starItems(c.var.deps, actor(c), b.ids, b.on)); })
    .get("/manifest", async (c) => c.json(await manifest(c.var.deps, actor(c), (c.req.query("ids") ?? "").split(",").filter(Boolean))));
}
