/** TD5 mentions: token parsing and labels, index on create, edit and delete, permission aware resolve and References,
 * other workspace 404, flag off 404 with nothing written, private channel and private note read as restricted, log scrub. */
import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { diffRefs, labelsToTokens, parseRefKey, parseRefs, tokensToLabels, atQuery, MAX_REFS_PER_SOURCE, displayTitle } from "@/shared/mentions-td5";
import { isMentionsExcluded, syncRefs } from "@/server/services/mentions-td5";

describe("TD5 pure rules", () => {
  it("parses tokens strictly, dedupes and caps", () => {
    const t = "see <#task:tsk_1> and <#doc:doc_2> and <#task:tsk_1> <#bogus:x> <#doc:bad id> <#contact:OPS-12>";
    expect(parseRefs(t)).toEqual([{ type: "task", id: "tsk_1" }, { type: "doc", id: "doc_2" }, { type: "contact", id: "OPS-12" }]);
    const many = Array.from({ length: 30 }, (_, i) => `<#doc:d${i}>`).join(" ");
    expect(parseRefs(many)).toHaveLength(MAX_REFS_PER_SOURCE);
    expect(parseRefKey("invoice:inv_1")).toEqual({ type: "invoice", id: "inv_1" });
    expect(parseRefKey("user:1")).toBeNull();
    expect(parseRefKey("doc:<script>")).toBeNull();
  });
  it("labels round trip, clashes numbered, restricted keeps its token", () => {
    const text = "a <#doc:1> b <#doc:2> c <#invoice:9> d <#doc:1>";
    const { text: shown, map } = tokensToLabels(text, { "doc:1": "Plan", "doc:2": "Plan", "invoice:9": "Restricted item" });
    expect(shown).toBe("a @[Plan] b @[Plan 2] c @[Restricted item] d @[Plan]");
    expect(labelsToTokens(shown + " more", map)).toBe(text + " more");
    expect(tokensToLabels("<#doc:1>", { "doc:1": "Bad ] <name>" }).text).toBe("@[Bad name]");
  });
  it("diff, @ query, display titles, exclusion", () => {
    expect(diffRefs([{ type: "doc", id: "a" }, { type: "task", id: "b" }], [{ type: "task", id: "b" }, { type: "deal", id: "c" }]))
      .toEqual({ add: [{ type: "deal", id: "c" }], remove: [{ type: "doc", id: "a" }] });
    expect(atQuery("hi @pla", 7)).toEqual({ start: 3, query: "pla" });
    expect(atQuery("mail a@b", 8)).toBeNull();
    expect(atQuery("see @orbit la", 13)).toEqual({ start: 4, query: "orbit la" });
    expect(atQuery("see @a b c d", 12)).toBeNull();
    expect(displayTitle({ state: "restricted", type: "doc", id: "x" })).toBe("Restricted item");
    expect(displayTitle({ state: "deleted", type: "doc", id: "x" })).toBe("Deleted item");
    expect(isMentionsExcluded({ id: "org_1", slug: "vv8k-co" })).toBe(true);
    expect(isMentionsExcluded({ id: "org_1", slug: "acme" }, "acme")).toBe(true);
    expect(isMentionsExcluded({ id: "org_1", slug: "acme" })).toBe(false);
  });
  it("a failed index write reports no text and never throws", async () => {
    const reportError = vi.fn();
    const deps = { config: { mentionsTd5: true }, db: { all: async () => { throw new Error("db down"); } }, reportError } as never;
    await expect(syncRefs(deps, { orgId: "org_x", userId: "u" }, { type: "chat", id: "m1" }, "secret words <#doc:d1>")).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(reportError.mock.calls[0][1])).toBe('{"where":"mentions-td5.sync","sourceType":"chat"}');
  });
});

