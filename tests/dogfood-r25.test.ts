import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { chatMessages, messages, organizations } from "@/server/db/schema";
import { excerptOf } from "@/server/services/suite/docs";
import { numberProgress } from "@/server/services/suite/goals";
import { setDisplayTimeZone, zonedDateTime } from "@/web/lib/format";

/**
 * R25: the Haajir HQ dogfood findings (DF-2, 5, 6, 11, 13, 14, 16, 17) were fixed in round 13 and
 * after; these tests guard each one through the same steps the finding gives. MB-61's per mailbox
 * default Reply-To is new here.
 */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
let key: string;
let orgId: string;

async function api(k: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${k}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function verifiedDomain(c: Client, name: string) {
  const domainId = (await c.post("/api/domains", { name })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
  return domainId as string;
}

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@haajir.test", "Olive Owner");
  orgId = (await owner.get("/api/account/me")).body.organization.id;
  await ctx.db.update(organizations).set({ name: "Haajir HQ", timezone: "Australia/Sydney" }).where(eq(organizations.id, orgId));
  key = (await owner.post("/api/developer/keys", { name: "Org setup script" })).body.secret;
});

describe("DF-2: chat authors for API key posts", () => {
  it("an agent made with POST /agents posts under its name with the agent label; a workspace key posts as the workspace", async () => {
    await verifiedDomain(owner, "haajir.test");
    const made = await api(key, "POST", "/agents", { name: "Builder", localPart: "builder" });
    expect(made.status).toBe(201);
    const agentKey = (made.body.apiKey?.secret ?? made.body.key ?? made.body.secret) as string;
    expect(agentKey).toMatch(/^mm_live_/);
    const ch = (await api(key, "POST", "/chat/channels", { name: "eng" })).body.channel;
    const ws = (await api(key, "POST", `/chat/channels/${ch.id}/messages`, { body: "Welcome." })).body.message;
    expect(ws.author.name).toBe("Haajir HQ");
    const posted = await api(agentKey, "POST", `/chat/channels/${ch.id}/messages`, { body: "Build is green." });
    expect(posted.status).toBe(201);
    expect(posted.body.message.author).toMatchObject({ type: "agent", name: "Builder", agent: true });
    const list = (await owner.get(`/api/chat/channels/${ch.id}/messages`)).body.messages as { author: { name: string } }[];
    expect(list.map((m) => m.author.name)).not.toContain('API key "Org setup script"');
    expect(JSON.stringify(list)).not.toContain("API key");
  });

  it("migration 0053 renames posts stored with the old API key author", async () => {
    await verifiedDomain(owner, "haajir.test");
    const made = await api(key, "POST", "/agents", { name: "Builder", localPart: "builder" });
    const agentKey = (made.body.apiKey?.secret ?? made.body.key ?? made.body.secret) as string;
    const ch = (await api(key, "POST", "/chat/channels", { name: "eng" })).body.channel;
    const a = (await api(agentKey, "POST", `/chat/channels/${ch.id}/messages`, { body: "old agent post" })).body.message;
    const w = (await api(key, "POST", `/chat/channels/${ch.id}/messages`, { body: "old script post" })).body.message;
    // How rows written before ae526d7 read.
    await ctx.db.update(chatMessages).set({ authorName: 'API key "Builder agent key"' }).where(eq(chatMessages.id, a.id));
    await ctx.db.update(chatMessages).set({ authorName: 'API key "Org setup script"' }).where(eq(chatMessages.id, w.id));
    const file = readFileSync("drizzle/0053_r25_mailbox_reply_to.sql", "utf8");
    for (const stmt of file.split("--> statement-breakpoint").map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter((s) => s.startsWith("UPDATE"))) {
      await ctx.db.run(sql.raw(stmt));
    }
    const rows = await ctx.db.select({ id: chatMessages.id, name: chatMessages.authorName }).from(chatMessages).where(eq(chatMessages.channelId, ch.id));
    expect(rows.find((r) => r.id === a.id)?.name).toBe("Builder");
    expect(rows.find((r) => r.id === w.id)?.name).toBe("Haajir HQ");
  });
});

