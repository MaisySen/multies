/** TD8 Team AI: memory CRUD and audit, instruction sets, routines (schedule, triggers once, caps), own key only, the AI
 * switch (off = no provider call), chat answers filtered to what every reader can open, other workspace 404, flag off,
 * and nothing of the prompt or answer in logs. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { citedNumbers, cleanText, mentionsAssistant, nextRunAt, questionOf, TEAMAI_CAPS } from "@/shared/teamai-td8";

const gate = vi.hoisted(() => ({ on: true }));
vi.mock("@/server/services/teamai-gate-td8", () => ({ teamAiSwitchOn: async () => gate.on }));

type Call = { url: string; body: string };
/** Not a key: a placeholder the fake provider below accepts. */
const FAKE_KEY = ["unit", "test", "placeholder", "only"].join("-");
function fakeAi(answer = "Launch is on Friday [1].", status = 200) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push({ url, body: String(init?.body ?? "") });
    if (status !== 200) return new Response("provider says no secret words here", { status });
    return Response.json({ choices: [{ message: { content: answer } }], data: [] });
  }) as typeof fetch;
  return { calls, f };
}

async function setup(env: Record<string, string> = { TEAMAI_TD8: "on" }, ai = fakeAi()) {
  const logs: unknown[] = [];
  const ctx = await makeTestApp(env, { fetch: ai.f });
  const sink = (...x: unknown[]) => { logs.push(x); };
  ctx.deps.log = { info: sink, warn: sink, error: sink, debug: sink } as unknown as typeof ctx.deps.log;
  ctx.deps.reportError = (err, c) => { logs.push([String(err), c]); return undefined; };
  const admin = new Client(ctx.app);
  await admin.signup("ada@acme.io", "Ada Lovelace", "Acme");
  const join = async (email: string, name: string, role: "member" | "admin" = "member") => {
    const inv = await admin.post("/api/team/invites", { email, role });
    const m = new Client(ctx.app);
    await m.signup(email, name, `${name} Co`);
    expect((await m.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    return m;
  };
  const addKey = async () => expect((await admin.call("PUT", "/api/ai/key", { provider: "openai", apiKey: FAKE_KEY })).status).toBe(200);
  const runs = async () => ctx.deps.db.all<{ id: string; kind: string; status: string; reason: string | null; result: string | null; message_id: string | null; input: string | null }>(
    sql`select id, kind, status, reason, result, message_id, input from teamai_runs order by created_at asc`);
  const providerCalls = () => ai.calls.filter((c) => /openai|anthropic|groq|openrouter/.test(c.url) && !c.url.endsWith("/models"));
  return { ctx, admin, join, addKey, runs, ai, providerCalls, logs };
}

beforeEach(() => { gate.on = true; });

describe("TD8 pure rules", () => {
  it("mentions, questions, schedules, citations and clean text", () => {
    expect(mentionsAssistant("@assistant what is due?")).toBe(true);
    expect(mentionsAssistant("hey @Assistant, summary please")).toBe(true);
    expect(mentionsAssistant("mail me at x@assistant.io")).toBe(false);
    expect(mentionsAssistant("`@assistant` is the bot")).toBe(false);
    expect(questionOf("@assistant: when is launch?")).toBe("when is launch?");
    // 2026-11-02 09:00 UTC is 20:00 in Sydney; daily at 9 is tomorrow 9:00 Sydney = 22:00 UTC today.
    const now = Date.UTC(2026, 10, 2, 9, 0);
    expect(new Date(nextRunAt(now, "Australia/Sydney", "daily", 9, 1)!).toISOString()).toBe("2026-11-02T22:00:00.000Z");
    expect(new Date(nextRunAt(now, "UTC", "weekly", 8, 1)!).toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(new Date(nextRunAt(now, "Not/AZone", "daily", 10, 0)!).toISOString()).toBe("2026-11-02T10:00:00.000Z");
    expect(nextRunAt(now, "UTC", "task_created", 9, 1)).toBeNull();
    // Across a clock change (Sydney starts daylight time on 2026-10-04): 9:00 local is 22:00 UTC the day before.
    expect(new Date(nextRunAt(Date.UTC(2026, 9, 3, 0), "Australia/Sydney", "daily", 9, 0)!).toISOString()).toBe("2026-10-03T22:00:00.000Z");
    expect(citedNumbers("see [2] and [1] and [9] and [2]", 3)).toEqual([2, 1]);
    expect(cleanText(" a\u0000b \n c ", 10)).toBe("ab c");
    expect(cleanText("x".repeat(20), 5)).toBe("xxxxx");
  });
});

describe("TD8 flag and access", () => {
  it("flag off: every path 404 and @assistant does nothing", async () => {
    const t = await setup({});
    expect((await t.admin.get("/api/team-ai/state")).status).toBe(404);
    expect((await t.admin.post("/api/team-ai/memory", { text: "We ship on Fridays" })).status).toBe(404);
    const g = (await t.admin.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
    expect((await t.admin.post(`/api/chat/channels/${g.id}/messages`, { body: "@assistant hello" })).status).toBe(201);
    const [n] = await t.ctx.deps.db.all<{ n: number }>(sql`select count(*) as n from teamai_runs`);
    expect(Number(n.n)).toBe(0);
    expect(t.providerCalls().length).toBe(0);
  });

  it("signed out 401, other workspace 404, members read only for memory", async () => {
    const t = await setup();
    expect((await new Client(t.ctx.app).get("/api/team-ai/state")).status).toBe(401);
    const m = await t.join("sam@acme.io", "Sam Member");
    const st = await m.get("/api/team-ai/state");
    expect(st.status).toBe(200);
    expect(st.body.isAdmin).toBe(false);
    expect(st.body.ai).toEqual({ on: true, key: false, provider: null });
    expect(JSON.stringify(st.body)).not.toMatch(/sk-/);
    const a = await t.admin.post("/api/team-ai/memory", { text: "Our refund window is 30 days" });
    expect(a.status).toBe(201);
    expect(a.body.status).toBe("active");
    expect((await m.call("PATCH", `/api/team-ai/memory/${a.body.id}`, { text: "changed" })).status).toBe(403);
    expect((await m.call("DELETE", `/api/team-ai/memory/${a.body.id}`)).status).toBe(403);
    const other = new Client(t.ctx.app);
    await other.signup("eve@other.io", "Eve Other", "Other");
    expect((await other.call("PATCH", `/api/team-ai/memory/${a.body.id}`, { text: "mine now" })).status).toBe(404);
    expect((await other.call("DELETE", `/api/team-ai/memory/${a.body.id}`)).status).toBe(404);
    expect((await other.get("/api/team-ai/memory")).body.memory).toEqual([]);
  });
});

describe("TD8 memory", () => {
  it("add, suggest, accept, edit and delete, each audited with who and when", async () => {
    const t = await setup();
    const m = await t.join("sam@acme.io", "Sam Member");
    expect((await t.admin.post("/api/team-ai/memory", { text: "x" })).status).toBe(422);
    const sug = await m.post("/api/team-ai/memory", { text: "Support hours are 9 to 5" });
    expect(sug.body.status).toBe("suggested");
    expect((await t.admin.get("/api/team-ai/memory")).body.memory.map((x: { id: string }) => x.id)).toContain(sug.body.id);
    const acc = await t.admin.post(`/api/team-ai/memory/${sug.body.id}/accept`);
    expect(acc.body.status).toBe("active");
    expect(acc.body.createdByName).toBe("Sam Member");
    expect(acc.body.updatedByName).toBe("Ada Lovelace");
    const ed = await t.admin.call("PATCH", `/api/team-ai/memory/${sug.body.id}`, { text: "Support hours are 9 to 6" });
    expect(ed.body.text).toBe("Support hours are 9 to 6");
    expect((await t.admin.call("DELETE", `/api/team-ai/memory/${sug.body.id}`)).status).toBe(200);
    expect((await m.get("/api/team-ai/memory")).body.memory).toEqual([]);
    const acts = (await t.ctx.deps.db.all<{ action: string; metadata: string | null }>(sql`select action, metadata from audit_logs where action like 'teamai.%' order by created_at`)).map((r) => r.action);
    expect(acts).toEqual(["teamai.memory_suggested", "teamai.memory_accepted", "teamai.memory_edited", "teamai.memory_deleted"]);
    const meta = await t.ctx.deps.db.all<{ metadata: string | null }>(sql`select metadata from audit_logs where action like 'teamai.%'`);
    expect(JSON.stringify(meta)).not.toMatch(/Support hours/);
  });

  it("caps the number of notes", async () => {
    const t = await setup();
    const now = Date.now();
    const orgId = (await t.ctx.deps.db.all<{ id: string }>(sql`select id from organizations limit 1`))[0].id;
    for (let i = 0; i < TEAMAI_CAPS.memoryMax; i++) await t.ctx.deps.db.run(sql`insert into teamai_memory (id, org_id, text, status, created_at, updated_at) values (${`m${i}`}, ${orgId}, 'note', 'active', ${now}, ${now})`);
    expect((await t.admin.post("/api/team-ai/memory", { text: "one too many" })).status).toBe(409);
  });
});

describe("TD8 instruction sets and own key only", () => {
  it("own sets, admin only sharing, shared read only for members, no key means no call", async () => {
    const t = await setup();
    const m = await t.join("sam@acme.io", "Sam Member");
    expect((await m.post("/api/team-ai/instructions", { name: "Weekly", body: "Summarise", shared: true })).status).toBe(403);
    const mine = await m.post("/api/team-ai/instructions", { name: "My notes", body: "Write three bullet points" });
    expect(mine.status).toBe(201);
    expect((await t.admin.get("/api/team-ai/instructions")).body.instructions.length).toBe(0);
    const sh = await t.admin.post("/api/team-ai/instructions", { name: "Standup", body: "Write a standup summary", shared: true });
    const list = (await m.get("/api/team-ai/instructions")).body.instructions;
    expect(list.map((x: { name: string }) => x.name).sort()).toEqual(["My notes", "Standup"]);
    expect(list.find((x: { name: string }) => x.name === "Standup").canEdit).toBe(false);
    expect((await m.call("PATCH", `/api/team-ai/instructions/${sh.body.id}`, { body: "nope" })).status).toBe(403);
    const r = await m.post(`/api/team-ai/instructions/${mine.body.id}/run`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "skipped", reason: "no_key", reasonText: "No AI key is connected" });
    expect(t.providerCalls().length).toBe(0);
    await t.addKey();
    const ok = await m.post(`/api/team-ai/instructions/${mine.body.id}/run`);
    expect(ok.body.status).toBe("done");
    expect(ok.body.result).toContain("Launch is on Friday");
    expect(t.providerCalls().map((c) => new URL(c.url).hostname)).toEqual(["api.openai.com"]);
    // Admins see every run; another member sees none of Sam's.
    const other = await t.join("kim@acme.io", "Kim Member");
    expect((await other.get("/api/team-ai/runs")).body.runs).toEqual([]);
    expect((await other.get(`/api/team-ai/runs/${ok.body.id}`)).status).toBe(404);
    expect((await t.admin.get("/api/team-ai/runs")).body.runs.length).toBe(2);
  });

  it("AI switch off: no provider call, the run says why", async () => {
    const t = await setup();
    await t.addKey();
    gate.on = false;
    const s = await t.admin.post("/api/team-ai/instructions", { name: "Standup", body: "Write a standup summary", shared: true });
    const r = await t.admin.post(`/api/team-ai/instructions/${s.body.id}/run`);
    expect(r.body).toMatchObject({ status: "skipped", reason: "ai_off" });
    expect(t.providerCalls().length).toBe(0);
    expect((await t.admin.get("/api/team-ai/state")).body.ai.on).toBe(false);
  });
});

describe("TD8 routines", () => {
  async function withRoutine(trigger: string, extra: Record<string, unknown> = {}) {
    const t = await setup();
    await t.addKey();
    const s = await t.admin.post("/api/team-ai/instructions", { name: "Triage", body: "Suggest next steps", shared: true });
    const r = await t.admin.post("/api/team-ai/routines", { name: "On new task", instructionId: s.body.id, trigger, output: "draft", ...extra });
    expect(r.status).toBe(201);
    return { ...t, routine: r.body, ins: s.body };
  }

  it("admins only; a new task runs the routine once, as a draft", async () => {
    const t = await withRoutine("task_created");
    const m = await t.join("sam@acme.io", "Sam Member");
    expect((await m.post("/api/team-ai/routines", { name: "x", instructionId: t.ins.id, trigger: "daily" })).status).toBe(403);
    const proj = await t.admin.post("/api/projects", { name: "Launch" });
    const task = await t.admin.post("/api/tasks", { projectId: proj.body.project.id, title: "Ship pricing page" });
    expect(task.status).toBe(201);
    let rs = await t.runs();
    expect(rs.map((x) => [x.kind, x.status])).toEqual([["routine", "done"]]);
    expect(rs[0].input).toBeNull();
    expect(t.providerCalls()[0].body).toContain("Ship pricing page");
    const { onTaskCreated } = await import("@/server/services/teamai-td8");
    const actor = { orgId: proj.body.project.orgId ?? (await t.ctx.deps.db.all<{ id: string }>(sql`select id from organizations limit 1`))[0].id, userId: "", email: "", name: "x", system: true };
    await onTaskCreated(t.ctx.deps, actor, { id: task.body.task.id, projectId: proj.body.project.id });
    rs = await t.runs();
    expect(rs.length).toBe(1);
  });

  it("form responses trigger once per response; drafts never become email", async () => {
    const t = await withRoutine("task_created");
    const orgId = (await t.ctx.deps.db.all<{ id: string }>(sql`select id from organizations limit 1`))[0].id;
    await t.ctx.deps.db.run(sql`insert into forms (id, org_id, name, slug, fields, created_at, updated_at) values ('frm1', ${orgId}, 'Contact us', 'contact-us', '[{"id":"q1","label":"Message"}]', ${Date.now()}, ${Date.now()})`);
    const f = await t.admin.post("/api/team-ai/routines", { name: "Reply ideas", instructionId: t.ins.id, trigger: "form_response", formId: "frm1", output: "draft" });
    expect(f.status).toBe(201);
    await t.ctx.deps.db.run(sql`insert into form_submissions (id, org_id, form_id, data, created_at) values ('sub1', ${orgId}, 'frm1', '{"q1":"Please call me"}', ${Date.now()})`);
    const svc = await import("@/server/services/teamai-td8");
    const mailBefore = JSON.stringify(t.ctx.outbound).length;
    await svc.onFormResponse(t.ctx.deps, orgId, "frm1", "sub1");
    await svc.onFormResponse(t.ctx.deps, orgId, "frm1", "sub1");
    await svc.runTeamAiPass(t.ctx.deps);
    const rs = await t.runs();
    expect(rs.filter((x) => x.kind === "routine").length).toBe(1);
    expect(rs[0].status).toBe("done");
    expect(t.providerCalls()[0].body).toContain("Please call me");
    expect(JSON.stringify(t.ctx.outbound).length).toBe(mailBefore);
  });

  it("schedule: due routine runs once per due time and moves to the next day", async () => {
    const t = await withRoutine("daily", { hour: 9 });
    expect(t.routine.nextRunAt).toBeTruthy();
    await t.ctx.deps.db.run(sql`update teamai_routines set next_run_at = ${Date.now() - 1000}`);
    const svc = await import("@/server/services/teamai-td8");
    expect((await svc.runTeamAiPass(t.ctx.deps)).queued).toBe(1);
    expect((await svc.runTeamAiPass(t.ctx.deps)).queued).toBe(0);
    const [r] = await t.ctx.deps.db.all<{ next_run_at: number; last_status: string }>(sql`select next_run_at, last_status from teamai_routines`);
    expect(r.next_run_at).toBeGreaterThan(Date.now());
    expect(r.last_status).toBe("done");
    // Cap: a full day stops new runs with one visible line and no provider call.
    const orgId = (await t.ctx.deps.db.all<{ id: string }>(sql`select id from organizations limit 1`))[0].id;
    for (let i = 0; i < TEAMAI_CAPS.runsPerDay; i++) await t.ctx.deps.db.run(sql`insert into teamai_runs (id, org_id, kind, event_key, status, created_at) values (${`x${i}`}, ${orgId}, 'try', ${`k${i}`}, 'done', ${Date.now()})`);
    const before = t.providerCalls().length;
    const now = await t.admin.post(`/api/team-ai/routines/${t.routine.id}/run`);
    expect(now.status).toBe(409);
    expect(t.providerCalls().length).toBe(before);
    expect((await t.runs()).some((x) => x.reason === "cap")).toBe(true);
  });

  it("chat output needs a channel the admin can see", async () => {
    const t = await withRoutine("daily");
    expect((await t.admin.post("/api/team-ai/routines", { name: "Post", instructionId: t.ins.id, trigger: "daily", output: "chat", channelId: "nope" })).status).toBe(422);
  });
});

describe("TD8 assistant in chat", () => {
  it("answers in the thread with items every reader can open, never another person's private items", async () => {
    const t = await setup();
    await t.addKey();
    const m = await t.join("sam@acme.io", "Sam Member");
    await t.join("kim@acme.io", "Kim Member");
    const g = (await m.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
    // A private channel only Sam and Ada read, holding a secret.
    const sec = await t.admin.post("/api/chat/channels", { name: "secret", private: true, memberIds: [] });
    expect(sec.status).toBe(201);
    await t.admin.post(`/api/chat/channels/${sec.body.channel.id}/messages`, { body: "The launch password is bluefalcon" });
    await t.admin.post(`/api/chat/channels/${g.id}/messages`, { body: "The launch date is Friday" });
    await t.admin.post("/api/team-ai/memory", { text: "Launches happen at noon" });
    const ask = await t.admin.post(`/api/chat/channels/${g.id}/messages`, { body: "@assistant launch?" });
    expect(ask.status).toBe(201);
    const rs = await t.runs();
    expect(rs.map((x) => [x.kind, x.status])).toEqual([["mention", "done"]]);
    const prompt = t.providerCalls()[0].body;
    expect(prompt).toContain("Launches happen at noon");
    expect(prompt).not.toContain("bluefalcon");
    expect(prompt).toContain("launch date is Friday");
    const thread = await t.admin.get(`/api/chat/messages/${ask.body.message.id}/thread`);
    const reply = (thread.body.replies ?? thread.body.messages ?? []).find((x: { author: { name: string } }) => x.author.name === "Assistant");
    expect(reply).toBeTruthy();
    expect(reply.author.type).toBe("system");
    // The answer itself does not trigger another answer.
    expect((await t.runs()).length).toBe(1);
  });

  it("provider failure logs a reason code only, never the question or answer", async () => {
    const t = await setup({ TEAMAI_TD8: "on" }, fakeAi("x", 500));
    await t.addKey();
    const g = (await t.admin.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
    await t.admin.post(`/api/chat/channels/${g.id}/messages`, { body: "@assistant what is the zebracode for payroll" });
    const rs = await t.runs();
    expect(rs[0].status === "failed" || rs[0].status === "skipped").toBe(true);
    expect(JSON.stringify(t.logs)).not.toMatch(/zebracode|provider says/);
  });
});
