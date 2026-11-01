/**
 * R101 Files plus: the workspace drive and the brand library (flag FILES_PLUS_R101).
 *
 * Spaces: "team" (everyone in the workspace opens, adds and edits; delete forever is the uploader or an admin),
 * "private" (My files: the owner, plus members it is shared with, view or edit; a shared folder shares what is in
 * it; admins do not see other people's My files) and "brand" (everyone opens and downloads; admins edit).
 * Every check walks the item's folders server side (one recursive query, bounded depth).
 *
 * Bytes: the S3 body store when configured (deps.bodyStore), else the separate FILES_DB database (deps.filesDb,
 * table drive_blobs made on first use, base64 chunks of DRIVE_CHUNK bytes), else the main database (self hosted
 * and tests only). Lists are bounded; nothing here runs on a hot read route.
 */
import { inIds } from "../../lib/sql-chunks";
import { and, asc, desc, eq, inArray, isNull, isNotNull, lt, or, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import type { DB } from "../../db";
import { driveItems, driveShares, driveStars, driveVersions, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { fromB64, newId, toB64 } from "../../lib/crypto";
import { audit } from "../audit";
import {
  DRIVE_CHUNK, DRIVE_LIMITS as L, VIEW_LABEL, cleanName, cleanTags, uniqueName,
  type DriveCrumb, type DriveDetail, type DriveItem, type DriveList, type DriveManifest, type DriveRole, type DriveShare, type DriveSpace, type DriveUsage, type DriveVersion, type DriveView,
} from "../../../shared/drive";
import { containsText } from "../../lib/like-search";

type Row = typeof driveItems.$inferSelect;
type Actor = Pick<AuthContext, "orgId" | "userId" | "email" | "role"> & { name?: string };
const isAdmin = (a: Actor) => a.role === "owner" || a.role === "admin";
const DAY = 86_400_000;

// ------------------------------------------------------------------ bytes

export interface DriveBlobs {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<number>;
  /** The bytes from start to end inclusive (whole file when no range), streamed chunk by chunk. */
  read(key: string, parts: number, size: number, range?: { start: number; end: number }): ReadableStream<Uint8Array>;
  readAll(key: string, parts: number, size: number): Promise<Uint8Array>;
  delete(key: string, parts: number): Promise<void>;
}

const ensured = new WeakSet<object>();
async function ensureBlobTable(db: DB) {
  if (ensured.has(db)) return;
  await db.run(sql`CREATE TABLE IF NOT EXISTS drive_blobs (key TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (key, part))`);
  ensured.add(db);
}

/** Base64 chunks in a D1 (or SQLite) database. */
export function dbBlobs(db: DB): DriveBlobs {
  const part = async (key: string, i: number) => {
    const r = await db.get<{ data: string }>(sql`SELECT data FROM drive_blobs WHERE key = ${key} AND part = ${i}`);
    if (!r) throw notFound("File");
    return fromB64(r.data);
  };
  return {
    async put(key, bytes) {
      await ensureBlobTable(db);
      let n = 0;
      for (let at = 0; at < bytes.length || n === 0; at += DRIVE_CHUNK) {
        await db.run(sql`INSERT OR REPLACE INTO drive_blobs (key, part, data) VALUES (${key}, ${n}, ${toB64(bytes.subarray(at, at + DRIVE_CHUNK))})`);
        n++;
        if (!bytes.length) break;
      }
      return n;
    },
    read(key, parts, size, range) {
      const start = range?.start ?? 0, end = range?.end ?? size - 1;
      let i = Math.floor(start / DRIVE_CHUNK);
      const last = Math.min(parts - 1, Math.floor(Math.max(end, 0) / DRIVE_CHUNK));
      return new ReadableStream<Uint8Array>({
        async pull(ctl) {
          if (size === 0 || i > last) { ctl.close(); return; }
          const bytes = await part(key, i);
          const base = i * DRIVE_CHUNK;
          ctl.enqueue(bytes.subarray(Math.max(0, start - base), Math.min(bytes.length, end - base + 1)));
          i++;
        },
      });
    },
    async readAll(key, parts, size) {
      const out = new Uint8Array(size);
      for (let i = 0; i < parts; i++) { if (size) out.set(await part(key, i), i * DRIVE_CHUNK); }
      return out;
    },
    async delete(key) {
      await ensureBlobTable(db);
      await db.run(sql`DELETE FROM drive_blobs WHERE key = ${key}`);
    },
  };
}

function storeBlobs(store: NonNullable<Deps["bodyStore"]>): DriveBlobs {
  return {
    async put(key, bytes, type) { await store.put(key, bytes, type); return 1; },
    read(key, _parts, size, range) {
      return new ReadableStream<Uint8Array>({
        async start(ctl) {
          const b = await store.get(key);
          if (!b) { ctl.error(notFound("File")); return; }
          ctl.enqueue(range ? b.subarray(range.start, range.end + 1) : b.subarray(0, size));
          ctl.close();
        },
      });
    },
    async readAll(key) { const b = await store.get(key); if (!b) throw notFound("File"); return b; },
    async delete(key) { await store.delete(key); },
  };
}

export function blobsFor(deps: Pick<Deps, "bodyStore" | "filesDb" | "db">): DriveBlobs {
  return deps.bodyStore ? storeBlobs(deps.bodyStore) : dbBlobs(deps.filesDb ?? deps.db);
}

// ------------------------------------------------------------------ access

/** The item's folders from its parent up to the root (nearest first), one recursive query. */
async function ancestors(db: DB, orgId: string, parentId: string | null): Promise<Row[]> {
  if (!parentId) return [];
  const rows = await db.all<{ id: string; depth: number }>(sql`WITH RECURSIVE anc(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM drive_items WHERE id = ${parentId} AND org_id = ${orgId}
      UNION ALL SELECT d.id, d.parent_id, anc.depth + 1 FROM drive_items d JOIN anc ON d.id = anc.parent_id WHERE d.org_id = ${orgId} AND anc.depth < ${L.depth}
    ) SELECT id, depth FROM anc`);
  if (!rows.length) return [];
  const full = await db.select().from(driveItems).where(inIds(driveItems.id, rows.map((r) => r.id))).all();
  const depth = new Map(rows.map((r) => [r.id, Number(r.depth)]));
  return full.sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0));
}

