/**
 * Tools P2 (H5): secure share links and e-sign, against a fake engine (signed calls checked like the real one)
 * and the in memory KV store. Covers expiry, password lockout, download limits, storage caps, single use
 * signing links, the in sequence order, reminders, decline, cancel, and that the signing record the engine
 * gets and the request page shows match the D1 rows.
 */
import { describe, it, expect } from "vitest";
import { createHmac, createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { and, eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { messages } from "@/server/db/schema";
import { MemoryToolFileStore } from "@/server/services/tools/p2-bindings";
import { runSignPass, mediaBoxes, pageListFromZip } from "@/server/services/tools/esign";
import { agentFamily } from "@/server/services/tools/kept-files";

const ENGINE_KEY = "k".repeat(40);
// R107: these pin the original flow (ESIGN_V2 off), which older links keep; tests/esign-v2-r107.test.ts covers v2.
const ON = { ESIGN_V2: "off", TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: ENGINE_KEY, TOOLS_TOKEN_KEY: "t".repeat(40), TOOLS_FEATURES: "share,esign", APP_URL: "http://localhost" };
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const PDF = "%PDF-1.4\n1 0 obj << /Type /Page /MediaBox [0 0 595.28 841.89] >> endobj\n2 0 obj << /Type /Page /MediaBox [0 0 612 792] >> endobj\n";
const SIGNED = "%PDF-1.4 signed copy";

function png(w = 200, h = 283) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
}
const pngUrl = () => `data:image/png;base64,${Buffer.from(png(300, 100)).toString("base64")}`;

interface Job { id: string; ws: string; op: string; form: FormData; status: string }

function fakeEngine() {
  const jobs = new Map<string, Job>();
  let thumbsWithManifest = true;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = init?.body ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()) : new Uint8Array();
    const len = h.get("content-length") ?? "0";
    const want = createHmac("sha256", ENGINE_KEY).update(["v1", method, url.pathname + url.search, h.get("x-multies-ts"), h.get("x-multies-nonce"), h.get("x-multies-ws"), h.get("x-multies-user"), h.get("x-multies-max-bytes"), len].join("\n")).digest("hex");
    if (h.get("x-multies-sig") !== want) return Response.json({ error: "unauthorized" }, { status: 401 });
    const ws = h.get("x-multies-ws")!;
    if (method === "POST" && url.pathname === "/internal/v1/jobs") {
      const form = await new Response(body, { headers: { "content-type": h.get("content-type")! } }).formData();
      const id = Math.random().toString(16).slice(2).padEnd(16, "a") + "beef";
      jobs.set(id, { id, ws, op: url.searchParams.get("op")!, form, status: "done" });
      return Response.json({ id, status: "queued" }, { status: 202 });
    }
    const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
    const job = m ? jobs.get(m[1]) : undefined;
    if (!job || job.ws !== ws) return Response.json({ error: "not_found" }, { status: 404 });
    if (m![2]) {
      if (job.op === "thumbnails") {
        const files: Record<string, Uint8Array> = { "page-001.png": png(200, 283), "page-002.png": png(200, 259) };
        if (thumbsWithManifest) files["pages.json"] = strToU8(JSON.stringify([{ page: 1, width: 595.28, height: 841.89 }, { page: 2, width: 612, height: 792 }]));
        return new Response(zipSync(files));
      }
      // Sharp previews (PDF to images at 72 dpi): page-p1.jpg ...
      if (job.op === "to-jpeg") return new Response(zipSync({ "page-p1.jpg": JPG, "page-p2.jpg": JPG }));
      return new Response(SIGNED);
    }
    if (job.status !== "done") return Response.json({ id: job.id, status: job.status });
    return Response.json({ id: job.id, status: "done", output: { bytes: 10 }, result: job.op === "sign" ? { pages: 3, sha256: "ab".repeat(32) } : { pages: 2 } });
  };
  return { fetch: fetch as typeof globalThis.fetch, jobs, setManifest: (v: boolean) => { thumbsWithManifest = v; } };
}

