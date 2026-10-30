import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { entityLinks } from "@/server/db/schema";
import { actionItemsOf, actionItemText, appendActionItem, collectTaskItems, itemKey, notesTemplate, parseActionItem, parseDue, sectionsOf, type ActionPerson, type PMNodeLike } from "@/shared/action-items";
import { createActionItems, ensureNotesDoc, meetingNotes } from "@/server/services/suite/meeting-notes";

/** Round 23 (R23.1, R23.5): a meeting's agenda and notes doc, and action items that become tasks. */

const people: ActionPerson[] = [
  { type: "member", id: "usr_kai", name: "Kai Lee", email: "kai@acme.io" },
  { type: "member", id: "usr_kate", name: "Kate Moss", email: "kate@acme.io" },
  { type: "member", id: "usr_mia", name: "Mia Wong", email: "mia@acme.io" },
  { type: "agent", id: "agt_bot", name: "Helper", email: "helper@acme.io" },
];
// Monday 26 October 2026, 03:00 UTC = 14:00 in Sydney (Mon), 20:00 Sunday 25th in Los Angeles.
const NOW = new Date("2026-10-26T03:00:00Z");
const item = (text: string, checked = false) => ({ type: "taskItem", attrs: { checked }, content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }] });
const docOf = (...nodes: PMNodeLike[]): PMNodeLike => ({ type: "doc", content: nodes });
const p = (text: string, mentionIds: string[] = []) => parseActionItem({ key: itemKey(text), text, checked: false, mentionIds }, people, NOW, "Australia/Sydney");