interface Access { view: boolean; edit: boolean; del: boolean; share: boolean; role: DriveRole | "owner" | "member" | null }
const NONE: Access = { view: false, edit: false, del: false, share: false, role: null };

async function sharesFor(db: DB, orgId: string, userId: string, ids: string[]) {
  if (!ids.length) return new Map<string, DriveRole>();
  const rows = await db.select({ itemId: driveShares.itemId, role: driveShares.role }).from(driveShares)
    .where(and(eq(driveShares.orgId, orgId), eq(driveShares.userId, userId), inArray(driveShares.itemId, ids.slice(0, 90)))).all();
  return new Map(rows.map((r) => [r.itemId, r.role as DriveRole]));
}

/** What the actor may do with an item, given its folders (nearest first). */
async function accessOf(db: DB, a: Actor, item: Row, chain: Row[]): Promise<Access> {
  if (item.space === "brand") return { view: true, edit: isAdmin(a), del: isAdmin(a), share: false, role: isAdmin(a) ? "owner" : "view" };
  if (item.space === "team") return { view: true, edit: true, del: isAdmin(a) || item.createdBy === a.userId, share: false, role: "member" };
  if (item.ownerId === a.userId) return { view: true, edit: true, del: true, share: true, role: "owner" };
  const shares = await sharesFor(db, a.orgId, a.userId, [item.id, ...chain.map((c) => c.id)]);
  let role: DriveRole | null = null;
  for (const id of [item.id, ...chain.map((c) => c.id)]) { const r = shares.get(id); if (r === "edit") { role = "edit"; break; } if (r) role = "view"; }
  if (!role) return NONE;
  return { view: true, edit: role === "edit", del: false, share: false, role };
}

async function loadItem(db: DB, a: Actor, id: string, opts: { trashed?: boolean } = {}) {
  const item = await db.select().from(driveItems).where(and(eq(driveItems.orgId, a.orgId), eq(driveItems.id, id))).get();
  if (!item || (!opts.trashed && item.trashedAt)) throw notFound("File");
  const chain = await ancestors(db, a.orgId, item.parentId);
  const acc = await accessOf(db, a, item, chain);
  if (!acc.view) throw notFound("File");
  return { item, chain, acc };
}

// ------------------------------------------------------------------ shape

async function names(db: DB, ids: string[]) {
  const uniq = [...new Set(ids)].slice(0, 90);
  if (!uniq.length) return new Map<string, string>();
  const rows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inIds(users.id, uniq)).all();
  return new Map(rows.map((r) => [r.id, r.name || r.email || "Someone"]));
}

async function shape(db: DB, a: Actor, rows: Row[], accessFor: (r: Row) => Access | Promise<Access>, location?: (r: Row) => string | undefined): Promise<DriveItem[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id).slice(0, 90);
  const [stars, shared] = await Promise.all([
    db.select({ itemId: driveStars.itemId }).from(driveStars).where(and(eq(driveStars.userId, a.userId), inIds(driveStars.itemId, ids))).all(),
    db.select({ itemId: driveShares.itemId }).from(driveShares).where(and(eq(driveShares.orgId, a.orgId), inIds(driveShares.itemId, ids))).all(),
  ]);
  const st = new Set(stars.map((s) => s.itemId)), sh = new Set(shared.map((s) => s.itemId));
  const out: DriveItem[] = [];
  for (const r of rows) {
    const acc = await accessFor(r);
    out.push({
      id: r.id, kind: r.kind, space: r.space, parentId: r.parentId, name: r.name, contentType: r.contentType, sizeBytes: Number(r.sizeBytes), versions: Number(r.versions),
      tags: r.tags ? r.tags.split(",").filter(Boolean) : [], note: r.note, createdBy: { id: r.createdBy, name: r.createdByName || "Someone" }, ownerId: r.ownerId,
      updatedAt: new Date(Number(r.updatedAt)).toISOString(), createdAt: new Date(Number(r.createdAt)).toISOString(), starred: st.has(r.id), shared: sh.has(r.id),
      trashedAt: r.trashedAt ? new Date(Number(r.trashedAt)).toISOString() : null, canEdit: acc.edit, canDelete: acc.del, ...(location ? { location: location(r) } : {}),
    });
  }
  return out;
}

const order = [asc(sql`CASE WHEN ${driveItems.kind} = 'folder' THEN 0 ELSE 1 END`), asc(sql`lower(${driveItems.name})`), asc(driveItems.id)];

// ------------------------------------------------------------------ lists

