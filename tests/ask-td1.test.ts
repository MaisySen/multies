import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { crmEntries } from "@/server/db/schema";
import { cosine, parseAbout, stemOf, widenWords } from "@/server/services/ask-td1";
import { askAi } from "@/server/services/tools/ai-meter";
import { coverageLine, whereOf } from "@/shared/ask-td1";

/** TD1 Ask v2: AI trust gate (off means no provider call), coverage, gone sources, ask about this, meaning search, log scrub. */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let orgId: string;
let prompts: string[];
let fetched: string[];
let logged: string[];
let seq = 0;
const nid = (p: string) => `${p}_${Date.now().toString(36)}_${seq++}`;
const SECRET_WORDS = "Zebrafinch quarterly margin";

async function teammate(email = "mate@acme.io", name = "Sam Mate", role: "member" | "admin" = "member") {
  const invite = await c.post("/api/team/invites", { email, role });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return m;
}
async function note(body: string) {
  const id = nid("crm");
  const now = new Date();
  await ctx.deps.db.insert(crmEntries).values({ id, orgId, entityType: "contact", entityId: "ct_x", kind: "note", body, occurredAt: now, private: false, authorName: "Olive Owner", createdByType: "member", createdAt: now, updatedAt: now } as never);
  return id;
}
type Msg = { id: string; answer: string; status: string; gone?: number; coverage?: { read: number; matched: number; meaning: string; about: boolean } | null; about?: { id: string } | null; sources: { type: string; id: string; cited: boolean }[] };
const ask = async (cl: Client, question: string, about?: string) => {
  const r = await cl.post("/api/ask", { question, about });
  return { status: r.status, body: r.body as { thread: { id: string }; message: Msg; code?: string; error?: { code?: string } } };
};
const turnOn = async () => expect((await c.put("/api/ai-trust", { enabled: true })).status).toBe(200);

async function setup(env: Record<string, string>) {
  ctx = await makeTestApp({ SEARCH_R98: "on", CRM_TIMELINE: "on", ASK_R110: "on", ...env });
  prompts = []; fetched = []; logged = [];
  ctx.deps.askAi = {
    async run(_m: string, input: unknown) {
      const user = ((input as { messages: { role: string; content: string }[] }).messages.find((x) => x.role === "user")?.content) ?? "";
      prompts.push(user);
      return { response: "Found it [1].", usage: { prompt_tokens: 300, completion_tokens: 20 } };
    },
  } as never;
  ctx.deps.ai = ctx.deps.askAi;
  const rec = (...a: unknown[]) => { logged.push(JSON.stringify(a)); };
  ctx.deps.log = { info: rec, warn: rec, error: rec, debug: rec, child: () => ctx.deps.log } as never;
  ctx.deps.reportError = rec as never;
  ctx.deps.fetch = (async (url: string, init?: { body?: string }) => {
    fetched.push(String(url));
    const input = (JSON.parse(String(init?.body ?? "{}")) as { input?: string[] }).input ?? [];
    // Fake embeddings: "money" texts point one way, everything else the other.
    const vec = (t: string) => (/invoice|bill|paid|money/i.test(t) ? [1, 0] : [0, 1]);
    return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vec(t) })) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as never;
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  orgId = (await c.get("/api/account/me")).body.organization.id;
}

