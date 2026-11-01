import { describe, it, expect, beforeEach } from "vitest";
import { unzipSync } from "fflate";
import { makeTestApp, Client } from "./helpers";
import { driveItems } from "@/server/db/schema";
import { purgeExpired } from "@/server/services/suite/drive-r101";
import { DRIVE_CHUNK, cleanName, cleanTags, inlineSafe, parseRange, previewKind, uniqueName } from "@/shared/drive";
import { eq } from "drizzle-orm";

/** R101 Files plus: the drive (spaces, folders, versions, stars, trash, shares, zip manifest) and the brand library. Made up fixtures only. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let orgId: string;
let now: Date;

async function setup(env: Record<string, string> = { FILES_PLUS_R101: "on" }) {
  ctx = await makeTestApp(env);
  now = new Date("2026-11-01T01:00:00Z");
  ctx.deps.now = () => now;
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  await owner.post("/api/org/plan", { plan: "pro" });
  orgId = (await owner.get("/api/account/me")).body.organization.id;
}
async function teammate(email: string, role: "member" | "admin" = "member") {
  const invite = await owner.post("/api/team/invites", { email, role });
  const m = new Client(ctx.app);
  await m.signup(email, email.split("@")[0], "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return { client: m, id: (await m.get("/api/account/me")).body.user.id as string };
}
async function upload(c: Client, name: string, bytes: Uint8Array | string, q: Record<string, string> = {}, type = "text/plain") {
  const body = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const qs = new URLSearchParams({ space: "team", name, ...q });
  const res = await ctx.app.request(`/api/drive/upload?${qs}`, { method: "PUT", headers: { cookie: c.cookie, host: "localhost", "content-type": type, "x-multies-upload": "1" }, body: body as BodyInit });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function newVersion(c: Client, id: string, text: string) {
  const res = await ctx.app.request(`/api/drive/items/${id}/content`, { method: "PUT", headers: { cookie: c.cookie, host: "localhost", "content-type": "text/plain", "x-multies-upload": "1" }, body: new TextEncoder().encode(text) });
  return { status: res.status, body: await res.json() };
}
async function content(c: Client, id: string, headers: Record<string, string> = {}, q = "") {
  const res = await ctx.app.request(`/api/drive/items/${id}/content${q}`, { headers: { cookie: c.cookie, host: "localhost", ...headers } });
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const list = async (c: Client, view: string, folder?: string, q?: string) => (await c.get(`/api/drive/list?view=${view}${folder ? `&folder=${folder}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`));

describe("R101 shared helpers", () => {
  it("cleans names and tags", () => {
    expect(cleanName("  a/b\\c\u0001  ")).toBe("a b c");
    expect(cleanName("..")).toBe("");
    expect(cleanName("x".repeat(500)).length).toBe(200);
    expect(cleanTags(["Logo", "logo", " Dark  mode! ", "", "x".repeat(50)])).toEqual(["logo", "dark mode", "x".repeat(32)]);
    expect(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length).toBe(12);
  });
  it("makes unique names", () => {
    expect(uniqueName("Report.pdf", new Set(["report.pdf"]))).toBe("Report (2).pdf");
    expect(uniqueName("Report (2).pdf", new Set(["Report.pdf", "Report (2).pdf"]))).toBe("Report (3).pdf");
    expect(uniqueName("Notes", new Set(["Notes"]))).toBe("Notes (2)");
    expect(uniqueName("New", new Set())).toBe("New");
  });
  it("picks previews and inline types", () => {
    expect(previewKind("image/png", "a.png")).toBe("image");
    expect(previewKind("application/octet-stream", "a.pdf")).toBe("pdf");
    expect(previewKind("video/mp4", "a.mp4")).toBe("video");
    expect(previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")).toBe("office");
    expect(previewKind("application/octet-stream", "notes.md")).toBe("text");
    expect(previewKind("application/zip", "a.zip")).toBe("none");
    expect(inlineSafe("text/html")).toBe(false);
    expect(inlineSafe("image/svg+xml")).toBe(true);
    expect(inlineSafe("application/javascript")).toBe(false);
  });
  it("parses ranges", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=0-999", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange(undefined, 100)).toBeNull();
  });
});

describe("R101 drive", () => {
  beforeEach(async () => { await setup(); });

  it("is off without the flag", async () => {
    await setup({});
    expect((await owner.get("/api/drive/list?view=team")).status).toBe(404);
    expect((await owner.get("/api/config")).body.filesPlus).toBeFalsy();
  });

  it("signals the flag in config and needs a session", async () => {
    expect((await owner.get("/api/config")).body.filesPlus).toBe(true);
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/drive/list?view=team")).status).toBe(401);
  });

  it("folders: create, nest, unique names, breadcrumbs, rename", async () => {
    const a = (await owner.post("/api/drive/folders", { space: "team", name: "Clients" })).body.item;
    const a2 = (await owner.post("/api/drive/folders", { space: "team", name: "clients" })).body.item;
    expect(a2.name).toBe("clients (2)");
    const b = (await owner.post("/api/drive/folders", { space: "team", parentId: a.id, name: "Acme" })).body.item;
    const l = (await list(owner, "team", b.id)).body;
    expect(l.path.map((p: { name: string }) => p.name)).toEqual(["Team files", "Clients", "Acme"]);
    expect(l.canAdd).toBe(true);
    expect((await owner.post("/api/drive/folders", { space: "team", name: "  " })).status).toBe(422);
    const r = await owner.patch(`/api/drive/items/${b.id}`, { name: "Acme Pty" });
    expect(r.body.item.name).toBe("Acme Pty");
    const root = (await list(owner, "team")).body.items.map((i: { name: string }) => i.name);
    expect(root).toEqual(["Clients", "clients (2)"]);
  });

  it("upload, download, versions and restore", async () => {
    const up = await upload(owner, "plan.txt", "first");
    expect(up.status).toBe(200);
    const id = up.body.item.id;
    expect(up.body.item.versions).toBe(1);
    expect(text((await content(owner, id)).bytes)).toBe("first");
    const dup = await upload(owner, "plan.txt", "other");
    expect(dup.body.item.name).toBe("plan (2).txt");
    const v2 = await newVersion(owner, id, "second");
    expect(v2.body.versions.length).toBe(2);
    expect(text((await content(owner, id)).bytes)).toBe("second");
    const v1 = v2.body.versions.find((v: { number: number }) => v.number === 1);
    const old = await content(owner, id, {}, `?v=${v1.id}`);
    expect(text(old.bytes)).toBe("first");
    expect(old.headers.get("content-disposition")).toContain("version 1");
    const back = await owner.post(`/api/drive/items/${id}/versions/${v1.id}/restore`);
    expect(back.body.versions[0].note).toBe("Restored from version 1");
    expect(text((await content(owner, id)).bytes)).toBe("first");
  });

  it("keeps 20 versions and frees old bytes", async () => {
    const id = (await upload(owner, "v.txt", "v1")).body.item.id;
    for (let i = 2; i <= 22; i++) await newVersion(owner, id, `v${i}`);
    const d = (await owner.get(`/api/drive/items/${id}`)).body;
    expect(d.versions.length).toBe(20);
    expect(d.versions[0].number).toBe(22);
    const usage = (await owner.get("/api/drive/usage")).body;
    expect(usage.usedBytes).toBeLessThanOrEqual(20 * 3);
  });

  it("stores big files in chunks and serves ranges", async () => {
    const big = new Uint8Array(DRIVE_CHUNK * 2 + 10).map((_, i) => i % 251);
    const id = (await upload(owner, "clip.mp4", big, {}, "video/mp4")).body.item.id;
    const all = await content(owner, id);
    expect(all.bytes.length).toBe(big.length);
    expect(all.bytes[DRIVE_CHUNK + 5]).toBe(big[DRIVE_CHUNK + 5]);
    const part = await content(owner, id, { range: `bytes=${DRIVE_CHUNK - 2}-${DRIVE_CHUNK + 1}` }, "?inline=1");
    expect(part.status).toBe(206);
    expect([...part.bytes]).toEqual([...big.subarray(DRIVE_CHUNK - 2, DRIVE_CHUNK + 2)]);
    expect(part.headers.get("content-range")).toBe(`bytes ${DRIVE_CHUNK - 2}-${DRIVE_CHUNK + 1}/${big.length}`);
    expect(part.headers.get("content-disposition")).toMatch(/^inline/);
    expect((await content(owner, id, { range: `bytes=${big.length}-` })).status).toBe(416);
  });

  it("never sends unsafe types inline and refuses oversize or plain uploads", async () => {
    const id = (await upload(owner, "page.html", "<script>x</script>", {}, "text/html")).body.item.id;
    const r = await content(owner, id, {}, "?inline=1");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    const big = await ctx.app.request(`/api/drive/upload?space=team&name=big.bin`, { method: "PUT", headers: { cookie: owner.cookie, host: "localhost", "x-multies-upload": "1", "content-length": String(30 * 1024 * 1024) }, body: new Uint8Array(10) });
    expect(big.status).toBe(413);
    const noHeader = await ctx.app.request(`/api/drive/upload?space=team&name=a.txt`, { method: "PUT", headers: { cookie: owner.cookie, host: "localhost" }, body: new Uint8Array(3) });
    expect(noHeader.status).toBe(403);
  });

  it("move: into folders, not into itself, names stay unique", async () => {
    const f = (await owner.post("/api/drive/folders", { space: "team", name: "Box" })).body.item;
    const inner = (await owner.post("/api/drive/folders", { space: "team", parentId: f.id, name: "Inner" })).body.item;
    const a = (await upload(owner, "a.txt", "a")).body.item;
    await upload(owner, "a.txt", "dup", { parent: f.id });
    expect((await owner.post("/api/drive/move", { ids: [a.id], parentId: f.id })).body.moved).toBe(1);
    const names = (await list(owner, "team", f.id)).body.items.map((i: { name: string }) => i.name).sort();
    expect(names).toEqual(["Inner", "a (2).txt", "a.txt"]);
    expect((await owner.post("/api/drive/move", { ids: [f.id], parentId: inner.id })).status).toBe(422);
    expect((await owner.post("/api/drive/move", { ids: [f.id], parentId: f.id })).status).toBe(422);
  });

  it("trash and restore a folder with what is in it, then delete forever", async () => {
    const f = (await owner.post("/api/drive/folders", { space: "team", name: "Old" })).body.item;
    const file = (await upload(owner, "x.txt", "x", { parent: f.id })).body.item;
    await owner.post("/api/drive/trash", { ids: [f.id] });
    expect((await list(owner, "team")).body.items.length).toBe(0);
    expect((await owner.get(`/api/drive/items/${file.id}`)).status).toBe(404);
    const trash = (await list(owner, "trash")).body.items;
    expect(trash.map((i: { name: string }) => i.name)).toEqual(["Old"]);
    await owner.post("/api/drive/restore", { ids: [f.id] });
    expect((await list(owner, "team", f.id)).body.items.map((i: { name: string }) => i.name)).toEqual(["x.txt"]);
    // A file restored after its folder went to the trash comes back at the top.
    await owner.post("/api/drive/trash", { ids: [file.id] });
    await owner.post("/api/drive/trash", { ids: [f.id] });
    await owner.post("/api/drive/restore", { ids: [file.id] });
    expect((await list(owner, "team")).body.items.map((i: { name: string }) => i.name)).toEqual(["x.txt"]);
    expect((await owner.post("/api/drive/delete", { ids: [file.id] })).status).toBe(404); // not in the trash
    await owner.post("/api/drive/delete", { ids: [f.id] });
    expect((await list(owner, "trash")).body.items.length).toBe(0);
    expect((await ctx.db.select().from(driveItems).where(eq(driveItems.id, f.id))).length).toBe(0);
  });

  it("empties trash older than 30 days", async () => {
    const id = (await upload(owner, "old.txt", "o")).body.item.id;
    await owner.post("/api/drive/trash", { ids: [id] });
    now = new Date(now.getTime() + 31 * 86_400_000);
    expect(await purgeExpired(ctx.deps, orgId)).toBe(1);
    expect((await ctx.db.select().from(driveItems).where(eq(driveItems.id, id))).length).toBe(0);
  });

  it("stars are per person", async () => {
    const mate = await teammate("mate@acme.io");
    const id = (await upload(owner, "s.txt", "s")).body.item.id;
    await owner.post("/api/drive/star", { ids: [id], on: true });
    expect((await list(owner, "starred")).body.items.length).toBe(1);
    expect((await list(mate.client, "starred")).body.items.length).toBe(0);
    await owner.post("/api/drive/star", { ids: [id], on: false });
    expect((await list(owner, "starred")).body.items.length).toBe(0);
  });

  it("My files are private; shares give view or edit; admins don't see them", async () => {
    const mate = await teammate("mate@acme.io");
    const other = await teammate("other@acme.io");
    const admin = await teammate("boss@acme.io", "admin");
    const folder = (await mate.client.post("/api/drive/folders", { space: "private", name: "Mine" })).body.item;
    const file = (await upload(mate.client, "secret.txt", "s", { space: "private", parent: folder.id })).body.item;
    expect((await list(owner, "mine")).body.items.length).toBe(0);
    expect((await owner.get(`/api/drive/items/${file.id}`)).status).toBe(404);
    expect((await admin.client.get(`/api/drive/items/${file.id}`)).status).toBe(404);
    expect((await content(other.client, file.id)).status).toBe(404);
    expect((await list(other.client, "team", folder.id)).status).toBe(404);
    // Share the folder with Other, view only.
    const s = await mate.client.put(`/api/drive/items/${folder.id}/shares`, { shares: [{ userId: other.id, role: "view" }] });
    expect(s.body.shares.length).toBe(1);
    expect((await list(other.client, "shared")).body.items.map((i: { name: string }) => i.name)).toEqual(["Mine"]);
    const inside = (await list(other.client, "team", folder.id)).body;
    expect(inside.view).toBe("shared");
    expect(inside.canAdd).toBe(false);
    expect(text((await content(other.client, file.id)).bytes)).toBe("s");
    expect((await other.client.patch(`/api/drive/items/${file.id}`, { name: "x" })).status).toBe(403);
    expect((await other.client.post("/api/drive/trash", { ids: [file.id] })).status).toBe(403);
    expect((await other.client.put(`/api/drive/items/${folder.id}/shares`, { shares: [] })).status).toBe(403);
    // Edit lets them add and rename, not move it out of My files.
    await mate.client.put(`/api/drive/items/${folder.id}/shares`, { shares: [{ userId: other.id, role: "edit" }] });
    expect((await upload(other.client, "added.txt", "a", { parent: folder.id })).status).toBe(200);
    expect((await other.client.patch(`/api/drive/items/${file.id}`, { name: "renamed.txt" })).status).toBe(200);
    expect((await other.client.post("/api/drive/move", { ids: [file.id], parentId: null, space: "team" })).status).toBe(403);
    // Only workspace members can be added.
    expect((await mate.client.put(`/api/drive/items/${folder.id}/shares`, { shares: [{ userId: "usr_nope", role: "view" }] })).status).toBe(422);
    // Removing the share removes access.
    await mate.client.put(`/api/drive/items/${folder.id}/shares`, { shares: [] });
    expect((await content(other.client, file.id)).status).toBe(404);
  });

  it("team files: members add, edit and trash; delete forever is the uploader or an admin", async () => {
    const mate = await teammate("mate@acme.io");
    const other = await teammate("other@acme.io");
    const id = (await upload(mate.client, "team.txt", "t")).body.item.id;
    expect((await other.client.patch(`/api/drive/items/${id}`, { name: "Team.txt" })).status).toBe(200);
    expect((await other.client.post("/api/drive/trash", { ids: [id] })).status).toBe(200);
    expect((await list(mate.client, "trash")).body.items.length).toBe(1);
    expect((await other.client.post("/api/drive/delete", { ids: [id] })).status).toBe(403);
    expect((await mate.client.post("/api/drive/delete", { ids: [id] })).status).toBe(200);
  });

  it("brand library: everyone views, only admins change; tags", async () => {
    const mate = await teammate("mate@acme.io");
    expect((await upload(mate.client, "logo.png", "png", { space: "brand" }, "image/png")).status).toBe(403);
    expect((await mate.client.post("/api/drive/folders", { space: "brand", name: "Logos" })).status).toBe(403);
    const logo = (await upload(owner, "logo.png", "png", { space: "brand" }, "image/png")).body.item;
    const t = await owner.patch(`/api/drive/items/${logo.id}`, { tags: ["Logo", "Dark"], note: "Use on dark backgrounds" });
    expect(t.body.item.tags).toEqual(["logo", "dark"]);
    expect((await mate.client.patch(`/api/drive/items/${logo.id}`, { tags: ["x"] })).status).toBe(403);
    expect((await mate.client.post("/api/drive/trash", { ids: [logo.id] })).status).toBe(403);
    const seen = (await list(mate.client, "brand")).body;
    expect(seen.canAdd).toBe(false);
    expect(seen.items[0].canEdit).toBe(false);
    expect(text((await content(mate.client, logo.id)).bytes)).toBe("png");
    expect((await mate.client.get("/api/drive/tags")).body.tags).toEqual([{ tag: "dark", count: 1 }, { tag: "logo", count: 1 }]);
    expect((await list(mate.client, "trash")).body.items.length).toBe(0);
  });

  it("zip manifest: paths for folders, only what the person can open", async () => {
    const f = (await owner.post("/api/drive/folders", { space: "team", name: "Pack" })).body.item;
    const sub = (await owner.post("/api/drive/folders", { space: "team", parentId: f.id, name: "Sub" })).body.item;
    await upload(owner, "a.txt", "a", { parent: f.id });
    await upload(owner, "b.txt", "bb", { parent: sub.id });
    const lone = (await upload(owner, "c.txt", "c")).body.item;
    const m = (await owner.get(`/api/drive/manifest?ids=${f.id},${lone.id}`)).body;
    expect(m.files.map((x: { path: string }) => x.path).sort()).toEqual(["Pack/Sub/b.txt", "Pack/a.txt", "c.txt"]);
    expect(m.totalBytes).toBe(4);
    const mate = await teammate("mate@acme.io");
    const priv = (await upload(owner, "p.txt", "p", { space: "private" })).body.item;
    expect((await mate.client.get(`/api/drive/manifest?ids=${priv.id}`)).status).toBe(404);
    expect(unzipSync).toBeTypeOf("function");
  });

  it("search, recent and quota", async () => {
    await upload(owner, "Invoice March.pdf", "x", {}, "application/pdf");
    await upload(owner, "photo.png", "y", {}, "image/png");
    expect((await list(owner, "team", undefined, "invoice")).body.items.map((i: { name: string }) => i.name)).toEqual(["Invoice March.pdf"]);
    expect((await list(owner, "recent")).body.items.length).toBe(2);
    const u = (await owner.get("/api/drive/usage")).body;
    expect(u.usedBytes).toBe(2);
    expect(u.quotaBytes).toBe(200 * 1024 * 1024);
  });
});