export async function listDrive(deps: Deps, a: Actor, view: DriveView, opts: { folderId?: string | null; q?: string; tag?: string; cursor?: number } = {}): Promise<DriveList> {
  const db = deps.db;
  const q = (opts.q ?? "").trim().toLowerCase().slice(0, 100);
  const offset = Math.max(0, Math.min(opts.cursor ?? 0, 5000));
  const live = isNull(driveItems.trashedAt);
  const nameLike = q ? containsText(driveItems.name, q) : undefined; // LK1: no 50 byte LIKE limit
  const page = <T>(rows: T[]) => ({ rows: rows.slice(0, L.page), next: rows.length > L.page ? String(offset + L.page) : null });

  if (view === "team" || view === "mine" || view === "brand") {
    const space: DriveSpace = view === "team" ? "team" : view === "mine" ? "private" : "brand";
    let folder: DriveList["folder"] = null, path: DriveCrumb[] = [{ id: null, name: VIEW_LABEL[view] }], canAdd = space !== "brand" || isAdmin(a);
    const spaceOwner: string | null = space === "private" ? a.userId : null;
    let listView: DriveView = view;
    if (opts.folderId) {
      const { item, chain, acc } = await loadItem(db, a, opts.folderId);
      if (item.kind !== "folder") throw notFound("Folder");
      // A folder someone shared with you opens under "Shared with me".
      if (item.space !== space) listView = item.space === "private" ? (item.ownerId === a.userId ? "mine" : "shared") : item.space === "team" ? "team" : "brand";
      folder = { id: item.id, name: item.name, canEdit: acc.edit };
      canAdd = acc.edit;
      const visible = [...chain].reverse();
      if (listView === "shared") {
        // Only the part of the path the person can open.
        const sh = await sharesFor(db, a.orgId, a.userId, [item.id, ...chain.map((c) => c.id)]);
        const firstShared = visible.findIndex((c) => sh.has(c.id));
        path = [{ id: null, name: VIEW_LABEL.shared }, ...(firstShared >= 0 ? visible.slice(firstShared) : []).map((c) => ({ id: c.id, name: c.name })), { id: item.id, name: item.name }];
      } else path = [{ id: null, name: VIEW_LABEL[listView] }, ...visible.map((c) => ({ id: c.id, name: c.name })), { id: item.id, name: item.name }];
      const rows = await db.select().from(driveItems).where(and(eq(driveItems.orgId, a.orgId), eq(driveItems.parentId, item.id), live, nameLike)).orderBy(...order).limit(L.page + 1).offset(offset).all();
      const pg = page(rows);
      return { view: listView, folder, path, canAdd, items: await shape(db, a, pg.rows, () => acc), next: pg.next };
    }
    const where = and(eq(driveItems.orgId, a.orgId), eq(driveItems.space, space), live, spaceOwner ? eq(driveItems.ownerId, spaceOwner) : undefined,
      q ? undefined : isNull(driveItems.parentId), nameLike);
    const rows = await db.select().from(driveItems).where(where).orderBy(...order).limit(L.page + 1).offset(offset).all();
    const pg = page(rows);
    // A search across the whole space shows each hit's folder.
    const parentNames = q ? await folderNames(db, a.orgId, pg.rows.map((r) => r.parentId)) : new Map<string, string>();
    const access = (r: Row) => accessOf(db, a, r, []);
    return { view, folder, path, canAdd, items: await shape(db, a, pg.rows, access, q ? (r) => (r.parentId ? parentNames.get(r.parentId) : VIEW_LABEL[view]) : undefined), next: pg.next };
  }

  if (view === "shared") {
    const sh = await db.select({ itemId: driveShares.itemId }).from(driveShares).where(and(eq(driveShares.orgId, a.orgId), eq(driveShares.userId, a.userId))).limit(500).all();
    const ids = sh.map((s) => s.itemId).slice(0, 90);
    const rows = ids.length ? await db.select().from(driveItems).where(and(eq(driveItems.orgId, a.orgId), inIds(driveItems.id, ids), live, nameLike)).orderBy(...order).all() : [];
    const owners = await names(db, rows.map((r) => r.ownerId ?? ""));
    return { view, folder: null, path: [{ id: null, name: VIEW_LABEL.shared }], canAdd: false,
      items: await shape(db, a, rows, (r) => accessOf(db, a, r, []), (r) => `From ${owners.get(r.ownerId ?? "") ?? "a teammate"}`), next: null };
  }

  if (view === "starred" || view === "recent") {
    const rows = view === "starred"
      ? (await db.select({ i: driveItems }).from(driveStars).innerJoin(driveItems, eq(driveItems.id, driveStars.itemId))
          .where(and(eq(driveStars.userId, a.userId), eq(driveStars.orgId, a.orgId), live, nameLike)).orderBy(desc(driveStars.createdAt)).limit(L.page).all()).map((x) => x.i)
      : await db.select().from(driveItems).where(and(eq(driveItems.orgId, a.orgId), eq(driveItems.kind, "file"), live, nameLike,
          or(inArray(driveItems.space, ["team", "brand"]), eq(driveItems.ownerId, a.userId)))).orderBy(desc(driveItems.updatedAt)).limit(50).all();
    const visible: { r: Row; acc: Access }[] = [];
    for (const r of rows) {
      const acc = await accessOf(db, a, r, r.space === "private" && r.ownerId !== a.userId ? await ancestors(db, a.orgId, r.parentId) : []);
      if (acc.view) visible.push({ r, acc });
    }
    const parentNames = await folderNames(db, a.orgId, visible.map((v) => v.r.parentId));
    const accMap = new Map(visible.map((v) => [v.r.id, v.acc]));
    return { view, folder: null, path: [{ id: null, name: VIEW_LABEL[view] }], canAdd: false,
      items: await shape(db, a, visible.map((v) => v.r), (r) => accMap.get(r.id) ?? NONE, (r) => (r.parentId ? parentNames.get(r.parentId) : VIEW_LABEL[r.space === "private" ? "mine" : r.space === "team" ? "team" : "brand"])), next: null };
  }

  // Trash: what each person can bring back. Team trash for everyone, your own My files, brand for admins.
  await purgeExpired(deps, a.orgId);
  const rows = await db.select().from(driveItems).where(and(eq(driveItems.orgId, a.orgId), isNotNull(driveItems.trashedAt), sql`${driveItems.trashRootId} = ${driveItems.id}`, nameLike,
    or(eq(driveItems.space, "team"), and(eq(driveItems.space, "private"), eq(driveItems.ownerId, a.userId)), isAdmin(a) ? eq(driveItems.space, "brand") : undefined)))
    .orderBy(desc(driveItems.trashedAt)).limit(L.page + 1).offset(offset).all();
  const pg = page(rows);
  const parentNames = await folderNames(db, a.orgId, pg.rows.map((r) => r.parentId));
  return { view, folder: null, path: [{ id: null, name: VIEW_LABEL.trash }], canAdd: false,
    items: await shape(db, a, pg.rows, (r) => accessOf(db, a, r, []), (r) => (r.parentId ? parentNames.get(r.parentId) ?? VIEW_LABEL[r.space === "private" ? "mine" : r.space === "team" ? "team" : "brand"] : VIEW_LABEL[r.space === "private" ? "mine" : r.space === "team" ? "team" : "brand"])), next: pg.next };
}