describe("DF-5: key results that count down", () => {
  it("start 10, target 0, current 10 is 0 percent and rises as the count falls", async () => {
    expect(numberProgress(10, 0, 10)).toBe(0);
    expect(numberProgress(10, 0, 4)).toBeCloseTo(0.6);
    const goal = (await api(key, "POST", "/goals", { name: "Quality", keyResults: [{ name: "Open high severity bugs", kind: "number", start: 10, target: 0, current: 10 }] })).body.goal;
    const kr = goal.keyResults[0];
    expect(kr).toMatchObject({ start: 10, target: 0, current: 10, progress: 0 });
    const moved = await api(key, "PATCH", `/key-results/${kr.id}`, { current: 5 });
    expect(moved.status).toBe(200);
    expect(moved.body.keyResult.progress).toBe(50);
    // Made with only a current value, a countdown starts from it.
    const g2 = (await api(key, "POST", "/goals", { name: "Support", keyResults: [{ name: "Open tickets", kind: "number", target: 0, current: 4 }] })).body.goal;
    expect(g2.keyResults[0]).toMatchObject({ start: 4, target: 0, progress: 0 });
  });

  it("the Goals page says down to for a countdown, never 10 of 0", () => {
    const src = readFileSync("src/web/pages/app/work/goals.tsx", "utf8");
    expect(src).toContain("down to");
    expect(src).toMatch(/k\.target < k\.start/);
  });
});

describe("DF-6: meetings repeat and name their zone", () => {
  it("POST /meetings takes a weekly recurrence", async () => {
    const r = await api(key, "POST", "/meetings", { title: "Weekly prep", startsAt: "2026-10-25T23:00:00.000Z", durationMin: 30, recurrence: { interval: 1, days: ["mo"], timezone: "Australia/Sydney" } });
    expect(r.status).toBe(201);
    expect(JSON.stringify(r.body.meeting.recurrence ?? r.body.meeting.rrule ?? "")).toMatch(/WEEKLY|mo/i);
  });

  it("a Monday 10:00 Sydney meeting reads 10:00 with the zone named, whatever the browser zone", () => {
    setDisplayTimeZone("Australia/Sydney");
    const label = zonedDateTime("2026-10-25T23:00:00.000Z");
    expect(label).toContain("Mon");
    expect(label).toContain("10:00");
    expect(label).toMatch(/AEDT|GMT\+11/);
    expect(readFileSync("src/web/pages/app/work/meetings.tsx", "utf8")).toContain("zonedDateTime");
  });
});

