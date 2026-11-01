import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { closeWord, editDistance, parseFilters, queryWords, scoreMatch, typoBudget, typoPieces, INDEX_CAP } from "@/server/services/search-r98";
import { chatFiles, crmEntries, taskFiles } from "@/server/db/schema";
import { searchEverything } from "@/server/services/search";

/** R98: typo tolerant, filtered search with files and notes, and the instant index. Every permission rule, member, admin and guest. */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let domainId: string;
let ownerId: string;
let wsKey: string;
let orgId: string;


async function verify() {
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
}
async function inbound(to: string, subject: string, text: string, from = { address: "grace@example.com", name: "Grace Hopper" }) {
  return deliverInbound(ctx.deps, {
    envelopeFrom: from.address, rcptTo: to, sizeBytes: text.length + 200, via: "test",
    email: { messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from, to: [{ address: to }], cc: [], subject, text, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
}
async function teammate(email = "mate@acme.io", name = "Sam Mate", role: "member" | "admin" = "member") {
  const invite = await c.post("/api/team/invites", { email, role });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const me = (await m.get("/api/account/me")).body;
  return { client: m, id: me.user.id as string };
}
type Group = { type: string; items: { id: string; title: string; subtitle: string; snippet: string; url: string }[] };
const search = async (cl: Client, q: string, extra = "") => (await cl.get(`/api/search?q=${encodeURIComponent(q)}${extra}`)).body as { groups: Group[]; tookMs: number; partial: boolean };
const group = (r: { groups: Group[] }, type: string) => r.groups.find((g) => g.type === type)?.items ?? [];
const general = async (cl: Client = c) => ((await cl.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
const todayUtc = () => new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  ctx = await makeTestApp({ SEARCH_R98: "on", CRM_TIMELINE: "on" });
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const me = (await c.get("/api/account/me")).body;
  ownerId = me.user.id;
  orgId = me.organization.id;
  domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  await verify();
  wsKey = (await c.post("/api/developer/keys", { name: "Ops" })).body.secret;
});

let seq = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}_${seq++}`;
async function taskFile(taskId: string, filename: string, by = ownerId, org = orgId) {
  const fid = id("tf");
  await ctx.deps.db.insert(taskFiles).values({ id: fid, orgId: org, taskId, filename, contentType: "application/pdf", sizeBytes: 2048, uploadedByType: "member", uploadedById: by, uploadedByName: "Someone" } as never);
  return fid;
}
async function chatFile(channelId: string, messageId: string, filename: string, org = orgId) {
  const fid = id("cf");
  await ctx.deps.db.insert(chatFiles).values({ id: fid, orgId: org, channelId, messageId, filename, contentType: "image/png", sizeBytes: 4096 } as never);
  return fid;
}
async function note(body: string, opts: { private?: boolean; by?: string; entityId?: string } = {}) {
  const nid = id("crm");
  const now = new Date();
  await ctx.deps.db.insert(crmEntries).values({ id: nid, orgId, entityType: "contact", entityId: opts.entityId ?? "ct_x", kind: "note", body, occurredAt: now, private: !!opts.private, authorName: "Olive Owner", createdByType: "member", createdById: opts.by ?? ownerId, createdAt: now, updatedAt: now } as never);
  return nid;
}
const ids = (r: { groups: Group[] }, type: string) => group(r, type).map((x) => x.id);
const allIds = (r: { groups: Group[] }) => r.groups.flatMap((g) => g.items.map((x) => x.id));

describe("words, typos and ranking", () => {
  it("splits words in any script, drops repeats and keeps at most six", () => {
    expect(queryWords("Invoice  MARCH invoice")).toEqual(["invoice", "march"]);
    expect(queryWords("a b c d e f g h")).toHaveLength(6);
    expect(queryWords("café rød 東京")).toEqual(["café", "rød", "東京"]);
    expect(queryWords("ops-12")).toEqual(["ops-12"]);
  });
  it("allows no typo under 4 letters, 1 from 4, 2 from 8", () => {
    expect([typoBudget("abc"), typoBudget("abcd"), typoBudget("abcdefg"), typoBudget("abcdefgh")]).toEqual([0, 1, 1, 2]);
  });
  it("counts inserts, deletes, changes and swaps, and stops early", () => {
    expect(editDistance("invoice", "invoice")).toBe(0);
    expect(editDistance("invoce", "invoice")).toBe(1);
    expect(editDistance("invoicee", "invoice")).toBe(1);
    expect(editDistance("invioce", "invoice")).toBe(1);
    expect(editDistance("invpice", "invoice")).toBe(1);
    expect(editDistance("kitten", "sitting", 2)).toBe(3);
    expect(editDistance("a", "abcdef", 2)).toBe(3);
  });
  it("one typo always leaves one piece of the word whole, so the typo pass can find it", () => {
    const words = ["invoice", "quarterly", "budget", "walrus", "narwhal", "proposal", "kangaroo"];
    const letters = "abcdefghijklmnopqrstuvwxyz";
    for (const w of words) {
      const typos = new Set<string>();
      for (let i = 0; i < w.length; i++) {
        typos.add(w.slice(0, i) + w.slice(i + 1));
        if (i < w.length - 1) typos.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
        for (const ch of letters) { typos.add(w.slice(0, i) + ch + w.slice(i + 1)); typos.add(w.slice(0, i) + ch + w.slice(i)); }
      }
      for (const t of typos) {
        if (typoBudget(t) === 0) continue;
        expect(typoPieces(t).some((p) => w.includes(p)), `${t} for ${w}`).toBe(true);
        expect(closeWord(t, `the ${w} here`), `${t} for ${w}`).not.toBeNull();
      }
    }
  });
  it("finds a word start within the budget and nothing beyond it", () => {
    expect(closeWord("invo", "Invoice March")?.word).toBe("invoice");
    expect(closeWord("invoce", "Invoice March")).toMatchObject({ word: "invoice", distance: 1 });
    expect(closeWord("zzzzzz", "Invoice March")).toBeNull();
    expect(closeWord("cat", "cart")).toBeNull();
  });
  it("ranks title words above word starts above parts above the body, and exact above typo", () => {
    const whole = scoreMatch(["plan"], "Plan for May", "", false)!.score;
    const start = scoreMatch(["plan"], "Planning May", "", false)!.score;
    const part = scoreMatch(["plan"], "Floorplans", "", false)!.score;
    const body = scoreMatch(["plan"], "May", "the plan", false)!.score;
    expect(whole).toBeGreaterThan(start);
    expect(start).toBeGreaterThan(part);
    expect(part).toBeGreaterThan(body);
    expect(scoreMatch(["plna"], "Plan for May", "", false)).toBeNull();
    const typo = scoreMatch(["plna"], "Plan for May", "", true)!;
    expect(typo.typos).toBe(1);
    expect(typo.score).toBeLessThan(body + 30);
    expect(scoreMatch(["plan", "june"], "Plan for May", "", true)).toBeNull();
  });
  it("checks filters: real dates in order, plain ids", () => {
    expect(parseFilters({ from: "2026-10-01", to: "2026-10-31", project: "p_1", person: "u-2" })).toEqual({ from: "2026-10-01", to: "2026-10-31", project: "p_1", person: "u-2" });
    expect(() => parseFilters({ from: "yesterday" })).toThrow(/date like/);
    expect(() => parseFilters({ from: "2026-11-01", to: "2026-10-01" })).toThrow(/after the end/);
    expect(() => parseFilters({ person: "x' or 1=1" })).toThrow(/Unknown person/);
    expect(parseFilters({ from: " ", person: "" })).toEqual({});
  });
});

describe("search with SEARCH_R98", () => {
  it("finds words in any order, forgives a typo, says what it searched for, and strict turns that off", async () => {
    const t = (await c.post("/api/tasks", { title: "Quarterly invoice review" })).body.task;
    expect(ids(await search(c, "review quarterly"), "tasks")).toEqual([t.id]);
    const typo = await search(c, "invoce");
    expect(ids(typo, "tasks")).toEqual([t.id]);
    expect((typo as unknown as { corrected: string }).corrected).toBe("invoice");
    expect(group(typo, "tasks")[0]).toMatchObject({ match: "typo" });
    expect(ids(await search(c, "invoce", "&strict=1"), "tasks")).toEqual([]);
    expect(ids(await search(c, "quartrely reveiw"), "tasks")).toEqual([t.id]);
    // Short words get no typo budget: "inv" is a part of a word, "ivn" finds nothing.
    expect(ids(await search(c, "ivn"), "tasks")).toEqual([]);
  });

  it("ranks a title match first, then newer", async () => {
    const inNotes = (await c.post("/api/tasks", { title: "Call the bank", notes: "about the gecko account" })).body.task;
    const inTitle = (await c.post("/api/tasks", { title: "Gecko launch" })).body.task;
    expect(ids(await search(c, "gecko"), "tasks")).toEqual([inTitle.id, inNotes.id]);
    expect(ids(await search(c, "OPS-1".toLowerCase()), "tasks").length).toBeLessThanOrEqual(1);
  });

  it("filters by project, person, date and type, and leaves out types a filter cannot apply to", async () => {
    const mate = await teammate();
    const p = (await c.post("/api/projects", { name: "Heron" })).body.project;
    const mine = (await c.post("/api/tasks", { title: "Heron copy", projectId: p.id })).body.task;
    const theirs = (await mate.client.post("/api/tasks", { title: "Heron photos", projectId: p.id })).body.task;
    const p2 = (await c.post("/api/projects", { name: "Egret" })).body.project;
    const elsewhere = (await c.post("/api/tasks", { title: "Heron budget", projectId: p2.id })).body.task;
    await c.post("/api/contacts", { email: "heron@x.example", name: "Heron" });
    const byProject = await search(c, "heron", `&project=${p.id}`);
    expect(ids(byProject, "tasks").sort()).toEqual([mine.id, theirs.id].sort());
    expect(group(byProject, "contacts")).toEqual([]);
    expect(ids(await search(c, "heron", `&person=${mate.id}`), "tasks")).toEqual([theirs.id]);
    const today = todayUtc();
    expect(ids(await search(c, "heron", `&from=${today}&to=${today}`), "tasks")).toContain(elsewhere.id);
    expect((await search(c, "heron", "&from=2001-01-01&to=2001-01-02")).groups).toEqual([]);
    expect((await search(c, "heron", "&types=contacts")).groups.map((g) => g.type)).toEqual(["contacts"]);
    expect((await c.get("/api/search?q=heron&from=nope")).status).toBe(422);
  });

  it("refuses a person from another workspace", async () => {
    const other = new Client(ctx.app);
    await other.signup("x@other.io", "Xena Other");
    const otherId = (await other.get("/api/account/me")).body.user.id;
    expect((await c.get(`/api/search?q=anything&person=${otherId}`)).status).toBe(422);
  });

  it("searches files on tasks and in chat, and notes", async () => {
    const t = (await c.post("/api/tasks", { title: "Lease" })).body.task;
    const tf = await taskFile(t.id, "signed-lease-2026.pdf");
    const g = await general();
    const m = (await c.post(`/api/chat/channels/${g.id}/messages`, { body: "photo attached" })).body.message;
    const cf = await chatFile(g.id, m.id, "lease-floorplan.png");
    const files = await search(c, "lease", "&types=files");
    expect(ids(files, "files").sort()).toEqual([tf, cf].sort());
    expect(group(files, "files").find((x) => x.id === tf)).toMatchObject({ url: `/app/tasks?project=${t.projectId}&task=${t.id}` });
    expect(group(files, "files").find((x) => x.id === cf)?.url).toBe(`/app/chat/${g.id}?thread=${m.id}`);
    expect(ids(await search(c, "floorplna"), "files")).toEqual([cf]);
    const n = await note("Albatross wants a discount");
    expect(ids(await search(c, "albatross"), "notes")).toEqual([n]);
  });
});

describe("permissions with SEARCH_R98 (member, admin, guest, key, other workspace)", () => {
  it("never shows another workspace, exact or with a typo", async () => {
    const other = new Client(ctx.app);
    await other.signup("x@other.io", "Xena Other");
    const t = (await other.post("/api/tasks", { title: "Walrus secret plan" })).body.task;
    await other.post("/api/docs", { title: "Walrus secrets", text: "walrus" });
    const otherOrg = (await other.get("/api/account/me")).body.organization.id;
    await taskFile(t.id, "walrus-plan.pdf", "u", otherOrg);
    for (const q of ["walrus", "walrsu", "wlarus plan"]) expect(allIds(await search(c, q))).toEqual([]);
    expect((await c.get("/api/search/index")).body.items.some((x: { title: string }) => /walrus/i.test(x.title))).toBe(false);
  });

  it("keeps private channel messages and files to the channel's members, admins included", async () => {
    const mate = await teammate();
    const admin = await teammate("ada@acme.io", "Ada Admin", "admin");
    const priv = (await c.post("/api/chat/channels", { name: "board", private: true })).body.channel;
    const m = (await c.post(`/api/chat/channels/${priv.id}/messages`, { body: "the narwhal acquisition" })).body.message;
    const f = await chatFile(priv.id, m.id, "narwhal-term-sheet.pdf");
    const dm = (await c.post("/api/chat/dms", { userIds: [mate.id] })).body.channel;
    const dmMsg = (await c.post(`/api/chat/channels/${dm.id}/messages`, { body: "narwhal lunch tomorrow?" })).body.message;
    // The owner is in both.
    const own = await search(c, "narwhal");
    expect(ids(own, "chat").sort()).toEqual([m.id, dmMsg.id].sort());
    expect(ids(own, "files")).toEqual([f]);
    // A member sees the DM they are in, not the private channel (nor its file), with or without a typo.
    for (const q of ["narwhal", "narwhla", "narwhal-term"]) {
      const r = await search(mate.client, q);
      expect(allIds(r)).not.toContain(m.id);
      expect(allIds(r)).not.toContain(f);
    }
    expect(ids(await search(mate.client, "narwhal"), "chat")).toEqual([dmMsg.id]);
    // An admin who is not in the channel or the DM sees neither.
    for (const q of ["narwhal", "narwhla"]) expect(allIds(await search(admin.client, q))).toEqual([]);
    // The index: no private channel name or file for those outside it.
    for (const who of [mate.client, admin.client]) {
      const items = (await who.get("/api/search/index")).body.items as { id: string; title: string }[];
      expect(items.some((x) => x.id === priv.id || x.id === f)).toBe(false);
    }
    expect(((await c.get("/api/search/index")).body.items as { id: string }[]).some((x) => x.id === f)).toBe(true);
  });

  it("shows private notes only to their author, even to admins", async () => {
    const mate = await teammate();
    const admin = await teammate("ada@acme.io", "Ada Admin", "admin");
    const shared = await note("Pelican renewal is safe");
    const mine = await note("Pelican is unhappy with pricing", { private: true });
    const matesOwn = await note("Pelican contact prefers calls", { private: true, by: mate.id });
    expect(ids(await search(c, "pelican"), "notes").sort()).toEqual([shared, mine].sort());
    expect(ids(await search(mate.client, "pelican"), "notes").sort()).toEqual([shared, matesOwn].sort());
    expect(ids(await search(admin.client, "pelican"), "notes")).toEqual([shared]);
    expect(ids(await search(admin.client, "pelcian"), "notes")).toEqual([shared]);
  });

  it("keeps mail to the mailboxes a member was given; owners and admins see the workspace's", async () => {
    const mate = await teammate();
    const admin = await teammate("ada@acme.io", "Ada Admin", "admin");
    const mb = (await c.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Sales" })).body.mailbox;
    await inbound("sales@acme.io", "Toucan order 42", "Please confirm the toucan order");
    expect(group(await search(c, "toucan"), "mail")).toHaveLength(1);
    expect(group(await search(admin.client, "toucan"), "mail")).toHaveLength(1);
    expect(group(await search(mate.client, "toucan"), "mail")).toEqual([]);
    expect(group(await search(mate.client, "tuocan"), "mail")).toEqual([]);
    expect((await c.patch(`/api/team/members/${mate.id}`, { mailboxIds: [mb.id] })).status).toBe(200);
    expect(group(await search(mate.client, "tuocan"), "mail")).toHaveLength(1);
  });

  it("lets a guest search only their project: tasks, docs, files and guest channels; no people filter, no notes", async () => {
    const p = (await c.post("/api/projects", { name: "Harbour site" })).body.project;
    const other = (await c.post("/api/projects", { name: "Internal" })).body.project;
    const inP = (await c.post("/api/tasks", { title: "Ibis homepage copy", projectId: p.id })).body.task;
    const outP = (await c.post("/api/tasks", { title: "Ibis salary review", projectId: other.id })).body.task;
    const fIn = await taskFile(inP.id, "ibis-wireframe.pdf");
    const fOut = await taskFile(outP.id, "ibis-salaries.xlsx");
    await note("Ibis client note");
    const g = await general();
    const shared = (await c.post("/api/chat/channels", { name: "harbour", projectId: p.id, guestAccess: true })).body.channel;
    const sm = (await c.post(`/api/chat/channels/${shared.id}/messages`, { body: "ibis feedback is in" })).body.message;
    const team = (await c.post(`/api/chat/channels/${g.id}/messages`, { body: "ibis team only" })).body.message;
    const teamFile = await chatFile(g.id, team.id, "ibis-team.png");
    const inv = await c.post("/api/guests", { projectId: p.id, email: "client@harbour.example", name: "Mia" });
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const token = sent.map((m) => m.text).reverse().find((t) => t.includes("/g/"))?.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1] ?? (inv.body.inviteUrl as string).split("/g/")[1];
    const guest = new Client(ctx.app);
    expect((await guest.post("/api/guest/accept", { token })).status).toBe(200);
    expect((await guest.get("/api/search?q=ibis")).status).toBe(401);
    expect((await guest.get("/api/search/index")).status).toBe(401);
    for (const q of ["ibis", "ibsi wirefrme"]) {
      const r = (await guest.get(`/api/guest/search?q=${encodeURIComponent(q)}`)).body as { groups: Group[] };
      const all = allIds(r);
      for (const hidden of [outP.id, fOut, team.id, teamFile]) expect(all).not.toContain(hidden);
      expect(r.groups.every((x) => ["tasks", "docs", "chat", "files"].includes(x.type))).toBe(true);
    }
    const r = (await guest.get("/api/guest/search?q=ibis")).body as { groups: Group[] };
    expect(ids(r, "tasks")).toEqual([inP.id]);
    expect(ids(r, "files")).toEqual([fIn]);
    expect(ids(r, "chat")).toEqual([sm.id]);
    expect(group(r, "files")[0].url).toBe(`/guest?task=${inP.id}`);
    expect(((await guest.get(`/api/guest/search?q=ibis&project=${other.id}`)).body as { groups: Group[] }).groups).toEqual([]);
    expect(((await guest.get(`/api/guest/search?q=ibis&person=${ownerId}`)).body as { groups: Group[] }).groups).toEqual([]);
  });

  it("gives API keys no notes and no index", async () => {
    await note("Cormorant pricing");
    await c.post("/api/tasks", { title: "Cormorant launch" });
    const r = await searchEverything(ctx.deps, { kind: "actor", actor: { orgId, userId: ownerId, email: "owner@acme.io", name: "Ops", apiKeyId: "key_1" } }, "cormorant");
    const text = JSON.stringify(r);
    expect(text).toContain("Cormorant launch");
    expect(text).not.toContain("Cormorant pricing");
    const idx = await ctx.app.request("/api/search/index", { headers: { authorization: `Bearer ${wsKey}`, host: "localhost" } });
    expect([401, 403]).toContain(idx.status);
  });

  it("builds a bounded index of titles the person can open", async () => {
    await general();
    const p = (await c.post("/api/projects", { name: "Kestrel" })).body.project;
    await c.post("/api/tasks", { title: "Kestrel nest", projectId: p.id });
    await c.post("/api/docs", { title: "Kestrel brief", text: "x" });
    await c.post("/api/contacts", { email: "k@x.example", name: "Kim Kestrel" });
    const res = await c.get("/api/search/index");
    expect(res.status).toBe(200);
    const items = res.body.items as { type: string; title: string; url: string; projectId?: string }[];
    expect(items.filter((x) => /kestrel/i.test(x.title)).map((x) => x.type).sort()).toEqual(["contacts", "docs", "projects", "tasks"]);
    expect(items.find((x) => x.type === "tasks" && x.title === "Kestrel nest")?.projectId).toBe(p.id);
    expect(items.some((x) => x.type === "channels" && x.title === "#general")).toBe(true);
    expect(Object.values(INDEX_CAP).every((n) => n <= 300)).toBe(true);
  });
});

describe("with SEARCH_R98 off", () => {
  it("answers as before: no index, filters ignored, no files or notes", async () => {
    const off = await makeTestApp();
    const o = new Client(off.app);
    await o.signup("o@acme.io", "Olive Off");
    await o.post("/api/tasks", { title: "Quarterly invoice review" });
    expect((await o.get("/api/search/index")).status).toBe(404);
    const r = (await o.get("/api/search?q=invoice&from=nonsense")).body as { groups: Group[]; corrected?: string };
    expect(r.groups.map((g) => g.type)).toEqual(["tasks"]);
    expect(((await o.get("/api/search?q=invoce")).body as { groups: Group[] }).groups).toEqual([]);
    expect((await o.get("/api/search?q=invoice&types=files,notes")).status).toBe(422);
    expect((await o.get("/api/config")).body.searchR98).toBe(false);
  });
});
