import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { meetingRecordings } from "@/server/db/schema";
import { followUpEmail, groundQuote, parseSuggestions, sentencesOf, splitSummary } from "@/shared/meeting-suggest-td3";

/** TD3 (MEET_TD3): meetings to tasks. Suggestions from a transcript, accept or discard, undo, the manual path, the follow up draft. */

const KEY = ["sk", "test", "td3", "not", "a", "real", "key"].join("-"); // made at run time so the leak scan has nothing to match
const TRANSCRIPT = [
  "[00:10] Olive: Thanks all. Let's ship the pricing page on Friday.",
  "[01:02] Sam: I will write the launch email by Thursday.",
  "[02:30] Olive: Can someone book the venue for the offsite? Sam, can you take that?",
  "[03:00] Sam: Sure. SECRET_PHRASE_ZEBRA is the code name, keep it quiet.",
].join("\n");
let answer = "";
let aiCalls = 0;
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let logged: string[] = [];

async function setup(env: Record<string, string> = { MEET_TD3: "on" }) {
  ctx = await makeTestApp(env);
  aiCalls = 0;
  logged = [];
  const capture = (level: string) => (msg: string, fields?: Record<string, unknown>) => { logged.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`); };
  ctx.deps.log = { info: capture("info"), warn: capture("warn"), error: capture("error") };
  answer = JSON.stringify({ actionItems: [
    { text: "Write the launch email", owner: "Sam", due: "Thursday", quote: "I will write the launch email by Thursday." },
    { text: "Book the offsite venue", owner: "Sam Mate", due: null, quote: "book the venue for the offsite, Sam can do it" },
    { text: "Ship the pricing page", owner: "Nobody Here", due: "2026-10-30", quote: null },
  ] });
  ctx.deps.fetch = (async () => { aiCalls++; return Response.json({ choices: [{ message: { content: answer } }] }); }) as unknown as typeof fetch;
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
}
async function teammate(email = "mate@acme.io", name = "Sam Mate") {
  const invite = await c.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const me = (await m.get("/api/account/me")).body;
  return { client: m, id: me.user.id as string };
}
async function meeting(invitees: string[] = ["mate@acme.io", "client@outside.io"]) {
  const r = await c.post("/api/meetings", { title: "Launch sync", startsAt: "2026-10-26T03:00:00.000Z", durationMin: 30, invitees });
  expect(r.status).toBeLessThan(300);
  return r.body.meeting as { id: string };
}
async function withTranscript(meetingId: string, by: string, text = TRANSCRIPT) {
  const me = (await c.get("/api/account/me")).body;
  const orgId = me.organization?.id ?? me.org?.id ?? me.user.orgId ?? (await c.get("/api/org")).body.organization?.id ?? (await c.get("/api/org")).body.id;
  const now = new Date("2026-10-26T03:30:00.000Z");
  await ctx.db.insert(meetingRecordings).values({ orgId, meetingId, id: "rec_1", startedBy: by, status: "done", startedAt: now, endedAt: now, durationSec: 600, chunkCount: 2, transcript: text, summary: "We agreed to ship the pricing page.\n\nDecisions:\n- Ship on Friday", actionItems: "[]", updatedAt: now } as never);
  return "rec_1";
}
const count = (t: string) => (ctx.db as unknown as { $client: { prepare: (q: string) => { get: () => { n: number } } } }).$client.prepare(t === "tasks" ? "select count(*) n from tasks where deleted_at is null" : `select count(*) n from ${t}`).get().n;

describe("suggestion parsing (pure)", () => {
  it("reads a bare array, fenced JSON, other list keys and one item (MB-331)", () => {
    expect(parseSuggestions('[{"text":"Send the shortlist","quote":"q"}]').map((x) => x.title)).toEqual(["Send the shortlist"]);
    expect(parseSuggestions('Sure.\n```json\n{"action_items":[{"title":"Draft the budget"}]}\n```').map((x) => x.title)).toEqual(["Draft the budget"]);
    expect(parseSuggestions('{"tasks":["Book the room"]}').map((x) => x.title)).toEqual(["Book the room"]);
    expect(parseSuggestions('{"text":"Call the client","owner":"Sam"}')[0]).toMatchObject({ title: "Call the client", owner: "Sam" });
    expect(parseSuggestions("No action items here.")).toEqual([]);
  });
  it("reads items, drops duplicates and junk, caps the length", () => {
    const s = parseSuggestions('Sure! {"actionItems": [{"text": "  Send the deck ", "owner": "Kai", "due": "Fri", "quote": "Kai sends the deck Fri"}, "Call the bank", {"title": "send the deck"}, {"nope": 1}, 42]}');
    expect(s).toEqual([{ title: "Send the deck", owner: "Kai", due: "Fri", quote: "Kai sends the deck Fri" }, { title: "Call the bank", owner: null, due: null, quote: null }]);
    expect(parseSuggestions("no json here")).toEqual([]);
    expect(parseSuggestions(null)).toEqual([]);
    expect(parseSuggestions(JSON.stringify({ actionItems: Array.from({ length: 40 }, (_, i) => `Item ${i}`) }))).toHaveLength(15);
    expect(parseSuggestions(JSON.stringify({ items: [{ task: "x".repeat(900) }] }))[0].title).toHaveLength(300);
  });
  it("keeps only quotes that are really in the source", () => {
    expect(sentencesOf(TRANSCRIPT)[0]).toBe("Olive: Thanks all.");
    expect(groundQuote("I will write the launch email by Thursday.", "Write the launch email", TRANSCRIPT)).toBe("Sam: I will write the launch email by Thursday.");
    // A reworded quote is replaced by the closest real sentence.
    expect(groundQuote("book the venue for the offsite, Sam can do it", "Book the offsite venue", TRANSCRIPT)).toBe("Olive: Can someone book the venue for the offsite?");
    // A made up one with nothing close is dropped.
    expect(groundQuote("We will rebuild the data centre", "Rebuild the data centre", TRANSCRIPT)).toBeNull();
    expect(groundQuote(null, "Ship the pricing page", TRANSCRIPT)).toBe("Let's ship the pricing page on Friday.");
  });
  it("writes a follow up email with no dashes", () => {
    const { summary, decisions } = splitSummary("We agreed.\n\nDecisions:\n- Ship on Friday\n- Keep the price");
    expect(summary).toBe("We agreed.");
    expect(decisions).toEqual(["Ship on Friday", "Keep the price"]);
    const m = followUpEmail({ title: "Launch sync", date: "Monday, 26 October", senderName: "Olive Owner", summary, decisions, tasks: [{ title: "Write the launch email", owner: "Sam Mate", due: "2026-10-29" }] });
    expect(m.subject).toBe("Follow up: Launch sync");
    expect(m.text).toContain("Next steps\n• Write the launch email (Sam Mate, due Thu 29 Oct)");
    expect(m.text).toContain("Decisions\n• Ship on Friday");
    expect(m.text).not.toMatch(/[\u2013\u2014]| - /);
    expect(m.text.endsWith("Olive Owner")).toBe(true);
  });
});

describe("meetings to tasks", () => {
  beforeEach(() => setup());

  it("is 404 with the flag off, before auth", async () => {
    await setup({});
    const m = await meeting();
    expect((await c.get(`/api/meeting-td3/${m.id}`)).status).toBe(404);
    expect((await new Client(ctx.app).get(`/api/meeting-td3/${m.id}`)).status).toBe(404);
    expect((await c.get("/api/config")).body.meetTd3).toBe(false);
  });

  it("needs a session, and other workspaces get 404", async () => {
    const m = await meeting();
    expect((await new Client(ctx.app).get(`/api/meeting-td3/${m.id}`)).status).toBe(401);
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve Other");
    expect((await other.get(`/api/meeting-td3/${m.id}`)).status).toBe(404);
    expect((await other.get(`/api/meeting-td3/${m.id}/follow-up`)).status).toBe(404);
    expect((await other.post(`/api/meeting-td3/${m.id}/suggestions`, { title: "Sneaky", accept: true })).status).toBe(404);
    expect((await c.get("/api/config")).body.meetTd3).toBe(true);
  });

  it("without an AI key: no provider call, a clear manual path", async () => {
    const mate = await teammate();
    const m = await meeting();
    await withTranscript(m.id, mate.id);
    const v = (await c.get(`/api/meeting-td3/${m.id}`)).body;
    expect(v.ai.state).toBe("no_key");
    expect(v.sources.recordings).toHaveLength(1);
    const r = await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "recording", recordingId: "rec_1" });
    expect(r.status).toBe(409);
    expect(r.body.error?.code ?? r.body.code).toBe("ai_key_required");
    expect(aiCalls).toBe(0);
    // Manual: select a line, make a task, one click.
    const src = (await c.get(`/api/meeting-td3/${m.id}/source?source=recording&recordingId=rec_1`)).body;
    expect(src.text).toContain("launch email");
    const made = await c.post(`/api/meeting-td3/${m.id}/suggestions`, { title: "Write the launch email", quote: "I will write the launch email by Thursday.", assigneeId: mate.id, due: "2026-10-29", accept: true });
    expect(made.status).toBe(200);
    expect(made.body.suggestion.status).toBe("accepted");
    expect(made.body.suggestion.task.id).toMatch(/^tsk/);
    expect(count("tasks")).toBeGreaterThanOrEqual(1);
    expect(aiCalls).toBe(0);
  });

  it("with no key and built in AI on: ready, suggestions come from built in AI, no paid call; switch off stops it", async () => {
    await setup({ MEET_TD3: "on", AI_CONNECT_AI2: "on", ASK_TD1: "on" });
    let builtinCalls = 0;
    ctx.deps.ai = { run: async () => { builtinCalls++; return { response: answer, usage: { prompt_tokens: 40, completion_tokens: 60 } }; } };
    const mate = await teammate();
    const m = await meeting();
    await withTranscript(m.id, mate.id);
    expect((await c.get(`/api/meeting-td3/${m.id}`)).body.ai.state).toBe("ready");
    const r = await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "recording", recordingId: "rec_1" });
    expect(r.status).toBe(200);
    expect(r.body.suggestions.length).toBeGreaterThan(0);
    expect(builtinCalls).toBe(1);
    expect(aiCalls).toBe(0);
    expect((await c.put("/api/ai-trust", { enabled: false })).status).toBe(200);
    expect((await c.get(`/api/meeting-td3/${m.id}`)).body.ai.state).toBe("off");
    const off = await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "recording", recordingId: "rec_1" });
    expect(off.status).toBe(409);
    expect(builtinCalls).toBe(1);
  });

  it("built in AI answers as already parsed JSON, as a bare array in words, or with nothing: suggestions or a clear none (MB-331)", async () => {
    await setup({ MEET_TD3: "on", AI_CONNECT_AI2: "on" });
    const pasted = ["Tom, can you send the venue shortlist to the team by Friday?", "Yes, I will send the venue shortlist by Friday.", "I will draft the budget summary next week."].join("\n");
    const items = [
      { text: "Send the venue shortlist to the team", owner: "Tom", due: "Friday", quote: "I will send the venue shortlist by Friday." },
      { text: "Draft the budget summary", owner: null, due: "next week", quote: "I will draft the budget summary next week." },
    ];
    const replies: unknown[] = [
      { actionItems: items }, // the service hands back JSON already parsed
      `Here are the action items:\n\`\`\`json\n${JSON.stringify(items)}\n\`\`\``, // a bare array inside words and a code fence
      "There are no action items in this text.",
    ];
    let builtinCalls = 0;
    ctx.deps.ai = { run: async () => ({ response: replies[builtinCalls++], usage: { prompt_tokens: 60, completion_tokens: 80 } }) };
    const m = await meeting();
    for (const want of [2, 2, 0]) {
      const r = await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "pasted", text: pasted });
      expect(r.status).toBe(200);
      expect(r.body.added).toBe(want);
      const open = r.body.suggestions.filter((s: { status: string }) => s.status === "open");
      expect(open).toHaveLength(want);
      for (const s of open) expect(pasted).toContain(s.quote);
    }
    expect(builtinCalls).toBe(3);
    expect(aiCalls).toBe(0);
  });

  it("with no key, built in AI flag on but no binding: no_key, no call", async () => {
    await setup({ MEET_TD3: "on", AI_CONNECT_AI2: "on" });
    ctx.deps.ai = undefined;
    const m = await meeting();
    expect((await c.get(`/api/meeting-td3/${m.id}`)).body.ai.state).toBe("no_key");
    expect(aiCalls).toBe(0);
  });

  it("with the workspace AI switch off: 409 ai_off, no provider call, manual path still works", async () => {
    await setup({ MEET_TD3: "on", ASK_TD1: "on" });
    const mate = await teammate();
    await c.put("/api/ai/key", { provider: "openai", apiKey: KEY });
    const m = await meeting();
    await withTranscript(m.id, mate.id);
    expect((await c.put("/api/ai-trust", { enabled: false })).status).toBe(200);
    const v = (await c.get(`/api/meeting-td3/${m.id}`)).body;
    expect(v.ai.state).toBe("off");
    const r = await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "recording", recordingId: "rec_1" });
    expect(r.status).toBe(409);
    expect(r.body.error?.code ?? r.body.code).toBe("ai_off");
    expect(aiCalls).toBe(0);
    const made = await c.post(`/api/meeting-td3/${m.id}/suggestions`, { title: "Book the venue", accept: true });
    expect(made.status).toBe(200);
    expect(aiCalls).toBe(0);
    // Switched back on, one press is one provider call.
    expect((await c.put("/api/ai-trust", { enabled: true })).status).toBe(200);
    expect((await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "recording", recordingId: "rec_1" })).status).toBe(200);
    expect(aiCalls).toBe(1);
  });

  it("suggests with owner guesses from attendees only, dates from the meeting day, real quotes; nothing created", async () => {
    const mate = await teammate();
    await c.put("/api/ai/key", { provider: "openai", apiKey: KEY });
    const m = await meeting();
    await withTranscript(m.id, mate.id);
    const tasksBefore = count("tasks");
    const r = await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "recording", recordingId: "rec_1" });
    expect(r.status).toBe(200);
    expect(aiCalls).toBe(1);
    expect(count("tasks")).toBe(tasksBefore);
    const [a, b, d] = r.body.suggestions;
    expect(a).toMatchObject({ title: "Write the launch email", status: "open", assignee: { id: mate.id }, due: "2026-10-29", quote: "Sam: I will write the launch email by Thursday." });
    expect(b).toMatchObject({ title: "Book the offsite venue", assignee: { id: mate.id }, due: null });
    expect(d).toMatchObject({ title: "Ship the pricing page", assignee: null, due: "2026-10-30" });
    // Logs carry no transcript words, titles or quotes.
    const all = logged.join("\n");
    expect(all).not.toContain("SECRET_PHRASE_ZEBRA");
    expect(all).not.toContain("launch email");
    expect(all).not.toContain(KEY);
  });

  it("accept is idempotent (a double click makes one task), discard and undo work, accept all", async () => {
    const mate = await teammate();
    await c.put("/api/ai/key", { provider: "openai", apiKey: KEY });
    const m = await meeting();
    await withTranscript(m.id, mate.id);
    const list = (await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "recording", recordingId: "rec_1" })).body.suggestions as { id: string }[];
    const before = count("tasks");
    const [x, y] = await Promise.all([c.post(`/api/meeting-td3/${m.id}/suggestions/${list[0].id}/accept`, {}), c.post(`/api/meeting-td3/${m.id}/suggestions/${list[0].id}/accept`, {})]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect([x.body.created, y.body.created].filter(Boolean)).toHaveLength(1);
    expect(count("tasks")).toBe(before + 1);
    expect((await c.post(`/api/meeting-td3/${m.id}/suggestions/${list[0].id}/accept`, {})).body.created).toBe(false);
    expect(count("tasks")).toBe(before + 1);
    // The task links back to the meeting.
    expect(count("entity_links")).toBeGreaterThanOrEqual(1);
    // Discard, then it cannot be accepted until undone.
    expect((await c.post(`/api/meeting-td3/${m.id}/suggestions/${list[1].id}/discard`, {})).body.suggestion.status).toBe("discarded");
    expect((await c.post(`/api/meeting-td3/${m.id}/suggestions/${list[1].id}/accept`, {})).status).toBe(409);
    const undone = await c.post(`/api/meeting-td3/${m.id}/undo`, { ids: [list[1].id, list[0].id] });
    expect(undone.body.undone.sort()).toEqual([list[0].id, list[1].id].sort());
    expect(count("tasks")).toBe(before);
    // Suggest again keeps decided ones out and replaces only open ones.
    await c.post(`/api/meeting-td3/${m.id}/suggestions/${list[2].id}/discard`, {});
    const again = (await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "recording", recordingId: "rec_1" })).body.suggestions as { title: string; status: string }[];
    expect(again.filter((s) => s.title === "Ship the pricing page")).toHaveLength(1);
    // Accept all makes one task per open suggestion, and undo takes them all back.
    const all = await c.post(`/api/meeting-td3/${m.id}/accept-all`, {});
    expect(all.body.accepted).toHaveLength(2);
    expect(count("tasks")).toBe(before + 2);
    expect((await c.post(`/api/meeting-td3/${m.id}/accept-all`, {})).body.accepted).toHaveLength(0);
    await c.post(`/api/meeting-td3/${m.id}/undo`, { ids: all.body.accepted });
    expect(count("tasks")).toBe(before);
  });

  it("checks owners, dates and input sizes", async () => {
    const m = await meeting();
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve Other");
    const eve = (await other.get("/api/account/me")).body.user.id as string;
    expect((await c.post(`/api/meeting-td3/${m.id}/suggestions`, { title: "Task", assigneeId: eve })).status).toBe(422);
    expect((await c.post(`/api/meeting-td3/${m.id}/suggestions`, { title: "Task", due: "30/10/2026" })).status).toBe(422);
    expect((await c.post(`/api/meeting-td3/${m.id}/suggestions`, { title: "" })).status).toBe(422);
    expect((await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "pasted", text: "" })).status).toBe(422);
    expect((await c.post(`/api/meeting-td3/${m.id}/suggestions/nope/accept`, {})).status).toBe(404);
    expect(count("tasks")).toBe(0);
  });

  it("pasted text works and is not stored; edit before accept", async () => {
    await c.put("/api/ai/key", { provider: "openai", apiKey: KEY });
    const m = await meeting([]);
    const r = await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "pasted", text: TRANSCRIPT });
    expect(r.status).toBe(200);
    expect(r.body.suggestions[0].assignee).toBeNull(); // Sam is not an attendee here
    const dump = JSON.stringify((ctx.db as unknown as { $client: { prepare: (q: string) => { all: () => unknown[] } } }).$client.prepare("select * from meeting_suggestions").all());
    expect(dump).not.toContain("SECRET_PHRASE_ZEBRA");
    const e = await c.patch(`/api/meeting-td3/${m.id}/suggestions/${r.body.suggestions[0].id}`, { title: "Write and send the launch email", due: null });
    expect(e.body.suggestion).toMatchObject({ title: "Write and send the launch email", due: null });
  });

  it("the follow up is a draft only: attendees, summary, decisions and accepted tasks; nothing sent", async () => {
    const mate = await teammate();
    const m = await meeting();
    await withTranscript(m.id, mate.id);
    await c.post(`/api/meeting-td3/${m.id}/suggestions`, { title: "Write the launch email", assigneeId: mate.id, due: "2026-10-29", accept: true });
    const outbox = count("messages");
    const f = await c.get(`/api/meeting-td3/${m.id}/follow-up`);
    expect(f.status).toBe(200);
    expect(f.body.to.sort()).toEqual(["client@outside.io", "mate@acme.io"]);
    expect(f.body.subject).toBe("Follow up: Launch sync");
    expect(f.body.text).toContain("We agreed to ship the pricing page.");
    expect(f.body.text).toContain("• Ship on Friday");
    expect(f.body.text).toContain("• Write the launch email (Sam Mate, due Thu 29 Oct)");
    expect(count("messages")).toBe(outbox);
  });
});
