import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client, d1Violations } from "./helpers";
import { members, sessions, users } from "@/server/db/schema";
import { inIds, notInIds, INLINE_IN_MAX } from "@/server/lib/sql-chunks";

/**
 * Round 27: the last list reads that bound one SQL variable per id. A person (and an agent key) who can open 160
 * mailboxes, 170 open threads across them, 130 readable chat channels: the open-threads views, mail search and
 * search everything (web, REST API and MCP), My Work, the mail list and a bulk action on 150 messages all run under
 * D1's 100 variable limit (tests/helpers.ts). Every statement over the limit is named in the failure.
 */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
type Raw = { prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => Record<string, unknown> | undefined; all: (...a: unknown[]) => Record<string, unknown>[] }; transaction: (f: () => void) => () => void };
let ctx: Ctx;
let owner: Client;
let mia: Client;
let orgId: string;
let miaId: string;
let agentKey: string;
const BOXES = 160;
const THREADS = 170;

async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const v1 = (path: string) => ctx.app.request(`/api/v1${path}`, { headers: { host: "localhost", authorization: `Bearer ${agentKey}` } });

beforeAll(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@wide.test", "Olive Owner");
  orgId = (await owner.get("/api/account/me")).body.organization.id;
  mia = new Client(ctx.app);
  await mia.signup("mia@wide.test", "Mia Member", "");
  miaId = (await ctx.db.select().from(users).where(eq(users.email, "mia@wide.test")).get())!.id;
  await ctx.db.insert(members).values({ id: `mem_${miaId}`, organizationId: orgId, userId: miaId, role: "member" });
  await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, miaId));
  const channel = (await owner.post("/api/chat/channels", { name: "wide" })).body.channel;
  await owner.post(`/api/chat/channels/${channel.id}/messages`, { body: "template hello" });
  const db = (ctx.db as unknown as { $client: Raw }).$client;
  const now = Date.now();
  db.prepare("INSERT INTO domains (id, org_id, name, status, verification_token, dkim_selector, dkim_public_key, dkim_private_key_enc, created_at) VALUES ('dom_wide', @o, 'wide.test', 'verified', 'x', 'mm', 'x', 'x', @n)").run({ o: orgId, n: now });
  const made = await owner.post("/api/agents", { name: "Wide bot", localPart: "bot" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  agentKey = made.body.apiKey.secret;
  const agentId = made.body.agent.id;
  const cols = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => String(c.name));
  const clone = (table: string, where: string, arg: string, rows: Record<string, unknown>[]) => {
    const names = cols(table);
    const tpl = db.prepare(`SELECT * FROM ${table} WHERE ${where} = @a LIMIT 1`).get({ a: arg })!;
    const ins = db.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map((n) => "@" + n).join(",")})`);
    db.transaction(() => { for (const r of rows) ins.run({ ...tpl, ...r }); })();
  };
  const box = db.prepare("INSERT INTO mailboxes (id, org_id, domain_id, local_part, address, display_name, quota_mb, created_at) VALUES (@id, @o, 'dom_wide', @lp, @addr, @lp, 5000, @n)");
  const access = db.prepare("INSERT INTO mailbox_access (org_id, user_id, mailbox_id, created_at) VALUES (@o, @u, @m, @n)");
  const agentAccess = db.prepare("INSERT INTO agent_mailbox_access (agent_id, mailbox_id, org_id, created_at) VALUES (@a, @m, @o, @n)");
  const msg = db.prepare("INSERT INTO messages (id, org_id, mailbox_id, folder, message_id_header, thread_id, from_address, from_name, to_json, subject, text_body, snippet, size_bytes, is_read, date, created_at) VALUES (@id, @o, @m, 'inbox', @h, @t, 'a@x.test', 'Asha', '[\"team@wide.test\"]', @s, 'body', 'body', 900, 0, @d, @d)");
  const state = db.prepare("INSERT INTO mail_thread_state (org_id, thread_id, mailbox_id, status, assignee_user_id, assigned_at, updated_at) VALUES (@o, @t, @m, @st, @u, @d, @d)");
  db.transaction(() => {
    for (let i = 0; i < BOXES; i++) {
      box.run({ id: `mbx_w${i}`, o: orgId, lp: `box${i}`, addr: `box${i}@wide.test`, n: now });
      access.run({ o: orgId, u: miaId, m: `mbx_w${i}`, n: now });
      agentAccess.run({ a: agentId, m: `mbx_w${i}`, o: orgId, n: now });
    }
    for (let i = 0; i < THREADS; i++) {
      const m = `mbx_w${i % BOXES}`;
      msg.run({ id: `msg_w${i}`, o: orgId, m, h: `<w${i}@x.test>`, t: `thr_w${i}`, s: `Wide subject ${i}`, d: now - i * 1000 });
      if (i % 3 === 0) state.run({ o: orgId, t: `thr_w${i}`, m, st: i % 9 === 0 ? "done" : "open", u: miaId, d: now - i * 1000 });
    }
  })();
  clone("chat_channels", "id", channel.id, Array.from({ length: 130 }, (_, i) => ({ id: `chc_w${i}`, name: `wide-${i}`, created_at: now - i * 1000, updated_at: now - i * 1000 })));
  clone("chat_messages", "channel_id", channel.id, Array.from({ length: 130 }, (_, i) => ({ id: `chm_w${i}`, channel_id: `chc_w${i}`, body: `Wide hello ${i}`, created_at: now - i * 1000, updated_at: now - i * 1000 })));
}, 120_000);

describe("R27: reads over many mailboxes, threads and channels stay under D1's 100 variable limit", () => {
  it("open threads, mail search and search everything (web, REST API, MCP), My Work, mail lists, bulk", async () => {
    d1Violations.length = 0;
    const errors: string[] = [];
    const web = async (c: Client, who: string, p: string) => { const r = await c.get(`/api${p}`); if (r.status !== 200) errors.push(`${who} GET ${p}: ${r.status}`); return r.body; };

    // Open threads (shared inbox views), newest first, paged across the whole scope.
    const open = await web(mia, "mia", "/agents/threads?view=open&limit=100");
    expect.soft(open.data).toHaveLength(100);
    const page2 = await web(mia, "mia", `/agents/threads?view=open&limit=100&before=${open.nextCursor}`);
    const doneCount = Array.from({ length: THREADS }, (_, i) => i).filter((i) => i % 9 === 0).length;
    expect.soft((open.data?.length ?? 0) + (page2.data?.length ?? 0)).toBe(THREADS - doneCount);
    expect.soft(open.data?.[0]?.id).toBe("thr_w1");
    for (const view of ["mine", "unassigned", "assigned", "done", "all"]) await web(mia, "mia", `/agents/threads?view=${view}&limit=100`);
    const mine = await web(mia, "mia", "/my-work");
    expect.soft(JSON.stringify(mine)).toContain("thr_w3");
    // Mail search and search everything across 160 mailboxes and 130 channels.
    const s = await web(mia, "mia", "/search?q=Wide&limit=20");
    expect.soft(s.partial).toBeFalsy();
    expect.soft(JSON.stringify(s)).toContain("Wide subject 0");
    expect.soft(JSON.stringify(s)).toContain("Wide hello 0");
    await web(owner, "owner", "/search?q=Wide&limit=20");
    expect.soft((await web(owner, "owner", "/chat/channels")).channels?.length ?? 0).toBeGreaterThan(130);
    await web(mia, "mia", "/chat/channels");
    await web(mia, "mia", "/chat/unread");
    await web(mia, "mia", "/mail/overview");
    await web(mia, "mia", "/mail/messages?folder=inbox&limit=200");
    await web(mia, "mia", "/mail/messages?q=Wide&limit=200");
    await web(mia, "mia", "/threads/stats/replies");
    await web(mia, "mia", "/threads/thr_w1/state");
    for (const view of ["snoozed", "scheduled", "returned"]) await web(mia, "mia", `/mail-schedules?view=${view}`);
    await web(mia, "mia", "/deliveries");
    // A bulk action on 150 messages.
    const bulk = await mia.post("/api/mail/messages/bulk", { ids: Array.from({ length: 150 }, (_, i) => `msg_w${i}`), action: "read" });
    expect.soft(bulk.status).toBe(200);
    expect.soft(bulk.body.updated).toBe(150);

    // The same through an agent key that can read every mailbox: REST API and MCP.
    for (const p of ["/threads?view=open&limit=100", "/threads?view=unassigned&limit=100", "/search?q=Wide&limit=100", "/search/everything?q=Wide&limit=20", "/messages?limit=100", "/agents/threads?limit=100"]) {
      const r = await v1(p);
      if (r.status >= 500) errors.push(`v1 GET ${p}: ${r.status}`);
    }
    const mcp = await mcpFor(agentKey);
    for (const [name, args] of [["list_threads", { limit: 50 }], ["list_threads_by_view", { view: "open", limit: 50 }], ["search", { query: "Wide", limit: 50 }], ["search_everything", { q: "Wide", limit: 20 }]] as const) {
      const r = await mcp.callTool({ name, arguments: args as Record<string, unknown> });
      if (r.isError) errors.push(`mcp ${name}: ${JSON.stringify(r.content).slice(0, 200)}`);
    }
    await mcp.close();

    expect(d1Violations, `statements over 100 variables:\n${d1Violations.join("\n")}`).toEqual([]);
    expect(errors).toEqual([]);
  }, 180_000);
});

describe("inIds", () => {
  it("binds one variable past the inline size and matches nothing for an empty list", async () => {
    const { messages } = await import("@/server/db/schema");
    const dialect = (ctx.db as unknown as { dialect: { sqlToQuery: (s: unknown) => { sql: string; params: unknown[] } } }).dialect;
    const many = dialect.sqlToQuery(inIds(messages.id, Array.from({ length: 500 }, (_, i) => `m${i}`)));
    expect(many.params).toHaveLength(1);
    expect(many.sql).toContain("json_each");
    const few = dialect.sqlToQuery(inIds(messages.id, ["a", "b", "a"]));
    expect(few.params).toEqual(["a", "b"]);
    expect(dialect.sqlToQuery(inIds(messages.id, [])).sql).toBe("0");
    expect(notInIds(messages.id, [])).toBeUndefined();
    expect(dialect.sqlToQuery(notInIds(messages.id, Array.from({ length: INLINE_IN_MAX + 1 }, (_, i) => `x${i}`))!).params).toHaveLength(1);
  });
});

describe("no new unbounded IN list", () => {
  it("every inArray in the server is a literal list, a chunked list or marked; lists that grow use inIds", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
    const bad: string[] = [];
    for (const file of walk(join(__dirname, "../src/server"))) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (!/(?<![A-Za-z])inArray\(/.test(line) || /^import /.test(line.trim())) return;
        const literal = [...line.matchAll(/(?<![A-Za-z])inArray\([^,]+,\s*(.)/g)].every((m) => m[1] === "[");
        const chunked = /slice\(i|inChunks|chunk\(|chunkIds|slice\(0, 90\)|CHUNK\)|D1:/.test(line);
        if (!literal && !chunked) bad.push(`${file.split("/src/")[1]}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(bad, "use inIds (lib/sql-chunks) for an id list that can grow, or inChunks").toEqual([]);
  });
});
