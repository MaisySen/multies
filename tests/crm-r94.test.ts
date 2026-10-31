import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { parseCsv, guessMapping, checkRows } from "@/shared/crm-csv";
import { computeForecast, decodeCursor, encodeCursor, formFields, mergePage, normaliseDomain, type TimelineItem } from "@/server/services/suite/crm-r94";
import { dealCloseFields, dealProbability } from "@/server/services/suite/contacts";

const item = (id: string, at: string, kind: TimelineItem["kind"] = "note"): TimelineItem => ({ kind, id, at });

describe("R94 CSV", () => {
  it("parses quotes, doubled quotes, CRLF, a BOM and semicolons", () => {
    expect(parseCsv('\uFEFFname,email\r\n"Lee, Ann",ann@x.com\r\n"Say ""hi""",b@x.com\r\n')).toEqual([["name", "email"], ["Lee, Ann", "ann@x.com"], ['Say "hi"', "b@x.com"]]);
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv('a,b\n"line\none",2\n\n')).toEqual([["a", "b"], ["line\none", "2"]]);
  });
  it("guesses columns from common headers", () => {
    const m = guessMapping(["First Name", "Last Name", "E-mail Address", "Mobile", "Organisation", "Job Title"]);
    expect(m).toMatchObject({ firstName: 0, lastName: 1, email: 2, phone: 3, company: 4, title: 5, name: -1, notes: -1 });
    expect(guessMapping(["Contact", "Work mail"]).email).toBe(1);
  });
  it("checks rows: bad and missing emails by line, repeats counted once, names joined", () => {
    const rows = parseCsv("First,Last,Email\nAnn,Lee,ANN@x.com\nBob,,not-an-email\nCat,,\nAnn,Again,ann@x.com\nDee,Doe,dee@y.co");
    const c = checkRows(rows.slice(1), guessMapping(rows[0]));
    expect(c.rows.map((r) => r.email)).toEqual(["ann@x.com", "dee@y.co"]);
    expect(c.rows[0].name).toBe("Ann Lee");
    expect(c.invalid).toEqual([{ line: 3, reason: "Email looks wrong" }, { line: 4, reason: "No email" }]);
    expect(c.duplicatesInFile).toBe(1);
    expect(c.tooMany).toBe(false);
  });
});

