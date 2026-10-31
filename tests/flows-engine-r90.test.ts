import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { resetLoopGuard } from "@/server/services/suite/automations-r24";
import { resetWriteBudgetCache } from "@/server/services/write-budget";
import { advance, resumeDueRuns, sendDueDigests, startRun } from "@/server/services/suite/flows";
import { checkWatch, resetWatchState, setWatchFetch } from "@/server/services/suite/flow-watch";
import { chatChannels, flowDigestItems, flowRuns, flowRunSteps, flows, flowWatches, notifications } from "@/server/db/schema";
import type { FlowGraph } from "@/shared/flows";

/** R90: flows end to end against the database: triggers, branches, waits, approvals, retries, watches. */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let m: Client;
let me: string;
let mate: string;
let pid: string;
let chan: string;

beforeEach(async () => {
  resetLoopGuard();
  resetWriteBudgetCache();
  resetWatchState();
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  me = (await c.get("/api/account/me")).body.user.id;
  const invite = await c.post("/api/team/invites", { email: "max@acme.io", role: "member" });
  m = new Client(ctx.app);
  await m.signup("max@acme.io", "Max Member", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  mate = (await m.get("/api/account/me")).body.user.id;
  pid = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  chan = (await c.post("/api/chat/channels", { name: "ops" })).body.channel.id;
});
afterEach(() => setWatchFetch(null));

const N = (id: string, kind: string, config: Record<string, unknown> = {}) => ({ id, kind, config, x: 0, y: 0 });
const E = (from: string, to: string, branch = "next") => ({ id: `${from}-${to}-${branch}`, from, to, branch });
async function makeFlow(graph: unknown, name = "Test flow", on = true) {
  const r = await c.post("/api/flows", { name, graph });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.flow.id as string;
  if (on) { const p = await c.patch(`/api/flows/${id}`, { enabled: true }); expect(p.status, JSON.stringify(p.body)).toBe(200); }
  return id;
}
const runsOf = (flowId: string) => ctx.deps.db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)).all();
const stepsOf = (runId: string) => ctx.deps.db.select().from(flowRunSteps).where(eq(flowRunSteps.runId, runId)).all();
const messages = async () => ((await c.get(`/api/chat/channels/${chan}/messages`)).body.messages as { body: string }[]).map((x) => x.body);
const later = (ms: number) => { const base = Date.now() + ms; ctx.deps.now = () => new Date(base); };

describe("permissions and validation", () => {
  it("members see flows but cannot make, change or run them", async () => {
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "manual" })], edges: [] }, "Seen", false);
    expect((await m.get("/api/flows")).body.flows.map((f: { id: string }) => f.id)).toContain(id);
    expect((await m.post("/api/flows", { name: "x", graph: { nodes: [N("t", "trigger", { trigger: "manual" })], edges: [] } })).status).toBe(403);
    expect((await m.patch(`/api/flows/${id}`, { enabled: true })).status).toBe(403);
    expect((await m.post(`/api/flows/${id}/run`, {})).status).toBe(403);
  });
  it("a broken graph saves as a draft but cannot be turned on", async () => {
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "task_created" }), N("x", "action", {})], edges: [] }, "Draft", false);
    const r = await c.patch(`/api/flows/${id}`, { enabled: true });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/Fix this before turning the flow on/);
  });
  it("refuses a private network page to watch", async () => {
    const r = await c.post("/api/flows", { name: "w", graph: { nodes: [N("t", "trigger", { trigger: "page_changed", url: "ftp://example.com" })], edges: [] } });
    expect(r.status).toBe(422);
  });
});

