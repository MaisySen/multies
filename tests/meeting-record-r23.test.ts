import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { appendText, parseSummary, summaryMessage, TRANSCRIPT_CAP, TRUNCATED_NOTE } from "@/server/services/suite/meeting-recordings";
import { canTranscribe, transcribe, TRANSCRIBE_URL } from "@/server/services/ai/transcribe";
import { fakeAiAllowed } from "@/server/services/ai/fake-fetch";
import { decodeSignal, encodeSignal, UploadQueue, type Chunk } from "@/web/lib/call-recorder";

/** Round 23 (R23.2): recording a call, transcribing it on the workspace's own key, the summary posted once. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
const KEY = "sk-test-0123456789abcdefWXYZ";
const GROQ_KEY = "gsk_test0123456789abcdefWXYZ";

type Call = { url: string; auth: string | null; model: string | null; file: Blob | null; json: Record<string, unknown> | null };
let calls: Call[];
let summaryAnswer = JSON.stringify({ summary: "We agreed to ship on Friday.", decisions: ["Ship Friday"], actionItems: [{ text: "Write the launch email", assignee: "Sam Mate", due: "Thursday" }] });
let transcriptAnswer: (n: number) => Response = (n) => Response.json({ text: `Part ${n} of the call.` });

function fakeProviders() {
  ctx.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body;
    const form = body instanceof FormData ? body : null;
    calls.push({ url, auth: new Headers(init?.headers).get("authorization"), model: form ? String(form.get("model")) : null, file: form ? (form.get("file") as Blob) : null, json: typeof body === "string" ? JSON.parse(body) : null });
    if (url.endsWith("/audio/transcriptions")) return transcriptAnswer(calls.filter((x) => x.url.endsWith("/audio/transcriptions")).length);
    return Response.json({ choices: [{ message: { content: summaryAnswer } }] });
  }) as typeof fetch;
}

async function setup() {
  ctx = await makeTestApp();
  clock = new Date("2026-10-26T09:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
  calls = [];
  summaryAnswer = JSON.stringify({ summary: "We agreed to ship on Friday.", decisions: ["Ship Friday"], actionItems: [{ text: "Write the launch email", assignee: "Sam Mate", due: "Thursday" }] });
  transcriptAnswer = (n) => Response.json({ text: `Part ${n} of the call.` });
  fakeProviders();
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
const general = async (cl: Client = c) => ((await cl.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
const audio = (bytes = 64) => Buffer.from(new Uint8Array(bytes).map((_, i) => i % 251)).toString("base64");
const chunk = (cl: Client, mid: string, rid: string, seq: number, extra: Record<string, unknown> = {}) => cl.call("PUT", `/api/meetings/${mid}/recordings/${rid}/chunks/${seq}`, { audioBase64: audio(), mime: "audio/webm;codecs=opus", offsetSec: seq * 300, durationSec: (seq + 1) * 300, ...extra });
const count = (t: string) => (ctx.db as unknown as { $client: { prepare: (q: string) => { get: () => { n: number } } } }).$client.prepare(`select count(*) n from ${t}`).get().n;
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
async function callMeeting() {
  const g = await general();
  const r = await c.post(`/api/chat/channels/${g.id}/call`, {});
  return { channelId: g.id, meetingId: r.body.meeting.id as string };
}

describe("transcribe() request shape", () => {
  it("sends multipart with the file and the model to OpenAI and Groq, and keeps the key out of errors", async () => {
    const seen: { url: string; auth: string | null; form: FormData }[] = [];
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => { seen.push({ url: String(u), auth: new Headers(init?.headers).get("authorization"), form: init?.body as FormData }); return Response.json({ text: " hello there " }); }) as typeof fetch;
    expect(await transcribe("openai", KEY, new Uint8Array([1, 2, 3]), "audio/webm;codecs=opus", f)).toBe("hello there");
    expect(await transcribe("groq", GROQ_KEY, new Uint8Array([1, 2, 3]), "audio/ogg", f)).toBe("hello there");
    expect(seen[0].url).toBe(TRANSCRIBE_URL.openai);
    expect(seen[0].url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(seen[1].url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(seen[0].auth).toBe(`Bearer ${KEY}`);
    expect(seen[0].form).toBeInstanceOf(FormData);
    expect(seen[0].form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(seen[1].form.get("model")).toBe("whisper-large-v3-turbo");
    const file = seen[0].form.get("file") as File;
    expect(file.size).toBe(3);
    expect(file.type).toBe("audio/webm");
    expect(file.name).toBe("chunk.webm");
    expect((seen[1].form.get("file") as File).name).toBe("chunk.ogg");
    // A refusal that echoes the key never carries it.
    const bad = (async () => new Response(`{"error":"Incorrect API key provided: ${KEY}"}`, { status: 401 })) as unknown as typeof fetch;
    const err = await transcribe("openai", KEY, new Uint8Array([1]), "audio/webm", bad).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect((err as unknown as { status: number }).status).toBe(401);
    const thrown = (async () => { throw new Error(`socket closed for ${GROQ_KEY}`); }) as unknown as typeof fetch;
    expect(String(((await transcribe("groq", GROQ_KEY, new Uint8Array([1]), "audio/webm", thrown).catch((e: Error) => e)) as Error).message)).not.toContain(GROQ_KEY);
    expect(canTranscribe("anthropic")).toBe(false);
    expect(canTranscribe("openrouter")).toBe(false);
  });

  it("the fake AI hook is only for a localhost APP_URL with AI_FAKE=1", () => {
    expect(fakeAiAllowed({ AI_FAKE: "1", APP_URL: "http://localhost:8930" })).toBe(true);
    expect(fakeAiAllowed({ AI_FAKE: "1", APP_URL: "http://127.0.0.1:8930" })).toBe(true);
    expect(fakeAiAllowed({ AI_FAKE: "1", APP_URL: "https://multies.si" })).toBe(false);
    expect(fakeAiAllowed({ APP_URL: "http://localhost:8930" })).toBe(false);
    expect(fakeAiAllowed({ AI_FAKE: "1" })).toBe(false);
  });
});

describe("transcript and summary helpers", () => {
  it("appends with [mm:ss] marks and cuts at 200 KB with a note", () => {
    expect(appendText("", "Hello", 0)).toBe("[00:00] Hello");
    expect(appendText("[00:00] Hello", "Next", 305)).toBe("[00:00] Hello\n\n[05:05] Next");
    expect(appendText("A", "", 0)).toBe("A");
    const big = appendText("x".repeat(TRANSCRIPT_CAP - 10), "y".repeat(100), null);
    expect(new TextEncoder().encode(big).length).toBeLessThanOrEqual(TRANSCRIPT_CAP);
    expect(big.endsWith(TRUNCATED_NOTE)).toBe(true);
    expect(appendText(big, "more", 10)).toBe(big);
  });
  it("reads the model's JSON, tolerates prose around it, and builds one chat message", () => {
    const s = parseSummary("Sure:\n" + JSON.stringify({ summary: "Short.", decisions: ["A"], actionItems: [{ text: "Do it", assignee: "Ana", due: "Friday" }, "Plain item", { nope: 1 }] }))!;
    expect(s).toEqual({ summary: "Short.", decisions: ["A"], actionItems: [{ text: "Do it", assignee: "Ana", due: "Friday" }, { text: "Plain item", assignee: null, due: null }] });
    expect(parseSummary("No JSON at all")).toEqual({ summary: "No JSON at all", decisions: [], actionItems: [] });
    expect(parseSummary(null)).toBeNull();
    const msg = summaryMessage({ title: "#general call", joinUrl: "http://localhost/app/meetings/mtg_1" }, s);
    expect(msg.split("\n")[0]).toBe("Call summary: #general call");
    expect(msg).toContain("- Do it (Ana, due Friday)");
    expect(msg).toContain("http://localhost/app/meetings/mtg_1");
    expect(msg).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("recording a call", () => {
  beforeEach(setup);

  it("without a key: 409 with the setup code; Anthropic and OpenRouter keys get the setup message; nothing is written", async () => {
    const { meetingId } = await callMeeting();
    const before = count("meeting_recordings");
    const list = await c.get(`/api/meetings/${meetingId}/recordings`);
    expect(list.body.setup).toMatchObject({ ready: false, code: "recording_needs_ai_key", canConfigure: true });
    expect(list.body.setup.message).toContain("Add your OpenAI or Groq key in Settings > AI");
    const r = await c.post(`/api/meetings/${meetingId}/recordings`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("recording_needs_ai_key");
    expect(r.body.error.message).toBe("Add your OpenAI or Groq key in Settings > AI to record and transcribe. Multies doesn't charge for this; your provider bills your key.");
    for (const provider of ["anthropic", "openrouter"]) {
      await c.put("/api/ai/key", { provider, apiKey: KEY });
      const w = await c.post(`/api/meetings/${meetingId}/recordings`, {});
      expect(w.status).toBe(409);
      expect(w.body.error.code).toBe("recording_needs_transcribe_key");
      expect(w.body.error.message).toContain("can't transcribe audio");
      expect(w.body.error.message).toContain("Settings > AI");
    }
    expect(count("meeting_recordings")).toBe(before);
    expect(calls).toHaveLength(0);
    // A member who can't change settings is told to ask an admin.
    const mate = await teammate();
    expect((await mate.client.get(`/api/meetings/${meetingId}/recordings`)).body.setup).toMatchObject({ ready: false, canConfigure: false });
  });

  it("transcribes chunks in order, keeps only text, summarises once at Stop and posts it to the call's channel", async () => {
    const mate = await teammate();
    await c.put("/api/ai/key", { provider: "openai", apiKey: KEY });
    const { channelId, meetingId } = await callMeeting();
    const start = await c.post(`/api/meetings/${meetingId}/recordings`, {});
    expect(start.status).toBe(201);
    const rid = start.body.recording.id as string;
    expect(start.body.recording).toMatchObject({ status: "recording", startedBy: { name: "Olive Owner" }, chunks: 0 });
    // Everyone (and late joiners) can read that a recording is live.
    expect((await mate.client.get(`/api/meetings/${meetingId}/recordings`)).body.recordings[0]).toMatchObject({ id: rid, status: "recording" });
    // A second press joins the live recording instead of starting another.
    const again = await c.post(`/api/meetings/${meetingId}/recordings`, {});
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ joined: true, recording: { id: rid } });

    // Chunks carry a sequence number: skipping ahead is refused, a retried chunk is not transcribed twice.
    const skip = await chunk(c, meetingId, rid, 1);
    expect(skip.status).toBe(409);
    expect(skip.body.error).toMatchObject({ code: "out_of_order", details: { expected: 0 } });
    expect((await chunk(c, meetingId, rid, 0)).status).toBe(200);
    const dup = await chunk(c, meetingId, rid, 0);
    expect(dup.body.duplicate).toBe(true);
    const second = await chunk(c, meetingId, rid, 1);
    expect(second.body.recording.transcript).toBe("[00:00] Part 1 of the call.\n\n[05:00] Part 2 of the call.");
    expect(calls.filter((x) => x.url.endsWith("/audio/transcriptions"))).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: "https://api.openai.com/v1/audio/transcriptions", auth: `Bearer ${KEY}`, model: "gpt-4o-mini-transcribe" });
    expect(calls[0].file!.size).toBe(64);
    // Only the recorder uploads.
    expect((await chunk(mate.client, meetingId, rid, 2)).status).toBe(403);

    const msgs0 = count("chat_messages");
    const stop = await c.post(`/api/meetings/${meetingId}/recordings/${rid}/stop`, { durationSec: 640 });
    expect(stop.status).toBe(200);
    expect(stop.body.recording).toMatchObject({ status: "done", durationSec: 640, actionItems: [{ text: "Write the launch email", assignee: "Sam Mate", due: "Thursday" }] });
    expect(stop.body.recording.summary).toContain("We agreed to ship on Friday.");
    expect(stop.body.posted).toMatchObject({ type: "chat", channelId });
    // The summary prompt is short and carries the transcript, not the key.
    const chat = calls.find((x) => x.url.endsWith("/chat/completions"))!;
    expect(chat.json!.max_tokens).toBe(600);
    expect(JSON.stringify(chat.json)).toContain("Part 2 of the call.");
    // Stop again (a retry, or a second person): no second summary, no second post.
    const stop2 = await c.post(`/api/meetings/${meetingId}/recordings/${rid}/stop`, {});
    expect(stop2.body.posted).toBeNull();
    expect(mate && (await mate.client.post(`/api/meetings/${meetingId}/recordings/${rid}/stop`, {})).body.posted).toBeNull();
    expect(count("chat_messages") - msgs0).toBe(1);
    expect(calls.filter((x) => x.url.endsWith("/chat/completions"))).toHaveLength(1);
    const seen = (await mate.client.get(`/api/chat/channels/${channelId}/messages`)).body.messages;
    const card = seen.at(-1);
    expect(card.body.split("\n")[0]).toBe("Call summary: #general call");
    expect(card.body).toContain("- Write the launch email (Sam Mate, due Thursday)");
    expect(card.body).toContain(`/app/meetings/${meetingId}`);
    expect(card.author.name).toBe("Olive Owner");
    // A chunk after Stop is refused.
    expect((await chunk(c, meetingId, rid, 2)).status).toBe(409);
    // The audio itself is stored nowhere: the row holds the text.
    const row = (ctx.db as unknown as { $client: { prepare: (q: string) => { get: () => Record<string, unknown> } } }).$client.prepare("select * from meeting_recordings").get();
    expect(Object.keys(row)).not.toContain("audio");
    expect(JSON.stringify(row)).not.toContain(audio());
  });

  it("uses a Groq key for speech to text, and refuses a chunk over 24 MB with 413", async () => {
    await c.put("/api/ai/key", { provider: "groq", apiKey: GROQ_KEY });
    const { meetingId } = await callMeeting();
    const rid = (await c.post(`/api/meetings/${meetingId}/recordings`, {})).body.recording.id;
    expect((await chunk(c, meetingId, rid, 0)).status).toBe(200);
    expect(calls[0]).toMatchObject({ url: "https://api.groq.com/openai/v1/audio/transcriptions", auth: `Bearer ${GROQ_KEY}`, model: "whisper-large-v3-turbo" });
    const big = await chunk(c, meetingId, rid, 1, { audioBase64: Buffer.alloc(24 * 1024 * 1024 + 10).toString("base64") });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("chunk_too_large");
    expect(calls).toHaveLength(1);
  });

  it("a refused key is a plain 409 ai_key_refused without the key; the transcript waits for a retry", async () => {
    await c.put("/api/ai/key", { provider: "openai", apiKey: KEY });
    const { meetingId } = await callMeeting();
    const rid = (await c.post(`/api/meetings/${meetingId}/recordings`, {})).body.recording.id;
    transcriptAnswer = () => new Response(`{"error":{"message":"Incorrect API key provided: ${KEY}"}}`, { status: 401 });
    const r = await chunk(c, meetingId, rid, 0);
    // Round 2 (PR 20, changed on purpose): a key problem answers 409 with its own code, as every other AI route; it
    // was 502 ai_provider_error. An outage is still 502.
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("ai_key_refused");
    expect(r.body.error.details).toMatchObject({ fix: "/app/settings#ai" });
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    // QUAL1 (audit row 14): the same plain sentence Settings shows, and the refusal is noted on the key until it works.
    expect(r.body.error.message).toBe("OpenAI refused your workspace's AI key. An admin can paste a new key in Settings, AI.");
    expect((await c.get("/api/ai/status")).body.problem).toBe("key_refused");
    // An outage is still 502 ai_provider_error.
    transcriptAnswer = () => new Response("down", { status: 503 });
    const down = await chunk(c, meetingId, rid, 0);
    expect([down.status, down.body.error.code]).toEqual([502, "ai_provider_error"]);
    transcriptAnswer = () => Response.json({ text: "Back again." });
    expect((await chunk(c, meetingId, rid, 0)).body.recording.transcript).toBe("[00:00] Back again.");
    expect((await c.get("/api/ai/status")).body.problem).toBeUndefined();
  });

  it("with no channel, the attendees who are members get a notification and the meeting page has the summary", async () => {
    const mate = await teammate();
    await c.put("/api/ai/key", { provider: "openai", apiKey: KEY });
    const m = (await c.post("/api/meetings", { title: "Pricing review", invitees: ["mate@acme.io", "client@outside.example"] })).body.meeting;
    const rid = (await c.post(`/api/meetings/${m.id}/recordings`, {})).body.recording.id;
    await chunk(c, m.id, rid, 0);
    const stop = await c.post(`/api/meetings/${m.id}/recordings/${rid}/stop`, {});
    expect(stop.body.posted.type).toBe("notification");
    expect(stop.body.posted.userIds).toContain(mate.id);
    expect(stop.body.posted.userIds).toHaveLength(2);
    const n = (await mate.client.get("/api/notifications")).body.notifications;
    expect(n[0]).toMatchObject({ type: "meeting.summary", title: "Call summary ready: Pricing review" });
    expect((await mate.client.get(`/api/meetings/${m.id}/recordings`)).body.recordings[0].summary).toContain("We agreed to ship on Friday.");
  });

  it("an empty recording finishes with a note and posts nothing; delete takes the transcript away", async () => {
    await c.put("/api/ai/key", { provider: "openai", apiKey: KEY });
    const { meetingId } = await callMeeting();
    const rid = (await c.post(`/api/meetings/${meetingId}/recordings`, {})).body.recording.id;
    const stop = await c.post(`/api/meetings/${meetingId}/recordings/${rid}/stop`, {});
    expect(stop.body.recording).toMatchObject({ status: "done", summary: null });
    expect(stop.body.recording.error).toContain("Nothing was transcribed");
    expect(stop.body.posted).toBeNull();
    expect((await c.del(`/api/meetings/${meetingId}/recordings/${rid}`)).body.deleted).toBe(true);
    expect((await c.get(`/api/meetings/${meetingId}/recordings`)).body.recordings).toHaveLength(0);
  });

  it("keeps recordings to people who can open the meeting: other workspaces, guests, keys", async () => {
    await c.put("/api/ai/key", { provider: "openai", apiKey: KEY });
    const { meetingId } = await callMeeting();
    const rid = (await c.post(`/api/meetings/${meetingId}/recordings`, {})).body.recording.id;
    await chunk(c, meetingId, rid, 0);
    // Another workspace: not found, for every action.
    const stranger = new Client(ctx.app);
    await stranger.signup("eve@else.io", "Eve Else");
    await stranger.put("/api/ai/key", { provider: "openai", apiKey: KEY });
    expect((await stranger.get(`/api/meetings/${meetingId}/recordings`)).status).toBe(404);
    expect((await stranger.post(`/api/meetings/${meetingId}/recordings`, {})).status).toBe(404);
    expect((await chunk(stranger, meetingId, rid, 1)).status).toBe(404);
    expect((await stranger.post(`/api/meetings/${meetingId}/recordings/${rid}/stop`, {})).status).toBe(404);
    expect((await stranger.del(`/api/meetings/${meetingId}/recordings/${rid}`)).status).toBe(404);
    // A stranger's own meeting can't reach this recording by its id either.
    const theirs = (await stranger.post("/api/meetings", { title: "Theirs" })).body.meeting;
    expect((await stranger.post(`/api/meetings/${theirs.id}/recordings/${rid}/stop`, {})).status).toBe(404);
    // No session (a meeting guest or a project guest has none): 401.
    const anon = new Client(ctx.app);
    expect((await anon.get(`/api/meetings/${meetingId}/recordings`)).status).toBe(401);
    anon.cookie = "mm_guest=gst_1.secret";
    expect((await anon.get(`/api/meetings/${meetingId}/recordings`)).status).toBe(401);
    expect((await anon.post(`/api/meetings/${meetingId}/recordings`, {})).status).toBe(401);

    // REST: a read only key reads; it can't record (no write routes exist on v1 for recordings).
    const ro = (await c.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    const rest = await ctx.app.request(`/api/v1/meetings/${meetingId}/recordings`, { headers: { authorization: `Bearer ${ro}`, host: "localhost" } });
    expect(rest.status).toBe(200);
    const restBody = (await rest.json()) as { recordings: { id: string; transcript: string }[] };
    expect(restBody.recordings[0]).toMatchObject({ id: rid, transcript: "[00:00] Part 1 of the call." });
    const post = await ctx.app.request(`/api/v1/meetings/${meetingId}/recordings`, { method: "POST", headers: { authorization: `Bearer ${ro}`, host: "localhost", "content-type": "application/json" }, body: "{}" });
    expect([403, 404, 405]).toContain(post.status);
    const otherKey = (await stranger.post("/api/developer/keys", { name: "Theirs", scope: "read" })).body.secret;
    expect((await ctx.app.request(`/api/v1/meetings/${meetingId}/recordings`, { headers: { authorization: `Bearer ${otherKey}`, host: "localhost" } })).status).toBe(404);

    // MCP: get_meeting_transcript works on a read only key, and not across workspaces.
    const reader = await mcpFor(ro);
    const got = await reader.callTool({ name: "get_meeting_transcript", arguments: { meetingId } });
    expect(got.isError).toBeFalsy();
    const parsed = JSON.parse((got as { content: { text: string }[] }).content[0].text);
    expect(parsed.recordings[0]).toMatchObject({ id: rid, status: "recording", transcript: "[00:00] Part 1 of the call." });
    const outsider = await mcpFor(otherKey);
    expect((await outsider.callTool({ name: "get_meeting_transcript", arguments: { meetingId } })).isError).toBe(true);
    // The key is never in any answer.
    expect(JSON.stringify(parsed)).not.toContain(KEY);
    expect(JSON.stringify((await c.get(`/api/meetings/${meetingId}/recordings`)).body)).not.toContain(KEY);
  });
});

describe("the browser recorder's pure parts", () => {
  it("the Recording banner signal round trips and ignores junk", () => {
    const s = { on: true, by: "Olive Owner", recordingId: "rec_1", startedAt: "2026-10-26T09:00:00.000Z" };
    expect(decodeSignal(encodeSignal(s))).toEqual(s);
    expect(decodeSignal(new TextEncoder().encode("not json"))).toBeNull();
    expect(decodeSignal(new TextEncoder().encode(JSON.stringify({ on: true })))).toBeNull();
  });
  it("uploads chunks one at a time in sequence order, retries a failure, and skips a 4xx", async () => {
    const sent: number[] = [];
    let failOnce = true;
    const q = new UploadQueue(async (c) => {
      await new Promise((r) => setTimeout(r, 5));
      if (c.seq === 1 && failOnce) { failOnce = false; throw new Error("network"); }
      if (c.seq === 3) throw Object.assign(new Error("stopped"), { status: 409 });
      sent.push(c.seq);
    }, { pauseMs: 1 });
    const chunk = (seq: number): Chunk => ({ seq, blob: new Blob(["x"]), offsetSec: seq * 300, durationSec: (seq + 1) * 300 });
    q.add(chunk(0));
    q.add(chunk(2));
    q.add(chunk(1));
    q.add(chunk(3));
    await q.flush();
    expect(sent).toEqual([0, 1, 2]);
    expect(q.failed?.message).toBe("stopped");
    expect(q.pending).toBe(0);
  });
});