async function setup(env: Record<string, string> = { MENTIONS_TD5: "on", INVOICES_ENABLED: "true", CRM_TIMELINE: "on" }) {
  const ctx = await makeTestApp(env);
  const admin = new Client(ctx.app);
  await admin.signup("ada@acme.io", "Ada Lovelace", "Acme");
  const inv = await admin.post("/api/team/invites", { email: "bo@acme.io", role: "member" });
  const member = new Client(ctx.app);
  await member.signup("bo@acme.io", "Bo Member", "Bo Co");
  expect((await member.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const proj = (await admin.post("/api/projects", { name: "Launch" })).body.project;
  const task = (await admin.post("/api/tasks", { projectId: proj.id, title: "Ship the launch" })).body.task;
  const doc = (await admin.post("/api/docs", { title: "Launch plan", text: "plan" })).body.doc;
  const contact = (await admin.post("/api/contacts", { email: "kim@client.co", name: "Kim Client" })).body.contact;
  const general = (await admin.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
  const rows = async () => ctx.deps.db.all<{ source_type: string; target_type: string; target_id: string }>(sql`select source_type, target_type, target_id from record_refs order by source_type, target_id`);
  return { ctx, admin, member, proj, task, doc, contact, general, rows };
}

describe("TD5 index and References", () => {
  it("chat message: indexed on send, rewritten on edit, removed on delete; panel shows the channel", async () => {
    const t = await setup();
    const m = (await t.admin.post(`/api/chat/channels/${t.general.id}/messages`, { body: `look <#doc:${t.doc.id}> and <#contact:${t.contact.id}> and <#doc:nope>` })).body.message;
    expect((await t.rows()).map((r) => `${r.source_type}>${r.target_type}`).sort()).toEqual(["chat>contact", "chat>doc"]);
    const inDoc = await t.member.get(`/api/mentions/refs/doc/${t.doc.id}?dir=in`);
    expect(inDoc.status).toBe(200);
    expect(inDoc.body.items[0].record).toMatchObject({ state: "ok", type: "channel", title: "#general" });
    expect((await t.admin.patch(`/api/chat/messages/${m.id}`, { body: `only <#contact:${t.contact.id}>` })).status).toBe(200);
    expect((await t.rows()).map((r) => r.target_type)).toEqual(["contact"]);
    expect((await t.member.get(`/api/mentions/refs/doc/${t.doc.id}?dir=in`)).body.items).toEqual([]);
    expect((await t.admin.del(`/api/chat/messages/${m.id}`)).status).toBe(200);
    expect(await t.rows()).toEqual([]);
  });

  it("chat cards are resolved per reader: private channel and deleted targets carry no title", async () => {
    const t = await setup();
    const priv = (await t.admin.post("/api/chat/channels", { name: "secret", private: true })).body.channel;
    const m = (await t.admin.post(`/api/chat/channels/${t.general.id}/messages`, { body: `doc <#doc:${t.doc.id}> task <#task:${t.task.id}>` })).body.message;
    const list = await t.member.get(`/api/chat/channels/${t.general.id}/messages`);
    const mine = list.body.messages.find((x: { id: string }) => x.id === m.id);
    expect(mine.links.find((l: { type: string }) => l.type === "doc")).toMatchObject({ title: "Launch plan", url: `/app/docs/${t.doc.id}` });
    expect((await t.admin.del(`/api/docs/${t.doc.id}`)).status).toBeLessThan(300);
    const again = (await t.member.get(`/api/chat/channels/${t.general.id}/messages`)).body.messages.find((x: { id: string }) => x.id === m.id);
    expect(again.links.find((l: { type: string }) => l.type === "doc")).toMatchObject({ state: "deleted", title: "" });
    // A private channel message that mentions the task: the member sees "restricted" in the task's panel, no channel name.
    await t.admin.post(`/api/chat/channels/${priv.id}/messages`, { body: `secret plan for <#task:${t.task.id}>` });
    const inTask = (await t.member.get(`/api/mentions/refs/task/${t.task.id}?dir=in`)).body.items;
    const restricted = inTask.find((x: { record: { state: string } }) => x.record.state === "restricted");
    expect(restricted.record).toEqual({ state: "restricted", type: "channel", id: priv.id });
    expect(JSON.stringify(inTask)).not.toContain("secret");
    const adminView = (await t.admin.get(`/api/mentions/refs/task/${t.task.id}?dir=in`)).body.items;
    expect(adminView.some((x: { record: { title?: string } }) => x.record.title === "#secret")).toBe(true);
  });

  it("task description, task comment and contact note: both directions, private note restricted", async () => {
    const t = await setup();
    expect((await t.admin.patch(`/api/tasks/${t.task.id}`, { notes: `Brief in <#doc:${t.doc.id}>` })).status).toBe(200);
    await t.admin.post(`/api/tasks/${t.task.id}/comments`, { body: `client <#contact:${t.contact.id}>` });
    const out = (await t.member.get(`/api/mentions/refs/task/${t.task.id}?dir=out`)).body;
    expect(out.items.map((x: { record: { title: string } }) => x.record.title).sort()).toEqual(["Kim Client", "Launch plan"]);
    const inDoc = (await t.member.get(`/api/mentions/refs/doc/${t.doc.id}?dir=in`)).body.items;
    expect(inDoc[0]).toMatchObject({ via: "task", record: { state: "ok", type: "task", title: "Ship the launch" } });
    // Editing the description drops the stale link.
    await t.admin.patch(`/api/tasks/${t.task.id}`, { notes: "No links now" });
    expect((await t.member.get(`/api/mentions/refs/doc/${t.doc.id}?dir=in`)).body.items).toEqual([]);
    // A private note by the admin that mentions the doc: the member sees it as restricted, the admin as the contact.
    await t.admin.post("/api/crm/entries", { entityType: "contact", entityId: t.contact.id, kind: "note", body: `see <#doc:${t.doc.id}>`, private: true });
    const memberIn = (await t.member.get(`/api/mentions/refs/doc/${t.doc.id}?dir=in`)).body.items;
    expect(memberIn[0].record).toEqual({ state: "restricted", type: "contact", id: t.contact.id });
    expect((await t.admin.get(`/api/mentions/refs/doc/${t.doc.id}?dir=in`)).body.items[0].record).toMatchObject({ state: "ok", title: "Kim Client" });
    // The contact's outgoing list hides the private note from the member.
    expect((await t.member.get(`/api/mentions/refs/contact/${t.contact.id}?dir=out`)).body.items).toEqual([]);
  });

  it("search lists people and records the caller can see, newest first; invoices only for admins", async () => {
    const t = await setup();
    await t.admin.post("/api/invoices/docs", { kind: "invoice", buyerName: "Launch buyer", lines: [{ description: "Design", quantityMilli: 1000, unitCents: 10000 }] });
    const a = (await t.admin.get("/api/mentions/search?q=launch")).body;
    expect(a.records.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(["task", "doc", "project", "invoice"]));
    const m = (await t.member.get("/api/mentions/search?q=launch")).body;
    expect(m.records.some((x: { type: string }) => x.type === "invoice")).toBe(false);
    expect((await t.member.get("/api/mentions/search?q=ada")).body.people[0]).toMatchObject({ kind: "person", title: "Ada Lovelace" });
    const inv = a.records.find((x: { type: string }) => x.type === "invoice");
    const r = (await t.member.post("/api/mentions/resolve", { refs: [`invoice:${inv.id}`, `doc:${t.doc.id}`, "doc:unknown", "nope"] })).body.items;
    expect(r[`invoice:${inv.id}`]).toEqual({ state: "restricted", type: "invoice", id: inv.id });
    expect(r[`doc:${t.doc.id}`]).toMatchObject({ state: "ok", title: "Launch plan" });
    expect(r["doc:unknown"].state).toBe("deleted");
    expect((await t.member.get(`/api/mentions/refs/invoice/${inv.id}`)).status).toBe(404);
    expect((await t.member.post("/api/mentions/resolve", { refs: Array.from({ length: 51 }, (_, i) => `doc:d${i}`) })).status).toBe(422);
  });

  it("other workspace: 404 on the record path, deleted on resolve, nothing from search", async () => {
    const t = await setup();
    const other = new Client(t.ctx.app);
    await other.signup("eve@other.io", "Eve Other", "Other");
    expect((await other.get(`/api/mentions/refs/doc/${t.doc.id}`)).status).toBe(404);
    expect((await other.post("/api/mentions/resolve", { refs: [`doc:${t.doc.id}`] })).body.items[`doc:${t.doc.id}`]).toEqual({ state: "deleted", type: "doc", id: t.doc.id });
    expect((await other.get("/api/mentions/search?q=launch")).body.records).toEqual([]);
    // A foreign id in Eve's own chat is not indexed.
    const g = (await other.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
    await other.post(`/api/chat/channels/${g.id}/messages`, { body: `<#doc:${t.doc.id}>` });
    expect(await t.rows()).toEqual([]);
    expect((await new Client(t.ctx.app).get("/api/mentions/search?q=a")).status).toBe(401);
  });

  it("flag off: every path 404 and nothing is indexed", async () => {
    const t = await setup({});
    expect((await t.admin.get("/api/mentions/search?q=launch")).status).toBe(404);
    expect((await t.admin.get(`/api/mentions/refs/doc/${t.doc.id}`)).status).toBe(404);
    await t.admin.post(`/api/chat/channels/${t.general.id}/messages`, { body: `<#doc:${t.doc.id}>` });
    await t.admin.patch(`/api/tasks/${t.task.id}`, { notes: `<#doc:${t.doc.id}>` });
    expect(await t.rows()).toEqual([]);
  });
});