describe("R94 timeline paging", () => {
  it("merges sources newest first and pages without repeats", () => {
    const a = [item("a3", "2026-10-03T00:00:00Z"), item("a1", "2026-10-01T00:00:00Z")];
    const b = [item("b2", "2026-10-02T00:00:00Z", "mail"), item("b0", "2026-09-30T00:00:00Z", "mail")];
    const p1 = mergePage([a, b], null, 2);
    expect(p1.items.map((i) => i.id)).toEqual(["a3", "b2"]);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = mergePage([a, b], decodeCursor(p1.nextCursor), 2);
    expect(p2.items.map((i) => i.id)).toEqual(["a1", "b0"]);
    expect(p2.nextCursor).toBeNull();
  });
  it("breaks ties on the same moment by id and never skips one", () => {
    const same = [item("x2", "2026-10-01T00:00:00Z"), item("x1", "2026-10-01T00:00:00Z"), item("x0", "2026-10-01T00:00:00Z")];
    const p1 = mergePage([same], null, 2);
    const p2 = mergePage([same], decodeCursor(p1.nextCursor), 2);
    expect([...p1.items, ...p2.items].map((i) => i.id)).toEqual(["x2", "x1", "x0"]);
  });
  it("round trips a cursor and rejects junk", () => {
    expect(decodeCursor(encodeCursor(item("cre_1", "2026-10-01T00:00:00Z")))).toEqual({ at: Date.parse("2026-10-01T00:00:00Z"), id: "cre_1" });
    expect(decodeCursor("nope")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("R94 deals", () => {
  it("uses the stage default unless a deal has its own chance; won and lost are fixed", () => {
    expect(dealProbability("lead", null)).toBe(10);
    expect(dealProbability("proposal", 75)).toBe(75);
    expect(dealProbability("won", 20)).toBe(100);
    expect(dealProbability("lost", 90)).toBe(0);
    expect(dealProbability("qualified", 150)).toBe(100);
  });
  it("stamps the close date on won or lost and clears it when reopened", () => {
    const now = new Date("2026-10-31T00:00:00Z");
    expect(dealCloseFields({ stage: "proposal", closedAt: null }, { stage: "won", closeReason: "Best price" }, now)).toEqual({ closedAt: now, closeReason: "Best price" });
    expect(dealCloseFields({ stage: "won", closedAt: now }, { stage: "lead" }, now)).toEqual({ closedAt: null, closeReason: null });
    expect(dealCloseFields({ stage: "lost", closedAt: now }, { closeReason: "Too dear" }, now)).toEqual({ closeReason: "Too dear" });
    expect(dealCloseFields({ stage: "lead", closedAt: null }, { title: "x" } as never, now)).toEqual({});
  });
  it("forecasts the weighted pipeline by month, this month's wins and the top reasons", () => {
    const now = new Date("2026-10-15T00:00:00Z");
    const f = computeForecast([
      { stage: "proposal", valueCents: 100_000, probability: null, expectedCloseAt: new Date("2026-10-20T00:00:00Z"), closedAt: null, closeReason: null },
      { stage: "lead", valueCents: 50_000, probability: 50, expectedCloseAt: new Date("2026-12-01T00:00:00Z"), closedAt: null, closeReason: null },
      { stage: "qualified", valueCents: 10_000, probability: null, expectedCloseAt: null, closedAt: null, closeReason: null },
      { stage: "qualified", valueCents: 20_000, probability: null, expectedCloseAt: new Date("2026-08-01T00:00:00Z"), closedAt: null, closeReason: null },
      { stage: "won", valueCents: 30_000, probability: null, expectedCloseAt: null, closedAt: new Date("2026-10-02T00:00:00Z"), closeReason: "Fast reply" },
      { stage: "lost", valueCents: 40_000, probability: null, expectedCloseAt: null, closedAt: new Date("2026-10-03T00:00:00Z"), closeReason: "Price" },
      { stage: "lost", valueCents: 1, probability: null, expectedCloseAt: null, closedAt: new Date("2026-09-20T00:00:00Z"), closeReason: "Price" },
    ], now);
    expect(f.months[0]).toMatchObject({ month: "2026-10", weighted: 660, count: 2 });
    expect(f.months[2]).toMatchObject({ month: "2026-12", weighted: 250 });
    expect(f.openWeighted).toBe(600 + 250 + 30 + 60);
    expect(f.noDate).toBe(1);
    expect(f.overdue).toBe(1);
    expect(f.wonThisMonth).toBe(300);
    expect(f.lostThisMonth).toBe(400);
    expect(f.reasons.lost).toEqual([{ reason: "Price", count: 2 }]);
  });
});

describe("R94 helpers", () => {
  it("labels form answers and skips empty ones", () => {
    expect(formFields('[{"id":"f1","label":"Your name"},{"id":"f2","label":"Budget"}]', '{"f1":"Ann","f2":"","f3":"x","f4":{"a":1}}')).toEqual([{ label: "Your name", value: "Ann" }, { label: "f3", value: "x" }]);
    expect(formFields("bad", "bad")).toEqual([]);
  });
  it("cleans a website into a domain", () => {
    expect(normaliseDomain("https://www.Acme.com.au/about")).toBe("acme.com.au");
    expect(normaliseDomain("")).toBeNull();
    expect(() => normaliseDomain("not a site")).toThrow();
  });
});

async function setup(env: Record<string, string> = { CRM_TIMELINE: "on" }) {
  const t = await makeTestApp(env);
  const owner = new Client(t.app);
  await owner.signup("owner-r94@example.com");
  const contact = (await owner.post("/api/contacts", { email: "sam@harbour.com.au", name: "Sam Lee" })).body.contact;
  return { ...t, owner, contact };
}
async function addMember(t: Awaited<ReturnType<typeof setup>>) {
  const invite = await t.owner.post("/api/team/invites", { email: "mate-r94@example.com", role: "member" });
  const mate = new Client(t.app);
  await mate.signup("mate-r94@example.com", "Mate", "");
  expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return mate;
}

describe("R94 API", () => {
  it("is not found while CRM_TIMELINE is off, and says so in public config", async () => {
    const t = await setup({});
    expect((await t.owner.get(`/api/crm/timeline?type=contact&id=${t.contact.id}`)).status).toBe(404);
    expect((await t.owner.get("/api/config")).body.crmTimeline).toBe(false);
    const on = await setup();
    expect((await on.owner.get("/api/config")).body.crmTimeline).toBe(true);
  });

  it("logs notes and calls and pages a long timeline with no repeats", async () => {
    const t = await setup();
    const call = await t.owner.post("/api/crm/entries", { entityType: "contact", entityId: t.contact.id, kind: "call", body: "", outcome: "voicemail", durationMin: 2 });
    expect(call.status).toBe(201);
    expect(call.body.entry).toMatchObject({ kind: "call", outcome: "voicemail", durationMin: 2, mine: true, canEdit: true });
    expect((await t.owner.post("/api/crm/entries", { entityType: "contact", entityId: t.contact.id, kind: "note", body: "  " })).status).toBe(400);
    for (let i = 0; i < 64; i++) {
      const at = new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString();
      await t.owner.post("/api/crm/entries", { entityType: "contact", entityId: t.contact.id, kind: "note", body: `Note ${i}`, occurredAt: at });
    }
    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const r = await t.owner.get(`/api/crm/timeline?type=contact&id=${t.contact.id}&limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((i: { id: string }) => i.id));
      if (!r.body.nextCursor) break;
      cursor = r.body.nextCursor;
    }
    const entries = seen.filter((id) => id.startsWith("cre_"));
    expect(entries.length).toBe(65);
    expect(new Set(seen).size).toBe(seen.length);
    const calls = await t.owner.get(`/api/crm/timeline?type=contact&id=${t.contact.id}&kinds=call`);
    expect(calls.body.items.map((i: { kind: string }) => i.kind)).toEqual(["call"]);
  });

  it("keeps private notes to their author; members cannot change someone else's note", async () => {
    const t = await setup();
    const mate = await addMember(t);
    const shared = (await t.owner.post("/api/crm/entries", { entityType: "contact", entityId: t.contact.id, kind: "note", body: "Shared" })).body.entry;
    await t.owner.post("/api/crm/entries", { entityType: "contact", entityId: t.contact.id, kind: "note", body: "Owner only", private: true });
    const seen = await mate.get(`/api/crm/timeline?type=contact&id=${t.contact.id}`);
    const bodies = seen.body.items.filter((i: { entry?: unknown }) => i.entry).map((i: { entry: { body: string } }) => i.entry.body);
    expect(bodies).toEqual(["Shared"]);
    expect((await mate.patch(`/api/crm/entries/${shared.id}`, { body: "Changed" })).status).toBe(403);
    expect((await mate.del(`/api/crm/entries/${shared.id}`)).status).toBe(403);
    const mine = (await mate.post("/api/crm/entries", { entityType: "contact", entityId: t.contact.id, kind: "note", body: "Mate note" })).body.entry;
    expect((await mate.patch(`/api/crm/entries/${mine.id}`, { body: "Mate note edited" })).body.entry.body).toBe("Mate note edited");
    // An admin can tidy a shared note; a delete can be undone.
    expect((await t.owner.del(`/api/crm/entries/${mine.id}`)).status).toBe(200);
    expect((await t.owner.post(`/api/crm/entries/${mine.id}/restore`)).body.entry.body).toBe("Mate note edited");
  });

  it("sets a next step as a linked task and pins the earliest open one", async () => {
    const t = await setup();
    const r = await t.owner.post("/api/crm/next-step", { entityType: "contact", entityId: t.contact.id, title: "Send the quote", due: "2026-11-03" });
    expect(r.status).toBe(201);
    const tl = await t.owner.get(`/api/crm/timeline?type=contact&id=${t.contact.id}`);
    expect(tl.body.nextStep).toMatchObject({ title: "Send the quote" });
    expect(tl.body.items.some((i: { kind: string }) => i.kind === "task")).toBe(true);
    expect((await t.owner.post("/api/crm/next-step", { entityType: "contact", entityId: t.contact.id, title: "x", due: "soon" })).status).toBe(422);
  });

  it("adds a company by hand and shows its people's activity on the company timeline", async () => {
    const t = await setup();
    const co = await t.owner.post("/api/crm/companies", { name: "Harbour Coffee", domain: "https://www.harbourbeans.com/" });
    expect(co.status).toBe(201);
    expect(co.body.company.domain).toBe("harbourbeans.com");
    expect((await t.owner.post("/api/crm/companies", { name: "Again", domain: "harbourbeans.com" })).status).toBe(400);
    await t.owner.patch(`/api/contacts/${t.contact.id}`, { companyId: co.body.company.id });
    await t.owner.post("/api/crm/entries", { entityType: "contact", entityId: t.contact.id, kind: "meeting", body: "Tasting session" });
    await t.owner.post("/api/crm/entries", { entityType: "company", entityId: co.body.company.id, kind: "note", body: "Head office in Bondi" });
    const tl = await t.owner.get(`/api/crm/timeline?type=company&id=${co.body.company.id}`);
    const entries = tl.body.items.filter((i: { entry?: unknown }) => i.entry);
    expect(entries.map((i: { entry: { body: string } }) => i.entry.body).sort()).toEqual(["Head office in Bondi", "Tasting session"]);
    expect(entries.find((i: { person?: { name: string } }) => i.person)?.person.name).toBe("Sam Lee");
  });

  it("records won and lost reasons, shows them on the timeline and in the forecast", async () => {
    const t = await setup();
    const deal = (await t.owner.post("/api/deals", { title: "Cafe fit out", value: 5000, contactId: t.contact.id, expectedClose: "2026-12-01" })).body.deal;
    expect(deal).toMatchObject({ probability: 10, probabilitySet: false, closeReason: null });
    const set = await t.owner.patch(`/api/deals/${deal.id}`, { probability: 40 });
    expect(set.body.deal).toMatchObject({ probability: 40, probabilitySet: true });
    const won = await t.owner.patch(`/api/deals/${deal.id}`, { stage: "won", closeReason: "Fast reply" });
    expect(won.body.deal).toMatchObject({ stage: "won", probability: 100, closeReason: "Fast reply" });
    expect(won.body.deal.closedAt).toBeTruthy();
    const tl = await t.owner.get(`/api/crm/timeline?type=contact&id=${t.contact.id}&kinds=deal`);
    expect(tl.body.items.map((i: { deal: { event: string } }) => i.deal.event)).toEqual(["won", "created"]);
    const f = await t.owner.get("/api/crm/forecast");
    expect(f.body.wonThisMonth).toBe(5000);
    expect(f.body.reasons.won).toEqual([{ reason: "Fast reply", count: 1 }]);
    const reopened = await t.owner.patch(`/api/deals/${deal.id}`, { stage: "proposal" });
    expect(reopened.body.deal).toMatchObject({ closedAt: null, closeReason: null, probability: 40 });
  });

  it("saves segments and filters contacts by them; personal segments stay personal", async () => {
    const t = await setup();
    const mate = await addMember(t);
    await t.owner.post("/api/contacts", { email: "solo@gmail.com", name: "Solo" });
    const seg = await t.owner.post("/api/crm/segments", { name: "No company", filters: { noCompany: true, junk: "x" } });
    expect(seg.status).toBe(201);
    expect(seg.body.segment.filters).toEqual({ noCompany: true });
    const list = await t.owner.get(`/api/crm/contacts?segment=${seg.body.segment.id}`);
    expect(list.body.contacts.map((c: { email: string }) => c.email)).toEqual(["solo@gmail.com"]);
    expect((await mate.get("/api/crm/segments")).body.segments).toEqual([]);
    const team = (await t.owner.post("/api/crm/segments", { name: "Imported", filters: { source: "import" }, shared: true })).body.segment;
    expect((await mate.get("/api/crm/segments")).body.segments.map((s: { name: string }) => s.name)).toEqual(["Imported"]);
    expect((await mate.del(`/api/crm/segments/${team.id}`)).status).toBe(403);
    expect((await mate.get(`/api/crm/contacts?segment=${seg.body.segment.id}`)).status).toBe(404);
  });

  it("imports CSV rows in batches: new rows created, matches skipped or updated", async () => {
    const t = await setup();
    const check = await t.owner.post("/api/crm/import/check", { emails: ["sam@harbour.com.au", "new@acme.io", "NEW@acme.io"] });
    expect(check.body).toEqual({ total: 2, existing: 1, new: 1 });
    const skip = await t.owner.post("/api/crm/import/batch", { mode: "skip", rows: [
      { email: "sam@harbour.com.au", name: "Samuel" }, { email: "new@acme.io", name: "New Person", company: "Acme Labs", title: "CEO" },
    ] });
    expect(skip.body).toMatchObject({ created: 1, skipped: 1, updated: 0, failed: [] });
    const people = (await t.owner.get("/api/contacts?q=acme")).body.contacts;
    expect(people[0]).toMatchObject({ email: "new@acme.io", name: "New Person", title: "CEO", source: "import" });
    expect(people[0].company.name).toBe("Acme Labs");
    const upd = await t.owner.post("/api/crm/import/batch", { mode: "update", rows: [{ email: "sam@harbour.com.au", name: "Samuel", phone: "0400 000 000" }] });
    expect(upd.body).toMatchObject({ updated: 1 });
    expect((await t.owner.get(`/api/contacts/${t.contact.id}`)).body.contact).toMatchObject({ name: "Samuel", phone: "0400 000 000" });
    expect((await t.owner.post("/api/crm/import/batch", { rows: Array.from({ length: 26 }, (_, i) => ({ email: `p${i}@x.io` })) })).status).toBe(422);
  });
});