describe("action item parser", () => {
  it("reads due dates in many phrasings", () => {
    const due = (s: string, tz = "Australia/Sydney") => parseDue(s, NOW, tz)?.due ?? null;
    expect(due("Send deck due Fri")).toBe("2026-10-30");
    expect(due("Send deck by Friday")).toBe("2026-10-30");
    expect(due("Send deck due Mon")).toBe("2026-10-26"); // today counts
    expect(due("Send deck by next Monday")).toBe("2026-11-02"); // next skips today
    expect(due("Send deck by 30 Oct")).toBe("2026-10-30");
    expect(due("Send deck by October 30th")).toBe("2026-10-30");
    expect(due("Send deck due 3 Nov 2027")).toBe("2027-11-03");
    expect(due("Send deck by 2026-10-30")).toBe("2026-10-30");
    expect(due("Send deck by 1 Jan")).toBe("2027-01-01"); // a passed date rolls to next year
    expect(due("Send deck by 20 Oct")).toBe("2027-10-20");
    expect(due("Send deck tomorrow")).toBe("2026-10-27");
    expect(due("Send deck today")).toBe("2026-10-26");
    expect(due("Send deck by 2026-02-30")).toBeNull();
    expect(due("Mon standup notes")).toBeNull(); // a bare weekday is not a date
    expect(due("Ship v2")).toBeNull();
  });

  it("resolves relative dates in the meeting's time zone", () => {
    // Same instant: Monday in Sydney, still Sunday in Los Angeles.
    expect(parseDue("tomorrow", NOW, "Australia/Sydney")?.due).toBe("2026-10-27");
    expect(parseDue("tomorrow", NOW, "America/Los_Angeles")?.due).toBe("2026-10-26");
    expect(parseDue("due Mon", NOW, "America/Los_Angeles")?.due).toBe("2026-10-26");
    expect(parseDue("tomorrow", NOW, "Not/AZone")?.due).toBe("2026-10-27"); // bad zone: UTC
  });

  it("finds assignees from @name, @first name, @email and mention nodes", () => {
    expect(p("Book venue @Kai Lee due Fri")).toMatchObject({ title: "Book venue", assignee: { id: "usr_kai" }, due: "2026-10-30" });
    expect(p("@mia@acme.io to draft the brief by 30 Oct")).toMatchObject({ title: "to draft the brief", assignee: { id: "usr_mia" }, due: "2026-10-30" });
    expect(p("Ping supplier @mia")).toMatchObject({ title: "Ping supplier", assignee: { id: "usr_mia" } });
    // "Ka" matches nobody; two people start with K so a first name has to be whole.
    expect(p("Call @Ka about it").assignee).toBeNull();
    expect(p("Ask @Helper to triage").assignee).toMatchObject({ type: "agent", id: "agt_bot" });
    expect(p("Write notes", ["usr_kate"]).assignee).toMatchObject({ id: "usr_kate" });
    expect(p("Plain item")).toMatchObject({ title: "Plain item", assignee: null, due: null });
  });

  it("collects task items anywhere, skips checked and empty ones, and keys repeats apart", () => {
    const doc = docOf(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Agenda" }] },
      { type: "paragraph", content: [{ type: "text", text: "Budget" }] },
      { type: "taskList", content: [item("Early item @Kai Lee")] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Action items" }] },
      { type: "taskList", content: [item("Send recap"), item("Done already", true), item(""), item("send  RECAP"),
        { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Review " }, { type: "mention", attrs: { id: "usr_kate", label: "Kate Moss" } }] }] }] },
    );
    const raw = collectTaskItems(doc);
    expect(raw.map((r) => r.text)).toEqual(["Early item @Kai Lee", "Send recap", "Done already", "send RECAP", "Review @Kate Moss"]);
    expect(raw[1].key).toBe(itemKey("send recap"));
    expect(raw[3].key).toBe(`${raw[1].key}#2`);
    const open = actionItemsOf(doc, people, NOW, "Australia/Sydney");
    expect(open.map((i) => i.title)).toEqual(["Early item", "Send recap", "send RECAP", "Review"]);
    expect(open[3].assignee).toMatchObject({ id: "usr_kate" });
    expect(actionItemsOf(null, people, NOW)).toEqual([]);
    expect(actionItemsOf(notesTemplate(), people, NOW)).toEqual([]);
    expect(sectionsOf(doc)).toMatchObject({ agenda: ["Budget"] });
  });

  it("writes new items back as text that reads the same", () => {
    const text = actionItemText("Order chairs", { name: "Kai Lee" }, "2026-11-03");
    expect(p(text)).toMatchObject({ title: "Order chairs", assignee: { id: "usr_kai" }, due: "2026-11-03" });
    const d = appendActionItem(notesTemplate(), text);
    expect(collectTaskItems(d).map((i) => i.text)).toEqual([text]); // the empty starter item gives way
    expect(collectTaskItems(appendActionItem(d, "Second")).map((i) => i.text)).toEqual([text, "Second"]);
    expect(collectTaskItems(appendActionItem(docOf({ type: "paragraph" }), "Only")).map((i) => i.text)).toEqual(["Only"]);
  });
});

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let me: { organization: { id: string }; user: { id: string; email: string; name: string } };
const tokenOf = (link: string) => link.split("/invite/")[1];
async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const actor = () => ({ orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const });
async function writeItems(docId: string, ...texts: string[]) {
  const d = (await owner.get(`/api/docs/${docId}`)).body.doc;
  let content = d.content;
  for (const t of texts) content = appendActionItem(content, t);
  expect((await owner.patch(`/api/docs/${docId}`, { content, version: d.version })).status).toBe(200);
}

beforeEach(async () => {
  ctx = await makeTestApp();
  ctx.deps.now = () => NOW;
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  me = (await owner.get("/api/account/me")).body;
});

describe("meeting notes", () => {
  it("makes one notes doc on first open, even when two people open it at once", async () => {
    const m = (await owner.post("/api/meetings", { title: "Weekly sync", startsAt: "2026-10-27T00:00:00Z" })).body.meeting;
    const before = (await owner.get(`/api/meeting-notes/${m.id}`)).body;
    expect(before.doc).toBeNull();
    expect(before.summary).toBeNull();
    const [a, b] = await Promise.all([ensureNotesDoc(ctx.deps, actor(), m.id), ensureNotesDoc(ctx.deps, actor(), m.id)]);
    expect(a).toBe(b);
    expect((await owner.get(`/api/meetings/${m.id}`)).body.meeting.docId).toBe(a);
    const docs = (await owner.get("/api/docs")).body.docs as { id: string; title: string }[];
    expect(docs.filter((d) => d.title === "Weekly sync notes")).toHaveLength(1);
    const opened = (await owner.post(`/api/meeting-notes/${m.id}`)).body;
    expect(opened.doc.id).toBe(a);
    expect(opened.doc.text).toContain("Agenda");
    expect((await owner.get(`/api/meeting-notes/by-doc/${a}`)).body.meeting).toMatchObject({ id: m.id, title: "Weekly sync" });
    // A deleted doc is replaced on the next open.
    await owner.del(`/api/docs/${a}`);
    const again = (await owner.post(`/api/meeting-notes/${m.id}`)).body;
    expect(again.doc.id).not.toBe(a);
  });

  it("turns action items into tasks once, with assignee, due date and a link back", async () => {
    const inv = await owner.post("/api/team/invites", { email: "kai@acme.io", role: "member", mailboxIds: [] });
    const kai = new Client(ctx.app);
    await kai.signup("kai@acme.io", "Kai Lee", "");
    expect((await kai.post(`/api/invites/${tokenOf(inv.body.link)}/accept`)).status).toBe(200);
    const kaiId = (await kai.get("/api/account/me")).body.user.id;
    const m = (await owner.post("/api/meetings", { title: "Launch", startsAt: "2026-10-27T00:00:00Z" })).body.meeting;
    const docId = (await owner.post(`/api/meeting-notes/${m.id}`)).body.doc.id;
    await writeItems(docId, "Book venue @Kai Lee due Fri", "Draft press note by 2026-11-02", "Ignore me");
    const notes = (await owner.get(`/api/meeting-notes/${m.id}`)).body;
    expect(notes.actionItems).toHaveLength(3);
    expect(notes.actionItems[0]).toMatchObject({ title: "Book venue", assignee: { id: kaiId }, task: null });
    // Kai (a member) can read the notes too.
    expect((await kai.get(`/api/meeting-notes/${m.id}`)).body.actionItems).toHaveLength(3);

    const keys = notes.actionItems.slice(0, 2).map((i: { key: string }) => ({ key: i.key }));
    const r = (await owner.post(`/api/meeting-notes/${m.id}/action-items`, { items: keys })).body;
    expect(r.created).toHaveLength(2);
    expect(r.created[0]).toMatchObject({ title: "Book venue", assignee: { id: kaiId }, due: expect.stringMatching(/^2026-10-30/) });
    expect(r.created[1]).toMatchObject({ title: "Draft press note", due: expect.stringMatching(/^2026-11-02/) });
    expect(r.notes.pending).toBe(1);
    expect(r.notes.actionItems[0].task).toMatchObject({ id: r.created[0].id, done: false });
    const links = await ctx.db.select().from(entityLinks).where(and(eq(entityLinks.fromType, "task"), eq(entityLinks.fromId, r.created[0].id), eq(entityLinks.toType, "meeting")));
    expect(links).toMatchObject([{ toId: m.id, relation: "about" }]);
    // Second press: nothing new; with no items, only the third one is made.
    expect((await owner.post(`/api/meeting-notes/${m.id}/action-items`, { items: keys })).body.created).toHaveLength(0);
    const all = (await owner.post(`/api/meeting-notes/${m.id}/action-items`, {})).body;
    expect(all.created.map((t: { title: string }) => t.title)).toEqual(["Ignore me"]);
    expect((await owner.post(`/api/meeting-notes/${m.id}/action-items`, {})).body.created).toHaveLength(0);
    // Checking the task done shows in the notes without touching the doc.
    const before = (await owner.get(`/api/docs/${docId}`)).body.doc.version;
    expect((await owner.patch(`/api/tasks/${r.created[0].id}`, { status: "done" })).status).toBe(200);
    const after = (await owner.get(`/api/meeting-notes/${m.id}`)).body;
    expect(after.actionItems[0].task).toMatchObject({ done: true });
    expect(after.doc.version).toBe(before);
  });

  it("checks assignees, other workspaces, guests and read only keys", async () => {
    const m = (await owner.post("/api/meetings", { title: "Board", startsAt: "2026-10-27T00:00:00Z" })).body.meeting;
    await owner.post(`/api/meeting-notes/${m.id}`);
    // An assignee from outside the workspace is refused before anything is written.
    const bad = await owner.post(`/api/meeting-notes/${m.id}/action-items`, { items: [{ title: "x", assignee: "member:usr_nobody" }] });
    expect(bad.status).toBe(422);
    expect((await owner.post(`/api/meeting-notes/${m.id}/action-items`, { items: [{ title: "x", assignee: "Nobody Here" }] })).status).toBe(422);
    expect((await owner.get(`/api/meeting-notes/${m.id}`)).body.actionItems).toHaveLength(0);
    // Another workspace: 404 on every path.
    const eve = new Client(ctx.app);
    await eve.signup("eve@other.io", "Eve", "Other");
    expect((await eve.get(`/api/meeting-notes/${m.id}`)).status).toBe(404);
    expect((await eve.post(`/api/meeting-notes/${m.id}`)).status).toBe(404);
    expect((await eve.post(`/api/meeting-notes/${m.id}/action-items`, {})).status).toBe(404);
    expect((await eve.get(`/api/meeting-notes/by-doc/${(await owner.get(`/api/meetings/${m.id}`)).body.meeting.docId}`)).status).toBe(404);
    // No workspace session (a meeting guest or a project guest): 401, and the guest page shows no notes.
    expect((await new Client(ctx.app).get(`/api/meeting-notes/${m.id}`)).status).toBe(401);
    const token = (m.guestUrl as string).split("/m/")[1];
    const guestView = (await new Client(ctx.app).get(`/api/public/meetings/${token}`)).body.meeting;
    expect(JSON.stringify(guestView)).not.toContain("doc");
    // Read only key: reads, never writes.
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    expect((await api(ro, "GET", `/meetings/${m.id}/notes`)).status).toBe(200);
    expect((await api(ro, "POST", `/meetings/${m.id}/notes`)).status).toBe(403);
    expect((await api(ro, "POST", `/meetings/${m.id}/action-items`, {})).status).toBe(403);
    await expect(createActionItems(ctx.deps, { ...actor(), scope: "read" }, m.id, {})).rejects.toMatchObject({ status: 403 });
    const otherKey = (await eve.post("/api/developer/keys", { name: "Other" })).body.secret;
    expect((await api(otherKey, "GET", `/meetings/${m.id}/notes`)).status).toBe(404);
  });

  it("REST and MCP: read the notes, add items and make tasks", async () => {
    const key = (await owner.post("/api/developer/keys", { name: "Full" })).body.secret;
    const m = (await owner.post("/api/meetings", { title: "Retro", startsAt: "2026-10-27T00:00:00Z" })).body.meeting;
    const got = await api(key, "GET", `/meetings/${m.id}/notes`);
    expect(got.status).toBe(200);
    expect(got.body.doc).toBeNull();
    const made = await api(key, "POST", `/meetings/${m.id}/notes`);
    expect(made.body.doc.title).toBe("Retro notes");
    const add = await api(key, "POST", `/meetings/${m.id}/action-items`, { items: [{ title: "Fix flaky test", assignee: "Olive Owner", due: "2026-10-29" }] });
    expect(add.status).toBe(200);
    expect(add.body.created[0]).toMatchObject({ title: "Fix flaky test", assignee: { id: me.user.id }, due: expect.stringMatching(/^2026-10-29/) });
    expect((await api(key, "POST", `/meetings/${m.id}/action-items`, {})).body.created).toHaveLength(0);

    const mcp = await mcpFor(key);
    const notes = data(await mcp.callTool({ name: "get_meeting_notes", arguments: { meetingId: m.id } }));
    expect(notes.actionItems[0]).toMatchObject({ title: "Fix flaky test", due: "2026-10-29", task: { id: add.body.created[0].id } });
    expect(notes.summary).toBeNull();
    expect(notes.doc.text).toContain("Fix flaky test");
    const r = data(await mcp.callTool({ name: "create_action_items", arguments: { meetingId: m.id, items: [{ title: "Book the room", due: "2026-11-01" }] } }));
    expect(r.created.map((t: { title: string }) => t.title)).toEqual(["Book the room"]);
    expect(data(await mcp.callTool({ name: "create_action_items", arguments: { meetingId: m.id } })).created).toHaveLength(0);
    const ro = await mcpFor((await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret);
    expect(data(await ro.callTool({ name: "get_meeting_notes", arguments: { meetingId: m.id } })).actionItems).toHaveLength(2);
    const denied = await ro.callTool({ name: "create_action_items", arguments: { meetingId: m.id } });
    expect((denied as { isError?: boolean }).isError).toBe(true);
    const n = await meetingNotes(ctx.deps, actor(), m.id);
    expect(n.pending).toBe(0);
  });
});
