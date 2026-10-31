/**
 * R107 e-sign v2 (ESIGN_V2): the email code that identifies a signer (tries, expiry, single use, gap and hourly cap),
 * consent before signing, the code bound to the link, one signer's link cannot sign for another, the append only
 * record with IP hash, device, time zone and document fingerprint, the workspace seal and the public check,
 * templates (who may use and delete), sending to a list, and that old links (v2 = 0) still sign without a code.
 * Emails go to the test outbox only (example.com addresses).
 */
import { describe, it, expect } from "vitest";
import { createHmac, createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { messages, users, members, sessions, mailboxAccess } from "@/server/db/schema";
import { MemoryToolFileStore } from "@/server/services/tools/p2-bindings";
import { runSignPass } from "@/server/services/tools/esign";
import { CODE_MAX_PER_HOUR, CODE_MAX_TRIES, CODE_MIN_GAP_MS, CODE_TTL_MS, cleanRoles, cleanPeople, parseList, sendPending, verifyByHash, maskEmail, validTz, deviceOf } from "@/server/services/tools/esign-v2";

const ENGINE_KEY = "k".repeat(40);
const ON = { ESIGN_V2: "on", TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: ENGINE_KEY, TOOLS_TOKEN_KEY: "t".repeat(40), TOOLS_FEATURES: "share,esign", APP_URL: "http://localhost" };
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


async function openPage(t: Awaited<ReturnType<typeof setup>>, path: string) {
  const res = await t.app.request(path, { headers: { host: "localhost" } });
  const html = await res.text();
  return { status: res.status, html, headers: res.headers, ft: html.match(/name="ft" value="([a-f0-9]+)"/)?.[1] ?? html.match(/data-ft="([a-f0-9]+)"/)?.[1] ?? "" };
}


const FIELDS = [
  { signer: 0, kind: "signature", page: 1, x: 60, y: 700, w: 180, h: 50 },
  { signer: 0, kind: "text", page: 1, x: 300, y: 710, w: 100, h: 20, label: "Job title" },
  { signer: 1, kind: "signature", page: 2, x: 60, y: 650, w: 180, h: 50 },
  { signer: 1, kind: "checkbox", page: 2, x: 300, y: 650, w: 20, h: 20, label: "I accept" },
];
type T = Awaited<ReturnType<typeof setup>>;

/** The latest code emailed to an address (system mail goes to the test outbox). */
function codeFor(t: T, to: string): string {
  const m = [...t.outbound.sent].reverse().find((x) => JSON.stringify(x.to).includes(to) && /Your code to sign/.test(x.subject));
  return m ? (String(m.text).match(/Your code is (\d{6})/)?.[1] ?? "") : "";
}
const codesSent = (t: T, to: string) => t.outbound.sent.filter((x) => JSON.stringify(x.to).includes(to) && /Your code to sign/.test(x.subject)).length;

async function two(t: T, order: "any" | "sequence" = "any", extra: Record<string, unknown> = {}) {
  const mb = await mailbox(t);
  const { id } = await draft(t);
  const sent = await t.c.post(`/api/tools/esign/${id}/send`, { signers: [{ name: "Bob Builder", email: "bob@example.com" }, { name: "Cara Lee", email: "cara@example.com" }], order, fields: FIELDS, mailboxId: mb, expiresDays: 7, remindDays: 0, ...extra });
  expect(sent.status).toBe(200);
  return { id, mb };
}

/** Opens the link, asks for a code, checks it. */
async function verify(t: T, path: string, email: string) {
  const p = await openPage(t, path);
  expect((await signPost(t, path, { ft: p.ft, action: "code_send" })).status).toBe(200);
  expect((await signPost(t, path, { ft: p.ft, action: "code_check", code: codeFor(t, email) })).status).toBe(200);
  return p;
}

async function member(t: T, email: string, mailboxIds: string[]) {
  const c = new Client(t.app);
  await c.signup(email, "Mo Member", "");
  const u = (await t.db.select().from(users).where(eq(users.email, email)).get())!;
  await t.db.insert(members).values({ id: `mem_${u.id}`, organizationId: t.orgId, userId: u.id, role: "member" });
  await t.db.update(sessions).set({ activeOrganizationId: t.orgId }).where(eq(sessions.userId, u.id));
  for (const m of mailboxIds) await t.db.insert(mailboxAccess).values({ orgId: t.orgId, userId: u.id, mailboxId: m });
  return c;
}

describe("R107 e-sign v2: the email code", () => {
  it("v2 requests are marked and the signer page asks for the code first", async () => {
    const t = await setup();
    const { id } = await two(t);
    expect((await t.db.get<{ v2: number }>(sql`select v2 from sign_requests where id = ${id}`))!.v2).toBe(1);
    const [b] = await links(t, "bob@example.com");
    const p = await openPage(t, b.path);
    expect(p.status).toBe(200);
    expect(p.html).not.toContain("cara@example.com");
    // No code yet: signing and declining are refused.
    expect((await signPost(t, b.path, { ft: p.ft, action: "sign", consent: true, images: [pngUrl(), pngUrl()] })).status).toBe(409);
    expect((await signPost(t, b.path, { ft: p.ft, action: "decline", reason: "No" })).status).toBe(403);
  });

  it("wrong codes count down to the limit; then even the right code is refused until a new one is sent", async () => {
    const t = await setup();
    await two(t);
    const [b] = await links(t, "bob@example.com");
    const p = await openPage(t, b.path);
    const sent = await signPost(t, b.path, { ft: p.ft, action: "code_send" });
    expect(sent.body.message).toContain(maskEmail("bob@example.com"));
    expect(sent.body.message).not.toContain("bob@example.com");
    const good = codeFor(t, "bob@example.com");
    expect(good).toMatch(/^\d{6}$/);
    const wrong = good === "000000" ? "111111" : "000000";
    expect((await signPost(t, b.path, { ft: p.ft, action: "code_check", code: "12ab" })).status).toBe(400);
    for (let i = 1; i <= CODE_MAX_TRIES; i++) {
      const r = await signPost(t, b.path, { ft: p.ft, action: "code_check", code: wrong });
      expect(r.status).toBe(400);
      if (i < CODE_MAX_TRIES) expect(String(r.body.message)).toContain(`${CODE_MAX_TRIES - i} ${CODE_MAX_TRIES - i === 1 ? "try" : "tries"} left`);
    }
    expect((await signPost(t, b.path, { ft: p.ft, action: "code_check", code: good })).status).toBe(429);
    // A new code resets the count.
    t.advance(CODE_MIN_GAP_MS);
    expect((await signPost(t, b.path, { ft: p.ft, action: "code_send" })).status).toBe(200);
    expect((await signPost(t, b.path, { ft: p.ft, action: "code_check", code: codeFor(t, "bob@example.com") })).status).toBe(200);
    const ev = await t.db.all<{ action: string }>(sql`select action from sign_events where action like 'code%' or action = 'identity_checked' order by seq`);
    expect(ev.filter((e) => e.action === "code_wrong")).toHaveLength(CODE_MAX_TRIES);
    expect(ev.at(-1)!.action).toBe("identity_checked");
  });

  it("a code expires after 10 minutes and works only once", async () => {
    const t = await setup();
    await two(t);
    const [b] = await links(t, "bob@example.com");
    const p = await openPage(t, b.path);
    await signPost(t, b.path, { ft: p.ft, action: "code_send" });
    const c1 = codeFor(t, "bob@example.com");
    t.advance(CODE_TTL_MS + 1);
    expect((await signPost(t, b.path, { ft: p.ft, action: "code_check", code: c1 })).status).toBe(409);
    await signPost(t, b.path, { ft: p.ft, action: "code_send" });
    const c2 = codeFor(t, "bob@example.com");
    expect(c2).toMatch(/^\d{6}$/);
    expect((await signPost(t, b.path, { ft: p.ft, action: "code_check", code: c2 })).status).toBe(200);
    expect((await signPost(t, b.path, { ft: p.ft, action: "code_check", code: c2 })).status).toBe(409);
    // The hash is gone from the row once used.
    const row = await t.db.get<{ code_hash: string | null; verified_at: number | null }>(sql`select code_hash, verified_at from sign_signers where email = 'bob@example.com'`);
    expect(row!.code_hash).toBeNull();
    expect(row!.verified_at).not.toBeNull();
    // The code itself is never stored or written to the record.
    const all = JSON.stringify(await t.db.all(sql`select * from sign_events`)) + JSON.stringify(await t.db.all(sql`select * from sign_signers`));
    expect(all).not.toContain(c2);
  });

  it("asks wait 60 seconds between codes and allow 5 an hour", async () => {
    const t = await setup();
    await two(t);
    const [b] = await links(t, "bob@example.com");
    const p = await openPage(t, b.path);
    expect((await signPost(t, b.path, { ft: p.ft, action: "code_send" })).status).toBe(200);
    const again = await t.app.request(b.path, { method: "POST", body: JSON.stringify({ ft: p.ft, action: "code_send" }), headers: { host: "localhost", "content-type": "application/json", origin: "http://localhost" } });
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0);
    for (let i = 1; i < CODE_MAX_PER_HOUR; i++) { t.advance(CODE_MIN_GAP_MS); expect((await signPost(t, b.path, { ft: p.ft, action: "code_send" })).status).toBe(200); }
    t.advance(CODE_MIN_GAP_MS);
    const capped = await signPost(t, b.path, { ft: p.ft, action: "code_send" });
    expect(capped.status).toBe(429);
    expect(String(capped.body.message)).toContain("hour");
    expect(codesSent(t, "bob@example.com")).toBe(CODE_MAX_PER_HOUR);
    t.advance(3_600_000);
    expect((await signPost(t, b.path, { ft: p.ft, action: "code_send" })).status).toBe(200);
  });

  it("the check is bound to the link: a reminder replaces the link, and the new link needs a new code", async () => {
    const t = await setup();
    await two(t, "any", { remindDays: 1 });
    const [b1] = await links(t, "bob@example.com");
    const p1 = await verify(t, b1.path, "bob@example.com");
    t.advance(86_400_000 + 60_000);
    await runSignPass(t.deps);
    const all = await links(t, "bob@example.com");
    expect(all.length).toBe(2);
    const b2 = all.at(-1)!;
    expect(b2.path).not.toBe(b1.path);
    expect((await openPage(t, b1.path)).status).toBe(404);
    expect((await signPost(t, b1.path, { ft: p1.ft, action: "sign", consent: true, images: [pngUrl(), pngUrl()] })).status).toBe(404);
    const p2 = await openPage(t, b2.path);
    const r = await signPost(t, b2.path, { ft: p2.ft, action: "sign", consent: true, images: [pngUrl(), pngUrl()] });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toContain("code");
    await verify(t, b2.path, "bob@example.com");
    expect((await signPost(t, b2.path, { ft: p2.ft, action: "sign", consent: true, images: [pngUrl(), pngUrl()] })).status).toBe(200);
  });
});