async function folderNames(db: DB, orgId: string, ids: (string | null)[]) {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))].slice(0, 90);
  if (!uniq.length) return new Map<string, string>();
  const rows = await db.select({ id: driveItems.id, name: driveItems.name }).from(driveItems).where(and(eq(driveItems.orgId, orgId), inIds(driveItems.id, uniq))).all();
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ------------------------------------------------------------------ create

/** Where new things go: a folder the actor can edit, or a space root. */
async function target(db: DB, a: Actor, space: DriveSpace, parentId: string | null | undefined) {
  if (parentId) {
    const { item, acc } = await loadItem(db, a, parentId);
    if (item.kind !== "folder") throw notFound("Folder");
    if (!acc.edit) throw new HttpError(403, "forbidden", item.space === "brand" ? "Only admins can change the brand library." : "You can only view this folder.");
    return { space: item.space, ownerId: item.ownerId, parentId: item.id };
  }
  if (space === "brand" && !isAdmin(a)) throw new HttpError(403, "forbidden", "Only admins can change the brand library.");
  return { space, ownerId: space === "private" ? a.userId : null, parentId: null };
}

async function siblingNames(db: DB, orgId: string, t: { space: DriveSpace; ownerId: string | null; parentId: string | null }, exceptId?: string) {
  const rows = await db.select({ id: driveItems.id, name: driveItems.name }).from(driveItems).where(and(eq(driveItems.orgId, orgId), eq(driveItems.space, t.space), isNull(driveItems.trashedAt),
    t.parentId ? eq(driveItems.parentId, t.parentId) : isNull(driveItems.parentId), !t.parentId && t.ownerId ? eq(driveItems.ownerId, t.ownerId) : undefined)).limit(5000).all();
  return new Set(rows.filter((r) => r.id !== exceptId).map((r) => r.name));
}

async function actorName(db: DB, a: Actor) {
  if (a.name) return a.name;
  const u = await db.select({ name: users.name }).from(users).where(eq(users.id, a.userId)).get();
  return u?.name || a.email || "Someone";
}

export async function createFolder(deps: Deps, a: Actor, body: { space: DriveSpace; parentId?: string | null; name: string }) {
  const db = deps.db;
  const name = cleanName(body.name);
  if (!name) throw new HttpError(422, "validation_failed", "Give the folder a name.");
  const t = await target(db, a, body.space, body.parentId);
  if (t.parentId) await assertDepth(db, a.orgId, t.parentId);
  const now = deps.now().getTime();
  const id = newId("drv");
  const final = uniqueName(name, await siblingNames(db, a.orgId, t));
  await db.insert(driveItems).values({ id, orgId: a.orgId, space: t.space, ownerId: t.ownerId, parentId: t.parentId, kind: "folder", name: final, createdBy: a.userId, createdByName: await actorName(db, a), createdAt: now, updatedAt: now });
  return (await getDetail(deps, a, id)).item;
}

async function assertDepth(db: DB, orgId: string, parentId: string) {
  if ((await ancestors(db, orgId, parentId)).length >= L.depth - 1) throw new HttpError(422, "validation_failed", "Folders can go 24 levels deep.");
}

export async function usage(deps: Deps, orgId: string): Promise<DriveUsage> {
  const r = await deps.db.get<{ used: number | null }>(sql`SELECT SUM(s) AS used FROM (SELECT MAX(size_bytes) AS s FROM drive_versions WHERE org_id = ${orgId} GROUP BY blob_key)`);
  return { usedBytes: Number(r?.used ?? 0), quotaBytes: L.workspaceBytes, fileBytes: L.fileBytes };
}

function checkSize(n: number) {
  if (n > L.fileBytes) throw new HttpError(413, "file_too_large", `Files can be up to ${Math.round(L.fileBytes / (1024 * 1024))} MB here.`);
}
async function checkQuota(deps: Deps, orgId: string, add: number) {
  const u = await usage(deps, orgId);
  if (u.usedBytes + add > u.quotaBytes) throw new HttpError(413, "quota_full", "Your workspace files are full. Empty the trash or delete old versions to make room.");
}

const typeOf = (t: string | undefined | null) => (t && /^[\w.+-]+\/[\w.+-]+$/.test(t) ? t.slice(0, 100).toLowerCase() : "application/octet-stream");

