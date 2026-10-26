import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq, like } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { chatMessages, docs, meetings } from "@/server/db/schema";
import { clearCallCache, type CallParticipant } from "@/server/services/suite/calls";
import { callNotesTitle, decisionOf, digestText, headingsOf, NOTES_MESSAGE_PREFIX } from "@/server/services/suite/meeting-live-r31";

/** Round 31: call notes made once per call, the So far digest, its REST and MCP doors, and guest read only notes. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
const rooms = new Map<string, CallParticipant[]>();

beforeEach(async () => {
  ctx = await makeTestApp();
  clock = new Date("2026-10-26T01:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
  rooms.clear(); clearCallCache();
  ctx.deps.callRooms = { list: async (room) => rooms.get(room) ?? [] };
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

const general = async () => ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
const roomOf = async (id: string) => (await ctx.db.select({ room: meetings.room }).from(meetings).where(eq(meetings.id, id)).get())!.room;
async function apiKey(scope: "full" | "read" = "full") {
  const r = await c.post("/api/developer/keys", { name: `k-${scope}`, scope });
  return r.body.secret as string;
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text);

describe("pure helpers", () => {
  it("reads decisions from chat lines and nothing else", () => {
    expect(decisionOf("Decision: ship on Friday")).toBe("ship on Friday");
    expect(decisionOf("agreed, we use the blue logo")).toBe("we use the blue logo");
    expect(decisionOf("We decided to drop the beta")).toBe("to drop the beta");
    expect(decisionOf("I have not decided yet")).toBeNull();
    expect(decisionOf("Decision:")).toBeNull();
  });
  it("lists headings and dates the notes title in the zone", () => {
    expect(headingsOf({ type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Agenda" }] }, { type: "paragraph", content: [{ type: "text", text: "x" }] }, { type: "heading", content: [{ type: "text", text: "Risks" }] }] })).toEqual(["Agenda", "Risks"]);
    expect(callNotesTitle("#design call", new Date("2026-10-25T20:00:00Z"), "Australia/Sydney")).toBe("#design call notes, 26 Oct 2026");
    expect(callNotesTitle("Sync", new Date("2026-10-25T20:00:00Z"), "Not/AZone")).toBe("Sync notes, 25 Oct 2026");
  });
  it("builds a plain digest", () => {
    const t = digestText({ meetingId: "m", title: "Sync", kind: "digest", label: "So far", state: "live", startedAt: "", elapsedMin: 12, participants: [{ name: "Maya", joinedAt: null, minutesIn: 12 }], notes: { docId: "d", title: "t", headings: ["Agenda"], agenda: [], notes: ["pricing"], todos: [{ text: "send deck", done: false }, { text: "old", done: true }] }, decisions: [{ text: "ship Friday", by: "Sam", at: "" }], transcript: null, canWriteSummary: false, lateJoinMs: 1 });
    expect(t).toContain("12 min since the start");
    expect(t).toContain("Maya (12 min)");
    expect(t).toContain("To-dos: send deck.");
    expect(t).not.toContain("old");
    expect(t).toContain("ship Friday (Sam)");
  });
});

describe("call notes", () => {
  it("makes one dated notes doc and one chat message for a call, even with two joins at once", async () => {
    const g = await general();
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    const [a, b] = await Promise.all([c.post(`/api/meeting-live/${call.meeting.id}/call-notes`, {}), c.post(`/api/meeting-live/${call.meeting.id}/call-notes`, {})]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.body.docId).toBe(b.body.docId);
    expect([a.body.created, b.body.created].filter(Boolean)).toHaveLength(1);
    const again = (await c.post(`/api/meeting-live/${call.meeting.id}/call-notes`, {})).body;
    expect(again).toMatchObject({ docId: a.body.docId, created: false, messageId: null });
    const d = await ctx.db.select().from(docs).where(eq(docs.id, a.body.docId)).get();
    expect(d!.title).toMatch(/^#general call notes, \d{1,2} Oct 2026$/);
    const msgs = await ctx.db.select().from(chatMessages).where(and(eq(chatMessages.channelId, g.id), like(chatMessages.body, `${NOTES_MESSAGE_PREFIX}%`)));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toContain(`/app/docs/${a.body.docId}`);
    // The call object and the meeting object both carry the notes doc.
    expect((await c.get(`/api/chat/calls/${call.meeting.id}`)).body.docId).toBe(a.body.docId);
    expect((await c.get(`/api/meetings/${call.meeting.id}`)).body.meeting.docId).toBe(a.body.docId);
  });

  it("keeps an existing meeting notes doc and posts nothing for a meeting without a chat", async () => {
    const m = (await c.post("/api/meetings", { title: "Planning" })).body.meeting;
    const made = (await c.post(`/api/meeting-notes/${m.id}`, {})).body.doc.id;
    const r = (await c.post(`/api/meeting-live/${m.id}/call-notes`, {})).body;
    expect(r).toMatchObject({ docId: made, created: false, messageId: null });
  });

  it("refuses API keys (people join calls) and unknown meetings", async () => {
    const m = (await c.post("/api/meetings", { title: "Planning" })).body.meeting;
    const key = await apiKey();
    const r = await ctx.app.request(`/api/meeting-live/${m.id}/call-notes`, { method: "POST", headers: { authorization: `Bearer ${key}`, host: "localhost" } });
    expect([401, 403]).toContain(r.status);
    expect((await c.post(`/api/meeting-live/mtg_nope/call-notes`, {})).status).toBe(404);
  });
});

describe("summary so far", () => {
  it("shows who is here and since when, notes headings and to-dos, and decisions from the call's chat", async () => {
    const g = await general();
    await c.post(`/api/chat/channels/${g.id}/messages`, { body: "Decision: this one is before the call" });
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    const room = await roomOf(call.meeting.id);
    const joined = clock;
    rooms.set(room, [{ identity: "member-a", name: "Olive Owner", joinedAt: joined }, { identity: "guest-x", name: "Gail Guest", joinedAt: null }]);
    const notes = (await c.post(`/api/meeting-live/${call.meeting.id}/call-notes`, {})).body;
    const d = await ctx.db.select().from(docs).where(eq(docs.id, notes.docId)).get();
    const content = { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Agenda" }] }, { type: "paragraph", content: [{ type: "text", text: "Pricing page" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Action items" }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Send the deck" }] }] }, { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Book room" }] }] }] },
    ] };
    await ctx.db.update(docs).set({ content: JSON.stringify(content) }).where(eq(docs.id, d!.id));
    await c.post(`/api/chat/channels/${g.id}/messages`, { body: "Agreed: ship on Friday" });
    await c.post(`/api/chat/channels/${g.id}/messages`, { body: "just chatting" });
    clock += 6 * 60_000;
    const s = (await c.get(`/api/meeting-live/${call.meeting.id}/so-far`)).body;
    expect(s).toMatchObject({ kind: "digest", label: "So far", state: "live", transcript: null, canWriteSummary: false });
    expect(s.elapsedMin).toBeGreaterThanOrEqual(6);
    expect(s.participants.map((p: { name: string }) => p.name)).toEqual(["Olive Owner", "Gail Guest"]);
    expect(s.participants[0].minutesIn).toBeGreaterThanOrEqual(6);
    expect(s.notes.headings).toEqual(["Agenda", "Action items"]);
    expect(s.notes.agenda).toEqual(["Pricing page"]);
    expect(s.notes.todos).toEqual([{ text: "Send the deck", done: false }, { text: "Book room", done: true }]);
    expect(s.decisions.map((x: { text: string }) => x.text)).toEqual(["ship on Friday"]);
    expect(s.text).toContain("Decisions: ship on Friday (Olive Owner)");
  });

  it("refuses Write a summary without the workspace's own key", async () => {
    const m = (await c.post("/api/meetings", { title: "Planning" })).body.meeting;
    const r = await c.post(`/api/meeting-live/${m.id}/so-far/summary`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("no_ai_key");
  });

  it("answers over v1 and MCP, read only keys included", async () => {
    const m = (await c.post("/api/meetings", { title: "Planning" })).body.meeting;
    rooms.set(await roomOf(m.id), [{ identity: "member-a", name: "Olive Owner", joinedAt: clock }]);
    const key = await apiKey("read");
    const r = await ctx.app.request(`/api/v1/meetings/${m.id}/summary-so-far`, { headers: { authorization: `Bearer ${key}`, host: "localhost" } });
    expect(r.status).toBe(200);
    const body = await r.json() as { participants: { name: string }[]; state: string };
    expect(body.state).toBe("live");
    expect(body.participants[0].name).toBe("Olive Owner");
    const mcp = await mcpFor(key);
    const out = data(await mcp.callTool({ name: "meeting_summary_so_far", arguments: { meetingId: m.id } }));
    expect(out.label).toBe("So far");
    expect(out.participants).toHaveLength(1);
    const none = await ctx.app.request(`/api/v1/meetings/mtg_nope/summary-so-far`, { headers: { authorization: `Bearer ${key}`, host: "localhost" } });
    expect(none.status).toBe(404);
  });
});

describe("Write a summary on the workspace's own key", () => {
  it("sends only the digest to the workspace's provider and returns its words", async () => {
    const sent: { url: string; body: string }[] = [];
    ctx.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: String(init?.body ?? "") });
      return Response.json({ choices: [{ message: { content: "- Reviewing the pricing page\n- Ship on Friday" } }] });
    }) as typeof fetch;
    expect((await c.put("/api/ai/key", { provider: "openai", apiKey: ["sk", "test", "0123456789abcdefWXYZ"].join("-") /* a made up key, not a credential */ })).status).toBe(200);
    const g = await general();
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    rooms.set(await roomOf(call.meeting.id), [{ identity: "member-a", name: "Olive Owner", joinedAt: clock }]);
    expect((await c.get(`/api/meeting-live/${call.meeting.id}/so-far`)).body.canWriteSummary).toBe(true);
    const before = sent.length;
    const r = await c.post(`/api/meeting-live/${call.meeting.id}/so-far/summary`, {});
    expect(r.status).toBe(200);
    expect(r.body.summary).toContain("Ship on Friday");
    expect(sent.length - before).toBe(1);
    expect(sent.at(-1)!.body).toContain("So far in #general call");
  });
});

describe("guest notes", () => {
  it("lets a meeting guest read the notes doc by the guest token, and nothing else", async () => {
    const m = (await c.post("/api/meetings", { title: "Planning" })).body.meeting;
    const token = m.guestUrl.split("/m/")[1];
    expect((await c.get(`/api/public/meeting-live/${token}/notes`)).body).toEqual({ notes: null });
    await c.post(`/api/meeting-live/${m.id}/call-notes`, {});
    const r = (await new Client(ctx.app).get(`/api/public/meeting-live/${token}/notes`)).body;
    expect(r.notes.headings).toEqual(["Agenda", "Notes", "Action items"]);
    expect((await new Client(ctx.app).get(`/api/public/meeting-live/nope/notes`)).status).toBe(404);
  });
});
