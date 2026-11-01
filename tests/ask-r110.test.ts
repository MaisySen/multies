import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { crmEntries } from "@/server/db/schema";
import {
  ASK_DAILY_QUESTIONS, ASK_GLOBAL_DAILY_UNITS, ASK_GLOBAL_ROW, askRow, buildPrompt, isAskExcluded, keywordsOf, parseAnswer, reserveAsk,
} from "@/server/services/ask-r110";
import { GLOBAL_DAILY_UNITS } from "@/server/services/tools/ai-meter";
import { dayOf } from "@/server/services/tools/usage";
import { answerParts, usageLine } from "@/web/pages/app/tools-ask/ask";
import { guestLinkParam } from "@/web/pages/app/work/guest";
import { searchErrorText } from "@/web/components/search-r98";

/** R110 Ask: permission filtered retrieval (member, admin, guest, key, revoked), caps, vv8k, cards, doc, history. */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let ownerId: string;
let orgId: string;
let prompts: string[];
let seq = 0;
const nid = (p: string) => `${p}_${Date.now().toString(36)}_${seq++}`;

async function note(body: string, opts: { private?: boolean; by?: string } = {}) {
  const id = nid("crm");
  const now = new Date();
  await ctx.deps.db.insert(crmEntries).values({ id, orgId, entityType: "contact", entityId: "ct_x", kind: "note", body, occurredAt: now, private: !!opts.private, authorName: "Olive Owner", createdByType: "member", createdById: opts.by ?? ownerId, createdAt: now, updatedAt: now } as never);
  return id;
}
async function teammate(email = "mate@acme.io", name = "Sam Mate", role: "member" | "admin" = "member") {
  const invite = await c.post("/api/team/invites", { email, role });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const me = (await m.get("/api/account/me")).body;
  return { client: m, id: me.user.id as string };
}
type Msg = { id: string; answer: string; status: string; sources: { type: string; id: string; title: string; url: string; cited: boolean }[]; cards: { id: string; kind: string; status: string; label: string }[] };
const ask = async (cl: Client, question: string, threadId?: string) => {
  const r = await cl.post("/api/ask", { question, threadId });
  return { status: r.status, body: r.body as { thread: { id: string }; message: Msg; usage: { used: number; cap: number; left: number; reached: boolean } } };
};

beforeEach(async () => {
  ctx = await makeTestApp({ SEARCH_R98: "on", CRM_TIMELINE: "on", ASK_R110: "on" });
  prompts = [];
  ctx.deps.askAi = {
    async run(_m: string, input: unknown) {
      const user = ((input as { messages: { role: string; content: string }[] }).messages.find((x) => x.role === "user")?.content) ?? "";
      prompts.push(user);
      const q = /Question: (.*)$/s.exec(user)?.[1]?.toLowerCase() ?? "";
      const lines = ["Found it [1]. Not a real source [9]."];
      if (q.includes("mark")) lines.push("ACTION task_status 1 done");
      if (q.includes("won")) lines.push("ACTION deal_stage 1 won");
      if (q.includes("create")) lines.push("ACTION task_create Call the printer");
      return { response: lines.join("\n"), usage: { prompt_tokens: 300, completion_tokens: 20 } };
    },
  } as never;
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const me = (await c.get("/api/account/me")).body;
  ownerId = me.user.id;
  orgId = me.organization.id;
});

