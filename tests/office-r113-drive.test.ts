import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { readDocx, writeDocx } from "@/shared/office-r113/docx";
import { readXlsx, writeXlsx } from "@/shared/office-r113/xlsx";
import { parseInput } from "@/shared/office-r113/sheet";

/** R113: saving from the office editors is always a new Files version; permissions are exactly R101's. Made up fixtures only. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function setup(env: Record<string, string> = { FILES_PLUS_R101: "on", OFFICE_EDIT_R113: "on" }) {
  ctx = await makeTestApp(env);
  ctx.deps.now = () => new Date("2026-11-01T01:00:00Z");
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  await owner.post("/api/org/plan", { plan: "pro" });
}
async function teammate(email: string) {
  const invite = await owner.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, email.split("@")[0], "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return { client: m, id: (await m.get("/api/account/me")).body.user.id as string };
}
async function upload(c: Client, name: string, body: Uint8Array, type: string, space = "team") {
  const qs = new URLSearchParams({ space, name });
  const res = await ctx.app.request(`/api/drive/upload?${qs}`, { method: "PUT", headers: { cookie: c.cookie, host: "localhost", "content-type": type, "x-multies-upload": "1" }, body: body as BodyInit });
  return (await res.json()).item as { id: string };
}
async function save(c: Client, id: string, body: Uint8Array, type: string, q: string) {
  const res = await ctx.app.request(`/api/drive/items/${id}/content?${q}`, { method: "PUT", headers: { cookie: c.cookie, host: "localhost", "content-type": type, "x-multies-upload": "1" }, body: body as BodyInit });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
async function bytes(c: Client, id: string, v = "") {
  const res = await ctx.app.request(`/api/drive/items/${id}/content${v ? `?v=${v}` : ""}`, { headers: { cookie: c.cookie, host: "localhost" } });
  return new Uint8Array(await res.arrayBuffer());
}
const docOf = (t: string) => writeDocx({ type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: t }] }] });

describe("R113 office editors on Files", () => {
  beforeEach(async () => { await setup(); });

  it("the flag reaches the app config", async () => {
    expect((await owner.get("/api/config")).body.officeEditR113).toBe(true);
    await setup({ FILES_PLUS_R101: "on" });
    expect((await owner.get("/api/config")).body.officeEditR113).toBe(false);
  });

  it("saving a DOCX from the editor adds a version and keeps the original", async () => {
    const f = await upload(owner, "Plan.docx", docOf("First"), DOCX);
    const d0 = (await owner.get(`/api/drive/items/${f.id}`)).body;
    const base = d0.versions.find((v: { current: boolean }) => v.current).id;
    const r = await save(owner, f.id, docOf("Second"), DOCX, `base=${base}&via=editor`);
    expect(r.status).toBe(200);
    expect(r.body.item.versions).toBe(2);
    expect(r.body.versions[0]).toMatchObject({ number: 2, note: "Saved in the editor", current: true });
    expect(readDocx(await bytes(owner, f.id)).doc.content![0].content![0].text).toBe("Second");
    expect(readDocx(await bytes(owner, f.id, base)).doc.content![0].content![0].text).toBe("First");
    // Restore the original: also a new version.
    const back = await owner.post(`/api/drive/items/${f.id}/versions/${base}/restore`, {});
    expect(back.body.item.versions).toBe(3);
    expect(readDocx(await bytes(owner, f.id)).doc.content![0].content![0].text).toBe("First");
  });

  it("a save that started from an older version is refused, then can be saved on purpose", async () => {
    const wb = { sheets: [{ name: "Sheet1", cells: new Map([["A1", parseInput("1")], ["A2", parseInput("=A1*3")]]), rowCount: 50, colCount: 12 }] };
    const f = await upload(owner, "Budget.xlsx", writeXlsx(wb), XLSX);
    const base = (await owner.get(`/api/drive/items/${f.id}`)).body.versions[0].id;
    expect((await save(owner, f.id, writeXlsx(wb), XLSX, `base=${base}&via=editor`)).status).toBe(200);
    const stale = await save(owner, f.id, writeXlsx(wb), XLSX, `base=${base}&via=editor`);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code ?? stale.body.code).toBe("version_conflict");
    expect((await owner.get(`/api/drive/items/${f.id}`)).body.item.versions).toBe(2);
    const forced = await save(owner, f.id, writeXlsx(wb), XLSX, "via=editor");
    expect(forced.status).toBe(200);
    expect(forced.body.item.versions).toBe(3);
    expect(readXlsx(await bytes(owner, f.id)).wb.sheets[0].cells.get("A2")).toMatchObject({ f: "A1*3", v: 3 });
  });

  it("only people who can edit may save: viewer refused, editor allowed, revoked gets nothing", async () => {
    const mate = await teammate("mate@acme.io"); const other = await teammate("other@acme.io");
    const f = await upload(mate.client, "Mine.docx", docOf("Private"), DOCX, "private");
    expect((await save(other.client, f.id, docOf("x"), DOCX, "via=editor")).status).toBe(404);
    await mate.client.put(`/api/drive/items/${f.id}/shares`, { shares: [{ userId: other.id, role: "view" }] });
    const viewer = await save(other.client, f.id, docOf("x"), DOCX, "via=editor");
    expect(viewer.status).toBe(403);
    expect((await other.client.get(`/api/drive/items/${f.id}`)).body.item.canEdit).toBe(false);
    await mate.client.put(`/api/drive/items/${f.id}/shares`, { shares: [{ userId: other.id, role: "edit" }] });
    expect((await save(other.client, f.id, docOf("Edited"), DOCX, "via=editor")).status).toBe(200);
    await mate.client.put(`/api/drive/items/${f.id}/shares`, { shares: [] });
    expect((await save(other.client, f.id, docOf("again"), DOCX, "via=editor")).status).toBe(404);
    expect(readDocx(await bytes(mate.client, f.id)).doc.content![0].content![0].text).toBe("Edited");
  });

  it("guests and portal visitors cannot open or save", async () => {
    const f = await upload(owner, "Plan.docx", docOf("Team"), DOCX);
    const p = (await owner.post("/api/projects", { name: "Harbour site" })).body.project;
    expect((await owner.post("/api/guests", { projectId: p.id, email: "mia@harbour.coffee", name: "Mia" })).status).toBeLessThan(300);
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const token = sent.map((x) => x.text).reverse().find((x) => x.includes("/g/"))?.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1];
    const guest = new Client(ctx.app);
    expect((await guest.post("/api/guest/accept", { token })).status).toBe(200);
    expect((await guest.get(`/api/drive/items/${f.id}`)).status).toBe(401);
    expect((await save(guest, f.id, docOf("x"), DOCX, "via=editor")).status).toBe(401);
    const portal = new Client(ctx.app); portal.cookie = "mp_portal=anything";
    expect((await save(portal, f.id, docOf("x"), DOCX, "via=editor")).status).toBe(401);
    expect(readDocx(await bytes(owner, f.id)).doc.content![0].content![0].text).toBe("Team");
  });

  it("the Files size cap still applies to saves", async () => {
    const f = await upload(owner, "Big.csv", new TextEncoder().encode("a,b\n"), "text/csv");
    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    expect((await save(owner, f.id, big, "text/csv", "via=editor")).status).toBe(413);
  });
});