describe("DF-11, DF-13, DF-14, DF-16, DF-17", () => {
  it("DF-11: a project made with only a name has software statuses, no Waiting on reply", async () => {
    const r = await api(key, "POST", "/projects", { name: "Launch" });
    expect(r.status).toBe(201);
    const names = ((r.body.project ?? r.body).statuses as { name: string }[]).map((s) => s.name);
    expect(names).toEqual(["To do", "In progress", "In review", "Done"]);
  });

  it("DF-13: the docs list preview is the first body line, without the title, with block breaks", async () => {
    expect(excerptOf("Brand", "Brand\nPrimary colour #0071E3\nText #1D1D1F")).toBe("Primary colour #0071E3\nText #1D1D1F");
    const made = await api(key, "POST", "/docs", { title: "Brand", text: "# Brand\n- Primary colour #0071E3\n- Text #1D1D1F" });
    expect(made.status).toBe(201);
    const list = (await api(key, "GET", "/docs?limit=10")).body;
    const doc = (list.data ?? list.docs ?? []).find((d: { title: string }) => d.title === "Brand");
    expect(doc.excerpt.startsWith("Primary colour #0071E3")).toBe(true);
    expect(doc.excerpt).not.toMatch(/^Brand/);
    expect(doc.excerpt).toContain("\n");
  });

  it("DF-14: Settings Team shows members and agents beside seats before the single sign on card", () => {
    const src = readFileSync("src/web/pages/app/team.tsx", "utf8");
    expect(src).toContain('data-testid="agent-seats"');
    const page = src.slice(src.indexOf("export function"));
    expect(page.indexOf("<AgentsCard")).toBeGreaterThan(-1);
    expect(page.indexOf("<SsoEnforcement")).toBeGreaterThan(page.indexOf("<AgentsCard"));
  });

  it("DF-16: no copy calls an instance 'this Multies'", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${d}/${e.name}`] : []));
    const hits = walk("src").filter((f) => /this Multies\b/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
    expect(readFileSync("src/web/i18n/w2/en-meetings.ts", "utf8")).toContain("Video calls aren't switched on for this workspace yet"); // POL5: the words moved to the meetings English file
  });

  it("DF-17: the default support address is the Multies one", async () => {
    expect((await owner.get("/api/config")).body.supportEmail).toBe("support@multies.si");
    expect(readFileSync("src/server/config.ts", "utf8")).not.toContain("mymail.au");
  });
});

describe("MB-61: a default Reply-To per mailbox", () => {
  it("is set over REST, used when a send names none, beaten by a send's own replyTo, and cleared with null", async () => {
    const domainId = await verifiedDomain(owner, "haajir.test");
    const box = (await api(key, "POST", "/mailboxes", { domainId, localPart: "no-reply", displayName: "Haajir" })).body;
    expect(box.replyTo).toBeNull();
    const set = await api(key, "PATCH", `/mailboxes/${box.id}`, { replyTo: " Support@Haajir.test " });
    expect(set.status).toBe(200);
    expect(set.body.replyTo).toBe("support@haajir.test");
    expect((await api(key, "GET", "/mailboxes")).body.data[0].replyTo).toBe("support@haajir.test");

    const plain = await api(key, "POST", "/messages", { from: "no-reply@haajir.test", to: ["parent@example.com"], subject: "Absent", text: "Hi" });
    expect(plain.status).toBe(200);
    expect(ctx.outbound.sent.at(-1)!.replyTo).toBe("support@haajir.test");
    const row = await ctx.db.select({ replyTo: messages.replyTo }).from(messages).where(eq(messages.id, plain.body.messageId)).get();
    expect(row?.replyTo).toBe("support@haajir.test");

    await api(key, "POST", "/messages", { from: "no-reply@haajir.test", to: ["parent@example.com"], subject: "Own", text: "Hi", replyTo: "office@haajir.test" });
    expect(ctx.outbound.sent.at(-1)!.replyTo).toBe("office@haajir.test");

    expect((await api(key, "PATCH", `/mailboxes/${box.id}`, { replyTo: "not an address" })).status).toBe(422);
    expect((await api(key, "PATCH", `/mailboxes/${box.id}`, {})).status).toBe(422);
    expect((await api(key, "PATCH", `/mailboxes/${box.id}`, { replyTo: null })).body.replyTo).toBeNull();
    await api(key, "POST", "/messages", { from: "no-reply@haajir.test", to: ["parent@example.com"], subject: "After", text: "Hi" });
    expect(ctx.outbound.sent.at(-1)!.replyTo).toBeUndefined();
  });

  it("is set from Settings (the app route) and over MCP", async () => {
    const domainId = await verifiedDomain(owner, "haajir.test");
    const box = (await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox;
    const r = await owner.patch(`/api/mailboxes/${box.id}`, { replyTo: "team@haajir.test" });
    expect(r.status).toBe(200);
    expect((await owner.get("/api/mailboxes")).body.mailboxes.find((m: { id: string }) => m.id === box.id).replyTo).toBe("team@haajir.test");
    expect((await owner.patch(`/api/mailboxes/${box.id}`, { replyTo: "" })).status).toBe(200);
    expect((await owner.get("/api/mailboxes")).body.mailboxes.find((m: { id: string }) => m.id === box.id).replyTo).toBeNull();

    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      const text = await res.text();
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      const msg = JSON.parse(line ? line.slice(5) : text);
      return JSON.parse(msg.result.content[0].text);
    };
    expect(await call("set_mailbox_reply_to", { mailboxId: box.id, replyTo: "help@haajir.test" })).toMatchObject({ replyTo: "help@haajir.test" });
    const inboxes = await call("list_inboxes", {});
    expect(inboxes.mailboxes.find((m: { mailboxId: string }) => m.mailboxId === box.id).replyTo).toBe("help@haajir.test");
  });
});