async function writeVersion(deps: Deps, a: Actor, itemId: string, number: number, name: string, contentType: string, bytes: Uint8Array, note: string | null) {
  const vid = newId("drvv");
  const key = `drive/${a.orgId}/${vid}`;
  const parts = await blobsFor(deps).put(key, bytes, contentType);
  await deps.db.insert(driveVersions).values({ id: vid, orgId: a.orgId, itemId, number, name, contentType, sizeBytes: bytes.length, blobKey: key, parts, note, createdBy: a.userId, createdByName: await actorName(deps.db, a), createdAt: deps.now().getTime() });
  return vid;
}

export async function uploadFile(deps: Deps, a: Actor, body: { space: DriveSpace; parentId?: string | null; name: string; contentType?: string | null; bytes: Uint8Array }) {
  const db = deps.db;
  const name = cleanName(body.name);
  if (!name) throw new HttpError(422, "validation_failed", "The file needs a name.");
  checkSize(body.bytes.length);
  const t = await target(db, a, body.space, body.parentId);
  await checkQuota(deps, a.orgId, body.bytes.length);
  const now = deps.now().getTime();
  const id = newId("drv");
  const final = uniqueName(name, await siblingNames(db, a.orgId, t));
  const contentType = typeOf(body.contentType);
  const vid = await writeVersion(deps, a, id, 1, final, contentType, body.bytes, null);
  await db.insert(driveItems).values({ id, orgId: a.orgId, space: t.space, ownerId: t.ownerId, parentId: t.parentId, kind: "file", name: final, contentType, sizeBytes: body.bytes.length,
    versionId: vid, versions: 1, createdBy: a.userId, createdByName: await actorName(db, a), updatedBy: a.userId, createdAt: now, updatedAt: now });
  if (t.space === "brand") await audit(db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "files.brand_added", metadata: { itemId: id, name: final } });
  return (await getDetail(deps, a, id)).item;
}

export async function addVersion(deps: Deps, a: Actor, id: string, body: { contentType?: string | null; bytes: Uint8Array; name?: string }) {
  const db = deps.db;
  const { item, acc } = await loadItem(db, a, id);
  if (item.kind !== "file") throw notFound("File");
  if (!acc.edit) throw new HttpError(403, "forbidden", "You can only view this file.");
  checkSize(body.bytes.length);
  await checkQuota(deps, a.orgId, body.bytes.length);
  const contentType = typeOf(body.contentType ?? item.contentType);
  const number = Number(item.versions) + 1;
  const vid = await writeVersion(deps, a, item.id, number, item.name, contentType, body.bytes, null);
  await db.update(driveItems).set({ versionId: vid, versions: number, sizeBytes: body.bytes.length, contentType, updatedBy: a.userId, updatedAt: deps.now().getTime() }).where(eq(driveItems.id, item.id));
  await pruneVersions(deps, a.orgId, item.id);
  return getDetail(deps, a, id);
}

export async function restoreVersion(deps: Deps, a: Actor, id: string, versionId: string) {
  const db = deps.db;
  const { item, acc } = await loadItem(db, a, id);
  if (!acc.edit) throw new HttpError(403, "forbidden", "You can only view this file.");
  const v = await db.select().from(driveVersions).where(and(eq(driveVersions.itemId, item.id), eq(driveVersions.id, versionId))).get();
  if (!v) throw notFound("Version");
  if (v.id === item.versionId) return getDetail(deps, a, id);
  const number = Number(item.versions) + 1;
  const vid = newId("drvv");
  await db.insert(driveVersions).values({ id: vid, orgId: a.orgId, itemId: item.id, number, name: v.name, contentType: v.contentType, sizeBytes: v.sizeBytes, blobKey: v.blobKey, parts: v.parts,
    note: `Restored from version ${v.number}`, createdBy: a.userId, createdByName: await actorName(db, a), createdAt: deps.now().getTime() });
  await db.update(driveItems).set({ versionId: vid, versions: number, sizeBytes: v.sizeBytes, contentType: v.contentType, updatedBy: a.userId, updatedAt: deps.now().getTime() }).where(eq(driveItems.id, item.id));
  await pruneVersions(deps, a.orgId, item.id);
  return getDetail(deps, a, id);
}

/** Keeps the newest versions; bytes go only when no version still points at them. */
async function pruneVersions(deps: Deps, orgId: string, itemId: string) {
  const all = await deps.db.select().from(driveVersions).where(eq(driveVersions.itemId, itemId)).orderBy(desc(driveVersions.number)).all();
  const old = all.slice(L.versions);
  if (!old.length) return;
  await deps.db.delete(driveVersions).where(inIds(driveVersions.id, old.map((v) => v.id)));
  await dropUnusedBlobs(deps, orgId, old);
}

async function dropUnusedBlobs(deps: Deps, orgId: string, gone: { blobKey: string; parts: number }[]) {
  const keys = [...new Map(gone.map((g) => [g.blobKey, g])).values()];
  for (let i = 0; i < keys.length; i += 80) {
    const slice = keys.slice(i, i + 80);
    const still = new Set((await deps.db.select({ k: driveVersions.blobKey }).from(driveVersions).where(and(eq(driveVersions.orgId, orgId), inIds(driveVersions.blobKey, slice.map((s) => s.blobKey)))).all()).map((r) => r.k));
    for (const s of slice) if (!still.has(s.blobKey)) await blobsFor(deps).delete(s.blobKey, s.parts);
  }
}

// ------------------------------------------------------------------ detail and edits