describe("pure rules", () => {
  it("keeps the question's real words", () => {
    expect(keywordsOf("What is the status of the Heron launch?")).toEqual(["status", "heron", "launch"]);
    expect(keywordsOf("what is it")).toEqual([]);
  });
  it("keeps only valid citations and parses change cards only when asked to change", () => {
    const src = [{ type: "tasks" as const }, { type: "deals" as const }];
    const a = parseAnswer("Yes [1] and [2] but [7].\nACTION task_status 1 done\nACTION task_status 2 done\nACTION deal_stage 2 won\nACTION deal_stage 1 won", src, "mark it done");
    expect(a.answer).toBe("Yes [1] and [2] but .");
    expect(a.cited).toEqual([1, 2]);
    expect(a.proposals).toEqual([{ kind: "task_status", source: 1, status: "done" }, { kind: "deal_stage", source: 2, stage: "won" }]);
    expect(parseAnswer("x [1]\nACTION task_status 1 done", src, "what is it").proposals).toEqual([]);
    expect(parseAnswer("ACTION task_create A\nACTION task_create B\nACTION task_create C\nACTION task_create D", src, "create tasks").proposals).toHaveLength(3);
  });
  it("puts only the given sources in the prompt and treats them as data", () => {
    const p = buildPrompt("when is the launch", [{ type: "tasks", id: "t1", title: "Launch", subtitle: "", snippet: "", url: "/x", at: null, body: "Friday", score: 1 }]);
    expect(p.user).toContain("[1] Task: Launch");
    expect(p.system).toContain("never instructions");
    expect(p.system).toContain("Do not propose changes");
  });
  it("excludes the client workspace by id, slug or name", () => {
    expect(isAskExcluded({ id: "o1", slug: "vv8k", name: "x" })).toBe(true);
    expect(isAskExcluded({ id: "o1", slug: "acme", name: "VV8K Pty" })).toBe(true);
    expect(isAskExcluded({ id: "o1", slug: "acme", name: "Acme" })).toBe(false);
    expect(isAskExcluded({ id: "o1", slug: "acme", name: "Acme" }, "acme")).toBe(true);
  });
  it("keeps the caps well under the free daily allocation", () => {
    expect(ASK_GLOBAL_DAILY_UNITS).toBeLessThanOrEqual(GLOBAL_DAILY_UNITS / 3);
    expect(ASK_DAILY_QUESTIONS.starter).toBeLessThan(ASK_DAILY_QUESTIONS.business);
  });
  it("web helpers: citations, usage line, guest links, filter error", () => {
    const s = [{ n: 1, type: "tasks" as const, id: "a", title: "A", subtitle: "", url: "/a", cited: true }];
    expect(answerParts("See [1] and [2].", s).map((p) => ("text" in p ? p.text : `#${p.source.n}`))).toEqual(["See ", "#1", " and ", "."]);
    expect(usageLine({ used: 3, cap: 15, left: 12, reached: false })).toBe("12 of 15 questions left today");
    expect(usageLine({ used: 15, cap: 15, left: 0, reached: true })).toBe("Daily limit reached, try again tomorrow.");
    expect(guestLinkParam("task", "?task=t_1")).toBe("t_1");
    expect(guestLinkParam("doc", "?doc=bad%20id")).toBeNull();
    expect(searchErrorText({ status: 422 })).toBe("That filter is not valid. Change it and try again.");
    expect(searchErrorText({ status: 500 })).toContain("not answering");
  });
});