async function setup(env: Record<string, string> = ON) {
  const engine = fakeEngine();
  const ctx = await makeTestApp(env, { fetch: engine.fetch });
  let clock = Date.parse("2026-10-30T04:00:00Z");
  ctx.deps.now = () => new Date(clock);
  ctx.deps.toolFiles = new MemoryToolFileStore(() => clock);
  const c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  const orgId = (await c.get("/api/account/me")).body.organization.id as string;
  const advance = (ms: number) => { clock += ms; };
  return { ...ctx, c, engine, orgId, advance, now: () => clock };
}

async function mailbox(t: Awaited<ReturnType<typeof setup>>) {
  const domainId = (await t.c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await t.c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") t.dns.records.mx = { ...t.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else t.dns.records.txt = { ...t.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await t.c.post(`/api/domains/${domainId}/verify`);
  return (await t.c.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" })).body.mailbox.id as string;
}

async function uploadShare(t: Awaited<ReturnType<typeof setup>>, fields: Record<string, string>, content = "hello world file", name = "Report.pdf") {
  const fd = new FormData();
  fd.append("file", new Blob([content], { type: "application/pdf" }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const req = new Request("http://localhost/x", { method: "POST", body: fd });
  const bytes = new Uint8Array(await req.arrayBuffer());
  const res = await t.app.request("/api/tools/share", { method: "POST", body: bytes, headers: { cookie: t.c.cookie, host: "localhost", "content-type": req.headers.get("content-type")!, "content-length": String(bytes.byteLength), "x-multies-upload": "1" } });
  return { status: res.status, body: await res.json() as { link: { id: string; url: string } } & { error?: { code: string; message: string } } };
}

const pathOf = (url: string) => new URL(url).pathname;

async function openPage(t: Awaited<ReturnType<typeof setup>>, path: string) {
  const res = await t.app.request(path, { headers: { host: "localhost" } });
  const html = await res.text();
  return { status: res.status, html, headers: res.headers, ft: html.match(/name="ft" value="([a-f0-9]+)"/)?.[1] ?? html.match(/data-ft="([a-f0-9]+)"/)?.[1] ?? "" };
}

async function download(t: Awaited<ReturnType<typeof setup>>, path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  const body = new URLSearchParams(form).toString();
  const res = await t.app.request(path, { method: "POST", body, headers: { host: "localhost", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost", "cf-ipcountry": "AU", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", ...headers } });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

describe("Tools P2 share links", () => {
  it("is off (404) unless the share flag is on", async () => {
    const t = await setup({ ...ON, TOOLS_FEATURES: "esign" });
    expect((await t.c.get("/api/tools/share")).status).toBe(404);
    expect((await openPage(t, `/d/${"a".repeat(43)}`)).status).toBe(404);
  });

  it("creates a link from an upload; the public page shows only the file, size and workspace; a download is logged without the address", async () => {
    const t = await setup();
    const r = await uploadShare(t, { expiresInSeconds: "3600", notifyFirst: "true" });
    expect(r.status).toBe(201);
    const token = pathOf(r.body.link.url).split("/")[2];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await t.db.get<{ token_hash: string }>(sql`select token_hash from tool_shares`);
    expect(row!.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row!.token_hash).not.toContain(token);
    const page = await openPage(t, pathOf(r.body.link.url));
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    expect(page.html).toContain("Report.pdf");
    expect(page.html).toContain("Shared by Acme");
    expect(page.html).not.toContain("ada@acme.io");
    // No form token, or another site's origin: blocked.
    expect((await download(t, pathOf(r.body.link.url), {})).status).toBe(403);
    expect((await download(t, pathOf(r.body.link.url), { ft: page.ft }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await download(t, pathOf(r.body.link.url), { ft: page.ft }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await download(t, pathOf(r.body.link.url), { ft: page.ft }, { origin: "null" })).status).toBe(403);
    // A browser on a no-referrer page sends Origin: null with Sec-Fetch-Site: same-origin; the form token still decides.
    const d = await download(t, pathOf(r.body.link.url), { ft: page.ft }, { origin: "null", "sec-fetch-site": "same-origin" });
    expect(d.status).toBe(200);
    expect(d.text).toBe("hello world file");
    expect(d.headers.get("content-disposition")).toContain("Report.pdf");
    const detail = await t.c.get(`/api/tools/share/${r.body.link.id}`);
    expect(detail.body).toMatchObject({ downloads: 1, status: "active", log: [{ country: "AU", agent: "Safari on macOS" }] });
    const cols = (await t.db.all<{ name: string }>(sql`select name from pragma_table_info('tool_share_downloads')`)).map((x) => x.name);
    expect(cols).not.toContain("ip");
    const sent = t.outbound.sent.map((m) => m.subject);
    expect(sent.some((s) => s.includes("Report.pdf was downloaded"))).toBe(true);
  });

  it("expires: the page and the download stop after the chosen time", async () => {
    const t = await setup();
    const r = await uploadShare(t, { expiresInSeconds: "3600" });
    const page = await openPage(t, pathOf(r.body.link.url));
    t.advance(3600_000 + 1000);
    expect((await openPage(t, pathOf(r.body.link.url))).status).toBe(410);
    expect((await download(t, pathOf(r.body.link.url), { ft: page.ft })).status).toBe(410);
    expect((await t.c.get("/api/tools/share")).body.links[0].status).toBe("expired");
  });

  it("refuses an expiry under 1 hour or over 30 days", async () => {
    const t = await setup();
    expect((await uploadShare(t, { expiresInSeconds: "1800" })).status).toBe(400);
    expect((await uploadShare(t, { expiresInSeconds: String(31 * 86400) })).status).toBe(400);
  });

  it("locks the link for 15 minutes after 5 wrong passwords, even for the right one", async () => {
    const t = await setup();
    const r = await uploadShare(t, { expiresInSeconds: "86400", password: "correct horse" });
    const path = pathOf(r.body.link.url);
    const { ft } = await openPage(t, path);
    const pwHash = (await t.db.get<{ password_hash: string }>(sql`select password_hash from tool_shares`))!.password_hash;
    expect(pwHash.startsWith("pbkdf2_sha256$")).toBe(true);
    for (let i = 0; i < 4; i++) {
      const w = await download(t, path, { ft, password: `wrong${i}` });
      expect(w.status).toBe(401);
      expect(w.text).toContain(`${4 - i} ${4 - i === 1 ? "try" : "tries"} left`);
    }
    expect((await download(t, path, { ft, password: "wrong again" })).status).toBe(429);
    expect((await download(t, path, { ft, password: "correct horse" })).status).toBe(429);
    expect((await openPage(t, path)).status).toBe(429);
    t.advance(15 * 60_000 + 1000);
    const ok = await download(t, path, { ft, password: "correct horse" });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("hello world file");
  });

  it("stops at the download limit", async () => {
    const t = await setup();
    const r = await uploadShare(t, { expiresInSeconds: "86400", maxDownloads: "2" });
    const path = pathOf(r.body.link.url);
    const { ft } = await openPage(t, path);
    expect((await download(t, path, { ft })).status).toBe(200);
    expect((await download(t, path, { ft })).status).toBe(200);
    expect((await download(t, path, { ft })).status).toBe(410);
    expect((await openPage(t, path)).html).toContain("used up");
    expect((await t.c.get(`/api/tools/share/${r.body.link.id}`)).body).toMatchObject({ downloads: 2, status: "used_up" });
  });

  it("revoke turns the link off and deletes the file", async () => {
    const t = await setup();
    const r = await uploadShare(t, { expiresInSeconds: "86400" });
    const fileId = (await t.db.get<{ file_id: string }>(sql`select file_id from tool_shares`))!.file_id;
    expect((await t.c.del(`/api/tools/share/${r.body.link.id}`)).body.status).toBe("revoked");
    expect(await t.deps.toolFiles!.get(`kept/${fileId}`)).toBeNull();
    expect((await openPage(t, pathOf(r.body.link.url))).status).toBe(410);
  });

  it("caps live bytes per workspace and in total", async () => {
    const t = await setup();
    const now = t.now();
    await t.db.run(sql`insert into tool_files (id, org_id, kind, bytes, expires_at, created_at) values ('kf_big', ${t.orgId}, 'share', ${100 * 1024 * 1024 - 5}, ${now + 86_400_000}, ${now})`);
    const full = await uploadShare(t, { expiresInSeconds: "3600" });
    expect(full.status).toBe(403);
    expect(full.body.error?.message).toContain("100 MB");
    // Expired rows do not count.
    await t.db.run(sql`update tool_files set expires_at = ${now - 1} where id = 'kf_big'`);
    expect((await uploadShare(t, { expiresInSeconds: "3600" })).status).toBe(201);
    await t.db.run(sql`insert into tool_files (id, org_id, kind, bytes, expires_at, created_at) values ('kf_other', 'org_other', 'share', ${800 * 1024 * 1024 - 5}, ${now + 86_400_000}, ${now})`);
    const global = await uploadShare(t, { expiresInSeconds: "3600" });
    expect(global.status).toBe(503);
    expect(global.body.error?.code).toBe("storage_full");
  });

  it("shares a mail attachment the person can see", async () => {
    const t = await setup();
    const mb = await mailbox(t);
    await t.c.post("/api/mail/send", { mailboxId: mb, to: ["ada@acme.io"], subject: "Invoice", text: "see attached" });
    const msg = await t.db.select({ id: messages.id }).from(messages).where(eq(messages.folder, "inbox")).get();
    await t.db.run(sql`insert into attachments (id, message_id, filename, content_type, size_bytes, content_b64, created_at) values ('att_1', ${msg!.id}, 'inv.pdf', 'application/pdf', 5, ${Buffer.from("%PDF-").toString("base64")}, ${t.now()})`);
    const r = await t.c.post("/api/tools/share/from", { source: "attachment", attachmentId: "att_1", expiresInSeconds: 86400 });
    expect(r.status).toBe(201);
    expect(r.body.link.name).toBe("inv.pdf");
    expect((await t.c.post("/api/tools/share/from", { source: "attachment", attachmentId: "att_nope", expiresInSeconds: 86400 })).status).toBe(404);
  });

  it("names browser families only", () => {
    expect(agentFamily("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(agentFamily("curl/8.0")).toBe("Script or bot");
    expect(agentFamily(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E-sign
// ---------------------------------------------------------------------------
async function draft(t: Awaited<ReturnType<typeof setup>>) {
  const fd = new FormData();
  fd.append("file", new Blob([PDF], { type: "application/pdf" }), "Contract.pdf");
  const req = new Request("http://localhost/x", { method: "POST", body: fd });
  const bytes = new Uint8Array(await req.arrayBuffer());
  const res = await t.app.request("/api/tools/esign/documents", { method: "POST", body: bytes, headers: { cookie: t.c.cookie, host: "localhost", "content-type": req.headers.get("content-type")!, "content-length": String(bytes.byteLength), "x-multies-upload": "1" } });
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  const pages = await t.c.get(`/api/tools/esign/${id}/pages`);
  expect(pages.body.status).toBe("done");
  return { id, pages: pages.body.pages as { page: number; width: number; height: number; img?: string }[] };
}

/** Signing links sent so far, newest last, from the sent copies in the mailbox. */
async function links(t: Awaited<ReturnType<typeof setup>>, to: string) {
  const rows = await t.db.select({ text: messages.text, to: messages.to, inReplyTo: messages.inReplyTo, folder: messages.folder }).from(messages).where(eq(messages.folder, "sent")).all();
  return rows.filter((r) => r.to.includes(to)).map((r) => ({ path: r.text.match(/\/sign\/([A-Za-z0-9_-]{43})/)?.[0] ?? "", inReplyTo: r.inReplyTo })).filter((r) => r.path);
}

async function signPost(t: Awaited<ReturnType<typeof setup>>, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await t.app.request(path, { method: "POST", body: JSON.stringify(body), headers: { host: "localhost", "content-type": "application/json", origin: "http://localhost", "cf-ipcountry": "NP", ...headers } });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function thread(t: Awaited<ReturnType<typeof setup>>, mb: string) {
  await t.c.post("/api/mail/send", { mailboxId: mb, to: ["bob@example.com"], subject: "Contract for Q4", text: "Here it is" });
  return (await t.db.select({ id: messages.id, header: messages.messageIdHeader }).from(messages).where(and(eq(messages.folder, "sent"), eq(messages.subject, "Contract for Q4"))).get())!;
}

const FIELDS = [
  { signer: 0, kind: "signature", page: 1, x: 60, y: 700, w: 180, h: 50 },
  { signer: 0, kind: "date", page: 1, x: 300, y: 710, w: 100, h: 20 },
  { signer: 1, kind: "signature", page: 2, x: 60, y: 650, w: 180, h: 50 },
];

describe("Tools P2 e-sign", () => {
  it("reads page sizes from the engine's pages.json, else the PDF's MediaBox", async () => {
    const t = await setup();
    const { pages } = await draft(t);
    expect(pages.map((p) => [p.page, p.width, p.height])).toEqual([[1, 595.28, 841.89], [2, 612, 792]]);
    // A short PDF with readable pages gets sharp JPEG previews; the sizes come from its MediaBox.
    expect([...t.engine.jobs.values()].some((j) => j.op === "to-jpeg" && j.form.get("dpi") === "72")).toBe(true);
    expect(pages[0].img).toMatch(/^data:image\/jpeg;base64,/);
    expect(mediaBoxes(new TextEncoder().encode(PDF))).toEqual([[595.28, 841.89], [612, 792]]);
    // Writers that put /MediaBox before /Type /Page (ReportLab and others) are read too.
    const before = "%PDF-1.4\n4 0 obj\n<<\n/Contents 9 0 R /MediaBox [ 0 0 595.2756 841.8898 ] /Parent 8 0 R /Rotate 0\n  /Type /Page\n>>\nendobj\n5 0 obj\n<< /MediaBox [ 0 0 842 595 ] /Type /Page >>\nendobj\n8 0 obj\n<< /Count 2 /Kids [ 4 0 R 5 0 R ] /Type /Pages >>\nendobj\n";
    expect(mediaBoxes(new TextEncoder().encode(before))).toEqual([[595.2756, 841.8898], [842, 595]]);
    const zip = zipSync({ "page-001.png": png(200, 283) });
    expect(pageListFromZip(zip, null)).toEqual([{ page: 1, width: 595.28, height: 841.89 }]);
  });

  it("in sequence: one link at a time, in the thread; links are single use; the finished copy goes back to everyone with a record that matches D1", async () => {
    const t = await setup();
    const mb = await mailbox(t);
    const parent = await thread(t, mb);
    const { id } = await draft(t);
    const sent = await t.c.post(`/api/tools/esign/${id}/send`, {
      signers: [{ name: "Bob Builder", email: "bob@example.com" }, { name: "Cara Lee", email: "cara@example.com" }],
      order: "sequence", fields: FIELDS, message: "Please sign by Friday", inReplyToId: parent.id, expiresDays: 14, remindDays: 0,
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: "out", orderMode: "sequence", waitingOn: ["Bob Builder"] });
    // Only the first signer has a link; it went in the same thread.
    const bob = await links(t, "bob@example.com");
    expect(bob).toHaveLength(1);
    expect(bob[0].inReplyTo).toBe(parent.header);
    expect(await links(t, "cara@example.com")).toHaveLength(0);
    const caraRow = await t.db.get<{ token_hash: string | null; status: string }>(sql`select token_hash, status from sign_signers where email = 'cara@example.com'`);
    expect(caraRow).toEqual({ token_hash: null, status: "waiting" });

    const page = await openPage(t, bob[0].path);
    expect(page.status).toBe(200);
    expect(page.html).toContain("Contract.pdf");
    expect(page.html).toContain("Please sign by Friday");
    expect(page.html).toContain("Some documents, such as wills, powers of attorney");
    expect(page.html).not.toContain("cara@example.com");
    expect(page.html).toContain('src="/sign/_/sign.js"');
    expect((await t.app.request(`${bob[0].path}/document`, { headers: { host: "localhost" } })).headers.get("content-type")).toBe("application/pdf");
    expect((await t.app.request(`${bob[0].path}/page/1`, { headers: { host: "localhost" } })).status).toBe(200);
    expect((await t.app.request(`${bob[0].path}/page/2`, { headers: { host: "localhost" } })).status).toBe(404);
    // Blocked without the form token or from another site.
    expect((await signPost(t, bob[0].path, { action: "sign", images: [pngUrl(), pngUrl()] })).status).toBe(403);
    expect((await signPost(t, bob[0].path, { ft: page.ft, action: "sign", images: [pngUrl(), pngUrl()] }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await signPost(t, bob[0].path, { ft: page.ft, action: "sign", images: [pngUrl()] })).status).toBe(409);
    expect((await signPost(t, bob[0].path, { ft: page.ft, action: "sign", images: [pngUrl(), pngUrl()] })).body).toMatchObject({ ok: true, finished: false });
    // Single use: the same link cannot sign again.
    expect((await signPost(t, bob[0].path, { ft: page.ft, action: "sign", images: [pngUrl(), pngUrl()] })).status).toBe(409);
    expect((await openPage(t, bob[0].path)).html).toContain("When everyone has signed, the signed copy is emailed to you.");

    // Now Cara's turn: her link arrives.
    const cara = await links(t, "cara@example.com");
    expect(cara).toHaveLength(1);
    const cp = await openPage(t, cara[0].path);
    expect(cp.html).toContain("Swipe sideways to read the whole page");
    expect((await signPost(t, cara[0].path, { ft: cp.ft, action: "sign", images: [pngUrl()] })).body).toMatchObject({ ok: true, finished: true });
    // R67: the last signer hears everyone has signed (the finished copy may still be on its way).
    expect((await openPage(t, cara[0].path)).html).toContain("Everyone has signed.");

    // The engine got every signature and the signing record, word for word from D1.
    const signJob = [...t.engine.jobs.values()].find((j) => j.op === "sign")!;
    const auditSent = JSON.parse(String(signJob.form.get("audit")));
    const sigs = JSON.parse(String(signJob.form.get("signatures")));
    expect(sigs).toHaveLength(3);
    // The PDF under "files", the three signature pictures under "images" (the engine's extra files field).
    expect(signJob.form.getAll("files")).toHaveLength(1);
    expect(signJob.form.getAll("images")).toHaveLength(3);
    expect(sigs.every((s: { date?: string }) => /^\d{4}-\d{2}-\d{2}$/.test(s.date ?? ""))).toBe(true);
    const rowsBefore = await t.db.all<{ at: number; name: string; email: string; action: string; ip_country: string | null }>(sql`select at, name, email, action, ip_country from sign_events where request_id = ${id} order by seq`);
    expect(auditSent.document_sha256).toBe(createHash("sha256").update(PDF).digest("hex"));
    expect(auditSent.events.map((e: { who: string; email: string; at: string; ip_country: string }) => [e.who, e.email, e.at, e.ip_country])).toEqual(rowsBefore.map((r) => [r.name, r.email, new Date(r.at).toISOString(), r.ip_country ?? ""]));
    expect(rowsBefore.map((r) => r.action)).toEqual(["created", "sent", "viewed", "signed", "sent", "viewed", "signed"]);
    expect(rowsBefore.filter((r) => r.action === "signed").map((r) => r.ip_country)).toEqual(["NP", "NP"]);

    // The request page moves it on: completed, with the record, and the finished copy in the thread to everyone.
    const done = await t.c.get(`/api/tools/esign/${id}`);
    expect(done.body).toMatchObject({ status: "completed", finalSha256: "ab".repeat(32), downloadUrl: `/api/tools/esign/${id}/download` });
    const rowsAfter = await t.db.all<{ at: number; name: string; email: string; action: string; ip_country: string | null }>(sql`select at, name, email, action, ip_country from sign_events where request_id = ${id} order by seq`);
    expect(done.body.events.map((e: { name: string; email: string; action: string; at: string; ipCountry: string | null }) => [e.name, e.email, e.action, e.at, e.ipCountry])).toEqual(rowsAfter.map((r) => [r.name, r.email, r.action, new Date(r.at).toISOString(), r.ip_country]));
    expect(rowsAfter.at(-1)!.action).toBe("completed");
    const finalMail = await t.db.select({ to: messages.to, inReplyTo: messages.inReplyTo, has: messages.hasAttachments, id: messages.id }).from(messages).where(and(eq(messages.folder, "sent"), eq(messages.hasAttachments, true))).all();
    expect(finalMail).toHaveLength(1);
    expect(finalMail[0].to).toContain("bob@example.com");
    expect(finalMail[0].to).toContain("cara@example.com");
    expect(finalMail[0].inReplyTo).toBe(parent.header);
    const att = await t.db.get<{ filename: string }>(sql`select filename from attachments where message_id = ${finalMail[0].id}`);
    expect(att!.filename).toBe("Contract (signed).pdf");
    const file = await t.app.request(`/api/tools/esign/${id}/download`, { headers: { cookie: t.c.cookie, host: "localhost" } });
    expect(await file.text()).toBe(SIGNED);
  });

  it("signing links expire with the request", async () => {
    const t = await setup();
    const mb = await mailbox(t);
    const { id } = await draft(t);
    await t.c.post(`/api/tools/esign/${id}/send`, { signers: [{ name: "Bob", email: "bob@example.com" }], fields: [FIELDS[0]], mailboxId: mb, expiresDays: 2, remindDays: 0 });
    const [l] = await links(t, "bob@example.com");
    const page = await openPage(t, l.path);
    t.advance(2 * 86_400_000 + 1000);
    expect((await openPage(t, l.path)).html).toContain("no longer active");
    expect((await signPost(t, l.path, { ft: page.ft, action: "sign", images: [pngUrl()] })).status).toBe(409);
    expect((await runSignPass(t.deps)).expired).toBe(1);
    expect((await t.c.get(`/api/tools/esign/${id}`)).body.status).toBe("expired");
    expect((await openPage(t, l.path)).status).toBe(404);
  });

  it("decline closes the request and tells the sender", async () => {
    const t = await setup();
    const mb = await mailbox(t);
    const { id } = await draft(t);
    await t.c.post(`/api/tools/esign/${id}/send`, { signers: [{ name: "Bob", email: "bob@example.com" }, { name: "Cara", email: "cara@example.com" }], order: "any", fields: FIELDS, mailboxId: mb, expiresDays: 7, remindDays: 0 });
    const [b] = await links(t, "bob@example.com");
    const [cl] = await links(t, "cara@example.com");
    const page = await openPage(t, b.path);
    expect((await signPost(t, b.path, { ft: page.ft, action: "decline", reason: "Wrong amount on page 2" })).status).toBe(200);
    const d = await t.c.get(`/api/tools/esign/${id}`);
    expect(d.body.status).toBe("declined");
    expect(d.body.signers[0]).toMatchObject({ status: "declined", declineReason: "Wrong amount on page 2" });
    expect((await openPage(t, cl.path)).html).toContain("no longer active");
    const told = await t.db.select({ subject: messages.subject }).from(messages).where(eq(messages.folder, "inbox")).all();
    expect(told.some((m) => m.subject.includes("Bob declined to sign Contract.pdf"))).toBe(true);
  });

  it("reminds after N days with a fresh link; the older link stops working", async () => {
    const t = await setup();
    const mb = await mailbox(t);
    const { id } = await draft(t);
    await t.c.post(`/api/tools/esign/${id}/send`, { signers: [{ name: "Bob", email: "bob@example.com" }], fields: [FIELDS[0]], mailboxId: mb, expiresDays: 14, remindDays: 3 });
    expect((await runSignPass(t.deps)).reminded).toBe(0);
    t.advance(3 * 86_400_000 + 1000);
    expect((await runSignPass(t.deps)).reminded).toBe(1);
    const all = await links(t, "bob@example.com");
    expect(all).toHaveLength(2);
    expect((await openPage(t, all[0].path)).status).toBe(404);
    expect((await openPage(t, all[1].path)).status).toBe(200);
    expect((await runSignPass(t.deps)).reminded).toBe(0);
    const ev = await t.db.all<{ action: string }>(sql`select action from sign_events where request_id = ${id} order by seq`);
    expect(ev.map((e) => e.action)).toContain("reminded");
  });

  it("sign yourself: places the pictures and keeps the signed copy for download", async () => {
    const t = await setup();
    const { id } = await draft(t);
    const r = await t.c.post(`/api/tools/esign/${id}/self`, { fields: [{ kind: "signature", page: 1, x: 50, y: 50, w: 150, h: 40 }, { kind: "initials", page: 2, x: 500, y: 740, w: 60, h: 30 }], images: [pngUrl(), pngUrl()] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "self", status: "completed" });
    const job = [...t.engine.jobs.values()].find((j) => j.op === "sign")!;
    expect(job.form.get("audit")).toBeNull();
    expect(JSON.parse(String(job.form.get("signatures")))[1]).toMatchObject({ page: 2, image: 1 });
    expect((await t.c.post(`/api/tools/esign/${id}/self`, { fields: [{ kind: "signature", page: 1, x: 50, y: 50, w: 150, h: 40 }], images: [pngUrl()] })).status).toBe(400);
    expect((await t.c.post(`/api/tools/esign/${(await draft(t)).id}/self`, { fields: [{ kind: "signature", page: 9, x: 50, y: 50, w: 150, h: 40 }], images: [pngUrl()] })).status).toBe(400);
    expect((await t.c.post(`/api/tools/esign/${(await draft(t)).id}/self`, { fields: [{ kind: "signature", page: 1, x: 50, y: 50, w: 150, h: 40 }], images: ["data:image/png;base64,AAAA"] })).status).toBe(400);
  });

  it("cancel stops every link and lists the request as cancelled; members only see their own", async () => {
    const t = await setup();
    const mb = await mailbox(t);
    const { id } = await draft(t);
    await t.c.post(`/api/tools/esign/${id}/send`, { signers: [{ name: "Bob", email: "bob@example.com" }], fields: [FIELDS[0]], mailboxId: mb, expiresDays: 7, remindDays: 0 });
    const [l] = await links(t, "bob@example.com");
    expect((await t.c.post(`/api/tools/esign/${id}/cancel`)).body.status).toBe("cancelled");
    expect((await openPage(t, l.path)).status).toBe(404);
    const list = await t.c.get("/api/tools/esign");
    expect(list.body.requests[0]).toMatchObject({ id, status: "cancelled" });
    expect(list.body.note).toContain("Electronic signatures suit most everyday business documents.");
  });

  it("refuses a non PDF and a signer without a field", async () => {
    const t = await setup();
    const fd = new FormData();
    fd.append("file", new Blob(["not a pdf"], { type: "application/pdf" }), "x.pdf");
    const req = new Request("http://localhost/x", { method: "POST", body: fd });
    const bytes = new Uint8Array(await req.arrayBuffer());
    const res = await t.app.request("/api/tools/esign/documents", { method: "POST", body: bytes, headers: { cookie: t.c.cookie, host: "localhost", "content-type": req.headers.get("content-type")!, "content-length": String(bytes.byteLength), "x-multies-upload": "1" } });
    expect(res.status).toBe(422);
    const mb = await mailbox(t);
    const { id } = await draft(t);
    const r = await t.c.post(`/api/tools/esign/${id}/send`, { signers: [{ name: "Bob", email: "bob@example.com" }, { name: "Cara", email: "cara@example.com" }], fields: [FIELDS[0]], mailboxId: mb, expiresDays: 7, remindDays: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("Cara");
  });
});
