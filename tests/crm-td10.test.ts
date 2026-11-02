import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { contacts, crmSuggestionsTd10, messages, tasks } from "@/server/db/schema";
import { findNextStep, parseSignature, parseWhen, TEMPLATE_INFO, ANALYSIS_TEMPLATES } from "@/shared/crm-td10";
import { cleanFilters, suggestFromMail, templateSpec } from "@/server/services/crm-td10";

const SIG = "Hi team,\n\nThanks for the quote. Can we talk next week about the fit out?\n\nKind regards,\nSam Lee\nOperations Manager | Harbour Coffee Pty Ltd\nM: +61 412 345 678\nwww.harbourcoffee.com.au\n\nOn Mon, 2 Nov 2026 at 9:00 Team <team@acme.io> wrote:\n> Regards,\n> Someone Else\n> CEO\n";

describe("TD10 signature rules", () => {
  it("reads name, title, company and phone from a sign off and ignores the quoted reply", () => {
    expect(parseSignature(SIG)).toEqual({ name: "Sam Lee", title: "Operations Manager", company: "Harbour Coffee Pty Ltd", phone: "+61 412 345 678" });
  });
  it("returns nothing without a sign off, and skips links, emails and dates", () => {
    expect(parseSignature("Just a quick note. Call 0412 345 678 later.")).toEqual({});
    expect(parseSignature("Cheers,\nAnn\nann@x.com\nhttps://x.com\n20261102")).toEqual({});
    expect(parseSignature("--\nJo Park\nDirector, Park Studio\nT 02 9999 1234").title).toBe("Director");
  });
});

describe("TD10 next step rules", () => {
  const at = new Date(Date.UTC(2026, 10, 2, 9)); // Monday 2 Nov 2026
  it("pairs a verb with a time and counts from the message date", () => {
    expect(findNextStep("Can we talk next week?", at)).toEqual({ reason: "follow_up", due: "2026-11-09", when: "next week" });
    expect(findNextStep("I'll call you on Friday.", at)).toEqual({ reason: "call", due: "2026-11-06", when: "Friday" });
    expect(findNextStep("Please send the proposal by 12 Nov.", at)?.due).toBe("2026-11-12");
    expect(findNextStep("Let's meet tomorrow for coffee", at)).toMatchObject({ reason: "meet", due: "2026-11-03" });
    expect(findNextStep("Follow up in 3 days please", at)?.due).toBe("2026-11-05");
  });
  it("needs both a verb and a time, and ignores quoted mail", () => {
    expect(findNextStep("Thanks, all good.", at)).toBeNull();
    expect(findNextStep("Talk soon!", at)).toBeNull();
    expect(findNextStep("Thanks.\n\nOn Sun, 1 Nov 2026 Ann wrote:\n> can we talk tomorrow?", at)).toBeNull();
    expect(parseWhen("on 31 Feb", at)).toBeNull();
  });
});

describe("TD10 suggestion rules (no database)", () => {
  const at = new Date(Date.UTC(2026, 10, 2, 9));
  const msg = (over: Partial<{ id: string; folder: string; fromAddress: string; fromName: string; to: string; text: string; date: Date }> = {}) => ({ id: "m1", mailboxId: "mbx1", folder: "inbox", fromAddress: "sam@harbour.com.au", fromName: "Sam", to: "[]", date: at, text: SIG, ...over });
  const outside = (e: string) => !e.endsWith("@acme.io");
  it("offers only the fields that differ, keyed so the same change is never offered twice", () => {
    const live = { id: "ct1", email: "sam@harbour.com.au", name: "Sam Lee", title: "Operations Manager", phone: "+61412345678", companyId: null, deletedAt: null };
    const out = suggestFromMail({ messages: [msg()], contacts: [live], deals: [], isOutside: outside });
    const det = out.find((s) => s.kind === "contact_details")!;
    expect(det.fields).toEqual({ company: "Harbour Coffee Pty Ltd" });
    expect(suggestFromMail({ messages: [msg()], contacts: [live], deals: [], isOutside: outside }).find((s) => s.kind === "contact_details")!.dedupeKey).toBe(det.dedupeKey);
    expect(out.find((s) => s.kind === "next_step")!.fields).toMatchObject({ reason: "follow_up", due: "2026-11-09", title: "Follow up with Sam" });
  });
  it("offers a new contact for an outside sender with none, never for own or robot addresses", () => {
    const out = suggestFromMail({ messages: [msg(), msg({ id: "m2", fromAddress: "me@acme.io" })], contacts: [], deals: [], isOutside: outside });
    expect(out.map((s) => s.kind)).toEqual(["new_contact"]);
    expect(out[0].fields).toMatchObject({ email: "sam@harbour.com.au", name: "Sam Lee", phone: "+61 412 345 678" });
  });
  it("offers last contacted on an open deal only when the mail is newer than its last activity", () => {
    const live = { id: "ct1", email: "sam@harbour.com.au", name: "Sam Lee", title: null, phone: null, companyId: "co1", deletedAt: null };
    const sent = msg({ folder: "sent", fromAddress: "me@acme.io", to: JSON.stringify([{ address: "sam@harbour.com.au" }]), text: "Here it is." });
    const older = suggestFromMail({ messages: [sent], contacts: [live], deals: [{ id: "d1", contactId: "ct1", createdAt: new Date(0), lastActivity: new Date(at.getTime() + 1) }], isOutside: outside });
    expect(older.filter((s) => s.kind === "last_contacted")).toHaveLength(0);
    const newer = suggestFromMail({ messages: [sent], contacts: [live], deals: [{ id: "d1", contactId: "ct1", createdAt: new Date(0), lastActivity: null }], isOutside: outside });
    expect(newer.find((s) => s.kind === "last_contacted")).toMatchObject({ targetId: "d1", dedupeKey: "last:d1:2026-11-02", fields: { date: "2026-11-02" } });
  });
});