describe("R107 e-sign v2: consent, signers and the record", () => {
  it("no sign without consent; one signer's link and form token cannot act for another", async () => {
    const t = await setup();
    await two(t);
    const [b] = await links(t, "bob@example.com");
    const [cl] = await links(t, "cara@example.com");
    const pb = await verify(t, b.path, "bob@example.com");
    const nc = await signPost(t, b.path, { ft: pb.ft, action: "sign", images: [pngUrl(), pngUrl()] });
    expect(nc.status).toBe(409);
    expect(String(nc.body.message)).toContain("agree");
    expect((await signPost(t, b.path, { ft: pb.ft, action: "sign", consent: "yes", images: [pngUrl(), pngUrl()] })).status).toBe(409);
    // Bob's form token on Cara's link is blocked, and Bob's check does not open Cara's link.
    expect((await signPost(t, cl.path, { ft: pb.ft, action: "code_send" })).status).toBe(403);
    const pc = await openPage(t, cl.path);
    expect((await signPost(t, cl.path, { ft: pc.ft, action: "sign", consent: true, images: [pngUrl(), pngUrl()] })).status).toBe(409);
    // Bob's code does not work on Cara's link.
    await signPost(t, cl.path, { ft: pc.ft, action: "code_send" });
    t.advance(CODE_MIN_GAP_MS);
    await signPost(t, b.path, { ft: pb.ft, action: "code_send" });
    expect((await signPost(t, cl.path, { ft: pc.ft, action: "code_check", code: codeFor(t, "bob@example.com") })).status).not.toBe(200);
    // Cara's page shows her fields only (page 2), not Bob's page 1.
    expect((await t.app.request(`${cl.path}/page/1`, { headers: { host: "localhost" } })).status).toBe(404);
    expect((await signPost(t, b.path, { ft: pb.ft, action: "sign", consent: true, tz: "Australia/Sydney", images: [pngUrl(), pngUrl()] })).body).toMatchObject({ ok: true, finished: false });
    const s = await t.db.all<{ email: string; status: string }>(sql`select email, status from sign_signers order by position`);
    expect(s[0]).toEqual({ email: "bob@example.com", status: "signed" });
    expect(s[1].status).not.toBe("signed");
  });

  it("each event keeps an IP hash (never the address), the device, the time zone and the document fingerprint; the record cannot be changed", async () => {
    const t = await setup();
    const { id } = await two(t);
    const [b] = await links(t, "bob@example.com");
    const ip = "203.0.113.77";
    const p = await openPage(t, b.path);
    const hdr = { "cf-connecting-ip": ip, "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" };
    await signPost(t, b.path, { ft: p.ft, action: "code_send", tz: "Australia/Sydney" }, hdr);
    await signPost(t, b.path, { ft: p.ft, action: "code_check", code: codeFor(t, "bob@example.com"), tz: "Australia/Sydney" }, hdr);
    expect((await signPost(t, b.path, { ft: p.ft, action: "sign", consent: true, tz: "Australia/Sydney", images: [pngUrl(), pngUrl()] }, hdr)).status).toBe(200);
    const ev = await t.db.get<{ ip_hash: string | null; user_agent: string | null; tz: string | null; doc_sha256: string | null; detail: string | null }>(sql`select ip_hash, user_agent, tz, doc_sha256, detail from sign_events where request_id = ${id} and action = 'signed'`);
    expect(ev!.ip_hash).toMatch(/^[a-f0-9]{16,64}$/);
    expect(ev!.ip_hash).not.toContain(ip);
    expect(ev!.user_agent).toContain("iPhone");
    expect(ev!.tz).toBe("Australia/Sydney");
    expect(ev!.doc_sha256).toBe(createHash("sha256").update(PDF).digest("hex"));
    expect(ev!.detail).toContain("agree to sign it electronically");
    expect(ev!.detail).toContain("Filled 1 field");
    expect(JSON.stringify(await t.db.all(sql`select * from sign_events`))).not.toContain(ip);
    // A bad time zone is dropped, not stored.
    expect(validTz("Not/AZone")).toBeNull();
    expect(validTz("Australia/Sydney")).toBe("Australia/Sydney");
    expect(deviceOf(hdr["user-agent"])).toContain("iPhone");
    // Append only.
    let err: { cause?: unknown } | null = null;
    try { await t.db.run(sql`update sign_events set detail = 'changed' where request_id = ${id}`); } catch (e) { err = e as { cause?: unknown }; }
    expect(String(err?.cause ?? err)).toContain("append only");
    // The record download carries the same fields.
    const rec = await t.app.request(`/api/tools/esign/${id}/record`, { headers: { cookie: t.c.cookie, host: "localhost" } });
    expect(rec.status).toBe(200);
    const j = await rec.json() as { consent_text: string; events: { what: string; ip_hash: string | null; time_zone: string | null; at_local: string | null; device: string | null }[] };
    const signed = j.events.find((e) => e.ip_hash && e.time_zone === "Australia/Sydney" && /sign/i.test(e.what))!;
    expect(signed.at_local).toBeTruthy();
    expect(signed.device).toContain("iPhone");
  });

  it("in order: the second signer gets a link only after the first signs; parallel: both at once", async () => {
    const t = await setup();
    await two(t, "sequence");
    expect(await links(t, "cara@example.com")).toHaveLength(0);
    const [b] = await links(t, "bob@example.com");
    const p = await verify(t, b.path, "bob@example.com");
    await signPost(t, b.path, { ft: p.ft, action: "sign", consent: true, images: [pngUrl(), pngUrl()] });
    expect(await links(t, "cara@example.com")).toHaveLength(1);
    const t2 = await setup();
    await two(t2, "any");
    expect(await links(t2, "bob@example.com")).toHaveLength(1);
    expect(await links(t2, "cara@example.com")).toHaveLength(1);
  });

  it("a declined request closes for everyone and the reason is kept", async () => {
    const t = await setup();
    const { id } = await two(t);
    const [b] = await links(t, "bob@example.com");
    const [cl] = await links(t, "cara@example.com");
    const p = await verify(t, b.path, "bob@example.com");
    expect((await signPost(t, b.path, { ft: p.ft, action: "decline", reason: "Wrong amount" })).status).toBe(200);
    expect((await t.c.get(`/api/tools/esign/${id}`)).body.status).toBe("declined");
    const pc = await openPage(t, cl.path);
    expect(pc.html).not.toContain("Wrong amount");
    expect((await signPost(t, cl.path, { ft: pc.ft, action: "code_send" })).status).not.toBe(200);
    expect(codesSent(t, "cara@example.com")).toBe(0);
    const ev = await t.db.get<{ detail: string }>(sql`select detail from sign_events where request_id = ${id} and action = 'declined'`);
    expect(ev!.detail).toBe("Wrong amount");
  });
});