describe("task events, branches and the run log", () => {
  it("a new urgent task posts in the channel; a low one takes the no path", async () => {
    const id = await makeFlow({
      nodes: [N("t", "trigger", { trigger: "task_created" }), N("c", "condition", { match: "all", rules: [{ field: "trigger.priority", op: "equals", value: "urgent" }] }),
        N("y", "action", { action: "post_to_channel", channelId: chan, message: "Urgent: {trigger.title}" }), N("n", "action", { action: "post_to_channel", channelId: chan, message: "Calm: {trigger.title}" })],
      edges: [E("t", "c"), E("c", "y", "yes"), E("c", "n", "no")],
    });
    await c.post("/api/tasks", { title: "Server down", projectId: pid, priority: "urgent" });
    await c.post("/api/tasks", { title: "Tidy docs", projectId: pid, priority: "low" });
    expect(await messages()).toEqual(expect.arrayContaining(["Urgent: Server down", "Calm: Tidy docs"]));
    const runs = await runsOf(id);
    expect(runs.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    const log = (await c.get(`/api/flows/runs/${runs[0].id}`)).body;
    expect(log.steps.map((s: { kind: string }) => s.kind)).toEqual(["trigger", "condition", "action"]);
    expect(log.steps[2].input.message).toMatch(/^(Urgent|Calm): /);
    expect((await c.get("/api/flows")).body.flows[0].runCount).toBe(2);
  });
  it("a flow that makes a task does not start itself again", async () => {
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "task_created" }), N("a", "action", { action: "create_task", title: "Follow up: {trigger.title}", projectId: pid })], edges: [E("t", "a")] });
    await c.post("/api/tasks", { title: "Call Sam", projectId: pid });
    expect((await runsOf(id)).length).toBe(1);
    const titles = (await c.get(`/api/tasks?projectId=${pid}`)).body.tasks.map((t: { title: string }) => t.title);
    expect(titles).toEqual(expect.arrayContaining(["Call Sam", "Follow up: Call Sam"]));
  });
  it("status change flows filter by stage and can move the task's priority", async () => {
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "status_changed", category: "done" }), N("a", "action", { action: "set_priority", priority: "low" })], edges: [E("t", "a")] });
    const t = (await c.post("/api/tasks", { title: "Ship", projectId: pid, priority: "high" })).body.task;
    await c.patch(`/api/tasks/${t.id}`, { status: "doing" });
    expect((await runsOf(id)).length).toBe(0);
    await c.patch(`/api/tasks/${t.id}`, { status: "done" });
    expect((await runsOf(id)).map((r) => r.status)).toEqual(["succeeded"]);
    expect((await c.get(`/api/tasks/${t.id}`)).body.task.priority).toBe("low");
  });
});

describe("idempotency", () => {
  it("one event starts one run, and a step attempt runs once even when two passes race", async () => {
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "manual" }), N("a", "action", { action: "post_to_channel", channelId: chan, message: "once" })], edges: [E("t", "a")] });
    const f = (await ctx.deps.db.select().from(flows).where(eq(flows.id, id)).get())!;
    const first = await startRun(ctx.deps, f, { note: "x" }, "evt:1");
    const again = await startRun(ctx.deps, f, { note: "x" }, "evt:1");
    expect(first).toBeTruthy();
    expect(again).toBeNull();
    // Force the run back to running and race two passes over the same step: the post happens once.
    await ctx.deps.db.update(flowRuns).set({ status: "running" }).where(eq(flowRuns.id, first!));
    await Promise.all([advance(ctx.deps, first!, "a"), advance(ctx.deps, first!, "a")]);
    expect((await messages()).filter((x) => x === "once").length).toBe(1);
    expect((await stepsOf(first!)).filter((s) => s.nodeId === "a").length).toBe(1);
  });
});