export async function getDetail(deps: Deps, a: Actor, id: string, opts: { trashed?: boolean } = {}): Promise<DriveDetail> {
  const db = deps.db;
  const { item, acc } = await loadItem(db, a, id, opts);
  const [shaped] = await shape(db, a, [item], () => acc);
  const versions: DriveVersion[] = item.kind === "file"
    ? (await db.select().from(driveVersions).where(eq(driveVersions.itemId, item.id)).orderBy(desc(driveVersions.number)).limit(L.versions).all()).map((v) => ({
        id: v.id, number: Number(v.number), sizeBytes: Number(v.sizeBytes), contentType: v.contentType, name: v.name, createdBy: v.createdByName || "Someone",
        createdAt: new Date(Number(v.createdAt)).toISOString(), note: v.note, current: v.id === item.versionId }))
    : [];
  let shares: DriveShare[] = [];
  if (item.space === "private" && (acc.share || acc.edit)) {
    const rows = await db.select({ userId: driveShares.userId, role: driveShares.role, name: users.name, email: users.email }).from(driveShares).innerJoin(users, eq(users.id, driveShares.userId))
      .where(and(eq(driveShares.orgId, a.orgId), eq(driveShares.itemId, item.id))).limit(100).all();
    shares = rows.map((r) => ({ userId: r.userId, name: r.name || r.email || "Someone", email: r.email, role: r.role as DriveRole }));
  }
  return { item: shaped, versions, shares, canShare: acc.share };
}

export async function updateItem(deps: Deps, a: Actor, id: string, body: { name?: string; tags?: string[]; note?: string | null }) {
  const db = deps.db;
  const { item, acc } = await loadItem(db, a, id);
  if (!acc.edit) throw new HttpError(403, "forbidden", item.space === "brand" ? "Only admins can change the brand library." : "You can only view this.");
  const set: Partial<Row> = { updatedAt: deps.now().getTime(), updatedBy: a.userId };
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) throw new HttpError(422, "validation_failed", "Give it a name.");
    set.name = uniqueName(name, await siblingNames(db, a.orgId, { space: item.space, ownerId: item.ownerId, parentId: item.parentId }, item.id));
  }
  if (body.tags !== undefined) set.tags = cleanTags(body.tags).join(",");
  if (body.note !== undefined) set.note = body.note ? String(body.note).trim().slice(0, L.note) || null : null;
  await db.update(driveItems).set(set).where(eq(driveItems.id, item.id));
  return (await getDetail(deps, a, id)).item;
}

/** Every item under the given folders (not the folders themselves), bounded. */
async function descendants(db: DB, orgId: string, ids: string[], opts: { includeTrashed?: boolean } = {}): Promise<Row[]> {
  let frontier = ids.slice();
  const out: Row[] = [];
  for (let depth = 0; frontier.length && depth < L.depth; depth++) {
    const next: Row[] = [];
    for (let i = 0; i < frontier.length; i += 80) {
      next.push(...await db.select().from(driveItems).where(and(eq(driveItems.orgId, orgId), inArray(driveItems.parentId, frontier.slice(i, i + 80)), opts.includeTrashed ? undefined : isNull(driveItems.trashedAt))).all());
    }
    out.push(...next);
    if (out.length > L.subtree) throw new HttpError(422, "too_many", `That is more than ${L.subtree} items at once. Move or delete a smaller folder.`);
    frontier = next.filter((r) => r.kind === "folder").map((r) => r.id);
  }
  return out;
}

const bulkIds = (ids: string[]) => {
  const u = [...new Set(ids)].filter((x) => typeof x === "string" && x.length < 80);
  if (!u.length) throw new HttpError(422, "validation_failed", "Choose at least one item.");
  if (u.length > L.bulk) throw new HttpError(422, "validation_failed", `Choose up to ${L.bulk} items at once.`);
  return u;
};

export async function moveItems(deps: Deps, a: Actor, body: { ids: string[]; parentId: string | null; space?: DriveSpace }) {
  const db = deps.db;
  const ids = bulkIds(body.ids);
  const t = await target(db, a, body.space ?? "team", body.parentId);
  const destChain = t.parentId ? new Set([t.parentId, ...(await ancestors(db, a.orgId, t.parentId)).map((c) => c.id)]) : new Set<string>();
  const taken = await siblingNames(db, a.orgId, t);
  const now = deps.now().getTime();
  let moved = 0;
  for (const id of ids) {
    const { item, acc } = await loadItem(db, a, id);
    if (!acc.edit) throw new HttpError(403, "forbidden", `You can only view ${item.name}.`);
    if (destChain.has(item.id)) throw new HttpError(422, "validation_failed", `A folder can't go inside itself.`);
    if ((item.space === "brand") !== (t.space === "brand") && !isAdmin(a)) throw new HttpError(403, "forbidden", "Only admins can change the brand library.");
    if (item.space === "private" && t.space !== "private" && !acc.share) throw new HttpError(403, "forbidden", `Only the owner can move ${item.name} out of My files.`);
    if (item.parentId === t.parentId && item.space === t.space && item.ownerId === t.ownerId) continue;
    const name = uniqueName(item.name, taken);
    taken.add(name);
    await db.update(driveItems).set({ parentId: t.parentId, space: t.space, ownerId: t.ownerId, name, updatedAt: now, updatedBy: a.userId }).where(eq(driveItems.id, item.id));
    if (item.kind === "folder" && (item.space !== t.space || item.ownerId !== t.ownerId)) {
      const sub = await descendants(db, a.orgId, [item.id], { includeTrashed: true });
      for (let i = 0; i < sub.length; i += 80) await db.update(driveItems).set({ space: t.space, ownerId: t.ownerId }).where(inArray(driveItems.id, sub.slice(i, i + 80).map((s) => s.id)));
    }
    // Leaving My files drops its shares; they no longer mean anything in a team space.
    if (item.space === "private" && t.space !== "private") await db.delete(driveShares).where(and(eq(driveShares.orgId, a.orgId), eq(driveShares.itemId, item.id)));
    moved++;
  }
  return { moved };
}