describe("R107 e-sign v2: seal and public check", () => {
  it("seals the finished copy with the workspace key; the check page finds it by fingerprint; a changed file is not found", async () => {
    const t = await setup();
    const { id } = await two(t);
    for (const who of ["bob@example.com", "cara@example.com"]) {
      const [l] = await links(t, who);
      const p = await verify(t, l.path, who);
      expect((await signPost(t, l.path, { ft: p.ft, action: "sign", consent: true, images: [pngUrl(), pngUrl()] })).status).toBe(200);
    }
    const done = await t.c.get(`/api/tools/esign/${id}`);
    expect(done.body.status).toBe("completed");
    const row = await t.db.get<{ seal: string | null; seal_key_id: string | null; final_sha256: string }>(sql`select seal, seal_key_id, final_sha256 from sign_requests where id = ${id}`);
    expect(row!.seal).toBeTruthy();
    expect(row!.seal_key_id).toMatch(/^esk_/);
    // The private key is stored encrypted and never in the record.
    const k = await t.db.get<{ private_enc: string; public_jwk: string }>(sql`select private_enc, public_jwk from esign_keys where org_id = ${t.orgId}`);
    expect(k!.private_enc).not.toContain('"d"');
    expect(JSON.parse(k!.public_jwk).d).toBeUndefined();
    const found = await t.app.request(`/sign/verify/${row!.final_sha256}`, { headers: { host: "localhost" } });
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ found: true, title: "Contract.pdf", workspace: "Acme", signers: 2, sealed: true, sealValid: true });
    const tampered = "cd".repeat(32);
    expect(await (await t.app.request(`/sign/verify/${tampered}`, { headers: { host: "localhost" } })).json()).toEqual({ found: false });
    expect((await t.app.request(`/sign/verify/nothex`, { headers: { host: "localhost" } })).status).toBe(400);
    // A changed seal or completion time no longer checks out.
    await t.db.run(sql`update sign_requests set completed_at = completed_at + 1000 where id = ${id}`);
    expect(await verifyByHash(t.deps, row!.final_sha256)).toMatchObject({ found: true, sealValid: false });
    const page = await openPage(t, "/sign/verify");
    expect(page.status).toBe(200);
    expect(page.html).toContain("Check a signed document");
    const rec = await (await t.app.request(`/api/tools/esign/${id}/record`, { headers: { cookie: t.c.cookie, host: "localhost" } })).text();
    expect(rec).not.toContain(k!.private_enc);
    expect(rec).toContain("ECDSA P-256");
  });

  it("the check page and templates are off when ESIGN_V2 is off", async () => {
    const t = await setup({ ...ON, ESIGN_V2: "off" });
    expect((await openPage(t, "/sign/verify")).status).toBe(404);
    expect((await t.c.get("/api/tools/esign/templates")).status).toBe(404);
  });
});

