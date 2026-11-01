import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { cleanOptions, cleanTopicName, cloudWords, decisionOutcome, isOpenPoll, normaliseWord, pollWinners, tallyCloud, topicKey } from "@/shared/chat-plus";

/** R96 chat plus: topics, announcements, polls, decision votes, live Q&A and word clouds. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;

async function setup() {
  ctx = await makeTestApp();
  clock = new Date("2026-11-01T00:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
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
type Msg = { id: string; topicId: string | null; body: string; poll?: { id: string; kind: string }; announcement?: boolean; pinnedAt: string | null; replyCount: number };
const general = async (cl: Client = c) => ((await cl.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
const post = async (channelId: string, body: string, cl: Client = c, extra: Record<string, unknown> = {}) => (await cl.post(`/api/chat/channels/${channelId}/messages`, { body, ...extra })).body.message as Msg;
const messages = async (channelId: string, cl: Client = c, q = "") => (await cl.get(`/api/chat/channels/${channelId}/messages${q}`)).body.messages as Msg[];
const topics = async (channelId: string, cl: Client = c) => (await cl.get(`/api/chat-plus/channels/${channelId}/topics`)).body.topics as { id: string; name: string; unread: number; total: number; resolved: boolean }[];

describe("chat plus rules", () => {
  it("cleans topic names and treats case and spacing as the same topic", () => {
    expect(cleanTopicName("  Launch   plan ")).toBe("Launch plan");
    expect(cleanTopicName("✓ Launch plan")).toBe("Launch plan");
    expect(topicKey("Launch  PLAN")).toBe(topicKey("launch plan"));
    expect(cleanTopicName("x".repeat(100))).toHaveLength(60);
  });
  it("needs two different poll choices and at most ten", () => {
    expect(cleanOptions(["Tea", " tea ", ""])).toEqual({ error: "Add at least two different choices." });
    expect(cleanOptions(["Tea", "Coffee"])).toEqual({ options: ["Tea", "Coffee"] });
    expect("error" in cleanOptions(Array.from({ length: 11 }, (_, i) => `o${i}`))).toBe(true);
  });
  it("decides: any block stops it, more agree than disagree passes, a tie does not", () => {
    expect(decisionOutcome({}).result).toBe("no_votes");
    expect(decisionOutcome({ agree: 5, block: 1 }).result).toBe("blocked");
    expect(decisionOutcome({ agree: 2, disagree: 1, abstain: 4 }).result).toBe("passed");
    expect(decisionOutcome({ agree: 1, disagree: 1 }).result).toBe("not_passed");
    expect(decisionOutcome({ abstain: 3 }).result).toBe("not_passed");
    expect(decisionOutcome({ agree: 2, disagree: 1 }).summary).toBe("Agreed (2 agree, 0 abstain, 1 disagree, 0 block).");
  });
  it("normalises word cloud entries in any script and keeps three", () => {
    expect(normaliseWord("  Speed!! ")).toBe("speed");
    expect(normaliseWord("नमस्ते")).toBe("नमस्ते");
    expect(cloudWords(["Fast, fast, clear", "simple", "extra"])).toEqual(["fast", "clear", "simple"]);
    expect(cloudWords(["!!!"])).toEqual([]);
    expect(tallyCloud(["a", "b", "a"])).toEqual([{ word: "a", count: 2 }, { word: "b", count: 1 }]);
  });
  it("finds every tied winner and knows when a vote is open", () => {
    expect(pollWinners(["A", "B", "C"], [2, 2, 1])).toEqual(["A", "B"]);
    expect(pollWinners(["A"], [0])).toEqual([]);
    const now = new Date("2026-11-01T00:00:00Z");
    expect(isOpenPoll({ closedAt: null, closesAt: null }, now)).toBe(true);
    expect(isOpenPoll({ closedAt: null, closesAt: "2026-10-31T00:00:00Z" }, now)).toBe(false);
    expect(isOpenPoll({ closedAt: "2026-10-31T00:00:00Z", closesAt: null }, now)).toBe(false);
  });
});

describe("topics", () => {
  beforeEach(setup);
  it("creates topics, posts into them, counts unread per topic and filters the channel", async () => {
    const g = await general();
    const mate = await teammate();
    await mate.client.post(`/api/chat/channels/${g.id}/join`, {});
    const made = await c.post(`/api/chat-plus/channels/${g.id}/topics`, { name: "Launch plan" });
    expect(made.status).toBe(201);
    const again = await c.post(`/api/chat-plus/channels/${g.id}/topics`, { name: " launch  PLAN " });
    expect(again.status).toBe(200);
    expect(again.body.topic.id).toBe(made.body.topic.id);
    const t = made.body.topic.id as string;
    const m1 = await post(g.id, "First idea", c, { topicId: t });
    expect(m1.topicId).toBe(t);
    await post(g.id, "Off topic");
    // A reply follows its thread's topic even when the client names none.
    const reply = await post(g.id, "A reply", c, { parentId: m1.id });
    expect(reply.topicId).toBe(t);
    expect((await topics(g.id, mate.client))[0]).toMatchObject({ name: "Launch plan", unread: 1, total: 1 });
    expect((await topics(g.id))[0].unread).toBe(0); // the author has read their own message
    const only = await messages(g.id, c, `?topicId=${t}`);
    expect(only.map((m) => m.body)).toEqual(["First idea"]);
    expect((await mate.client.post(`/api/chat-plus/topics/${t}/read`, {})).status).toBe(200);
    expect((await topics(g.id, mate.client))[0].unread).toBe(0);
  });

  it("refuses a topic from another channel or workspace, and topics in DMs", async () => {
    const g = await general();
    const other = (await c.post("/api/chat/channels", { name: "design" })).body.channel;
    const t = (await c.post(`/api/chat-plus/channels/${other.id}/topics`, { name: "Logo" })).body.topic.id;
    expect((await c.post(`/api/chat/channels/${g.id}/messages`, { body: "x", topicId: t })).status).toBe(404);
    const outsider = new Client(ctx.app);
    await outsider.signup("eve@other.io", "Eve Other");
    expect((await outsider.get(`/api/chat-plus/channels/${g.id}/topics`)).status).toBe(404);
    expect((await outsider.patch(`/api/chat-plus/topics/${t}`, { resolved: true })).status).toBe(404);
    expect((await c.post(`/api/chat-plus/channels/${g.id}/topics`, { name: "   " })).status).toBe(422);
    const mate = await teammate();
    const dm = (await c.post("/api/chat/dms", { userIds: [mate.id] })).body.channel;
    if (dm) expect((await c.post(`/api/chat-plus/channels/${dm.id}/topics`, { name: "Hi" })).status).toBe(422);
  });

  it("renames (creator or admin), merges on request, resolves with a tick and moves messages", async () => {
    const g = await general();
    const mate = await teammate();
    await mate.client.post(`/api/chat/channels/${g.id}/join`, {});
    const a = (await mate.client.post(`/api/chat-plus/channels/${g.id}/topics`, { name: "Budget" })).body.topic.id;
    const b = (await c.post(`/api/chat-plus/channels/${g.id}/topics`, { name: "Costs" })).body.topic.id;
    await post(g.id, "in budget", mate.client, { topicId: a });
    const loose = await post(g.id, "loose", mate.client);
    // A member cannot rename someone else's topic; the creator can; an admin can.
    expect((await mate.client.patch(`/api/chat-plus/topics/${b}`, { name: "Spend" })).status).toBe(403);
    expect((await mate.client.patch(`/api/chat-plus/topics/${a}`, { name: "Budget 2027" })).body.topic.name).toBe("Budget 2027");
    // A clash asks first, then merges.
    const clash = await c.patch(`/api/chat-plus/topics/${a}`, { name: "costs" });
    expect(clash.status).toBe(409);
    const merged = await c.patch(`/api/chat-plus/topics/${a}`, { name: "costs", merge: true });
    expect(merged.body).toMatchObject({ merged: true, topic: { id: b } });
    expect((await messages(g.id, c, `?topicId=${b}`)).map((m) => m.body)).toContain("in budget");
    expect((await topics(g.id)).map((t) => t.id)).toEqual([b]);
    // Resolve posts a note in the topic and marks it.
    const res = await mate.client.patch(`/api/chat-plus/topics/${b}`, { resolved: true });
    expect(res.body.topic.resolved).toBe(true);
    expect((await messages(g.id, c, `?topicId=${b}`)).at(-1)!.body).toContain("resolved");
    // Moving: the author (or an admin) moves a top level message; replies are refused.
    expect((await mate.client.post(`/api/chat-plus/messages/${loose.id}/topic`, { topicId: b })).body.topicId).toBe(b);
    const mine = await post(g.id, "owner says", c);
    expect((await mate.client.post(`/api/chat-plus/messages/${mine.id}/topic`, { topicId: b })).status).toBe(403);
    const reply = await post(g.id, "r", c, { parentId: mine.id });
    expect((await c.post(`/api/chat-plus/messages/${reply.id}/topic`, { topicId: b })).status).toBe(422);
    expect((await c.post(`/api/chat-plus/messages/${loose.id}/topic`, { topicId: null })).body.topicId).toBe(null);
  });
});

describe("announcements", () => {
  beforeEach(setup);
  it("lets admins announce, pins it, counts who has seen it and shows names to admins only", async () => {
    const g = await general();
    const mate = await teammate();
    expect((await mate.client.post(`/api/chat-plus/channels/${g.id}/announcements`, { body: "Hi all" })).status).toBe(403);
    expect((await c.post(`/api/chat-plus/channels/${g.id}/announcements`, { body: "  " })).status).toBe(422);
    const made = await c.post(`/api/chat-plus/channels/${g.id}/announcements`, { body: "Office closed Friday" });
    expect(made.status).toBe(201);
    expect(made.body.message).toMatchObject({ announcement: true });
    expect(made.body.message.pinnedAt).toBeTruthy();
    const feed = (await mate.client.get("/api/chat-plus/announcements")).body;
    expect(feed).toMatchObject({ unseen: 1, canPost: false });
    expect(feed.announcements[0]).toMatchObject({ seenCount: 1, audience: 2, seenByMe: false, channel: { name: "general" } });
    const id = feed.announcements[0].message.id;
    expect((await mate.client.post("/api/chat-plus/announcements/seen", { messageIds: [id, "chm_nope"] })).body.marked).toBe(1);
    expect((await mate.client.get("/api/chat-plus/announcements")).body.unseen).toBe(0);
    expect((await mate.client.get(`/api/chat-plus/announcements/${id}/receipts`)).body).toMatchObject({ seenCount: 2, seen: null });
    const names = (await c.get(`/api/chat-plus/announcements/${id}/receipts`)).body.seen.map((s: { name: string }) => s.name);
    expect(names).toEqual(["Olive Owner", "Sam Mate"]);
  });
  it("keeps private channel announcements to the channel's members and other workspaces out", async () => {
    const mate = await teammate();
    const secret = (await c.post("/api/chat/channels", { name: "leads", private: true })).body.channel;
    const id = (await c.post(`/api/chat-plus/channels/${secret.id}/announcements`, { body: "Board pack" })).body.message.id;
    expect((await mate.client.get("/api/chat-plus/announcements")).body.announcements).toHaveLength(0);
    expect((await mate.client.get(`/api/chat-plus/announcements/${id}/receipts`)).status).toBe(404);
    const outsider = new Client(ctx.app);
    await outsider.signup("eve@other.io", "Eve Other");
    expect((await outsider.get("/api/chat-plus/announcements")).body.announcements).toHaveLength(0);
  });
});

describe("polls and decisions", () => {
  beforeEach(setup);
  it("posts a poll card, takes one choice, hides names when anonymous and closes with the top choice in the thread", async () => {
    const g = await general();
    const mate = await teammate();
    expect((await c.post("/api/chat-plus/polls", { kind: "poll", question: "Lunch?", options: ["Thai"], channelId: g.id })).status).toBe(422);
    const made = await c.post("/api/chat-plus/polls", { kind: "poll", question: "Lunch?", options: ["Thai", "Pizza", "thai"], channelId: g.id, anonymous: true });
    expect(made.status).toBe(201);
    const poll = made.body.poll;
    expect(poll.options).toEqual(["Thai", "Pizza"]);
    const card = (await messages(g.id)).at(-1)!;
    expect(card).toMatchObject({ body: "Poll: Lunch?", poll: { id: poll.id, kind: "poll" } });
    expect((await mate.client.post(`/api/chat-plus/polls/${poll.id}/vote`, { choices: ["0", "1"] })).status).toBe(422);
    expect((await mate.client.post(`/api/chat-plus/polls/${poll.id}/vote`, { choices: ["5"] })).status).toBe(422);
    const v = (await mate.client.post(`/api/chat-plus/polls/${poll.id}/vote`, { choices: ["1"] })).body.poll;
    expect(v).toMatchObject({ voters: 1, mine: ["1"] });
    expect(v.tally[1]).toMatchObject({ count: 1, names: [] });
    await c.post(`/api/chat-plus/polls/${poll.id}/vote`, { choices: ["1"] });
    // Changing and taking back a vote.
    expect((await mate.client.post(`/api/chat-plus/polls/${poll.id}/vote`, { choices: [] })).body.poll.voters).toBe(1);
    expect((await mate.client.post(`/api/chat-plus/polls/${poll.id}/close`, {})).status).toBe(403);
    const closed = (await c.post(`/api/chat-plus/polls/${poll.id}/close`, {})).body.poll;
    expect(closed).toMatchObject({ open: false, canVote: false, outcome: { winners: ["Pizza"] } });
    expect((await mate.client.post(`/api/chat-plus/polls/${poll.id}/vote`, { choices: ["0"] })).status).toBe(409);
    const thread = (await c.get(`/api/chat/messages/${card.id}/thread`)).body;
    expect(JSON.stringify(thread)).toContain("Top choice: Pizza");
  });

  it("lets a multiple choice poll take several and shows names when not anonymous", async () => {
    const g = await general();
    const p = (await c.post("/api/chat-plus/polls", { kind: "poll", question: "Days?", options: ["Mon", "Tue", "Wed"], multi: true, channelId: g.id })).body.poll;
    const v = (await c.post(`/api/chat-plus/polls/${p.id}/vote`, { choices: ["0", "2"] })).body.poll;
    expect(v.mine).toEqual(["0", "2"]);
    expect(v.tally[0].names).toEqual(["Olive Owner"]);
  });

  it("runs a decision: block needs a reason, the deadline closes it and the outcome is posted", async () => {
    const g = await general();
    const mate = await teammate();
    const d = (await mate.client.post("/api/chat-plus/polls", { kind: "decision", question: "Move standup to 10", channelId: g.id })).body.poll;
    expect(d.options).toEqual(["agree", "abstain", "disagree", "block"]);
    expect(new Date(d.closesAt).getTime()).toBeGreaterThan(clock + 47 * 3_600_000); // defaults to two days
    expect((await c.post(`/api/chat-plus/polls/${d.id}/vote`, { choices: ["block"] })).status).toBe(422);
    expect((await c.post(`/api/chat-plus/polls/${d.id}/vote`, { choices: ["maybe"] })).status).toBe(422);
    await c.post(`/api/chat-plus/polls/${d.id}/vote`, { choices: ["block"], reason: "Clashes with client calls" });
    const v = (await mate.client.post(`/api/chat-plus/polls/${d.id}/vote`, { choices: ["agree"] })).body.poll;
    expect(v.standing).toMatchObject({ result: "blocked", label: "Blocked" });
    expect(v.reasons).toEqual([{ name: "Olive Owner", stance: "block", reason: "Clashes with client calls" }]);
    clock += 49 * 3_600_000;
    const after = (await mate.client.get(`/api/chat-plus/polls/${d.id}`)).body.poll;
    expect(after).toMatchObject({ open: false, outcome: { result: "blocked" } });
    const card = (await messages(g.id)).find((m) => m.poll?.id === d.id)!;
    expect(card.replyCount).toBe(1);
    // Reading again does not post the outcome twice.
    await c.get(`/api/chat-plus/polls/${d.id}`);
    expect((await messages(g.id)).find((m) => m.poll?.id === d.id)!.replyCount).toBe(1);
  });

  it("checks end times and archived channels", async () => {
    const g = await general();
    expect((await c.post("/api/chat-plus/polls", { kind: "poll", question: "Q", options: ["a", "b"], channelId: g.id, closesAt: new Date(clock - 1000).toISOString() })).status).toBe(422);
    expect((await c.post("/api/chat-plus/polls", { kind: "poll", question: "Q", options: ["a", "b"], channelId: g.id, closesAt: new Date(clock + 100 * 86_400_000).toISOString() })).status).toBe(422);
    expect((await c.post("/api/chat-plus/polls", { kind: "poll", question: "", options: ["a", "b"], channelId: g.id })).status).toBe(422);
    expect((await c.post("/api/chat-plus/polls", { kind: "poll", question: "Q", options: ["a", "b"] })).status).toBe(422);
    const ch = (await c.post("/api/chat/channels", { name: "old" })).body.channel;
    const p = (await c.post("/api/chat-plus/polls", { kind: "poll", question: "Q", options: ["a", "b"], channelId: ch.id })).body.poll;
    await c.patch(`/api/chat/channels/${ch.id}`, { archived: true });
    expect((await c.post(`/api/chat-plus/polls/${p.id}/vote`, { choices: ["0"] })).status).toBe(409);
  });

  it("keeps polls inside their workspace and private channel", async () => {
    const mate = await teammate();
    const secret = (await c.post("/api/chat/channels", { name: "leads", private: true })).body.channel;
    const p = (await c.post("/api/chat-plus/polls", { kind: "poll", question: "Q", options: ["a", "b"], channelId: secret.id })).body.poll;
    expect((await mate.client.get(`/api/chat-plus/polls/${p.id}`)).status).toBe(404);
    expect((await mate.client.post(`/api/chat-plus/polls/${p.id}/vote`, { choices: ["0"] })).status).toBe(404);
    const outsider = new Client(ctx.app);
    await outsider.signup("eve@other.io", "Eve Other");
    expect((await outsider.get(`/api/chat-plus/polls/${p.id}`)).status).toBe(404);
  });
});

describe("live Q&A and word clouds", () => {
  beforeEach(setup);
  it("takes questions, sorts by upvotes, refuses upvoting your own and lets the host mark answered", async () => {
    const g = await general();
    const mate = await teammate();
    const qa = (await c.post("/api/chat-plus/polls", { kind: "qa", question: "Town hall", channelId: g.id })).body.poll;
    expect((await mate.client.post(`/api/chat-plus/polls/${qa.id}/questions`, { body: " " })).status).toBe(422);
    const q1 = (await mate.client.post(`/api/chat-plus/polls/${qa.id}/questions`, { body: "When is the offsite?" })).body.poll.questions[0];
    await c.post(`/api/chat-plus/polls/${qa.id}/questions`, { body: "Budget for tools?" });
    expect((await mate.client.post(`/api/chat-plus/questions/${q1.id}/upvote`, {})).status).toBe(422);
    const up = (await c.post(`/api/chat-plus/questions/${q1.id}/upvote`, {})).body.poll;
    expect(up.questions[0]).toMatchObject({ body: "When is the offsite?", votes: 1, upvoted: true });
    expect((await c.post(`/api/chat-plus/questions/${q1.id}/upvote`, {})).body.poll.questions.find((q: { id: string }) => q.id === q1.id).votes).toBe(0);
    expect((await mate.client.post(`/api/chat-plus/questions/${q1.id}/answered`, { answered: true })).status).toBe(403);
    const ans = (await c.post(`/api/chat-plus/questions/${q1.id}/answered`, { answered: true })).body.poll;
    expect(ans.questions.at(-1)).toMatchObject({ id: q1.id, answered: true });
    expect((await c.post(`/api/chat-plus/polls/${qa.id}/vote`, { choices: ["x"] })).status).toBe(422);
  });

  it("collects up to three words each and tallies the cloud", async () => {
    const g = await general();
    const mate = await teammate();
    const w = (await c.post("/api/chat-plus/polls", { kind: "cloud", question: "One word for this week", channelId: g.id })).body.poll;
    await c.post(`/api/chat-plus/polls/${w.id}/vote`, { choices: ["Busy, fun"] });
    const v = (await mate.client.post(`/api/chat-plus/polls/${w.id}/vote`, { choices: ["busy", "Calm", "busy", "late", "more"] })).body.poll;
    expect(v.cloud[0]).toEqual({ word: "busy", count: 2 });
    expect(v.mine).toEqual(["busy", "calm", "late"]);
    expect((await c.post(`/api/chat-plus/polls/${w.id}/vote`, { choices: ["???"] })).status).toBe(422);
  });

  it("runs polls during a meeting for anyone in the workspace", async () => {
    const mate = await teammate();
    const mt = (await c.post("/api/meetings", { title: "Weekly", startsAt: new Date(clock + 3_600_000).toISOString(), durationMin: 30 })).body.meeting;
    const p = await c.post("/api/chat-plus/polls", { kind: "poll", question: "Ship it?", options: ["Yes", "No"], meetingId: mt.id });
    expect(p.status).toBe(201);
    expect(p.body.poll.messageId).toBe(null);
    await mate.client.post(`/api/chat-plus/polls/${p.body.poll.id}/vote`, { choices: ["0"] });
    const list = (await mate.client.get(`/api/chat-plus/meetings/${mt.id}/polls`)).body.polls;
    expect(list[0]).toMatchObject({ question: "Ship it?", voters: 1, canManage: false });
    const outsider = new Client(ctx.app);
    await outsider.signup("eve@other.io", "Eve Other");
    expect((await outsider.get(`/api/chat-plus/meetings/${mt.id}/polls`)).status).toBe(404);
    expect((await outsider.post("/api/chat-plus/polls", { kind: "poll", question: "x", options: ["a", "b"], meetingId: mt.id })).status).toBe(404);
  });
});

describe("guests", () => {
  beforeEach(setup);
  it("see poll results read only in a channel shared with them, without names", async () => {
    const p = (await c.post("/api/projects", { name: "Harbour site" })).body.project;
    const shared = (await c.post("/api/chat/channels", { name: "harbour-client", projectId: p.id, guestAccess: true })).body.channel;
    const internal = (await c.post("/api/chat/channels", { name: "harbour-internal", projectId: p.id })).body.channel;
    await c.patch(`/api/chat/channels/${internal.id}`, { guestAccess: false });
    const open = (await c.post("/api/chat-plus/polls", { kind: "poll", question: "Colour?", options: ["Blue", "Green"], channelId: shared.id })).body.poll;
    const hidden = (await c.post("/api/chat-plus/polls", { kind: "poll", question: "Fee?", options: ["a", "b"], channelId: internal.id })).body.poll;
    await c.post(`/api/chat-plus/polls/${open.id}/vote`, { choices: ["0"] });
    await c.post("/api/guests", { projectId: p.id, email: "mia@harbour.coffee", name: "Mia" });
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const token = sent.map((x) => x.text).reverse().find((x) => x.includes("/g/"))?.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1];
    const guest = new Client(ctx.app);
    expect((await guest.get(`/api/guest/chat-plus/polls/${open.id}`)).status).toBe(401);
    expect((await guest.post("/api/guest/accept", { token })).status).toBe(200);
    const seen = (await guest.get(`/api/guest/chat-plus/polls/${open.id}`)).body.poll;
    expect(seen).toMatchObject({ canVote: false, canManage: false, voters: 1 });
    expect(seen.tally[0]).toMatchObject({ count: 1, names: [] });
    expect((await guest.get(`/api/guest/chat-plus/polls/${hidden.id}`)).status).toBe(404);
    expect((await guest.post(`/api/chat-plus/polls/${open.id}/vote`, { choices: ["1"] })).status).toBe(401);
  });
});
