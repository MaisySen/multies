/**
 * R88: secure share. File requests (public chunked uploads with resume, limits, programs refused, owner download,
 * notification), secret links (ciphertext only, opens N times then burns, passphrase, receipt), the share link view
 * log, reports that pause a link, and the shared helpers.
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { MemoryToolFileStore } from "@/server/services/tools/p2-bindings";
import { isPreviewer } from "@/server/services/tools/kept-files";
import { allowedByGroups, blockedBytes, blockedName, REQUEST_CHUNK_BYTES } from "@/shared/secure-share";
import { decryptSecret, encryptSecret, fromB64u } from "@/web/lib/secret-crypto";

const ON = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: "k".repeat(40), TOOLS_TOKEN_KEY: "t".repeat(40), TOOLS_FEATURES: "share,file_requests,secrets", APP_URL: "http://localhost" };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const MB = 1024 * 1024;

async function setup(env: Record<string, string> = ON) {
  const ctx = await makeTestApp(env);
  let clock = Date.parse("2026-10-31T04:00:00Z");
  ctx.deps.now = () => new Date(clock);
  ctx.deps.toolFiles = new MemoryToolFileStore(() => clock);
  const c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  return { ...ctx, c, advance: (ms: number) => { clock += ms; } };
}
type T = Awaited<ReturnType<typeof setup>>;
const pathOf = (url: string) => new URL(url).pathname;

async function page(t: T, path: string, ua = UA) {
  const res = await t.app.request(path, { headers: { host: "localhost", "user-agent": ua } });
  const html = await res.text();
  return { status: res.status, html, ft: html.match(/data-ft="([a-f0-9]+)"/)?.[1] ?? html.match(/name="ft" value="([a-f0-9]+)"/)?.[1] ?? "" };
}

async function pub(t: T, method: string, path: string, ft: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body instanceof Uint8Array;
  const res = await t.app.request(path, {
    method, body: raw ? (body as Uint8Array<ArrayBuffer>) : body !== undefined ? JSON.stringify(body) : undefined,
    headers: { host: "localhost", origin: "http://localhost", "sec-fetch-site": "same-origin", "x-ft": ft, "user-agent": UA, "cf-ipcountry": "AU", ...(raw ? { "content-type": "application/octet-stream", "content-length": String((body as Uint8Array).byteLength) } : { "content-type": "application/json" }), ...headers },
  });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const baseReq = { title: "Tax documents 2026", message: "Please send your statements.", maxFileBytes: 25 * MB, maxTotalBytes: 50 * MB, allowed: "any", keepDays: 30, expiresInDays: 14 };

async function makeRequest(t: T, extra: Record<string, unknown> = {}) {
  const r = await t.c.post("/api/tools/requests", { ...baseReq, ...extra });
  expect(r.status).toBe(201);
  const path = pathOf(r.body.request.url);
  return { id: r.body.request.id as string, path, ...(await page(t, path)) };
}

async function upload(t: T, path: string, ft: string, name: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  const s = await pub(t, "POST", `${path}/start`, ft, { name, size: bytes.byteLength, type: "application/pdf", uploaderName: "Sam Client", note: "Here you go", ...extra });
  if (s.status !== 200) return { start: s };
  const { uploadId, uploadKey, chunkBytes, chunks } = s.body;
  const parts: { status: number; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let n = 0; n < chunks; n++) parts.push(await pub(t, "PUT", `${path}/uploads/${uploadId}/${n}`, ft, bytes.subarray(n * chunkBytes, Math.min(bytes.byteLength, (n + 1) * chunkBytes)), { "x-upload-key": uploadKey }));
  const fin = await pub(t, "POST", `${path}/uploads/${uploadId}/finish`, ft, {}, { "x-upload-key": uploadKey });
  return { start: s, parts, fin, uploadId, uploadKey };
}

const pdf = (n: number) => { const b = new Uint8Array(n); b.set([0x25, 0x50, 0x44, 0x46, 0x2d]); for (let i = 5; i < n; i++) b[i] = i % 251; return b; };

describe("R88 helpers", () => {
  it("refuses programs by name and by first bytes, and checks allowed groups", () => {
    expect(blockedName("invoice.pdf.exe")).toBe(true);
    expect(blockedName("setup.MSI")).toBe(true);
    expect(blockedName("report.pdf")).toBe(false);
    expect(blockedBytes(new Uint8Array([0x4d, 0x5a, 0x90, 0]))).toBe(true);
    expect(blockedBytes(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe(true);
    expect(blockedBytes(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]))).toBe(true);
    expect(blockedBytes(new Uint8Array([0x23, 0x21, 0x2f]))).toBe(true);
    expect(blockedBytes(pdf(8))).toBe(false);
    expect(allowedByGroups("a.pdf", "documents")).toBe(true);
    expect(allowedByGroups("a.png", "documents")).toBe(false);
    expect(allowedByGroups("a.png", "documents,images")).toBe(true);
    expect(allowedByGroups("a.bat", "any")).toBe(false);
    expect(isPreviewer("facebookexternalhit/1.1")).toBe(true);
    expect(isPreviewer("WhatsApp/2.23")).toBe(true);
    expect(isPreviewer(undefined)).toBe(true);
    expect(isPreviewer(UA)).toBe(false);
  });

  it("encrypts in the browser shape and decrypts back, with and without a passphrase", async () => {
    const a = await encryptSecret({ kind: "text", text: "hunter2 ✓" });
    expect(fromB64u(a.key)).toHaveLength(32);
    expect((await decryptSecret(a.ciphertext, a.key)).text).toBe("hunter2 ✓");
    const b = await encryptSecret({ kind: "file", bytes: new Uint8Array([1, 2, 3]), name: "k.txt", type: "text/plain" }, "correct horse");
    const back = await decryptSecret(b.ciphertext, b.key, "correct horse");
    expect(back.name).toBe("k.txt");
    expect([...back.bytes!]).toEqual([1, 2, 3]);
    await expect(decryptSecret(b.ciphertext, b.key, "wrong")).rejects.toBeTruthy();
  });
});

describe("R88 file requests", () => {
  it("is off (404) unless its flag is on", async () => {
    const t = await setup({ ...ON, TOOLS_FEATURES: "share" });
    expect((await t.c.get("/api/tools/requests")).status).toBe(404);
    expect((await page(t, `/u/${"a".repeat(43)}`)).status).toBe(404);
  });

  it("a client uploads a two part file without an account; the owner is told, sees and downloads it", async () => {
    const t = await setup();
    const q = await makeRequest(t);
    expect(q.status).toBe(200);
    expect(q.html).toContain("Tax documents 2026");
    expect(q.html).toContain("Please send your statements.");
    expect(q.html).toContain("Report this link");
    const row = await t.db.get<{ token_hash: string }>(sql`select token_hash from tool_file_requests`);
    expect(q.path).not.toContain(row!.token_hash);
    const bytes = pdf(REQUEST_CHUNK_BYTES + 1234);
    const up = await upload(t, q.path, q.ft, "Statement.pdf", bytes);
    expect(up.start.status).toBe(200);
    expect(up.start.body.chunks).toBe(2);
    expect(up.parts!.map((p) => p.status)).toEqual([200, 200]);
    expect(up.fin!.status).toBe(200);
    expect(up.fin!.body.status).toBe("done");
    const list = await t.c.get("/api/tools/requests");
    expect(list.body.requests[0]).toMatchObject({ uploads: 1, bytesReceived: bytes.byteLength, status: "open" });
    const detail = await t.c.get(`/api/tools/requests/${q.id}`);
    expect(detail.body.files[0]).toMatchObject({ name: "Statement.pdf", uploaderName: "Sam Client", note: "Here you go", country: "AU", status: "done" });
    const res = await t.app.request(`/api/tools/requests/files/${detail.body.files[0].id}`, { headers: { host: "localhost", cookie: t.c.cookie } });
    expect(res.status).toBe(200);
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.byteLength).toBe(bytes.byteLength);
    expect(Buffer.from(got).equals(Buffer.from(bytes))).toBe(true);
    const n = await t.db.get<{ title: string }>(sql`select title from notifications where type = 'tools.file_request_upload'`);
    expect(n!.title).toBe("New file for Tax documents 2026: Sam Client uploaded Statement.pdf");
    // R100: the owner sees it in Notifications (Inbox), linked to the request.
    const inbox = await t.c.get("/api/notifications?view=inbox&limit=100");
    const item = inbox.body.notifications.find((x: { type: string }) => x.type === "tools.file_request_upload");
    expect(item).toMatchObject({ category: "status", read: false, link: `/app/tools/share?tab=requests&request=${q.id}` });
    // Delete gives the room back.
    expect((await t.c.del(`/api/tools/requests/files/${detail.body.files[0].id}`)).status).toBe(200);
    expect((await t.c.get("/api/tools/requests")).body.requests[0]).toMatchObject({ uploads: 0, bytesReceived: 0 });
  });

  it("resumes: the status call says which parts arrived, a part sent twice is fine, finish waits for every part", async () => {
    const t = await setup();
    const q = await makeRequest(t);
    const bytes = pdf(REQUEST_CHUNK_BYTES * 2 + 10);
    const s = await pub(t, "POST", `${q.path}/start`, q.ft, { name: "Big.pdf", size: bytes.byteLength });
    const { uploadId, uploadKey, chunkBytes } = s.body;
    const k = { "x-upload-key": uploadKey };
    expect((await pub(t, "PUT", `${q.path}/uploads/${uploadId}/1`, q.ft, bytes.subarray(chunkBytes, 2 * chunkBytes), k)).body.received).toBe("010");
    expect((await pub(t, "POST", `${q.path}/uploads/${uploadId}/finish`, q.ft, {}, k)).status).toBe(409);
    expect((await pub(t, "GET", `${q.path}/uploads/${uploadId}`, q.ft, undefined, k)).body).toMatchObject({ status: "uploading", received: "010" });
    expect((await pub(t, "PUT", `${q.path}/uploads/${uploadId}/1`, q.ft, bytes.subarray(chunkBytes, 2 * chunkBytes), k)).status).toBe(200);
    expect((await pub(t, "PUT", `${q.path}/uploads/${uploadId}/0`, q.ft, bytes.subarray(0, 10), k)).status).toBe(400); // wrong size
    await pub(t, "PUT", `${q.path}/uploads/${uploadId}/0`, q.ft, bytes.subarray(0, chunkBytes), k);
    await pub(t, "PUT", `${q.path}/uploads/${uploadId}/2`, q.ft, bytes.subarray(2 * chunkBytes), k);
    expect((await pub(t, "POST", `${q.path}/uploads/${uploadId}/finish`, q.ft, {}, k)).status).toBe(200);
    // A wrong upload key finds nothing.
    expect((await pub(t, "GET", `${q.path}/uploads/${uploadId}`, q.ft, undefined, { "x-upload-key": "nope-nope-nope" })).status).toBe(404);
  });

  it("refuses programs, wrong types, files over the cap, and starts past the total or the file count", async () => {
    const t = await setup();
    const q = await makeRequest(t, { allowed: "documents", maxFileBytes: 10 * MB, maxUploads: 2 });
    expect((await pub(t, "POST", `${q.path}/start`, q.ft, { name: "setup.exe", size: 100 })).status).toBe(415);
    expect((await pub(t, "POST", `${q.path}/start`, q.ft, { name: "photo.png", size: 100 })).status).toBe(415);
    expect((await pub(t, "POST", `${q.path}/start`, q.ft, { name: "big.pdf", size: 11 * MB })).status).toBe(413);
    // A program renamed to .pdf is caught by its first bytes and its room is given back.
    const exe = new Uint8Array(200); exe.set([0x4d, 0x5a]);
    const up = await upload(t, q.path, q.ft, "invoice.pdf", exe);
    expect(up.parts![0].status).toBe(415);
    expect((await t.c.get("/api/tools/requests")).body.requests[0]).toMatchObject({ uploads: 0, bytesReceived: 0 });
    await upload(t, q.path, q.ft, "a.pdf", pdf(100));
    await upload(t, q.path, q.ft, "b.pdf", pdf(100));
    expect((await pub(t, "POST", `${q.path}/start`, q.ft, { name: "c.pdf", size: 100 })).status).toBe(410); // full
    expect((await page(t, q.path)).status).toBe(410); // full
  });

  it("checks the password, needs the page's form token, and closes and reopens", async () => {
    const t = await setup();
    const q = await makeRequest(t, { password: "s3cret!" });
    expect(q.html).toContain('id="pw"');
    expect((await pub(t, "POST", `${q.path}/start`, "0".repeat(40), { name: "a.pdf", size: 5, password: "s3cret!" })).status).toBe(403);
    const wrong = await pub(t, "POST", `${q.path}/start`, q.ft, { name: "a.pdf", size: 5, password: "nope" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toMatch(/4 tries left/);
    expect((await upload(t, q.path, q.ft, "a.pdf", pdf(50), { password: "s3cret!" })).fin!.status).toBe(200);
    expect((await t.c.patch(`/api/tools/requests/${q.id}`, { open: false })).body.status).toBe("closed");
    expect((await page(t, q.path)).status).toBe(410);
    expect((await pub(t, "POST", `${q.path}/start`, q.ft, { name: "b.pdf", size: 5, password: "s3cret!" })).status).toBe(410);
    expect((await t.c.patch(`/api/tools/requests/${q.id}`, { open: true })).body.status).toBe("open");
  });

  it("three reports pause the request and tell its owner", async () => {
    const t = await setup();
    const q = await makeRequest(t);
    for (let i = 0; i < 3; i++) {
      const res = await t.app.request(`${q.path}/report`, { method: "POST", body: new URLSearchParams({ ft: q.ft, reason: "phishing", detail: "fake" }).toString(), headers: { host: "localhost", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `10.0.0.${i + 1}` } });
      expect(res.status).toBe(200);
    }
    expect((await page(t, q.path)).status).toBe(410);
    expect((await t.c.get("/api/tools/requests")).body.requests[0].status).toBe("paused");
    expect((await t.db.get<{ n: number }>(sql`select count(*) as n from tool_link_reports where kind = 'request'`))!.n).toBe(3);
    expect((await t.c.patch(`/api/tools/requests/${q.id}`, { open: true })).body.status).toBe("open");
  });

  it("validates a new request", async () => {
    const t = await setup();
    expect((await t.c.post("/api/tools/requests", { ...baseReq, title: " " })).status).toBe(400);
    expect((await t.c.post("/api/tools/requests", { ...baseReq, maxFileBytes: 200 * MB })).status).toBe(400);
    expect((await t.c.post("/api/tools/requests", { ...baseReq, allowed: "programs" })).status).toBe(400);
    expect((await t.c.post("/api/tools/requests", { ...baseReq, keepDays: 365 })).status).toBe(400);
  });
});

describe("R88 secret links", () => {
  async function makeSecret(t: T, text: string, extra: Record<string, unknown> = {}, pass: string | null = null) {
    const enc = await encryptSecret({ kind: "text", text }, pass);
    const r = await t.c.post("/api/tools/secrets", { kind: "text", ciphertext: enc.ciphertext, passphrase: !!pass, maxViews: 1, expiresInSeconds: 86_400, label: "Wifi", ...extra });
    expect(r.status).toBe(201);
    return { id: r.body.secret.id as string, path: pathOf(r.body.secret.url), key: enc.key, info: r.body.secret };
  }

  it("keeps only ciphertext, warns before opening, hands it out once, then burns and tells the sender", async () => {
    const t = await setup();
    const s = await makeSecret(t, "the vault code is 4411");
    const row = await t.db.get<{ ciphertext: string; label: string }>(sql`select ciphertext, label from tool_secrets`);
    expect(row!.ciphertext).not.toContain("4411");
    expect(JSON.stringify((await t.c.get("/api/tools/secrets")).body)).not.toContain(row!.ciphertext.slice(0, 20));
    // A link previewer gets the page and uses no view.
    const pv = await page(t, s.path, "Slackbot-LinkExpanding 1.0");
    expect(pv.status).toBe(200);
    expect(pv.html).toContain("Show secret");
    expect(pv.html).not.toContain(row!.ciphertext.slice(0, 16));
    expect((await pub(t, "POST", `${s.path}/open`, "0".repeat(40))).status).toBe(403);
    const o = await pub(t, "POST", `${s.path}/open`, pv.ft);
    expect(o.status).toBe(200);
    expect(o.body.viewsLeft).toBe(0);
    expect((await decryptSecret(o.body.ciphertext, s.key)).text).toBe("the vault code is 4411");
    const after = await t.db.get<{ ciphertext: string | null; burned_at: number | null }>(sql`select ciphertext, burned_at from tool_secrets`);
    expect(after!.ciphertext).toBeNull();
    expect(after!.burned_at).not.toBeNull();
    expect((await pub(t, "POST", `${s.path}/open`, pv.ft)).status).toBe(410);
    expect((await page(t, s.path)).status).toBe(410);
    const d = await t.c.get(`/api/tools/secrets/${s.id}`);
    expect(d.body).toMatchObject({ status: "burned", views: 1 });
    expect(d.body.opens[0]).toMatchObject({ country: "AU", agent: "Safari on macOS" });
    expect((await t.db.get<{ title: string }>(sql`select title from notifications where type = 'tools.secret_opened'`))!.title).toContain("was opened and is now gone");
  });

  it("opens N times, works with a passphrase, and can be turned off", async () => {
    const t = await setup();
    const s = await makeSecret(t, "two views", { maxViews: 2 }, "pass phrase");
    const p = await page(t, s.path);
    const a = await pub(t, "POST", `${s.path}/open`, p.ft);
    expect(a.body).toMatchObject({ viewsLeft: 1, passphrase: true });
    expect((await decryptSecret(a.body.ciphertext, s.key, "pass phrase")).text).toBe("two views");
    expect((await t.c.del(`/api/tools/secrets/${s.id}`)).body.status).toBe("revoked");
    expect((await pub(t, "POST", `${s.path}/open`, p.ft)).status).toBe(410);
  });

  it("expires, validates, and stays off without its flag", async () => {
    const t = await setup();
    const s = await makeSecret(t, "short life", { expiresInSeconds: 3600 });
    t.advance(3601_000);
    expect((await page(t, s.path)).status).toBe(410);
    expect((await t.c.post("/api/tools/secrets", { kind: "text", ciphertext: "abc", maxViews: 1, expiresInSeconds: 3600 })).status).toBe(400);
    expect((await t.c.post("/api/tools/secrets", { kind: "text", ciphertext: "A".repeat(100), maxViews: 4, expiresInSeconds: 3600 })).status).toBe(400);
    const off = await setup({ ...ON, TOOLS_FEATURES: "share" });
    expect((await off.c.get("/api/tools/secrets")).status).toBe(404);
  });

  it("keeps a bigger secret in file storage and drops it when burned", async () => {
    const t = await setup();
    const enc = await encryptSecret({ kind: "file", bytes: new Uint8Array(200_000).fill(7), name: "id.png", type: "image/png" });
    const r = await t.c.post("/api/tools/secrets", { kind: "file", ciphertext: enc.ciphertext, maxViews: 1, expiresInSeconds: 3600 });
    expect(r.status).toBe(201);
    const row = await t.db.get<{ ciphertext: string | null; file_id: string }>(sql`select ciphertext, file_id from tool_secrets`);
    expect(row!.ciphertext).toBeNull();
    const path = pathOf(r.body.secret.url);
    const p = await page(t, path);
    const o = await pub(t, "POST", `${path}/open`, p.ft);
    const back = await decryptSecret(o.body.ciphertext, enc.key);
    expect(back.name).toBe("id.png");
    expect(back.bytes!.byteLength).toBe(200_000);
    expect((await t.db.get<{ deleted_at: number | null }>(sql`select deleted_at from tool_files where id = ${row!.file_id}`))!.deleted_at).not.toBeNull();
  });
});

describe("R88 share link view log", () => {
  it("logs a page open as a view, not a link previewer's fetch", async () => {
    const t = await setup();
    const fd = new FormData();
    fd.append("file", new Blob(["hello world file"], { type: "application/pdf" }), "Report.pdf");
    fd.append("expiresInSeconds", "3600");
    const req = new Request("http://localhost/x", { method: "POST", body: fd });
    const bytes = new Uint8Array(await req.arrayBuffer());
    const res = await t.app.request("/api/tools/share", { method: "POST", body: bytes, headers: { cookie: t.c.cookie, host: "localhost", "content-type": req.headers.get("content-type")!, "content-length": String(bytes.byteLength), "x-multies-upload": "1" } });
    const link = (await res.json() as { link: { id: string; url: string } }).link;
    await page(t, pathOf(link.url), "WhatsApp/2.23.20 A");
    const p = await page(t, pathOf(link.url));
    expect(p.html).toContain("Report this link");
    const d = await t.c.get(`/api/tools/share/${link.id}`);
    expect(d.body.views).toBe(1);
    expect(d.body.log).toHaveLength(1);
    expect(d.body.log[0]).toMatchObject({ kind: "view", agent: "Safari on macOS" });
  });
});
