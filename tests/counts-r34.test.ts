import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { localDay, zoneOr } from "@/server/services/counts-r34";

/** R34: unread counts for badges (GET /api/counts, GET /api/v1/counts, MCP get_counts). */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
const T0 = new Date("2026-10-26T00:00:00.000Z").getTime(); // 10 am in Brisbane

beforeEach(async () => {
  ctx = await makeTestApp();
  clock = T0;
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

async function req(path: string, headers: Record<string, string> = {}) {
  return ctx.app.request(path, { headers: { host: "localhost", ...headers } });
}
const raw = (q: string) => (ctx.db as unknown as { $client: { prepare: (q: string) => { run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } } }).$client.prepare(q);

describe("localDay", () => {
  it("finds the person's day in their zone", () => {
    const d = localDay(new Date("2026-10-26T00:00:00Z"), "Australia/Brisbane");
    expect(d.start.toISOString()).toBe("2026-10-25T14:00:00.000Z");
    expect(d.end.toISOString()).toBe("2026-10-26T14:00:00.000Z");
    expect(localDay(new Date("2026-10-26T12:30:00Z"), "UTC").end.toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(zoneOr("Not/AZone")).toBe("Australia/Brisbane");
  });
});

describe("GET /api/counts", () => {
  it("answers every count, with cache headers and a 304 on an unchanged poll", async () => {
    const p = (await c.post("/api/projects", { name: "Ops" })).body.project;
    const me = (await c.get("/api/account/me")).body.user.id as string;
    const today = new Date(T0 + 3 * 3600_000).toISOString(); // 1 pm Brisbane, later today
    const late = new Date(T0 - 2 * 86400_000).toISOString();
    await c.post("/api/tasks", { title: "Due today", projectId: p.id, assigneeId: `member:${me}`, due: today });
    await c.post("/api/tasks", { title: "Overdue", projectId: p.id, assigneeId: `member:${me}`, due: late });
    await c.post("/api/tasks", { title: "Not mine", projectId: p.id, due: today });
    const r = await c.get("/api/counts");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["at", "chat", "mail", "notifications", "tasks", "triage"]);
    expect(r.body.tasks).toEqual({ dueToday: 1, overdue: 1 });
    expect(r.body.mail).toEqual({ inbox: 0, important: 0, other: 0 });
    expect(r.body.chat).toEqual({ unread: 0, mentions: 0 });
    expect(typeof r.body.notifications.unread).toBe("number");
    expect(r.body.triage).toBe(0);

    const first = await req("/api/counts", { cookie: c.cookie });
    expect(first.headers.get("cache-control")).toBe("private, max-age=15, must-revalidate");
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"c-[0-9a-f]{16}"$/);
    const again = await req("/api/counts", { cookie: c.cookie, "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("makes no writes", async () => {
    await c.get("/api/counts");
    const before = JSON.stringify(raw("select name, (select count(*) from sqlite_master) n from sqlite_master where type='table'").all());
    const changes = () => Number((raw("select total_changes() n").all()[0] as { n: number }).n);
    const n0 = changes();
    await c.get("/api/counts");
    await c.get("/api/counts?tz=UTC");
    expect(changes()).toBe(n0);
    expect(JSON.stringify(raw("select name, (select count(*) from sqlite_master) n from sqlite_master where type='table'").all())).toBe(before);
  });

  it("counts chat unread and mentions, and the 304 breaks when a count moves", async () => {
    const invite = await c.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
    const m = new Client(ctx.app);
    await m.signup("mate@acme.io", "Sam Mate", "");
    expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    await c.get("/api/chat/channels"); // joins general
    const general = ((await m.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const one = await req("/api/counts", { cookie: c.cookie });
    const etag = one.headers.get("etag")!;
    await m.post(`/api/chat/channels/${general.id}/messages`, { body: "hello all" });
    const two = await req("/api/counts", { cookie: c.cookie, "if-none-match": etag });
    expect(two.status).toBe(200);
    const body = await two.json() as { chat: { unread: number } };
    expect(body.chat.unread).toBe(1);
  });

  it("needs a session", async () => {
    expect((await req("/api/counts")).status).toBe(401);
  });

  it("uses indexes for the task counts", () => {
    const plan = raw("explain query plan select count(*) from tasks where org_id = ? and assignee_type = 'member' and assignee_id = ? and deleted_at is null and status <> 'done' and triage_state is null and due_at < ?").all("o", "u", 1) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING (COVERING )?INDEX/);
    const notes = raw("explain query plan select count(*) from notifications where org_id = ? and user_id = ? and read_at is null and done_at is null").all("o", "u") as { detail: string }[];
    expect(notes.map((p) => p.detail).join(" ")).toMatch(/notifications_user_idx/);
  });
});

describe("v1 and MCP", () => {
  it("serves the same shape on /api/v1/counts and get_counts", async () => {
    const key = (await c.post("/api/developer/keys", { name: "badge" })).body.secret as string;
    const res = await req("/api/v1/counts?tz=UTC", { authorization: `Bearer ${key}` });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["at", "chat", "mail", "notifications", "tasks", "triage"]);
    const etag = res.headers.get("etag")!;
    expect((await req("/api/v1/counts?tz=UTC", { authorization: `Bearer ${key}`, "if-none-match": etag })).status).toBe(304);

    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const out = JSON.parse(((await mcp.callTool({ name: "get_counts", arguments: {} })) as { content: { text: string }[] }).content[0].text);
    expect(out.tasks).toEqual({ dueToday: 0, overdue: 0 });
    expect(out.mail).toEqual({ inbox: 0, important: 0, other: 0 });
  });
});