export async function trashItems(deps: Deps, a: Actor, idsIn: string[]) {
  const db = deps.db;
  const ids = bulkIds(idsIn);
  const now = deps.now().getTime();
  let n = 0;
  for (const id of ids) {
    const { item, acc } = await loadItem(db, a, id);
    if (!acc.edit) throw new HttpError(403, "forbidden", `You can only view ${item.name}.`);
    if (item.space === "private" && !acc.share) throw new HttpError(403, "forbidden", `Only the owner can move ${item.name} to the trash.`);
    const sub = item.kind === "folder" ? await descendants(db, a.orgId, [item.id]) : [];
    await db.update(driveItems).set({ trashedAt: now, trashedBy: a.userId, trashRootId: item.id }).where(eq(driveItems.id, item.id));
    for (let i = 0; i < sub.length; i += 80) await db.update(driveItems).set({ trashedAt: now, trashedBy: a.userId, trashRootId: item.id }).where(inArray(driveItems.id, sub.slice(i, i + 80).map((s) => s.id)));
    n++;
    if (item.space === "brand") await audit(db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "files.brand_trashed", metadata: { itemId: item.id, name: item.name } });
  }
  return { trashed: n };
}

async function loadTrashRoot(db: DB, a: Actor, id: string) {
  const item = await db.select().from(driveItems).where(and(eq(driveItems.orgId, a.orgId), eq(driveItems.id, id))).get();
  if (!item || !item.trashedAt || item.trashRootId !== item.id) throw notFound("File");
  const acc = await accessOf(db, a, item, []);
  const allowed = item.space === "team" || (item.space === "private" && item.ownerId === a.userId) || (item.space === "brand" && isAdmin(a));
  if (!allowed) throw notFound("File");
  return { item, acc };
}

export async function restoreItems(deps: Deps, a: Actor, idsIn: string[]) {
  const db = deps.db;
  const ids = bulkIds(idsIn);
  let n = 0;
  for (const id of ids) {
    const { item } = await loadTrashRoot(db, a, id);
    // Back where it was, or the top of its space when that folder is gone or in the trash.
    let parentId = item.parentId;
    if (parentId) {
      const p = await db.select({ id: driveItems.id, trashedAt: driveItems.trashedAt, space: driveItems.space, ownerId: driveItems.ownerId }).from(driveItems).where(and(eq(driveItems.orgId, a.orgId), eq(driveItems.id, parentId))).get();
      if (!p || p.trashedAt || p.space !== item.space || p.ownerId !== item.ownerId) parentId = null;
    }
    const name = uniqueName(item.name, await siblingNames(db, a.orgId, { space: item.space, ownerId: item.ownerId, parentId }, item.id));
    await db.update(driveItems).set({ trashedAt: null, trashedBy: null, trashRootId: null }).where(and(eq(driveItems.orgId, a.orgId), eq(driveItems.trashRootId, item.id)));
    await db.update(driveItems).set({ parentId, name, updatedAt: deps.now().getTime(), updatedBy: a.userId }).where(eq(driveItems.id, item.id));
    n++;
  }
  return { restored: n };
}

/** Delete forever, from the trash only: the uploader or owner, or an admin (brand: admins). */
export async function deleteForever(deps: Deps, a: Actor, idsIn: string[]) {
  const db = deps.db;
  const ids = bulkIds(idsIn);
  let n = 0;
  for (const id of ids) {
    const { item } = await loadTrashRoot(db, a, id);
    const may = item.space === "private" ? item.ownerId === a.userId : isAdmin(a) || (item.space === "team" && item.createdBy === a.userId);
    if (!may) throw new HttpError(403, "forbidden", `Only ${item.space === "team" ? "the person who added it or an admin" : "an admin"} can delete ${item.name} forever.`);
    await purge(deps, a.orgId, item.id);
    await audit(db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "files.deleted_forever", metadata: { itemId: item.id, name: item.name, space: item.space } });
    n++;
  }
  return { deleted: n };
}

async function purge(deps: Deps, orgId: string, rootId: string) {
  const db = deps.db;
  const rows = await db.select({ id: driveItems.id }).from(driveItems).where(and(eq(driveItems.orgId, orgId), eq(driveItems.trashRootId, rootId))).limit(L.subtree + 1).all();
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80);
    const vs = await db.select({ id: driveVersions.id, blobKey: driveVersions.blobKey, parts: driveVersions.parts }).from(driveVersions).where(inIds(driveVersions.itemId, slice)).all();
    if (vs.length) await db.delete(driveVersions).where(inIds(driveVersions.itemId, slice));
    await dropUnusedBlobs(deps, orgId, vs);
    await db.delete(driveStars).where(inIds(driveStars.itemId, slice));
    await db.delete(driveShares).where(inIds(driveShares.itemId, slice));
    await db.delete(driveItems).where(inIds(driveItems.id, slice));
  }
}

/** Trash older than 30 days goes, a few at a time, when someone opens the trash. */
export async function purgeExpired(deps: Deps, orgId: string, limit = 10) {
  const cutoff = deps.now().getTime() - L.trashDays * DAY;
  const rows = await deps.db.select({ id: driveItems.id }).from(driveItems).where(and(eq(driveItems.orgId, orgId), lt(driveItems.trashedAt, cutoff), sql`${driveItems.trashRootId} = ${driveItems.id}`)).limit(limit).all();
  for (const r of rows) await purge(deps, orgId, r.id);
  return rows.length;
}