describe("pure rules", () => {
  it("widens words by meaning and stems, never repeating the question's words", () => {
    expect(widenWords("unpaid bill from Heron")).toEqual(expect.arrayContaining(["invoice"]));
    expect(widenWords("bill")).not.toContain("bill");
    expect(widenWords("what is it")).toEqual([]);
    expect(stemOf("meetings")).toBe("meeting");
    expect(stemOf("bus")).toBe("bus");
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
  it("parses about refs strictly", () => {
    expect(parseAbout("tasks:abc_1")).toEqual({ kind: "tasks", id: "abc_1" });
    expect(parseAbout("mail:abc")).toBeNull();
    expect(parseAbout("tasks:../x")).toBeNull();
  });
  it("says plainly what an answer read and could not see", () => {
    const line = coverageLine({ matched: 9, read: 6, trimmed: 2, meaning: "widened", about: false });
    expect(line).toContain("Read 6 of 9 matches");
    expect(line).toContain("2 long items were cut");
    expect(line).toContain("Items you cannot open");
    expect(coverageLine(null)).toBe("");
    expect(whereOf("mistral").region).toContain("European Union");
    expect(whereOf("nope").name).toBe("Your own AI server");
  });
});

describe("flag off: today exactly", () => {
  beforeEach(() => setup({}));
  it("hides the new paths and keeps Ask on with no switch", async () => {
    await c.post("/api/tasks", { title: "Heron launch" });
    expect((await c.get("/api/ai-trust")).status).toBe(404);
    expect((await c.get("/api/ask/search?q=heron")).status).toBe(404);
    const r = await ask(c, "heron launch");
    expect(r.body.message.status).toBe("answered");
    expect(r.body.message.coverage).toBeUndefined();
    expect(r.body.message.gone).toBeUndefined();
  });
});

describe("TD1 on", () => {
  beforeEach(() => setup({ ASK_TD1: "on" }));

  it("AI is off until an admin turns it on, and off means no provider call at all", async () => {
    await c.post("/api/tasks", { title: "Heron launch" });
    const state = (await c.get("/api/ai-trust")).body;
    expect(state).toMatchObject({ controls: true, on: false, source: "default", canChange: true });
    const r = await ask(c, "heron launch");
    expect(r.status).toBe(409);
    expect((await c.get("/api/ask/state")).body).toMatchObject({ available: false, aiOff: true, canEnable: true });
    const tools = await askAi(ctx.deps, orgId, { task: "translate", texts: ["hello"], to: "fr" } as never);
    expect(tools.ok).toBe(false);
    expect(prompts).toHaveLength(0);
    expect(fetched).toHaveLength(0);
    await turnOn();
    expect((await ask(c, "heron launch")).body.message.status).toBe("answered");
    expect(prompts).toHaveLength(1);
  });

  it("only admins change it; members see that AI is on and which provider", async () => {
    const member = await teammate();
    expect((await member.put("/api/ai-trust", { enabled: true })).status).toBe(403);
    await turnOn();
    const seen = (await member.get("/api/ai-trust")).body;
    expect(seen).toMatchObject({ on: true, source: "admin", canChange: false });
    expect(seen.providers.map((p: { name: string }) => p.name)).toContain("Built in AI (Cloudflare Workers AI)");
    expect(seen.providers[0].region).toContain("outside Australia");
    expect((await c.put("/api/ai-trust", { enabled: false })).body.on).toBe(false);
    expect((await ask(member, "anything at all")).status).toBe(409);
  });

  it("a workspace that saved its own key counts as on and names that provider", async () => {
    expect((await c.put("/api/ai/key", { provider: "openai", apiKey: "fake-local-key-for-tests" })).status).toBe(200);
    const s = (await c.get("/api/ai-trust")).body;
    expect(s).toMatchObject({ on: true, source: "own_key" });
    expect(s.providers.map((p: { name: string }) => p.name)).toContain("OpenAI");
  });

  it("answers about one item first, and says what it read", async () => {
    await turnOn();
    const t = (await c.post("/api/tasks", { title: "Heron launch checklist", notes: "launch on Friday" })).body.task;
    await c.post("/api/tasks", { title: "Heron printing" });
    const r = await ask(c, "when does it launch", `tasks:${t.id}`);
    expect(r.status).toBe(200);
    expect(r.body.message.sources[0].id).toBe(t.id);
    expect(r.body.message.about?.id).toBe(t.id);
    expect(r.body.message.coverage).toMatchObject({ about: true });
    expect(prompts[0]).toContain("This is about source [1]");
  });

  it("never opens an item from another workspace or one the asker cannot open (404, no hint)", async () => {
    await turnOn();
    const t = (await c.post("/api/tasks", { title: "Heron secret plan" })).body.task;
    const other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve Other", "Other Co");
    await other.put("/api/ai-trust", { enabled: true });
    const r = await ask(other, "what is the plan", `tasks:${t.id}`);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain("Heron");
    expect((await ask(c, "what is the plan", "tasks:does_not_exist")).status).toBe(404);
    expect(prompts.join(" ")).not.toContain("Heron secret");
  });

  it("shows a cited source as gone, never named, once it is deleted or no longer open", async () => {
    await turnOn();
    const n = await note("Pelican contact prefers calls");
    const r = await ask(c, "pelican contact");
    expect(r.body.message.sources.map((s) => s.id)).toEqual([n]);
    await ctx.deps.db.run(sql`delete from crm_entries where id = ${n}`);
    const again = (await c.get(`/api/ask/threads/${r.body.thread.id}`)).body as { messages: Msg[] };
    expect(again.messages[0].status).toBe("restricted");
    expect(again.messages[0].gone).toBe(1);
    expect(again.messages[0].sources).toEqual([]);
    expect(JSON.stringify(again)).not.toContain("prefers calls");
  });

  it("meaning search finds close words for free, and ranks by meaning only on the workspace's own key", async () => {
    await c.post("/api/tasks", { title: "Invoice for Heron printing" });
    await c.post("/api/tasks", { title: "Bill the Egret project" });
    const free = (await c.get("/api/ask/search?q=unpaid%20bill")).body;
    expect(free.items.map((i: { title: string }) => i.title)).toContain("Invoice for Heron printing");
    expect(fetched).toHaveLength(0);
    await c.put("/api/ai/key", { provider: "openai", apiKey: "fake-local-key-for-tests" });
    const ranked = (await c.get("/api/ask/search?q=unpaid%20bill")).body;
    expect(ranked.mode).toBe("ranked");
    expect(fetched).toEqual(["https://api.openai.com/v1/embeddings"]);
    await c.put("/api/ai-trust", { enabled: false });
    fetched = [];
    expect((await c.get("/api/ask/search?q=unpaid%20bill")).body.mode).not.toBe("ranked");
    expect(fetched).toHaveLength(0);
  });

  it("keeps item text and questions out of logs and error reports", async () => {
    await turnOn();
    await c.post("/api/tasks", { title: SECRET_WORDS });
    await c.put("/api/ai/key", { provider: "openai", apiKey: "fake-local-key-for-tests" });
    ctx.deps.fetch = (async () => new Response("nope", { status: 500 })) as never;
    await ask(c, "zebrafinch margin");
    await c.get("/api/ask/search?q=zebrafinch");
    ctx.deps.askAi = { async run() { throw new Error("model down"); } } as never;
    await ask(c, "zebrafinch margin");
    const all = logged.join(" ").toLowerCase();
    expect(all).not.toContain("zebrafinch");
    expect(all).not.toContain("fake-local-key");
  });
});
