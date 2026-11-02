/** TD4: time to invoice. Rate and rounding math, billing runs that make a draft invoice and lock the time, no double
 * billing under two runs at once, edits refused while billed, release on draft delete or void with audit entries,
 * owners and admins only, other workspaces 404, the Home card, CSV safety, and the flag off. */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { groupRun, hoursText, lineCents, lineDescription, pickRate, roundSeconds, secondsToQtyMilli } from "@/shared/bill-time-td4";
import { lineAmounts } from "@/shared/invoices";
import { availableWidgets } from "@/server/services/home-widgets-r131";

const ON = { INVOICES_ENABLED: "true", BILL_TD4: "on", HOME_WIDGETS_R131: "on" };

async function setup(env: Record<string, string> = ON) {
  const ctx = await makeTestApp(env);
  ctx.deps.now = () => new Date("2026-11-01T01:00:00Z");
  const c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  const proj = (await c.post("/api/projects", { name: "Website" })).body.project;
  const task = (await c.post("/api/tasks", { projectId: proj.id, title: "Home page" })).body.task;
  const contact = (await c.post("/api/contacts", { email: "buyer@client.co", name: "Client Co" })).body.contact;
  const entry = async (minutes: number, date: string, extra: Record<string, unknown> = {}) => (await c.post("/api/time", { taskId: task.id, minutes, date, ...extra })).body.entry;
  const join = async (email: string, name: string, role: "member" | "admin" = "member") => {
    const inv = await c.post("/api/team/invites", { email, role });
    const m = new Client(ctx.app);
    await m.signup(email, name, `${name} Co`);
    expect((await m.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    return m;
  };
  const audits = async (action: string) => (await ctx.deps.db.all<{ n: number }>(sql`select count(*) as n from audit_logs where action = ${action}`))[0].n;
  return { ...ctx, c, proj, task, contact, entry, join, audits };
}
const range = "from=2026-10-01&to=2026-10-31";

describe("TD4 money and rounding", () => {
  it("rounds each entry up, keeps hours in thousandths and cents like an invoice line", () => {
    expect(roundSeconds(0, 15)).toBe(0);
    expect(roundSeconds(60, 15)).toBe(900);
    expect(roundSeconds(900, 15)).toBe(900);
    expect(roundSeconds(901, 6)).toBe(1080);
    expect(roundSeconds(61.9, 0)).toBe(61);
    expect(secondsToQtyMilli(3600)).toBe(1000);
    expect(secondsToQtyMilli(60)).toBe(17); // 16.67 rounds half up
    expect(lineCents(1250, 15000)).toBe(18750);
    expect(lineCents(17, 9999)).toBe(170); // 169.98
    for (const [q, r] of [[1250, 15000], [17, 9999], [333, 12345]]) expect(lineCents(q, r)).toBe(lineAmounts({ description: "", quantityMilli: q, unitCents: r }, "exclusive", false).totalCents);
    expect(hoursText(1250)).toBe("1.25 h");
  });

  it("groups by person and task, never averages two rates, and picks the most specific rate", () => {
    const e = (id: string, s: number, rate: number | null, task = "t1") => ({ id, seconds: s, personKey: "member:a", personName: "Ada", taskKey: task, taskLabel: task, rateCents: rate });
    const g = groupRun([e("1", 3600, 10000), e("2", 1800, 10000), e("3", 600, 20000), e("4", 60, null, "t2")], 15);
    expect(g.lines).toHaveLength(3);
    expect(g.lines.find((l) => l.rateCents === 10000)).toMatchObject({ seconds: 5400, qtyMilli: 1500, amountCents: 15000 });
    expect(g.lines.find((l) => l.rateCents === 20000)).toMatchObject({ seconds: 900, amountCents: 5000 });
    expect(g.missingRate).toBe(true);
    expect(pickRate({ personProject: 1, person: 2, project: 3, workspace: 4 })).toBe(1);
    expect(pickRate({ person: 2, project: 3, workspace: 4 })).toBe(2);
    expect(pickRate({ project: 0, workspace: 4 })).toBe(0);
    expect(pickRate({})).toBeNull();
    expect(lineDescription("Ada", "Home page", "2026-10-01", "2026-10-31", 15)).toContain("rounded up to 15 min");
  });
});

describe("TD4 billing runs", () => {
  it("is off without the flag and leaves time and invoices as they were", async () => {
    const t = await setup({ INVOICES_ENABLED: "true" });
    expect((await t.c.get("/api/bill-time/summary")).status).toBe(404);
    expect((await t.c.get(`/api/bill-time/preview?projectId=${t.proj.id}&${range}`)).status).toBe(404);
    const e = await t.entry(30, "2026-10-05");
    expect((await t.c.patch(`/api/time/${e.id}`, { minutes: 45 })).status).toBe(200);
    const d = await t.c.post("/api/invoices/docs", { kind: "invoice", lines: [{ description: "x", quantityMilli: 1000, unitCents: 100 }] });
    expect((await t.c.del(`/api/invoices/docs/${d.body.doc.id}`)).status).toBe(200);
    expect(availableWidgets(t.deps, { role: "owner" })).not.toContain("billing");
  });

  it("makes a draft invoice at the right rate, locks the time, and releases it when the draft is deleted", async () => {
    const t = await setup();
    const a = await t.entry(60, "2026-10-05", { note: "=HYPERLINK(1)" });
    const b = await t.entry(7, "2026-10-06");
    await t.entry(20, "2026-10-07", { billable: false });
    await t.entry(30, "2026-09-20"); // outside the range
    expect((await t.c.put("/api/bill-time/setup", { projectId: t.proj.id, rateCents: 15000, rounding: 15, contactId: t.contact.id })).status).toBe(200);
    const pv = await t.c.get(`/api/bill-time/preview?projectId=${t.proj.id}&${range}`);
    expect(pv.status).toBe(200);
    expect(pv.body.entries.map((e: { id: string }) => e.id).sort()).toEqual([a.id, b.id].sort());
    expect(pv.body.rounding).toBe(15);
    expect(pv.body.client.id).toBe(t.contact.id);

    const run = await t.c.post("/api/bill-time/runs", { projectId: t.proj.id, from: "2026-10-01", to: "2026-10-31", rounding: 15, entryIds: [a.id, b.id] });
    expect(run.status).toBe(201);
    const doc = (await t.c.get(`/api/invoices/docs/${run.body.docId}`)).body.doc ?? (await t.c.get(`/api/invoices/docs/${run.body.docId}`)).body;
    expect(doc.status).toBe("draft");
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({ quantityMilli: 1250, unitCents: 15000, netCents: 18750 });
    expect(doc.lines[0].description).toContain("rounded up to 15 min");
    expect(run.body.run).toMatchObject({ entryCount: 2, seconds: 4500, amountCents: 18750, status: "open" });
    expect(await t.audits("bill_time.run_created")).toBe(1);

    // Locked: no edit, no delete, not offered again, not billed twice.
    expect((await t.c.patch(`/api/time/${a.id}`, { minutes: 90 })).body.error?.code).toBe("billed_locked");
    expect((await t.c.del(`/api/time/${b.id}`)).status).toBe(409);
    expect((await t.c.get(`/api/bill-time/preview?projectId=${t.proj.id}&${range}`)).body.entries).toHaveLength(0);
    expect((await t.c.post("/api/bill-time/runs", { projectId: t.proj.id, from: "2026-10-01", to: "2026-10-31", rounding: 15, entryIds: [a.id] })).status).toBe(409);
    expect((await t.c.get("/api/time?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z")).body.entries.find((e: { id: string }) => e.id === a.id).billed).toBe(true);

    // CSV: header, two rows, a formula in a note is made safe.
    const res = await t.app.request(`/api/bill-time/runs/${run.body.run.id}/export.csv`, { headers: { cookie: t.c.cookie, host: "localhost" } });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(3);
    expect(csv).toContain("'=HYPERLINK(1)");

    // Release by deleting the draft.
    expect((await t.c.del(`/api/invoices/docs/${run.body.docId}`)).status).toBe(200);
    expect(await t.audits("bill_time.released")).toBe(1);
    expect((await t.c.get(`/api/bill-time/preview?projectId=${t.proj.id}&${range}`)).body.entries).toHaveLength(2);
    expect((await t.c.patch(`/api/time/${a.id}`, { minutes: 90 })).status).toBe(200);
    const runs = (await t.c.get("/api/bill-time/runs")).body.runs;
    expect(runs[0]).toMatchObject({ status: "released", releaseReason: "draft_deleted" });
  });

  it("never bills the same time twice when two runs go at once", async () => {
    const t = await setup();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await t.entry(30 + i, `2026-10-1${i}`)).id);
    await t.c.put("/api/bill-time/setup", { projectId: t.proj.id, rateCents: 10000, contactId: t.contact.id });
    const body = { projectId: t.proj.id, from: "2026-10-01", to: "2026-10-31", rounding: 0, entryIds: ids };
    const [x, y] = await Promise.all([t.c.post("/api/bill-time/runs", body), t.c.post("/api/bill-time/runs", { ...body, entryIds: ids.slice(2) })]);
    const ok = [x, y].filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const docs = await t.deps.db.all<{ doc: string; n: number }>(sql`select billed_doc_id as doc, count(*) as n from time_entries where billed_doc_id is not null group by billed_doc_id`);
    expect(docs.length).toBe(ok.length === 2 ? 2 : 1);
    const billed = (await t.deps.db.all<{ n: number }>(sql`select count(*) as n from time_entries where billed_doc_id is not null`))[0].n;
    expect(billed).toBe(ok.reduce((s, r) => s + r.body.run.entryCount, 0));
    const drafts = (await t.deps.db.all<{ n: number }>(sql`select count(*) as n from invoice_docs where status = 'draft'`))[0].n;
    expect(drafts).toBe(ok.length);
  });

  it("releases time when an issued invoice is voided", async () => {
    const t = await setup();
    await t.c.put("/api/invoices/settings", { businessName: "Fintex", abn: "51 824 753 556", bsb: "062-000", accountNumber: "12345678", accountName: "Fintex Pty Ltd", termsDays: 14 });
    const e = await t.entry(60, "2026-10-05");
    await t.c.put("/api/bill-time/setup", { projectId: t.proj.id, rateCents: 12000, contactId: t.contact.id });
    const run = await t.c.post("/api/bill-time/runs", { projectId: t.proj.id, from: "2026-10-01", to: "2026-10-31", rounding: 0, entryIds: [e.id] });
    expect(run.status).toBe(201);
    expect((await t.c.post(`/api/invoices/docs/${run.body.docId}/issue`)).status).toBe(200);
    expect((await t.c.patch(`/api/time/${e.id}`, { minutes: 5 })).status).toBe(409);
    expect((await t.c.post(`/api/invoices/docs/${run.body.docId}/void`, { reason: "Wrong client" })).status).toBe(200);
    expect(await t.audits("bill_time.released")).toBe(1);
    expect((await t.c.patch(`/api/time/${e.id}`, { minutes: 5 })).status).toBe(200);
    expect((await t.c.get("/api/bill-time/runs")).body.runs[0]).toMatchObject({ status: "released", releaseReason: "voided" });
  });

  it("asks for a rate and a client before it bills", async () => {
    const t = await setup();
    const e = await t.entry(60, "2026-10-05");
    const body = { projectId: t.proj.id, from: "2026-10-01", to: "2026-10-31", rounding: 0, entryIds: [e.id] };
    expect((await t.c.post("/api/bill-time/runs", body)).body.error?.code).toBe("missing_rate");
    await t.c.put("/api/bill-time/setup", { projectId: t.proj.id, workspaceRateCents: 9000 });
    expect((await t.c.post("/api/bill-time/runs", body)).body.error?.code).toBe("no_client");
    expect((await t.c.put("/api/bill-time/setup", { projectId: t.proj.id, rateCents: -1 })).status).toBe(422);
    expect((await t.c.post("/api/bill-time/runs", { ...body, contactId: t.contact.id })).status).toBe(201);
  });

  it("is for owners and admins only, and other workspaces get 404", async () => {
    const t = await setup();
    const e = await t.entry(60, "2026-10-05");
    await t.c.put("/api/bill-time/setup", { projectId: t.proj.id, rateCents: 10000, contactId: t.contact.id });
    const m = await t.join("mo@acme.io", "Mo");
    expect((await m.get("/api/bill-time/summary")).status).toBe(403);
    expect((await m.get(`/api/bill-time/preview?projectId=${t.proj.id}&${range}`)).status).toBe(403);
    expect((await m.post("/api/bill-time/runs", { projectId: t.proj.id, from: "2026-10-01", to: "2026-10-31", rounding: 0, entryIds: [e.id] })).status).toBe(403);
    const admin = await t.join("al@acme.io", "Al", "admin");
    expect((await admin.get(`/api/bill-time/preview?projectId=${t.proj.id}&${range}`)).status).toBe(200);
    const other = new Client(t.app);
    await other.signup("eve@else.io", "Eve", "Else");
    expect((await other.get(`/api/bill-time/preview?projectId=${t.proj.id}&${range}`)).status).toBe(404);
    expect((await other.get("/api/bill-time/runs")).body.runs).toHaveLength(0);
    const theirProj = (await other.post("/api/projects", { name: "Theirs" })).body.project;
    expect((await other.put("/api/bill-time/setup", { projectId: theirProj.id, contactId: t.contact.id })).status).toBe(404);
    expect(availableWidgets(t.deps, { role: "member" })).not.toContain("billing");
    expect(availableWidgets(t.deps, { role: "admin" })).toContain("billing");
  });

  it("prices the Home card from seconds, in whole cents rounded once (MB-332)", async () => {
    const t = await setup();
    await t.entry(60, "2026-10-05");
    await t.entry(7, "2026-10-06");
    await t.c.put("/api/bill-time/setup", { projectId: t.proj.id, rateCents: 15000, contactId: t.contact.id });
    let s = await t.c.get("/api/bill-time/summary");
    // 4020 s at 150.00 an hour is 167.50 exactly (rounded hours 1.117 would give 167.55).
    expect(s.body.clients[0]).toMatchObject({ seconds: 4020, amountCents: 16750 });
    expect(Number.isInteger(s.body.clients[0].amountCents)).toBe(true);
    expect(s.body.clients[0]).not.toHaveProperty("num");
    await t.c.put("/api/bill-time/setup", { projectId: t.proj.id, rateCents: 13333, contactId: t.contact.id });
    s = await t.c.get("/api/bill-time/summary");
    // 4020 x 13333 / 3600 = 14888.51, so 14889 cents (rounded hours would give 14893).
    expect(s.body.clients[0]).toMatchObject({ seconds: 4020, amountCents: 14889 });
  });

  it("shows hours still to bill per client on Home", async () => {
    const t = await setup();
    await t.entry(90, "2026-10-05");
    let s = await t.c.get("/api/bill-time/summary");
    expect(s.body.clients[0]).toMatchObject({ name: "Website", clientId: null, seconds: 5400, missingRate: true });
    await t.c.put("/api/bill-time/setup", { projectId: t.proj.id, rateCents: 10000, contactId: t.contact.id, currency: "NZD" });
    s = await t.c.get("/api/bill-time/summary");
    expect(s.body.clients[0]).toMatchObject({ name: "Client Co", clientId: t.contact.id, amountCents: 15000, currency: "NZD", projectId: t.proj.id });
    const hw = await t.c.get("/api/home-widgets");
    expect(hw.body.available).toContain("billing");
  });
});
