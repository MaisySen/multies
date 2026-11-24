/**
 * Wave 3 review Y8 (e): Ask (R110), Ask about this (TD1) and Team AI (TD8) retrieve as the person asking, and a person's
 * search shows Multies' own account mail (resets, sign in links, codes). That text went into the AI prompt. Retrieval
 * for AI now treats it as withheld, as for keys and agents: matched by subject and sender only, its text never sent.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { verifiedDomain } from "./priv1a-world";
import { mailboxes, messages } from "@/server/db/schema";
import { retrieveR98, retrieveRefsR98, searchR98 } from "@/server/services/search-r98";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let prompts: string[];
let orgId: string;
let actor: { orgId: string; userId: string; email: string; name: string; role: "owner" };

beforeEach(async () => {
  ctx = await makeTestApp({ SEARCH_R98: "on", ASK_R110: "on" });
  prompts = [];
  ctx.deps.askAi = {
    async run(_m: string, input: unknown) {
      prompts.push(((input as { messages: { role: string; content: string }[] }).messages.map((x) => x.content).join("\n")));
      return { response: "Found it [1].", usage: { prompt_tokens: 300, completion_tokens: 20 } };
    },
  } as never;
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const me = (await c.get("/api/account/me")).body;
  orgId = me.organization.id;
  actor = { orgId, userId: me.user.id, email: "owner@acme.io", name: "Olive Owner", role: "owner" };
  const domainId = await verifiedDomain(ctx, c, "acme.io");
  const mb = (await c.post("/api/mailboxes", { domainId, localPart: "olive", displayName: "Olive" })).body.mailbox.id as string;
  expect((await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mb)).get())).toBeTruthy();
  const base = { orgId, mailboxId: mb, folder: "inbox", fromName: "Multies", to: "[]", date: new Date(), isRead: false };
  await ctx.db.insert(messages).values({ ...base, id: "msg_y8eplatform0001", threadId: "thr_y8eplatform001", fromAddress: "accounts@notify.example", subject: "Quokka account help",
    text: "Your quokka reset words: purple elephant banana", snippet: "Your quokka reset words: purple elephant banana", authResults: '{"platform":"system"}' } as never);
  await ctx.db.insert(messages).values({ ...base, id: "msg_y8eordinary0001", threadId: "thr_y8eordinary001", fromAddress: "zoe@client.example", fromName: "Zoe", subject: "Quokka plans",
    text: "The quokka enclosure opens Friday", snippet: "The quokka enclosure opens Friday" } as never);
});

describe("Y8 (e): account mail never reaches AI prompts", () => {
  it("retrieval for AI leaves out the text of the platform's own mail", async () => {
    const got = await retrieveR98(ctx.deps, { kind: "actor", actor }, "quokka", { types: ["mail"] });
    const platform = got.find((x) => x.id === "msg_y8eplatform0001");
    expect(platform).toBeTruthy(); // still found by its subject
    expect(platform!.body).not.toMatch(/purple|elephant|banana/);
    expect(got.find((x) => x.id === "msg_y8eordinary0001")!.body).toMatch(/enclosure/);
    // Matching on its hidden text finds nothing.
    expect(await retrieveR98(ctx.deps, { kind: "actor", actor }, "elephant", { types: ["mail"] })).toEqual([]);
    const [about] = await retrieveRefsR98(ctx.deps, { kind: "actor", actor }, [{ type: "mail", id: "msg_y8eplatform0001" }]);
    expect(about.body).not.toMatch(/purple|elephant|banana/);
    // The person's own search still shows its preview.
    const s = await searchR98(ctx.deps, { kind: "actor", actor }, "elephant", { types: ["mail"] });
    expect(JSON.stringify(s)).toMatch(/elephant/);
  });

  it("an Ask question sends none of that text to the model", async () => {
    const r = await c.post("/api/ask", { question: "what about the quokka?" });
    expect(r.status).toBe(200);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.join("\n")).toMatch(/enclosure/);
    expect(prompts.join("\n")).not.toMatch(/purple|elephant|banana/);
  });

  it("a summary, triage or draft of the platform's own mail sends the model a placeholder, not its text", async () => {
    await c.put("/api/ai/key", { provider: "openai", apiKey: "sk-test-0123456789abcdefWXYZ" });
    const bodies: string[] = [];
    ctx.deps.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => { bodies.push(String(init?.body ?? "")); return Response.json({ choices: [{ message: { content: "{}" } }] }); }) as typeof fetch;
    for (const path of ["/api/ai/summary", "/api/ai/triage", "/api/ai/draft"]) expect((await c.post(path, { messageId: "msg_y8eplatform0001" })).status).toBe(200);
    expect(bodies).toHaveLength(3);
    for (const b of bodies) { expect(b).not.toMatch(/purple|elephant|banana/); expect(b).toContain("account mail from Multies"); }
    bodies.length = 0;
    await c.post("/api/ai/summary", { messageId: "msg_y8eordinary0001" });
    expect(bodies.join()).toMatch(/enclosure/);
  });
});