export async function starItems(deps: Deps, a: Actor, idsIn: string[], on: boolean) {
  const db = deps.db;
  const ids = bulkIds(idsIn);
  for (const id of ids) {
    await loadItem(db, a, id);
    if (on) await db.insert(driveStars).values({ userId: a.userId, itemId: id, orgId: a.orgId, createdAt: deps.now().getTime() }).onConflictDoNothing();
    else await db.delete(driveStars).where(and(eq(driveStars.userId, a.userId), eq(driveStars.itemId, id)));
  }
  return { ok: true };
}

/** Replaces who an item in My files is shared with. Only the owner shares; only members of this workspace. */
export async function setShares(deps: Deps, a: Actor, id: string, list: { userId: string; role: DriveRole }[], members: Set<string>) {
  const db = deps.db;
  const { item, acc } = await loadItem(db, a, id);
  if (item.space !== "private") throw new HttpError(422, "validation_failed", "Everyone in the workspace can already open this.");
  if (!acc.share) throw new HttpError(403, "forbidden", "Only the owner can share this.");
  const clean = new Map<string, DriveRole>();
  for (const s of list.slice(0, 100)) {
    if (s.userId === a.userId) continue;
    if (!members.has(s.userId)) throw new HttpError(422, "validation_failed", "You can only share with people in this workspace.");
    clean.set(s.userId, s.role === "edit" ? "edit" : "view");
  }
  const before = await db.select({ userId: driveShares.userId, role: driveShares.role }).from(driveShares).where(and(eq(driveShares.orgId, a.orgId), eq(driveShares.itemId, item.id))).all();
  await db.delete(driveShares).where(and(eq(driveShares.orgId, a.orgId), eq(driveShares.itemId, item.id)));
  const now = deps.now().getTime();
  for (const [userId, role] of clean) await db.insert(driveShares).values({ itemId: item.id, userId, orgId: a.orgId, role, createdBy: a.userId, createdAt: now });
  const added = [...clean.keys()].filter((u) => !before.some((b) => b.userId === u));
  const removed = before.filter((b) => !clean.has(b.userId)).map((b) => b.userId);
  if (added.length || removed.length) await audit(db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "files.shared", metadata: { itemId: item.id, added: added.length, removed: removed.length } });
  return getDetail(deps, a, id);
}

/** The file bytes, after the same access check (a trashed file opens for whoever can restore it). */
export async function openContent(deps: Deps, a: Actor, id: string, versionId?: string) {
  const db = deps.db;
  const item0 = await db.select({ trashedAt: driveItems.trashedAt, trashRootId: driveItems.trashRootId }).from(driveItems).where(and(eq(driveItems.orgId, a.orgId), eq(driveItems.id, id))).get();
  const { item } = item0?.trashedAt && item0.trashRootId === id ? await loadTrashRoot(db, a, id) : await loadItem(db, a, id);
  if (item.kind !== "file") throw notFound("File");
  const v = await db.select().from(driveVersions).where(and(eq(driveVersions.itemId, item.id), eq(driveVersions.id, versionId || item.versionId || ""))).get();
  if (!v) throw notFound("File");
  return { name: versionId && v.id !== item.versionId ? versionLabel(item.name, v.number) : item.name, contentType: v.contentType, size: Number(v.sizeBytes), key: v.blobKey, parts: Number(v.parts) };
}
const versionLabel = (name: string, n: number) => { const d = name.lastIndexOf("."); return d > 0 ? `${name.slice(0, d)} (version ${n})${name.slice(d)}` : `${name} (version ${n})`; };

/** The files under a selection with their paths, for a zip made in the browser. Only what the actor can open. */
export async function manifest(deps: Deps, a: Actor, idsIn: string[]): Promise<DriveManifest> {
  const db = deps.db;
  const ids = bulkIds(idsIn);
  const files: DriveManifest["files"] = [];
  let total = 0;
  const used = new Set<string>();
  const add = (id: string, path: string, size: number) => {
    let p = path, i = 2;
    while (used.has(p.toLowerCase())) { const d = path.lastIndexOf("."); p = d > path.lastIndexOf("/") + 0 && d > 0 ? `${path.slice(0, d)} (${i})${path.slice(d)}` : `${path} (${i})`; i++; }
    used.add(p.toLowerCase());
    files.push({ id, path: p, sizeBytes: size });
    total += size;
    if (files.length > L.zipFiles || total > L.zipBytes) throw new HttpError(422, "too_big", `A zip can hold up to ${L.zipFiles} files and ${Math.round(L.zipBytes / (1024 * 1024))} MB. Choose fewer.`);
  };
  for (const id of ids) {
    const { item } = await loadItem(db, a, id);
    if (item.kind === "file") { add(item.id, item.name, Number(item.sizeBytes)); continue; }
    const sub = await descendants(db, a.orgId, [item.id]);
    const byId = new Map(sub.map((s) => [s.id, s]));
    const pathOf = (r: Row): string => { const parts = [r.name]; let p = r.parentId; let guard = 0; while (p && p !== item.id && guard++ < L.depth) { const x = byId.get(p); if (!x) break; parts.unshift(x.name); p = x.parentId; } return `${item.name}/${parts.join("/")}`; };
    for (const r of sub) if (r.kind === "file") add(r.id, pathOf(r), Number(r.sizeBytes));
  }
  return { files, totalBytes: total };
}

export async function brandTags(deps: Deps, orgId: string) {
  const rows = await deps.db.select({ tags: driveItems.tags }).from(driveItems).where(and(eq(driveItems.orgId, orgId), eq(driveItems.space, "brand"), isNull(driveItems.trashedAt))).limit(2000).all();
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of (r.tags || "").split(",").filter(Boolean)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 50).map(([tag, count]) => ({ tag, count }));
}