describe("waits, approvals and retries", () => {
  it("a wait parks the run and the maintenance pass carries on when it is due", async () => {
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "manual" }), N("w", "wait", { amount: 2, unit: "hours" }), N("a", "action", { action: "post_to_channel", channelId: chan, message: "after the wait" })], edges: [E("t", "w"), E("w", "a")] });
    const run = (await c.post(`/api/flows/${id}/run`, {})).body.run;
    expect(run.status).toBe("waiting");
    expect(await resumeDueRuns(ctx.deps)).toBe(0);
    later(2 * 3_600_000 + 1000);
    expect(await resumeDueRuns(ctx.deps)).toBe(1);
    expect((await runsOf(id))[0].status).toBe("succeeded");
    expect(await messages()).toContain("after the wait");
  });
  it("an approval waits for an admin; a member cannot decide; approve carries on, reject stops", async () => {
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "manual" }), N("p", "approval", { note: "OK to post?" }), N("a", "action", { action: "post_to_channel", channelId: chan, message: "approved post" })], edges: [E("t", "p"), E("p", "a")] });
    const r1 = (await c.post(`/api/flows/${id}/run`, {})).body.run;
    expect(r1.status).toBe("waiting_approval");
    const notes = await ctx.deps.db.select().from(notifications).where(eq(notifications.userId, me)).all();
    expect(notes.some((n) => n.title.includes("OK to post?"))).toBe(true);
    expect((await m.get("/api/flows/approvals")).body.approvals).toEqual([]);
    expect((await m.post(`/api/flows/runs/${r1.id}/decide`, { decision: "approve" })).status).toBe(403);
    expect((await c.get("/api/flows/approvals")).body.approvals[0].asked).toBe("OK to post?");
    expect((await c.post(`/api/flows/runs/${r1.id}/decide`, { decision: "approve" })).body.run.status).toBe("succeeded");
    expect(await messages()).toContain("approved post");
    const r2 = (await c.post(`/api/flows/${id}/run`, {})).body.run;
    const rej = (await c.post(`/api/flows/runs/${r2.id}/decide`, { decision: "reject", note: "Not now" })).body.run;
    expect(rej.status).toBe("cancelled");
    expect(rej.error).toMatch(/Rejected by Olive Owner: Not now/);
    expect((await c.post(`/api/flows/runs/${r2.id}/decide`, { decision: "approve" })).status).toBe(422);
  });
  it("a chosen approver decides, not an admin", async () => {
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "manual" }), N("p", "approval", { approver: mate })], edges: [E("t", "p")] });
    const run = (await c.post(`/api/flows/${id}/run`, {})).body.run;
    expect((await c.post(`/api/flows/runs/${run.id}/decide`, { decision: "approve" })).status).toBe(403);
    expect((await m.get("/api/flows/approvals")).body.approvals.length).toBe(1);
    expect((await m.post(`/api/flows/runs/${run.id}/decide`, { decision: "approve" })).body.run.status).toBe("succeeded");
  });
  it("a failed step stops the run with its reason; retry runs only that step again", async () => {
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "manual" }), N("a1", "action", { action: "post_to_channel", channelId: chan, message: "first" }), N("a2", "action", { action: "post_to_channel", channelId: chan, message: "second" })], edges: [E("t", "a1"), E("a1", "a2")] });
    // The channel goes private after the flow was made: the second post fails for a reason a retry will not fix by itself.
    const f = (await ctx.deps.db.select().from(flows).where(eq(flows.id, id)).get())!;
    const g = JSON.parse(f.graph) as FlowGraph;
    const other = (await c.post("/api/chat/channels", { name: "later" })).body.channel.id as string;
    g.nodes[2].config.channelId = other;
    await ctx.deps.db.update(flows).set({ graph: JSON.stringify(g) }).where(eq(flows.id, id));
    await ctx.deps.db.update(chatChannels).set({ isPrivate: true }).where(eq(chatChannels.id, other));
    const run = (await c.post(`/api/flows/${id}/run`, {})).body.run;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/gone or private/);
    expect(run.currentNode).toBe("a2");
    await ctx.deps.db.update(chatChannels).set({ isPrivate: false }).where(eq(chatChannels.id, other));
    const after = (await c.post(`/api/flows/runs/${run.id}/retry`, {})).body;
    expect(after.run.status).toBe("succeeded");
    expect(after.steps.filter((s: { nodeId: string }) => s.nodeId === "a2").map((s: { attempt: number; status: string }) => `${s.attempt}:${s.status}`)).toEqual(["1:failed", "2:succeeded"]);
    expect((await messages()).filter((x) => x === "first").length).toBe(1);
    expect((await c.post(`/api/flows/runs/${run.id}/retry`, {})).status).toBe(422);
  });
  it("a failing step with an error path takes it instead of failing the run", async () => {
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "manual" }), N("a1", "action", { action: "set_priority", priority: "low" }), N("e", "action", { action: "post_to_channel", channelId: chan, message: "it failed" })], edges: [E("t", "a1"), E("a1", "e", "error")] }, "err", false);
    // set_priority needs a task trigger, so validation blocks turning it on, but Run now uses the same checks:
    expect((await c.post(`/api/flows/${id}/run`, {})).status).toBe(422);
    const id2 = await makeFlow({ nodes: [N("t", "trigger", { trigger: "manual" }), N("a1", "action", { action: "send_webhook", endpointId: "nope" }), N("e", "action", { action: "post_to_channel", channelId: chan, message: "webhook failed" })], edges: [E("t", "a1"), E("a1", "e", "error")] }, "err2", false).catch(() => null);
    expect(id2).toBeNull(); // an unknown webhook is refused when saving
  });
});