describe("asking (member, admin, guest, key, revoked access)", () => {
  it("answers from items the asker can open, with sources; nothing else reaches the prompt", async () => {
    const t = (await c.post("/api/tasks", { title: "Heron launch checklist", notes: "launch on Friday" })).body.task;
    const other = new Client(ctx.app);
    await other.signup("x@other.io", "Other Person");
    await other.post("/api/tasks", { title: "Heron launch secret", notes: "other workspace" });
    const r = await ask(c, "When is the Heron launch?");
    expect(r.status).toBe(200);
    expect(r.body.message.status).toBe("answered");
    expect(r.body.message.answer).toBe("Found it [1]. Not a real source .");
    expect(r.body.message.sources.map((s) => s.id)).toEqual([t.id]);
    expect(r.body.message.sources[0]).toMatchObject({ cited: true, url: expect.stringContaining(t.id) });
    expect(prompts.join("\n")).not.toContain("secret");
  });

  it("spends nothing when no item matches", async () => {
    const r = await ask(c, "anything about walruses");
    expect(r.body.message.status).toBe("no_sources");
    expect(prompts).toHaveLength(0);
    expect(r.body.usage.used).toBe(0);
  });

  it("never reads a private note for anyone but its author, admins included", async () => {
    const admin = await teammate("admin@acme.io", "Ada Admin", "admin");
    const member = await teammate();
    await note("Pelican pricing is too high", { private: true });
    for (const who of [admin.client, member.client]) {
      const r = await ask(who, "pelican pricing");
      expect(r.body.message.status).toBe("no_sources");
    }
    expect(prompts).toHaveLength(0);
    expect((await ask(c, "pelican pricing")).body.message.status).toBe("answered");
  });

  it("hides a saved answer once access to a cited item is removed", async () => {
    const member = await teammate();
    const n = await note("Pelican contact prefers calls");
    const r = await ask(member.client, "pelican contact");
    expect(r.body.message.sources.map((s) => s.id)).toEqual([n]);
    await ctx.deps.db.run(sql`update crm_entries set private = 1 where id = ${n}`);
    const again = (await member.client.get(`/api/ask/threads/${r.body.thread.id}`)).body as { messages: Msg[] };
    expect(again.messages[0].status).toBe("restricted");
    expect(again.messages[0].answer).not.toContain("Found it");
    expect(again.messages[0].sources).toEqual([]);
    expect((await member.client.post(`/api/ask/messages/${r.body.message.id}/doc`)).status).toBe(403);
  });

  it("is for people only: guests are signed out of it, keys are refused", async () => {
    const p = (await c.post("/api/projects", { name: "Harbour" })).body.project;
    const inv = await c.post("/api/guests", { projectId: p.id, email: "client@harbour.example", name: "Mia" });
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const token = sent.map((m) => m.text).reverse().find((x) => x.includes("/g/"))?.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1] ?? (inv.body.inviteUrl as string).split("/g/")[1];
    const guest = new Client(ctx.app);
    expect((await guest.post("/api/guest/accept", { token })).status).toBe(200);
    expect((await guest.get("/api/ask/state")).status).toBe(401);
    expect((await guest.post("/api/ask", { question: "harbour plans" })).status).toBe(401);
    const key = (await c.post("/api/developer/keys", { name: "Ops" })).body.secret;
    const res = await ctx.app.request("/api/ask/state", { headers: { authorization: `Bearer ${key}`, host: "localhost" } });
    expect([401, 403]).toContain(res.status);
  });

  it("guest search links open the guest view, not the member pages", async () => {
    const p = (await c.post("/api/projects", { name: "Harbour" })).body.project;
    const t = (await c.post("/api/tasks", { title: "Ibis homepage", projectId: p.id })).body.task;
    const d = (await c.post("/api/docs", { title: "Ibis brief", text: "ibis", projectId: p.id })).body.doc;
    const inv = await c.post("/api/guests", { projectId: p.id, email: "client@harbour.example", name: "Mia" });
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const token = sent.map((m) => m.text).reverse().find((x) => x.includes("/g/"))?.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1] ?? (inv.body.inviteUrl as string).split("/g/")[1];
    const guest = new Client(ctx.app);
    expect((await guest.post("/api/guest/accept", { token })).status).toBe(200);
    const r = (await guest.get("/api/guest/search?q=ibis")).body as { groups: { type: string; items: { id: string; url: string }[] }[] };
    const urls = r.groups.flatMap((g) => g.items.map((i) => i.url));
    expect(urls).toContain(`/guest?task=${t.id}`);
    expect(urls).toContain(`/guest?doc=${d.id}`);
    expect(urls.every((u) => u.startsWith("/guest"))).toBe(true);
  });
});

