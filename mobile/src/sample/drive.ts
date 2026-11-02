import { ApiError } from "@/api/errors";
import { VIEW_LABEL, cleanName, cleanTags, tooBigLine, DRIVE_LIMITS, type DriveDetail, type DriveItem, type DriveList, type DriveSpace, type DriveVersion, type DriveView } from "@/lib/drive";

/**
 * M1: the drive in the sample workspace (browser preview, tests, screenshots). Same paths and shapes as the web's
 * /api/drive routes; everything stays in memory on the device. The sample person is an admin ("me").
 */
interface Node extends DriveItem { history: DriveVersion[] }
export interface SampleDrive { items: Node[]; seq: number; now: number }

const ME = { id: "me", name: "Alex Morgan" };
const SAM = { id: "u-sam", name: "Sam Lee" };

function mk(now: number, n: number, p: Partial<DriveItem> & { id: string; name: string; space: DriveSpace }): Node {
  const at = new Date(now - n * 3_600_000).toISOString();
  const kind = p.kind ?? "file";
  const it: DriveItem = {
    kind, parentId: null, contentType: kind === "file" ? "application/octet-stream" : null, sizeBytes: 0, versions: kind === "file" ? 1 : 0, tags: [], note: null,
    createdBy: ME, ownerId: p.space === "private" ? ME.id : null, updatedAt: at, createdAt: at, starred: false, shared: false, trashedAt: null, canEdit: true, canDelete: true, ...p,
  };
  const history: DriveVersion[] = kind === "file" ? [{ id: `${p.id}-v1`, number: 1, sizeBytes: it.sizeBytes, contentType: it.contentType ?? "", name: it.name, createdBy: it.createdBy.name, createdAt: at, note: null, current: true }] : [];
  return { ...it, history };
}

export function sampleDrive(now = Date.now()): SampleDrive {
  const MB = 1024 * 1024;
  const items: Node[] = [
    mk(now, 30, { id: "drv-clients", kind: "folder", name: "Clients", space: "team", starred: true }),
    mk(now, 50, { id: "drv-marketing", kind: "folder", name: "Marketing", space: "team" }),
    mk(now, 2, { id: "drv-price", name: "Price list 2026.pdf", space: "team", contentType: "application/pdf", sizeBytes: 482_000, versions: 3 }),
    mk(now, 5, { id: "drv-photo", name: "Office opening.jpg", space: "team", contentType: "image/jpeg", sizeBytes: 2.4 * MB, starred: true }),
    mk(now, 26, { id: "drv-budget", name: "Budget FY27.xlsx", space: "team", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 96_000, createdBy: SAM, canDelete: false }),
    mk(now, 72, { id: "drv-acme", name: "Acme proposal.docx", space: "team", parentId: "drv-clients", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 210_000 }),
    mk(now, 80, { id: "drv-acme-brief", name: "Brief from Acme.pdf", space: "team", parentId: "drv-clients", contentType: "application/pdf", sizeBytes: 1.1 * MB, createdBy: SAM }),
    mk(now, 8, { id: "drv-notes", name: "Meeting notes.txt", space: "private", contentType: "text/plain", sizeBytes: 3_200 }),
    mk(now, 100, { id: "drv-contract", name: "Lease agreement signed.pdf", space: "private", contentType: "application/pdf", sizeBytes: 3.6 * MB, shared: true }),
    mk(now, 20, { id: "drv-logo", name: "Logo dark.png", space: "brand", contentType: "image/png", sizeBytes: 64_000, tags: ["logo", "dark"] }),
    mk(now, 40, { id: "drv-letterhead", name: "Letterhead.docx", space: "brand", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 120_000, tags: ["template"] }),
    mk(now, 12, { id: "drv-sam-plan", name: "Q4 plan.pptx", space: "private", ownerId: SAM.id, createdBy: SAM, contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sizeBytes: 5.2 * MB, canEdit: false, canDelete: false, shared: true }),
    mk(now, 200, { id: "drv-old", name: "Old flyer.pdf", space: "team", contentType: "application/pdf", sizeBytes: 740_000, trashedAt: new Date(now - 48 * 3_600_000).toISOString() }),
  ];
  const price = items.find((i) => i.id === "drv-price")!;
  price.history = [3, 2, 1].map((n) => ({ id: `drv-price-v${n}`, number: n, sizeBytes: 482_000 - (3 - n) * 10_000, contentType: "application/pdf", name: price.name, createdBy: n === 2 ? SAM.name : ME.name,
    createdAt: new Date(now - (2 + (3 - n) * 30) * 3_600_000).toISOString(), note: n === 3 ? "Updated prices" : null, current: n === 3 }));
  return { items, seq: 1, now };
}