describe("TD10 analysis templates", () => {
  it("every template has copy, filters and maps to an allowlisted question", () => {
    for (const t of ANALYSIS_TEMPLATES) expect(TEMPLATE_INFO[t].title).toMatch(/^[A-Z][a-z ]+$/);
    expect(templateSpec("revenue_by_month", { days: 365 })).toMatchObject({ table: "deals", groupBy: "closed", bucket: "month", measure: { op: "sum", field: "value" } });
    expect(templateSpec("time_by_project", { days: 30, person: "u1" }).filters).toEqual([{ field: "started", op: "last_days", value: "30" }, { field: "person", op: "is", value: "u1" }]);
  });
  it("drops filters a template does not offer", () => {
    expect(cleanFilters("response_rates", { days: 30, owner: "u1", project: "p1" })).toEqual({ days: 30 });
    expect(cleanFilters("pipeline_by_stage", {})).toEqual({ days: 0 });
  });
});

/* API */

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let fetchCalls = 0;
async function verifiedDomain(ctx: Ctx, c: Client, name: string) {
  const domainId = (await c.post("/api/domains", { name })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
  return domainId;
}

let seq = 0;
async function setup(env: Record<string, string> = { CRM_TD10: "on", CRM_TIMELINE: "on", ASK_TD1: "on" }) {
  const ctx = await makeTestApp(env, { fetch: (async () => { fetchCalls++; throw new Error("network disabled in tests"); }) as typeof fetch });
  const owner = new Client(ctx.app);
  await owner.signup(`owner${++seq}@acme.io`, "Olive Owner");
  const orgId = (await owner.get("/api/account/me")).body.organization.id as string;
  const domainId = await verifiedDomain(ctx, owner, "acme.io");
  const mailboxId = (await owner.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" })).body.mailbox.id as string;
  const mail = async (o: { from?: string; fromName?: string; to?: string; folder?: "inbox" | "sent"; text: string; daysAgo?: number }) => {
    const n = ++seq;
    await ctx.db.insert(messages).values({ id: `msg_td10_${n}`, orgId, mailboxId, folder: o.folder ?? "inbox", threadId: `thr_td10_${n}`, fromAddress: o.from ?? "team@acme.io", fromName: o.fromName ?? "",
      to: JSON.stringify([{ name: "", address: o.to ?? "team@acme.io" }]), subject: `Hello ${n}`, text: o.text, snippet: "hello", date: new Date(Date.now() - (o.daysAgo ?? 1) * 86_400_000) });
  };
  return { ctx, owner, orgId, mailboxId, mail };
}
async function addMember(t: Awaited<ReturnType<typeof setup>>, email: string) {
  const invite = await t.owner.post("/api/team/invites", { email, role: "member" });
  const mate = new Client(t.ctx.app);
  await mate.signup(email, "Mate", "");
  expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return mate;
}

const PATHS: [string, string][] = [["GET", "/api/crm-td10/suggestions"], ["POST", "/api/crm-td10/suggestions/scan"], ["POST", "/api/crm-td10/suggestions/sug_x/accept"], ["POST", "/api/crm-td10/suggestions/sug_x/discard"],
  ["GET", "/api/crm-td10/analyses"], ["GET", "/api/crm-td10/analyses/templates"], ["POST", "/api/crm-td10/analyses/run"], ["GET", "/api/crm-td10/prefs"]];

describe("TD10 API", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    t = await setup();
    await t.owner.post("/api/contacts", { email: "kim@harbour.com.au", name: "kim" });
    await t.mail({ from: "sam@harbour.com.au", fromName: "Sam", text: SIG });
    await t.mail({ from: "kim@harbour.com.au", text: "Thanks!\n\nBest,\nKim Ng\nHead of Sales\n+61 2 9000 1111", daysAgo: 2 });
  });

  it("is not found with the flag off, says so in config, and never writes", async () => {
    const off = await setup({ CRM_TIMELINE: "on" });
    for (const [m, p] of PATHS) expect((await off.owner.call(m, p, m === "POST" ? {} : undefined)).status, p).toBe(404);
    expect((await off.owner.get("/api/config")).body.crmTd10).toBe(false);
    expect((await new Client(off.ctx.app).get("/api/crm-td10/suggestions")).status).toBe(404);
    expect(await off.ctx.db.select().from(crmSuggestionsTd10)).toHaveLength(0);
  });

  it("asks for sign in with the flag on and never caches", async () => {
    expect((await t.owner.get("/api/config")).body.crmTd10).toBe(true);
    for (const [m, p] of PATHS) expect((await new Client(t.ctx.app).call(m, p, m === "POST" ? {} : undefined)).status, p).toBe(401);
    const r = await t.ctx.app.request("/api/crm-td10/prefs", { headers: { cookie: t.owner.cookie, host: "localhost" } });
    expect(r.headers.get("cache-control")).toContain("no-store");
  });

  it("a scan suggests by rules, changes nothing in the CRM, makes no provider call and stores no mail text", async () => {
    const before = await t.ctx.db.select().from(contacts).where(eq(contacts.orgId, t.orgId));
    fetchCalls = 0;
    const scan = await t.owner.post("/api/crm-td10/suggestions/scan");
    expect(scan.status).toBe(200);
    expect(scan.body.added).toBeGreaterThanOrEqual(2);
    expect(fetchCalls).toBe(0);
    expect(await t.ctx.db.select().from(contacts).where(eq(contacts.orgId, t.orgId))).toEqual(before);
    const rows = await t.ctx.db.select().from(crmSuggestionsTd10).where(eq(crmSuggestionsTd10.orgId, t.orgId));
    for (const r of rows) { expect(r.fieldsJson).not.toContain("quote"); expect(r.fieldsJson).not.toContain("Hello"); }
    expect((await t.owner.post("/api/crm-td10/suggestions/scan")).status).toBe(429);
    const list = (await t.owner.get("/api/crm-td10/suggestions")).body.items as { kind: string; fields: Record<string, string>; target: { label: string } }[];
    expect(list.map((s) => s.kind).sort()).toEqual(["contact_details", "new_contact"]);
    expect(list.find((s) => s.kind === "contact_details")!.fields).toMatchObject({ name: "Kim Ng", title: "Head of Sales" });
  });

  it("works the same with AI switched off (rules only, zero provider calls)", async () => {
    await t.owner.put("/api/ai-trust", { enabled: false });
    const t2 = await setup();
    await t2.owner.put("/api/ai-trust", { enabled: false });
    await t2.mail({ from: "lee@other.com", text: "Cheers,\nLee Fox\nFounder\n0400 000 111" });
    fetchCalls = 0;
    expect((await t2.owner.post("/api/crm-td10/suggestions/scan")).body.added).toBe(1);
    expect(fetchCalls).toBe(0);
    await t.owner.put("/api/ai-trust", { enabled: true });
  });

  it("accept writes once with the person's edits; a second accept is refused", async () => {
    const list = (await t.owner.get("/api/crm-td10/suggestions")).body.items as { id: string; kind: string }[];
    const det = list.find((s) => s.kind === "contact_details")!;
    const r = await t.owner.post(`/api/crm-td10/suggestions/${det.id}/accept`, { title: "Sales lead" });
    expect(r.status).toBe(200);
    const kim = await t.ctx.db.select().from(contacts).where(and(eq(contacts.orgId, t.orgId), eq(contacts.email, "kim@harbour.com.au"))).get();
    expect(kim).toMatchObject({ name: "Kim Ng", title: "Sales lead", phone: "+61 2 9000 1111" });
    expect((await t.owner.post(`/api/crm-td10/suggestions/${det.id}/accept`)).status).toBe(409);
    expect((await t.owner.post(`/api/crm-td10/suggestions/${det.id}/accept`, { phone: "call me" })).status).toBe(422);
    const created = list.find((s) => s.kind === "new_contact")!;
    expect((await t.owner.post(`/api/crm-td10/suggestions/${created.id}/accept`)).status).toBe(200);
    const sam = await t.ctx.db.select().from(contacts).where(and(eq(contacts.orgId, t.orgId), eq(contacts.email, "sam@harbour.com.au"))).get();
    expect(sam).toMatchObject({ name: "Sam Lee", title: "Operations Manager", phone: "+61 412 345 678" });
  });

  it("discard is remembered and Undo brings it back", async () => {
    await t.mail({ from: "kim@harbour.com.au", text: "Sure, I'll call you on Friday.\n\nThanks,\nKim Ng" });
    await t.ctx.db.update((await import("@/server/db/schema")).crmScanTd10).set({ scannedAt: new Date(0) });
    await t.owner.post("/api/crm-td10/suggestions/scan");
    const next = ((await t.owner.get("/api/crm-td10/suggestions")).body.items as { id: string; kind: string; fields: Record<string, string> }[]).find((s) => s.kind === "next_step")!;
    expect(next.fields).toMatchObject({ reason: "call", title: "Call Kim" });
    expect((await t.owner.post(`/api/crm-td10/suggestions/${next.id}/discard`)).status).toBe(200);
    await t.ctx.db.update((await import("@/server/db/schema")).crmScanTd10).set({ scannedAt: new Date(0) });
    await t.owner.post("/api/crm-td10/suggestions/scan");
    expect(((await t.owner.get("/api/crm-td10/suggestions")).body.items as { id: string }[]).some((s) => s.id === next.id)).toBe(false);
    expect((await t.owner.post(`/api/crm-td10/suggestions/${next.id}/undo`)).status).toBe(200);
    const due = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    expect((await t.owner.post(`/api/crm-td10/suggestions/${next.id}/accept`, { due })).status).toBe(200);
    const made = await t.ctx.db.select().from(tasks).where(and(eq(tasks.orgId, t.orgId), eq(tasks.title, "Call Kim"))).get();
    expect(made).toBeTruthy();
  });

  it("a member without the mailbox sees no suggestions and cannot act on one; another workspace gets 404", async () => {
    await t.mail({ from: "zed@harbour.com.au", text: "Best,\nZed Ray\nDirector" });
    await t.ctx.db.update((await import("@/server/db/schema")).crmScanTd10).set({ scannedAt: new Date(0) });
    await t.owner.post("/api/crm-td10/suggestions/scan");
    const open = ((await t.owner.get("/api/crm-td10/suggestions")).body.items as { id: string }[])[0];
    const mate = await addMember(t, `mate${seq}@example.com`);
    expect((await mate.get("/api/crm-td10/suggestions")).body.items).toEqual([]);
    expect((await mate.post(`/api/crm-td10/suggestions/${open.id}/accept`)).status).toBe(404);
    expect((await mate.post(`/api/crm-td10/suggestions/${open.id}/discard`)).status).toBe(404);
    const other = await setup();
    expect((await other.owner.post(`/api/crm-td10/suggestions/${open.id}/accept`)).status).toBe(404);
    expect((await other.owner.get("/api/crm-td10/suggestions")).body.items).toEqual([]);
    expect((await t.owner.post("/api/crm-td10/suggestions/bad%20id/accept")).status).toBe(404);
  });

  it("saved analyses: templates, run, save, share; others read only; results follow the viewer", async () => {
    expect((await t.owner.get("/api/crm-td10/analyses/templates")).body.items).toHaveLength(4);
    await t.owner.post("/api/deals", { title: "Fit out", value: 5000, stage: "proposal" });
    await t.owner.post("/api/deals", { title: "Beans", value: 1200, stage: "lead" });
    const run = await t.owner.post("/api/crm-td10/analyses/run", { template: "pipeline_by_stage", filters: { days: 30 } });
    expect(run.status).toBe(200);
    expect(run.body.result.rows.map((r: { label: string; value: number }) => [r.label, r.value]).sort()).toEqual([["Lead", 1200], ["Proposal", 5000]]);
    expect((await t.owner.post("/api/crm-td10/analyses/run", { template: "pipeline_by_stage", filters: { days: 12 } })).status).toBe(422);
    expect((await t.owner.post("/api/crm-td10/analyses/run", { template: "drop table", filters: {} })).status).toBe(422);
    const rates = await t.owner.post("/api/crm-td10/analyses/run", { template: "response_rates", filters: { days: 30 } });
    expect(rates.body.result.format).toBe("percent");
    expect(rates.body.result.rows.length).toBeGreaterThan(0);
    const saved = await t.owner.post("/api/crm-td10/analyses", { name: "Pipeline", template: "pipeline_by_stage", filters: { days: 0 }, shared: true });
    expect(saved.status).toBe(201);
    const priv = await t.owner.post("/api/crm-td10/analyses", { name: "Mine", template: "response_rates", filters: {} });
    const mate = await addMember(t, `mate${++seq}@example.com`);
    const seen = (await mate.get("/api/crm-td10/analyses")).body.items as { id: string; canEdit: boolean }[];
    expect(seen.map((s) => s.id)).toEqual([saved.body.id]);
    expect(seen[0].canEdit).toBe(false);
    expect((await mate.get(`/api/crm-td10/analyses/${priv.body.id}/run`)).status).toBe(404);
    expect((await mate.patch(`/api/crm-td10/analyses/${saved.body.id}`, { name: "Mine now" })).status).toBe(403);
    expect((await mate.del(`/api/crm-td10/analyses/${saved.body.id}`)).status).toBe(403);
    const mateRates = await mate.post("/api/crm-td10/analyses/run", { template: "response_rates", filters: { days: 30 } });
    expect(mateRates.body.result.rows).toEqual([]);
    const other = await setup();
    expect((await other.owner.get(`/api/crm-td10/analyses/${saved.body.id}/run`)).status).toBe(404);
    expect((await t.owner.patch(`/api/crm-td10/analyses/${saved.body.id}`, { shared: false })).body.shared).toBe(false);
    expect((await mate.get(`/api/crm-td10/analyses/${saved.body.id}/run`)).status).toBe(404);
    expect((await t.owner.del(`/api/crm-td10/analyses/${saved.body.id}`)).status).toBe(200);
  });

  it("a new contact suggestion for someone who got a contact since is hidden, and accepting it fills only empty fields", async () => {
    const t4 = await setup();
    await t4.mail({ from: "ivy@vine.com", text: "Thanks,\nIvy Moss\nPartner\n0400 111 222" });
    await t4.owner.post("/api/crm-td10/suggestions/scan");
    const s = ((await t4.owner.get("/api/crm-td10/suggestions")).body.items as { id: string; kind: string }[]).find((x) => x.kind === "new_contact")!;
    await t4.owner.post("/api/contacts", { email: "ivy@vine.com", name: "Ivy M", title: "Boss" });
    expect(((await t4.owner.get("/api/crm-td10/suggestions")).body.items as { id: string }[]).some((x) => x.id === s.id)).toBe(false);
    expect((await t4.owner.post(`/api/crm-td10/suggestions/${s.id}/accept`)).status).toBe(200);
    const ivy = await t4.ctx.db.select().from(contacts).where(and(eq(contacts.orgId, t4.orgId), eq(contacts.email, "ivy@vine.com"))).get();
    expect(ivy).toMatchObject({ name: "Ivy M", title: "Boss", phone: "0400 111 222" });
  });

  it("the shortcut switch is per person", async () => {
    expect((await t.owner.get("/api/crm-td10/prefs")).body).toEqual({ shortcutsOff: false });
    expect((await t.owner.put("/api/crm-td10/prefs", { shortcutsOff: true })).body).toEqual({ shortcutsOff: true });
    expect((await t.owner.get("/api/crm-td10/prefs")).body.shortcutsOff).toBe(true);
    const t3 = await setup();
    const mate = await addMember(t3, `mate${++seq}@example.com`);
    await t3.owner.put("/api/crm-td10/prefs", { shortcutsOff: true });
    expect((await mate.get("/api/crm-td10/prefs")).body.shortcutsOff).toBe(false);
    expect((await t.owner.put("/api/crm-td10/prefs", { shortcutsOff: "yes" })).status).toBe(422);
  });
});