describe("caps, the client workspace and the flag", () => {
  it("stops at the workspace's daily questions with a calm limit, without calling the AI", async () => {
    await c.post("/api/tasks", { title: "Heron launch" });
    const day = dayOf(new Date());
    await ctx.deps.db.run(sql`insert into ai_usage_daily (day, org_id, units, calls) values (${day}, ${askRow(orgId)}, ${ASK_DAILY_QUESTIONS.starter}, 0)
      on conflict (day, org_id) do update set units = excluded.units`);
    const r = await ask(c, "heron launch");
    expect(r.status).toBe(200);
    expect(r.body.message.status).toBe("limit");
    expect(r.body.message.answer).toBe("Daily limit reached, try again tomorrow.");
    expect(r.body.usage.reached).toBe(true);
    expect(prompts).toHaveLength(0);
  });

  it("stops at the account wide Ask budget and gives back the workspace's question", async () => {
    const day = dayOf(new Date());
    await ctx.deps.db.run(sql`insert into ai_usage_daily (day, org_id, units, calls) values (${day}, ${ASK_GLOBAL_ROW}, ${ASK_GLOBAL_DAILY_UNITS - 5}, 0)`);
    expect(await reserveAsk(ctx.deps, orgId, "starter", 30, day)).toBe(false);
    const rows = await ctx.deps.db.all<{ org_id: string; units: number }>(sql`select org_id, units from ai_usage_daily where day = ${day}`);
    expect(rows.find((x) => x.org_id === askRow(orgId))?.units ?? 0).toBe(0);
    expect(rows.find((x) => x.org_id === orgId)).toBeUndefined();
    expect(await reserveAsk(ctx.deps, orgId, "starter", 5, day)).toBe(true);
  });

  it("counts each answer against the shared meter too", async () => {
    await c.post("/api/tasks", { title: "Heron launch" });
    await ask(c, "heron launch");
    const day = dayOf(new Date());
    const rows = await ctx.deps.db.all<{ org_id: string; units: number }>(sql`select org_id, units from ai_usage_daily where day = ${day}`);
    for (const row of [askRow(orgId), ASK_GLOBAL_ROW, orgId, "*"]) expect(rows.find((x) => x.org_id === row)?.units ?? 0).toBeGreaterThan(0);
  });

  it("keeps the vv8k workspace out: Ask off, nothing read", async () => {
    await c.post("/api/tasks", { title: "Heron launch" });
    await ctx.deps.db.run(sql`update organizations set slug = 'vv8k' where id = ${orgId}`);
    expect((await c.get("/api/ask/state")).body).toMatchObject({ available: false, reason: "Ask is not available in this workspace." });
    expect((await ask(c, "heron launch")).status).toBe(403);
    expect(prompts).toHaveLength(0);
  });

  it("is not found while the feature is off", async () => {
    const off = await makeTestApp({ SEARCH_R98: "on" });
    const o = new Client(off.app);
    await o.signup("o@off.io", "Off Owner");
    expect((await o.get("/api/ask/state")).status).toBe(404);
  });
});