const order = (a: DriveItem, b: DriveItem) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1);
const strip = ({ history: _h, ...it }: Node): DriveItem => { void _h; return { ...it }; };
const spaceOf: Partial<Record<DriveView, DriveSpace>> = { team: "team", mine: "private", brand: "brand" };
const viewOf = (s: DriveSpace): DriveView => (s === "private" ? "mine" : s);

function chain(s: SampleDrive, id: string | null): Node[] {
  const out: Node[] = [];
  let cur = id ? s.items.find((i) => i.id === id) : undefined;
  while (cur) { out.unshift(cur); cur = cur.parentId ? s.items.find((i) => i.id === cur!.parentId) : undefined; }
  return out;
}

function list(s: SampleDrive, view: DriveView, folder: string | null, q: string): DriveList {
  const live = s.items.filter((i) => !i.trashedAt);
  const match = (i: DriveItem) => !q || i.name.toLowerCase().includes(q.toLowerCase());
  const where = (i: DriveItem) => (i.parentId ? s.items.find((p) => p.id === i.parentId)?.name : VIEW_LABEL[viewOf(i.space)]);
  if (folder) {
    const f = s.items.find((i) => i.id === folder && i.kind === "folder" && !i.trashedAt);
    if (!f) throw new ApiError(404, "not_found", "Folder not found.");
    const v = f.space === "private" && f.ownerId !== ME.id ? "shared" : viewOf(f.space);
    return { view: v, folder: { id: f.id, name: f.name, canEdit: f.canEdit }, canAdd: f.canEdit,
      path: [{ id: null, name: VIEW_LABEL[v] }, ...chain(s, f.id).map((c) => ({ id: c.id, name: c.name }))],
      items: live.filter((i) => i.parentId === f.id && match(i)).sort(order).map(strip), next: null };
  }
  const base = { view, folder: null, path: [{ id: null, name: VIEW_LABEL[view] }], next: null };
  const sp = spaceOf[view];
  if (sp) {
    const rows = live.filter((i) => i.space === sp && (sp !== "private" || i.ownerId === ME.id) && (q ? match(i) : !i.parentId)).sort(order);
    return { ...base, canAdd: true, items: rows.map((i) => ({ ...strip(i), ...(q ? { location: where(i) } : {}) })) };
  }
  if (view === "shared") return { ...base, canAdd: false, items: live.filter((i) => i.space === "private" && i.ownerId !== ME.id && match(i)).map((i) => ({ ...strip(i), location: `From ${i.createdBy.name}` })) };
  if (view === "starred") return { ...base, canAdd: false, items: live.filter((i) => i.starred && match(i)).map((i) => ({ ...strip(i), location: where(i) })) };
  if (view === "recent") return { ...base, canAdd: false, items: live.filter((i) => i.kind === "file" && match(i)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((i) => ({ ...strip(i), location: where(i) })) };
  return { ...base, canAdd: false, items: s.items.filter((i) => i.trashedAt && match(i)).map((i) => ({ ...strip(i), location: where(i) })) };
}

function detail(s: SampleDrive, id: string): DriveDetail {
  const it = s.items.find((i) => i.id === id);
  if (!it) throw new ApiError(404, "not_found", "File not found.");
  return { item: strip(it), versions: it.history.slice(), shares: it.shared && it.ownerId === ME.id ? [{ userId: SAM.id, name: SAM.name, email: "sam@example.com", role: "view" }] : [], canShare: it.space === "private" && it.ownerId === ME.id };
}

const used = (s: SampleDrive) => s.items.reduce((n, i) => n + i.history.reduce((m, v) => m + v.sizeBytes, 0), 0);

/** Answers a drive path, or undefined when the path is not the drive's. */
export function driveRoute(s: SampleDrive, method: string, rawPath: string, body: unknown): unknown {
  const [path, query = ""] = rawPath.split("?");
  if (!path.startsWith("/drive/")) return undefined;
  const qs = new URLSearchParams(query);
  const b = (body ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  const find = (id: string) => { const it = s.items.find((i) => i.id === id); if (!it) throw new ApiError(404, "not_found", "Not found."); return it; };
  const m = /^\/drive\/items\/([^/]+)(?:\/(content|versions\/([^/]+)\/restore))?$/.exec(path);
  if (method === "GET" && path === "/drive/list") return list(s, (qs.get("view") ?? "team") as DriveView, qs.get("folder"), qs.get("q") ?? "");
  if (method === "GET" && path === "/drive/usage") return { usedBytes: used(s), quotaBytes: DRIVE_LIMITS.workspaceBytes, fileBytes: DRIVE_LIMITS.fileBytes };
  if (method === "GET" && path === "/drive/tags") {
    const c = new Map<string, number>();
    for (const i of s.items) if (i.space === "brand" && !i.trashedAt) for (const t of i.tags) c.set(t, (c.get(t) ?? 0) + 1);
    return { tags: [...c].map(([tag, count]) => ({ tag, count })) };
  }
  if (method === "POST" && path === "/drive/folders") {
    const name = cleanName(String(b.name ?? ""));
    if (!name) throw new ApiError(422, "validation_failed", "Give the folder a name.");
    const it = mk(Date.now(), 0, { id: `drv-new-${s.seq++}`, kind: "folder", name, space: b.space as DriveSpace, parentId: (b.parentId as string | null) ?? null });
    s.items.push(it);
    return { item: strip(it) };
  }
  if (method === "PUT" && path === "/drive/upload") {
    if (Number(b.size ?? 0) > DRIVE_LIMITS.fileBytes) throw new ApiError(413, "file_too_large", tooBigLine());
    const it = mk(Date.now(), 0, { id: `drv-new-${s.seq++}`, name: cleanName(qs.get("name") ?? "") || "File", space: (qs.get("space") ?? "team") as DriveSpace, parentId: qs.get("parent"),
      contentType: String(b.type ?? "application/octet-stream"), sizeBytes: Number(b.size ?? 0) });
    s.items.push(it);
    return { item: strip(it) };
  }
  if (m && method === "GET" && !m[2]) return detail(s, m[1]);
  if (m && method === "PATCH") {
    const it = find(m[1]);
    if (!it.canEdit) throw new ApiError(403, "forbidden", it.space === "brand" ? "Only admins can change the brand library." : "You can only view this.");
    if (b.name !== undefined) { const n = cleanName(String(b.name)); if (!n) throw new ApiError(422, "validation_failed", "Give it a name."); it.name = n; }
    if (b.tags !== undefined) it.tags = cleanTags(b.tags as string[]);
    if (b.note !== undefined) it.note = b.note ? String(b.note).trim().slice(0, DRIVE_LIMITS.note) || null : null;
    it.updatedAt = now;
    return { item: strip(it) };
  }
  if (m && method === "PUT" && m[2] === "content") {
    const it = find(m[1]);
    const n = it.versions + 1;
    it.history = [{ id: `${it.id}-v${n}`, number: n, sizeBytes: Number(b.size ?? 0), contentType: String(b.type ?? it.contentType), name: it.name, createdBy: ME.name, createdAt: now, note: null, current: true },
      ...it.history.map((v) => ({ ...v, current: false }))].slice(0, DRIVE_LIMITS.versions);
    Object.assign(it, { versions: n, sizeBytes: Number(b.size ?? 0), updatedAt: now });
    return detail(s, it.id);
  }
  if (m && method === "POST" && m[3]) {
    const it = find(m[1]);
    const v = it.history.find((x) => x.id === m[3]);
    if (!v) throw new ApiError(404, "not_found", "Version not found.");
    if (!v.current) {
      const n = it.versions + 1;
      it.history = [{ ...v, id: `${it.id}-v${n}`, number: n, createdAt: now, note: `Restored from version ${v.number}`, current: true }, ...it.history.map((x) => ({ ...x, current: false }))].slice(0, DRIVE_LIMITS.versions);
      Object.assign(it, { versions: n, sizeBytes: v.sizeBytes, updatedAt: now });
    }
    return detail(s, it.id);
  }
  const ids = (b.ids as string[] | undefined) ?? [];
  if (method === "POST" && path === "/drive/move") {
    for (const id of ids) { const it = find(id); it.parentId = (b.parentId as string | null) ?? null; if (b.space) it.space = b.space as DriveSpace; it.updatedAt = now; }
    return { moved: ids.length };
  }
  if (method === "POST" && path === "/drive/trash") { for (const id of ids) find(id).trashedAt = now; return { trashed: ids.length }; }
  if (method === "POST" && path === "/drive/restore") { for (const id of ids) find(id).trashedAt = null; return { restored: ids.length }; }
  if (method === "POST" && path === "/drive/star") { for (const id of ids) find(id).starred = !!b.on; return { ok: true }; }
  throw new ApiError(404, "not_found", "Not found.");
}