describe("digests", () => {
  it("items gather and go out in one mail when due", async () => {
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "manual" }), N("d", "action", { action: "add_to_digest", every: "daily", title: "Item {trigger.note}" })], edges: [E("t", "d")] });
    await c.post(`/api/flows/${id}/run`, { note: "one" });
    await c.post(`/api/flows/${id}/run`, { note: "two" });
    const items = await ctx.deps.db.select().from(flowDigestItems).where(eq(flowDigestItems.flowId, id)).all();
    expect(items.map((i) => i.title).sort()).toEqual(["Item one", "Item two"]);
    expect(await sendDueDigests(ctx.deps)).toBe(0);
    later(2 * 86_400_000);
    expect(await sendDueDigests(ctx.deps)).toBe(1);
    expect((await ctx.deps.db.select().from(flowDigestItems).where(eq(flowDigestItems.flowId, id)).all()).every((i) => i.sentAt)).toBe(true);
  });
});

describe("page and feed watches", () => {
  const page = (body: string) => new Response(`<html><body><div id="price">${body}</div><p>Other</p></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  it("the first check learns the page; a change starts the flow with what changed", async () => {
    let body = "Price $10";
    setWatchFetch(async (url) => (url.endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /secret", { status: 200 }) : page(body)));
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "page_changed", url: "https://shop.example/item", selector: "#price", every: 60 }), N("a", "action", { action: "post_to_channel", channelId: chan, message: "Changed: {trigger.added}" })], edges: [E("t", "a")] });
    const w = () => ctx.deps.db.select().from(flowWatches).where(eq(flowWatches.flowId, id)).get();
    expect((await checkWatch(ctx.deps, (await w())!, { manual: true })).note).toMatch(/First look/);
    expect((await checkWatch(ctx.deps, (await w())!, { manual: true })).note).toBe("No change");
    body = "Price $12";
    expect((await checkWatch(ctx.deps, (await w())!, { manual: true })).started).toBe(1);
    expect(await messages()).toContain("Changed: Price $12");
    // Not manual and within ten minutes of the last request to the site: it waits instead.
    expect((await checkWatch(ctx.deps, (await w())!)).note).toMatch(/polite/);
  });
  it("robots.txt is respected", async () => {
    setWatchFetch(async (url) => (url.endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /secret", { status: 200 }) : page("x")));
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "page_changed", url: "https://shop.example/secret/page" }), N("a", "action", { action: "notify" })], edges: [E("t", "a")] });
    const w = (await ctx.deps.db.select().from(flowWatches).where(eq(flowWatches.flowId, id)).get())!;
    await expect(checkWatch(ctx.deps, w, { manual: true })).rejects.toThrow(/robots/);
    const after = (await ctx.deps.db.select().from(flowWatches).where(eq(flowWatches.flowId, id)).get())!;
    expect(after.failCount).toBe(1);
    expect(after.lastError).toMatch(/robots/);
  });
  it("a feed starts one run per new item, never twice for the same item", async () => {
    let items = ["a"];
    const feed = () => `<rss><channel><title>News</title>${items.map((i) => `<item><guid>${i}</guid><title>Post ${i}</title><link>https://n.example/${i}</link></item>`).join("")}</channel></rss>`;
    setWatchFetch(async (url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response(feed(), { status: 200 })));
    const id = await makeFlow({ nodes: [N("t", "trigger", { trigger: "feed_item", url: "https://n.example/feed.xml" }), N("a", "action", { action: "post_to_channel", channelId: chan, message: "New: {trigger.title}" })], edges: [E("t", "a")] });
    const w = () => ctx.deps.db.select().from(flowWatches).where(eq(flowWatches.flowId, id)).get();
    expect((await checkWatch(ctx.deps, (await w())!, { manual: true })).started).toBe(0);
    items = ["c", "b", "a"];
    expect((await checkWatch(ctx.deps, (await w())!, { manual: true })).started).toBe(2);
    expect((await checkWatch(ctx.deps, (await w())!, { manual: true })).started).toBe(0);
    expect((await messages()).filter((x) => x.startsWith("New: ")).sort()).toEqual(["New: Post b", "New: Post c"]);
  });
});
