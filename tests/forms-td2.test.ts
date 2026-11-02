/**
 * TD2 Forms pro: answer type validators, show, hide, require and disable logic with groups (shared by page and
 * server), file reading and safe names, uploads (size, type, count, rate), file access (other workspace, signed out),
 * server side logic enforcement, deleting a response with its files, and no answers or file names in logs.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { checkAnswers, checkLogic, cleanLogic, fieldError, fieldStates, normaliseUrl, type LogicField } from "@/shared/form-logic";
import { cleanFileName, parseTd2, sniffType, splitPages, steps } from "@/shared/forms-td2";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const f = (x: Partial<LogicField> & { id: string; type: LogicField["type"] }): LogicField => ({ label: x.id, required: false, ...x });

describe("TD2 validators", () => {
  it("checks time, date and time, web address, phone and dates", () => {
    expect(fieldError(f({ id: "t", type: "time" }), "14:30")).toBeNull();
    expect(fieldError(f({ id: "t", type: "time" }), "25:00")).toMatch(/time/);
    expect(fieldError(f({ id: "d", type: "datetime" }), "2026-11-02T09:15")).toBeNull();
    expect(fieldError(f({ id: "d", type: "datetime" }), "2026-02-30T09:15")).toMatch(/date and time/);
    expect(normaliseUrl("example.com/a")).toBe("https://example.com/a");
    expect(normaliseUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseUrl("https://user:pw@example.com")).toBeNull();
    expect(normaliseUrl("http://localhost")).toBeNull();
    expect(fieldError(f({ id: "p", type: "phone" }), "+61 2 9000 0000", false, { strict: true })).toBeNull();
    expect(fieldError(f({ id: "p", type: "phone" }), "call me", false, { strict: true })).toMatch(/phone/);
    expect(fieldError(f({ id: "p", type: "phone" }), "call me")).toBeNull(); // not strict: as before
    expect(fieldError(f({ id: "d", type: "date" }), "2026-02-31", false, { strict: true })).toMatch(/date/);
  });
  it("checks upload answers: ids only, no repeats, the field's count, plain required words", () => {
    const one = "fu_" + "a".repeat(24), two = "fu_" + "b".repeat(24);
    expect(fieldError(f({ id: "f", type: "file", maxFiles: 2 }), `${one}, ${two}`)).toBeNull();
    expect(fieldError(f({ id: "f", type: "file", maxFiles: 1 }), `${one}, ${two}`)).toMatch(/up to 1 file/);
    expect(fieldError(f({ id: "f", type: "file" }), "../../etc/passwd")).toMatch(/again/);
    expect(fieldError(f({ id: "f", type: "file", maxFiles: 3 }), `${one}, ${one}`)).toMatch(/again/);
    expect(fieldError(f({ id: "s", type: "signature" }), `${one}, ${two}`)).toMatch(/up to 1/);
    expect(fieldError(f({ id: "s", type: "signature", required: true }), "")).toBe('Please sign "s".');
    expect(fieldError(f({ id: "f", type: "file", required: true }), "")).toBe('Please add a file for "f".');
  });
  it("normalises a web address answer and skips layout blocks", () => {
    const r = checkAnswers([f({ id: "h", type: "heading" }), f({ id: "u", type: "url" })], { h: "x", u: "example.com" });
    expect(r.answers).toEqual({ u: "https://example.com/" });
  });
});

describe("TD2 logic", () => {
  const fields: LogicField[] = [
    f({ id: "kind", type: "select", options: ["Person", "Business"] }),
    f({ id: "size", type: "number" }),
    f({ id: "abn", type: "text", requireWhen: { join: "all", conditions: [{ field: "kind", op: "is", value: "Business" }] } }),
    f({ id: "promo", type: "text", disableWhen: { join: "any", conditions: [], groups: [{ join: "all", conditions: [{ field: "kind", op: "is", value: "Business" }, { field: "size", op: "gt", value: "50" }] }] } }),
    f({ id: "why", type: "text", logic: { join: "all", conditions: [{ field: "kind", op: "is", value: "Person" }], action: "hide" } }),
    f({ id: "after", type: "text", logic: { join: "all", conditions: [{ field: "promo", op: "answered" }] } }),
  ];
  it("hide, require when and disable when, with groups", () => {
    const s = fieldStates(fields, { kind: "Business", size: "80", promo: "X" });
    expect(s.required.has("abn")).toBe(true);
    expect(s.disabled.has("promo")).toBe(true);
    expect(s.shown.has("why")).toBe(true);
    // A disabled question reads as unanswered, so what depends on it hides too.
    expect(s.shown.has("after")).toBe(false);
    const p = fieldStates(fields, { kind: "Person", promo: "X" });
    expect(p.shown.has("why")).toBe(false);
    expect(p.required.has("abn")).toBe(false);
    expect(p.disabled.has("promo")).toBe(false);
  });
  it("the server drops disabled and hidden answers and enforces required when", () => {
    const r = checkAnswers(fields, { kind: "Business", size: "80", promo: "forced", why: "x" });
    expect(r.errors.abn).toMatch(/fill in/);
    expect(r.answers.promo).toBeUndefined();
    const ok = checkAnswers(fields, { kind: "Person", abn: "", promo: "keep", why: "forced", after: "y" });
    expect(ok.answers).toEqual({ kind: "Person", promo: "keep", after: "y" });
  });
  it("cleans and checks every kind of logic", () => {
    const cleaned = cleanLogic([f({ id: "a", type: "text" }), f({ id: "h", type: "heading" }), f({ id: "b", type: "text", requireWhen: { join: "all", conditions: [{ field: "gone", op: "answered" }, { field: "h", op: "answered" }] }, logic: { join: "all", conditions: [], groups: [{ join: "any", conditions: [{ field: "a", op: "answered" }, { field: "gone", op: "answered" }] }] } })]);
    expect(cleaned[2].requireWhen).toBeNull();
    expect(cleaned[2].logic?.groups?.[0].conditions).toEqual([{ field: "a", op: "answered" }]);
    const later = checkLogic([f({ id: "a", type: "text", disableWhen: { join: "all", conditions: [{ field: "b", op: "answered" }] } }), f({ id: "b", type: "text" })]);
    expect(later[0].code).toBe("later");
    const cycle = checkLogic([f({ id: "a", type: "text", requireWhen: { join: "all", conditions: [{ field: "b", op: "answered" }] } }), f({ id: "b", type: "text", logic: { join: "all", conditions: [{ field: "a", op: "answered" }] } })]);
    expect(cycle.some((p) => p.code === "cycle")).toBe(true);
  });
});

describe("TD2 files and pages", () => {
  it("reads the type from the bytes and refuses scripts", () => {
    expect(sniffType(PNG, "x.exe")?.type).toBe("image/png");
    expect(sniffType(PDF, "a.pdf")?.kind).toBe("pdf");
    expect(sniffType(SVG, "a.svg")).toBeNull();
    expect(sniffType(SVG, "a.txt")).toBeNull();
    expect(sniffType(new TextEncoder().encode("<html><script>1</script>"), "a.csv")).toBeNull();
    expect(sniffType(new TextEncoder().encode("a,b\n1,2\n"), "a.csv")?.type).toBe("text/csv");
    expect(sniffType(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), "a.zip")).toBeNull();
    expect(sniffType(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), "a.docx")?.kind).toBe("documents");
    expect(sniffType(new Uint8Array([0, 1, 2, 3]), "a.txt")).toBeNull();
  });
  it("cleans file names", () => {
    expect(cleanFileName("../../etc/<img src=x onerror=alert(1)>.png", "png")).toBe("img src=x onerror=alert(1).png");
    expect(cleanFileName("C:\\Users\\me\\report.pdf", "pdf")).toBe("report.pdf");
    expect(cleanFileName("..", "png")).toBe("file.png");
    expect(cleanFileName("a".repeat(400) + ".pdf", "pdf").length).toBeLessThanOrEqual(104);
  });
  it("splits pages and steps; reads settings", () => {
    const list = [f({ id: "a", type: "text" }), f({ id: "p1", type: "page" }), f({ id: "h", type: "heading" }), f({ id: "b", type: "text" }), f({ id: "d", type: "divider" })];
    expect(splitPages(list).map((p) => p.map((x) => x.id))).toEqual([["a"], ["h", "b", "d"]]);
    expect(steps(list).map((x) => x.id)).toEqual(["a", "h", "b"]);
    expect(parseTd2(null)).toEqual({ progress: true, oneAtATime: false });
    expect(parseTd2('{"oneAtATime":true,"progress":false}')).toEqual({ progress: false, oneAtATime: true });
  });
});

async function setup(env: Record<string, string> = { FORMS_TD2: "on", FILES_PLUS_R101: "on", APP_URL: "http://localhost" }) {
  const ctx = await makeTestApp(env);
  let clock = Date.parse("2026-11-02T00:00:00Z");
  ctx.deps.now = () => new Date(clock);
  const owner = new Client(ctx.app);
  await owner.signup("ada@acme.io", "Ada Lovelace", "Acme");
  return { ...ctx, owner, advance: (ms: number) => { clock += ms; } };
}
type T = Awaited<ReturnType<typeof setup>>;
async function raw(t: T, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
  const res = await t.app.request(path, { method, body, headers: { host: "localhost", ...headers } });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const upload = (t: T, slug: string, field: string, bytes: Uint8Array, name: string, ip = "10.1.1.1") =>
  raw(t, "POST", `/api/public/forms/${slug}/uploads?field=${field}`, bytes as BodyInit, { "x-multies-upload": "1", "x-file-name": encodeURIComponent(name), "content-type": "application/octet-stream", "cf-connecting-ip": ip, origin: "http://localhost" });
const submit = (t: T, slug: string, answers: Record<string, unknown>, ip = "10.1.1.1") =>
  raw(t, "POST", `/api/public/forms/${slug}`, JSON.stringify({ answers, elapsedMs: 5000 }), { "content-type": "application/json", "cf-connecting-ip": ip });

const FIELDS = [
  { id: "name", label: "Your name", type: "text", required: true },
  { id: "email", label: "Email", type: "email", required: true },
  { id: "p2", label: "Page", type: "page" },
  { id: "intro", label: "Files", type: "heading", text: "Send your papers" },
  { id: "docs", label: "Documents", type: "file", fileTypes: ["pdf", "images"], maxSizeMb: 1, maxFiles: 2 },
  { id: "sig", label: "Signature", type: "signature", required: true },
  { id: "kind", label: "Kind", type: "select", options: ["Person", "Business"] },
  { id: "abn", label: "Business number", type: "text", requireWhen: { join: "all", conditions: [{ field: "kind", op: "is", value: "Business" }] } },
  { id: "secret", label: "Staff only", type: "text", disableWhen: { join: "all", conditions: [{ field: "kind", op: "is", value: "Person" }] } },
];
async function makeForm(t: T, fields: unknown[] = FIELDS) {
  const r = await t.owner.post("/api/forms", { name: "Intake", target: "task", fields, td2: { progress: true, oneAtATime: true } });
  expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBeLessThan(300);
  return r.body.form ?? r.body;
}

describe("TD2 flag off is today", () => {
  it("new types fall back, paths are not found, no settings", async () => {
    const t = await setup({ APP_URL: "http://localhost" });
    const refused = await t.owner.post("/api/forms", { name: "Old", target: "task", fields: [{ label: "Your name", type: "text", required: true }, { label: "Upload", type: "file" }] });
    expect(refused.status).toBe(422);
    const r = await t.owner.post("/api/forms", { name: "Old", target: "task", td2: { oneAtATime: true }, fields: [{ label: "Your name", type: "text", required: true }, { label: "Kind", type: "text", logic: { join: "all", conditions: [], groups: [{ join: "all", conditions: [{ field: "your_name", op: "answered" }] }], action: "hide" } }] });
    const form = r.body.form ?? r.body;
    expect(form.fields[1].logic).toBeUndefined(); // groups and hide are TD2 only
    expect(form.td2).toBeUndefined();
    expect((await upload(t, form.slug, "upload", PNG, "a.png")).status).toBe(404);
    const pub = await raw(t, "GET", `/api/public/forms/${form.slug}`);
    expect(pub.body.form.td2).toBeUndefined();
    expect((await t.owner.get("/api/config")).body.formsTd2).toBe(false);
  });
});

describe("TD2 uploads and answers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("public form carries settings; upload checks size, type and field", async () => {
    const t = await setup();
    const form = await makeForm(t);
    expect(form.td2).toEqual({ progress: true, oneAtATime: true });
    const pub = await raw(t, "GET", `/api/public/forms/${form.slug}`);
    expect(pub.body.form.td2.oneAtATime).toBe(true);
    expect(pub.body.form.fields.find((x: { id: string }) => x.id === "docs").maxFiles).toBe(2);
    const ok = await upload(t, form.slug, "docs", PDF, "my report.pdf");
    expect(ok.status).toBe(201);
    expect(ok.body.id).toMatch(/^fu_[A-Za-z0-9]{24}$/);
    expect(ok.body.name).toBe("my report.pdf");
    const big = new Uint8Array(1024 * 1024 + 10); big.set(PDF);
    expect((await upload(t, form.slug, "docs", big, "big.pdf")).status).toBe(413);
    expect((await upload(t, form.slug, "docs", new Uint8Array(11 * 1024 * 1024), "huge.pdf")).status).toBe(413);
    const svg = await upload(t, form.slug, "docs", SVG, "x.svg");
    expect(svg.status).toBe(422);
    expect(svg.body.error.code).toBe("file_type");
    expect((await upload(t, form.slug, "docs", new TextEncoder().encode("hi"), "a.txt")).status).toBe(422); // text not allowed on this field
    expect((await upload(t, form.slug, "name", PDF, "a.pdf")).status).toBe(404); // not an upload question
    expect((await upload(t, form.slug, "sig", PDF, "a.pdf")).status).toBe(422); // a signature is a PNG
    expect((await raw(t, "POST", `/api/public/forms/${form.slug}/uploads?field=docs`, PDF as BodyInit, { "cf-connecting-ip": "10.1.1.1", origin: "http://localhost" })).status).toBe(403); // no upload header: refused like any non JSON post
  });

  it("limits uploads per sender", async () => {
    const t = await setup();
    const form = await makeForm(t);
    for (let i = 0; i < 20; i++) expect((await upload(t, form.slug, "docs", PDF, `a${i}.pdf`, "10.2.2.2")).status).toBe(201);
    const r = await upload(t, form.slug, "docs", PDF, "one-more.pdf", "10.2.2.2");
    expect(r.status).toBe(429);
    expect((await upload(t, form.slug, "docs", PDF, "other.pdf", "10.2.2.3")).status).toBe(201);
    t.advance(11 * 60_000);
    expect((await upload(t, form.slug, "docs", PDF, "later.pdf", "10.2.2.2")).status).toBe(201);
  });

  it("ties files to the answer once, opens them for members only, and deletes them with the response", async () => {
    const t = await setup();
    const logs: string[] = [];
    for (const k of ["log", "info", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    const reported: string[] = [];
    t.deps.reportError = ((err: unknown, ctx: unknown) => { reported.push(`${String(err)} ${JSON.stringify(ctx)}`); }) as typeof t.deps.reportError;
    const form = await makeForm(t);
    const doc = await upload(t, form.slug, "docs", PDF, "secret-file-name-zq.pdf");
    const sig = await upload(t, form.slug, "sig", PNG, "whatever.png");
    expect(sig.status).toBe(201);
    expect(sig.body.name).toBe("signature.png");
    // Required when: a business must give its number (checked on the server).
    const missing = await submit(t, form.slug, { name: "Bo", email: "bo@x.io", docs: [doc.body.id], sig: sig.body.id, kind: "Business" });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.field).toBe("abn");
    // Another sender can't use these files.
    const thief = await submit(t, form.slug, { name: "Eve", email: "eve@x.io", docs: [doc.body.id], sig: sig.body.id, kind: "Person" }, "10.6.6.6");
    expect(thief.status).toBe(400);
    // Disabled answers are dropped; the files are tied to this answer.
    const sent = await submit(t, form.slug, { name: "Bo secret-answer-qq", email: "bo@x.io", docs: [doc.body.id], sig: sig.body.id, kind: "Person", secret: "forced value" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    // The same upload can't be sent twice.
    expect((await submit(t, form.slug, { name: "Bo", email: "bo@x.io", docs: [doc.body.id], sig: sig.body.id, kind: "Person" })).status).toBe(400);
    const res = await t.owner.get(`/api/forms/${form.id}/responses`);
    const row = res.body.responses[0];
    expect(row.answers.secret).toBeUndefined();
    expect(res.body.fields.some((x: { type: string }) => x.type === "heading" || x.type === "page")).toBe(false);
    const files = res.body.files[row.id];
    expect(files.map((x: { name: string }) => x.name).sort()).toEqual(["secret-file-name-zq.pdf", "signature.png"]);
    const dl = await raw(t, "GET", `/api/forms/${form.id}/uploads/${doc.body.id}`, undefined, { cookie: t.owner.cookie });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(dl.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const img = await raw(t, "GET", `/api/forms/${form.id}/uploads/${sig.body.id}?inline=1`, undefined, { cookie: t.owner.cookie });
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-disposition")).toMatch(/^inline;/);
    // Signed out: refused. Another workspace: not found.
    expect((await raw(t, "GET", `/api/forms/${form.id}/uploads/${doc.body.id}`)).status).toBe(401);
    const other = new Client(t.app);
    await other.signup("zed@other.io", "Zed Other", "Other");
    expect((await other.get(`/api/forms/${form.id}/uploads/${doc.body.id}`)).status).toBe(404);
    expect((await other.call("DELETE", `/api/forms/${form.id}/responses/${row.id}`)).status).toBe(404);
    // Delete the response: its files go too.
    const del = await t.owner.call("DELETE", `/api/forms/${form.id}/responses/${row.id}`);
    expect(del.body).toEqual({ ok: true, files: 2 });
    expect((await raw(t, "GET", `/api/forms/${form.id}/uploads/${doc.body.id}`, undefined, { cookie: t.owner.cookie })).status).toBe(404);
    // No answer text or file name reached a log or the error reporter.
    const all = logs.join("\n") + reported.join("\n");
    expect(all).not.toContain("secret-file-name-zq");
    expect(all).not.toContain("secret-answer-qq");
    expect(all).not.toContain("forced value");
  });

  it("a task's notes count files instead of naming them; unsent uploads are swept after a day", async () => {
    const t = await setup();
    const form = await makeForm(t, [{ id: "name", label: "Your name", type: "text", required: true }, { id: "docs", label: "Documents", type: "file", maxFiles: 2 }]);
    const a = await upload(t, form.slug, "docs", PDF, "hidden-name.pdf");
    const stale = await upload(t, form.slug, "docs", PDF, "stale.pdf");
    const sent = await submit(t, form.slug, { name: "Cy", docs: [a.body.id] });
    expect(sent.status).toBe(200);
    const task = await t.owner.get(`/api/tasks/${sent.body.created.id}`);
    const notes = JSON.stringify(task.body);
    expect(notes).toContain("1 file");
    expect(notes).not.toContain("hidden-name");
    t.advance(25 * 60 * 60_000);
    await upload(t, form.slug, "docs", PDF, "fresh.pdf", "10.3.3.3"); // the next upload sweeps old unsent ones
    expect((await submit(t, form.slug, { name: "Cy", docs: [stale.body.id] })).status).toBe(400);
  });

  it("image blocks must be a Files image of this workspace; members can't delete responses", async () => {
    const t = await setup();
    await t.owner.post("/api/org/plan", { plan: "pro" });
    const bad = await t.owner.post("/api/forms", { name: "Pics", target: "task", fields: [{ label: "Your name", type: "text" }, { id: "pic", label: "Image", type: "image", imageId: "drv_nope1234" }] });
    expect(bad.status).toBe(422);
    const put = await raw(t, "PUT", `/api/drive/upload?space=team&name=logo.png`, PNG as BodyInit, { cookie: t.owner.cookie, "content-type": "image/png", "x-multies-upload": "1" });
    expect(put.status).toBeLessThan(300);
    const itemId = put.body.item?.id ?? put.body.id;
    const form = await makeForm(t, [{ label: "Your name", type: "text" }, { id: "pic", label: "Image", type: "image", imageId: itemId, imageAlt: "Our logo" }]);
    const pub = await raw(t, "GET", `/api/public/forms/${form.slug}`);
    const block = pub.body.form.fields.find((x: { id: string }) => x.id === "pic");
    expect(block.imageId).toBeUndefined();
    expect(block.hasImage).toBe(true);
    const pic = await raw(t, "GET", `/api/public/forms/${form.slug}/images/pic`);
    expect(pic.status).toBe(200);
    expect(pic.headers.get("content-type")).toBe("image/png");
    expect((await raw(t, "GET", `/api/public/forms/${form.slug}/images/nope`)).status).toBe(404);
    const invite = await t.owner.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
    const mate = new Client(t.app);
    await mate.signup("mate@acme.io", "Mate Person", "");
    await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`);
    expect((await mate.call("DELETE", `/api/forms/${form.id}/responses/fsb_x`)).status).toBe(403);
  });
});

describe("TD2 with TD7 on one form", () => {
  it("uploads follow the TD7 close date and password, before any bytes are kept", async () => {
    const t = await setup({ FORMS_TD2: "on", FORMS_TD7: "on", FILES_PLUS_R101: "on", APP_URL: "http://localhost" });
    const form = await makeForm(t);
    expect((await upload(t, form.slug, "docs", PDF, "a.pdf")).status).toBe(201);
    expect((await t.owner.put(`/api/forms/${form.id}/pro`, { settings: { closesAt: "2026-11-01T00:00:00Z" } })).status).toBe(200);
    const closed = await upload(t, form.slug, "docs", PDF, "b.pdf");
    expect(closed.status).toBe(410);
    expect(closed.body.error.code).toBe("form_closed");
    await t.owner.put(`/api/forms/${form.id}/pro`, { settings: { closesAt: null }, password: "Secret word 77" });
    expect((await upload(t, form.slug, "docs", PDF, "c.pdf")).status).toBe(401);
    const ok = await raw(t, "POST", `/api/public/forms/${form.slug}/password`, JSON.stringify({ password: "Secret word 77" }), { "content-type": "application/json", "cf-connecting-ip": "10.1.1.1", origin: "http://localhost" });
    expect(ok.status).toBe(200);
    const withAccess = await raw(t, "POST", `/api/public/forms/${form.slug}/uploads?field=docs`, PDF as BodyInit, { "x-multies-upload": "1", "x-file-name": "d.pdf", "content-type": "application/octet-stream", "cf-connecting-ip": "10.1.1.1", origin: "http://localhost", "x-form-access": ok.body.access });
    expect(withAccess.status).toBe(201);
  });
});