describe("R107 e-sign v2: templates and sending to a list", () => {
  async function saved(t: T, roles = ["Client", "Witness"], fields: unknown[] = FIELDS) {
    const { id } = await draft(t);
    const r = await t.c.post(`/api/tools/esign/${id}/template`, { name: "Service agreement", roles, fields, order: "any", expiresDays: 10, remindDays: 0 });
    expect(r.status).toBe(201);
    return r.body as { id: string; roles: string[]; fieldCount: number };
  }

  it("saves, lists and sends from a template; a member can use it but not delete another's; an admin can", async () => {
    const t = await setup();
    const mb = await mailbox(t);
    const tp = await saved(t);
    expect(tp).toMatchObject({ roles: ["Client", "Witness"], fieldCount: 4 });
    const m = await member(t, "mo@example.com", [mb]);
    const list = await m.get("/api/tools/esign/templates");
    expect(list.body.templates).toHaveLength(1);
    expect(list.body.templates[0]).toMatchObject({ id: tp.id, canDelete: false });
    // Wrong signer count is refused.
    expect((await m.post(`/api/tools/esign/templates/${tp.id}/send`, { signers: [{ name: "Bob", email: "bob@example.com" }], mailboxId: mb })).status).toBe(400);
    const sent = await m.post(`/api/tools/esign/templates/${tp.id}/send`, { signers: [{ name: "Bob", email: "bob@example.com" }, { name: "Cara", email: "cara@example.com" }], mailboxId: mb });
    expect(sent.status).toBe(200);
    expect(await links(t, "bob@example.com")).toHaveLength(1);
    expect((await m.del(`/api/tools/esign/templates/${tp.id}`)).status).toBe(403);
    // A member's own template they can delete.
    expect((await t.c.get("/api/tools/esign/templates")).body.templates[0].canDelete).toBe(true);
    expect((await t.c.del(`/api/tools/esign/templates/${tp.id}`)).status).toBe(200);
    expect((await t.c.get("/api/tools/esign/templates")).body.templates).toHaveLength(0);
    // Another workspace cannot see or send it.
    const other = new Client(t.app);
    await other.signup("eve@other.io", "Eve", "Other");
    expect((await other.post(`/api/tools/esign/templates/${tp.id}/send`, { signers: [{ name: "X", email: "x@example.com" }, { name: "Y", email: "y@example.com" }], mailboxId: mb })).status).toBe(404);
  });

  it("refuses a template without a signature for each role and duplicate role names", async () => {
    const t = await setup();
    const { id } = await draft(t);
    expect((await t.c.post(`/api/tools/esign/${id}/template`, { name: "X", roles: ["A", "B"], fields: [FIELDS[0]], order: "any" })).status).toBe(400);
    expect(() => cleanRoles(["A", "a"])).toThrow();
    expect(cleanRoles(["", " Client "])).toEqual(["Signer 1", "Client"]);
    expect(() => cleanPeople([{ name: "A", email: "a@example.com" }, { name: "B", email: "A@example.com" }], 5)).toThrow();
  });

  it("sends a one signer template to a list: one request per person, a few now and the rest claimed once by the pass", async () => {
    const t = await setup();
    const mb = await mailbox(t);
    const tp = await saved(t, ["Client"], [FIELDS[0], FIELDS[1]]);
    const lines = ["Name, Email", ...Array.from({ length: 12 }, (_, i) => `Person ${i + 1}, p${i + 1}@example.com`)].join("\n");
    const r = await t.c.post(`/api/tools/esign/templates/${tp.id}/bulk`, { text: lines, mailboxId: mb });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ count: 12 });
    const now = r.body.sentNow as number;
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThan(12);
    const n1 = await sendPending(t.deps, 100);
    expect(now + n1).toBe(12);
    expect(await sendPending(t.deps, 100)).toBe(0);
    for (let i = 1; i <= 12; i++) expect(await links(t, `p${i}@example.com`)).toHaveLength(1);
    const reqs = await t.db.get<{ n: number }>(sql`select count(*) as n from sign_requests where bulk_id = ${r.body.bulkId} and v2 = 1`);
    expect(Number(reqs!.n)).toBe(12);
    // A two role template cannot go to a list; a line without an address is named.
    const tp2 = await saved(t);
    expect((await t.c.post(`/api/tools/esign/templates/${tp2.id}/bulk`, { text: "a@example.com", mailboxId: mb })).status).toBe(400);
    const bad = await t.c.post(`/api/tools/esign/templates/${tp.id}/bulk`, { text: "ok@example.com\nno address here", mailboxId: mb });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("Line 2");
  });

  it("parses pasted lists", () => {
    expect(parseList("Name, Email\nAda Lovelace, ADA@example.com\nbob@example.com\nCara;cara@example.com\n\nnope")).toEqual({
      rows: [{ name: "Ada Lovelace", email: "ada@example.com" }, { name: "bob", email: "bob@example.com" }, { name: "Cara", email: "cara@example.com" }], bad: [6],
    });
  });
});

describe("R107 e-sign v2: old links", () => {
  it("a request sent before v2 (v2 = 0) still signs with no code or consent", async () => {
    const t = await setup({ ...ON, ESIGN_V2: "off" });
    const mb = await mailbox(t);
    const { id } = await draft(t);
    await t.c.post(`/api/tools/esign/${id}/send`, { signers: [{ name: "Bob", email: "bob@example.com" }], fields: [FIELDS[0]], mailboxId: mb, expiresDays: 7, remindDays: 0 });
    expect((await t.db.get<{ v2: number }>(sql`select v2 from sign_requests where id = ${id}`))!.v2).toBe(0);
    // v2 switched on later: the old link keeps the old flow.
    t.deps.config = { ...t.deps.config, esignV2: true };
    const [b] = await links(t, "bob@example.com");
    const p = await openPage(t, b.path);
    expect((await signPost(t, b.path, { ft: p.ft, action: "code_send" })).status).toBe(400);
    expect((await signPost(t, b.path, { ft: p.ft, action: "sign", images: [pngUrl()] })).body).toMatchObject({ ok: true, finished: true });
  });
});