describe("change cards, save to a doc, history and prompts", () => {
  it("changes nothing until Apply, applies once, and Dismiss changes nothing", async () => {
    const t = (await c.post("/api/tasks", { title: "Heron copy" })).body.task;
    const r = await ask(c, "mark heron copy done");
    const card = r.body.message.cards[0];
    expect(card).toMatchObject({ kind: "task_status", status: "pending", label: "Set task to Done" });
    expect((await c.get(`/api/tasks/${t.id}`)).body.task.status).not.toBe("done");
    const mate = await teammate();
    expect((await mate.client.post(`/api/ask/cards/${card.id}/apply`)).status).toBe(404);
    expect((await c.post(`/api/ask/cards/${card.id}/apply`)).body.card.status).toBe("applied");
    expect((await c.get(`/api/tasks/${t.id}`)).body.task.status).toBe("done");
    expect((await c.post(`/api/ask/cards/${card.id}/apply`)).status).toBe(409);

    const t2 = (await c.post("/api/tasks", { title: "Egret copy" })).body.task;
    const r2 = await ask(c, "mark egret copy done");
    expect((await c.post(`/api/ask/cards/${r2.body.message.cards[0].id}/dismiss`)).body.card.status).toBe("dismissed");
    expect((await c.get(`/api/tasks/${t2.id}`)).body.task.status).not.toBe("done");
  });

  it("creates a proposed task only on Apply, in the project picked", async () => {
    const p = (await c.post("/api/projects", { name: "Heron" })).body.project;
    await c.post("/api/tasks", { title: "Heron printing", projectId: p.id });
    const r = await ask(c, "create a task for heron printing");
    const card = r.body.message.cards.find((x) => x.kind === "task_create")!;
    expect((await c.get(`/api/tasks?project=${p.id}`)).body.tasks.some((x: { title: string }) => x.title === "Call the printer")).toBe(false);
    expect((await c.post(`/api/ask/cards/${card.id}/apply`, {})).status).toBe(422);
    expect((await c.post(`/api/ask/cards/${card.id}/apply`, { projectId: p.id })).status).toBe(200);
    expect((await c.get(`/api/tasks?project=${p.id}`)).body.tasks.some((x: { title: string }) => x.title === "Call the printer")).toBe(true);
  });

  it("saves an answer to a doc with its sources and the note", async () => {
    await c.post("/api/tasks", { title: "Heron launch" });
    const r = await ask(c, "heron launch");
    const saved = await c.post(`/api/ask/messages/${r.body.message.id}/doc`);
    expect(saved.status).toBe(200);
    const doc = (await c.get(`/api/docs/${saved.body.docId}`)).body.doc;
    expect(doc.title).toBe("Ask: heron launch");
    expect(JSON.stringify(doc)).toContain("AI answers can be wrong");
  });

  it("asks before saving an answer built from items others cannot open (verifier v13 BLOCKER, privacy)", async () => {
    const member = await teammate();
    await note("Pelican pricing is too high", { private: true });
    const r = await ask(c, "pelican pricing");
    expect(r.body.message.status).toBe("answered");
    const docsBefore = (await c.get("/api/docs")).body.docs.length;
    const refused = await c.post(`/api/ask/messages/${r.body.message.id}/doc`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code ?? refused.body.code).toBe("private_sources");
    expect(JSON.stringify(refused.body)).toContain("Everyone in the workspace can open a saved doc");
    expect((await c.get("/api/docs")).body.docs.length).toBe(docsBefore);
    // Nothing reached the member: no doc, and their own Ask finds nothing.
    expect((await member.client.get("/api/docs")).body.docs.some((d: { title: string }) => d.title.startsWith("Ask: pelican"))).toBe(false);
    // The asker can still choose to share, knowingly.
    const shared = await c.post(`/api/ask/messages/${r.body.message.id}/doc`, { share: true });
    expect(shared.status).toBe(200);
    expect((await member.client.get(`/api/docs/${shared.body.docId}`)).status).toBe(200);
  });

  it("saves at once when every member can open the sources", async () => {
    await teammate();
    await c.post("/api/tasks", { title: "Heron launch" });
    const r = await ask(c, "heron launch");
    expect((await c.post(`/api/ask/messages/${r.body.message.id}/doc`)).status).toBe(200);
  });

  it("keeps history private, follows up in a thread, and finds old questions", async () => {
    await c.post("/api/tasks", { title: "Heron launch" });
    const first = await ask(c, "heron launch");
    const second = await ask(c, "and when is it due", first.body.thread.id);
    expect(second.body.thread.id).toBe(first.body.thread.id);
    const th = (await c.get(`/api/ask/threads/${first.body.thread.id}`)).body as { messages: Msg[] };
    expect(th.messages).toHaveLength(2);
    expect((await c.get("/api/ask/threads?q=due")).body.threads).toHaveLength(1);
    expect((await c.get("/api/ask/threads?q=zebra")).body.threads).toHaveLength(0);
    const mate = await teammate();
    expect((await mate.client.get("/api/ask/threads")).body.threads).toEqual([]);
    expect((await mate.client.get(`/api/ask/threads/${first.body.thread.id}`)).status).toBe(404);
    expect((await mate.client.post("/api/ask", { question: "heron launch", threadId: first.body.thread.id })).status).toBe(404);
    expect((await c.del(`/api/ask/threads/${first.body.thread.id}`)).status).toBe(200);
    expect((await c.get("/api/ask/threads")).body.threads).toEqual([]);
  });

  it("keeps a prompt library: built in plus my own", async () => {
    const saved = (await c.post("/api/ask/prompts", { text: "What changed on Heron this week?" })).body;
    const list = (await c.get("/api/ask/prompts")).body;
    expect(list.builtIn.length).toBeGreaterThan(2);
    expect(list.mine.map((p: { id: string }) => p.id)).toEqual([saved.id]);
    const mate = await teammate();
    expect((await mate.client.get("/api/ask/prompts")).body.mine).toEqual([]);
    await c.del(`/api/ask/prompts/${saved.id}`);
    expect((await c.get("/api/ask/prompts")).body.mine).toEqual([]);
  });
});
