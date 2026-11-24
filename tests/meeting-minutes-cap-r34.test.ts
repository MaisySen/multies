import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { meetings, organizations, usageCounters } from "@/server/db/schema";
import { clearCallCache, type CallParticipant } from "@/server/services/suite/calls";
import { MEETING_MINUTES_METRIC } from "@/server/services/suite/meeting-minutes-r34";

/** R34 (MB-171): call minutes per free workspace, counted with one write at the call's end, warned in the call, capped on new calls. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
const rooms = new Map<string, CallParticipant[]>();
const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) };

beforeEach(async () => {
  ctx = await makeTestApp(LK);
  clock = new Date("2026-10-20T00:00:00.000Z").getTime();
  ctx.deps.now = () => new Date(clock);
  rooms.clear(); clearCallCache();
  ctx.deps.callRooms = { list: async (room) => rooms.get(room) ?? [] };
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

const general = async () => ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
const roomOf = async (id: string) => (await ctx.db.select({ room: meetings.room }).from(meetings).where(eq(meetings.id, id)).get())!.room;
const orgId = async () => (await ctx.db.select({ id: organizations.id }).from(organizations).get())!.id;
const counted = async () => (await ctx.db.select().from(usageCounters).where(and(eq(usageCounters.metric, MEETING_MINUTES_METRIC))).all());
const at = (min: number) => { clock = new Date("2026-10-20T00:00:00.000Z").getTime() + min * 60_000; };

describe("meeting minutes cap (R34, MB-171)", () => {
  it("counts participant-minutes with one upsert when the call ends, and shows the month on the meetings page", async () => {
    const g = await general();
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    expect((await c.post(`/api/meetings/${call.meeting.id}/join`)).status).toBe(200);
    const room = await roomOf(call.meeting.id);
    const t0 = clock;
    rooms.set(room, [{ identity: "member-a", name: "Olive", joinedAt: t0 }, { identity: "member-b", name: "Sam", joinedAt: t0 }]);
    at(1); expect((await c.get(`/api/chat/calls/${call.meeting.id}`)).body).toMatchObject({ state: "live", minutes: { cap: 1000, warn: null } });
    at(30); await c.get(`/api/chat/calls/${call.meeting.id}`);
    rooms.set(room, []);
    // MEET fixes: an empty room ends the call once it stayed empty for the grace (CALL_EMPTY_GRACE_MS, under a minute).
    at(31); expect((await c.get(`/api/chat/calls/${call.meeting.id}`)).body.state).toBe("waiting");
    at(32); expect((await c.get(`/api/chat/calls/${call.meeting.id}`)).body.state).toBe("ended");
    const rows = await counted();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ period: "2026-10", count: 60 });
    // Later reads of the ended call write nothing more.
    at(40); await c.get(`/api/chat/calls/${call.meeting.id}`);
    expect((await counted())[0].count).toBe(60);
    expect((await c.get("/api/chat/call-minutes")).body).toMatchObject({ used: 60, cap: 1000, remaining: 940, warn: null, resetsOn: "2026-11-01" });
    // The same over MCP with a read key.
    const key = (await c.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret as string;
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const r = await mcp.callTool({ name: "get_call_minutes", arguments: {} });
    expect(JSON.parse((r as { content: { text: string }[] }).content[0].text)).toMatchObject({ used: 60, cap: 1000, remaining: 940 });
  });

  it("warns in the call at 80% and in the last 5 minutes, then refuses a NEW call but never cuts off a running one", async () => {
    const id = await orgId();
    await ctx.db.insert(usageCounters).values({ orgId: id, period: "2026-10", metric: MEETING_MINUTES_METRIC, count: 790 });
    const g = await general();
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    expect((await c.post(`/api/meetings/${call.meeting.id}/join`)).status).toBe(200);
    const room = await roomOf(call.meeting.id);
    rooms.set(room, [{ identity: "member-a", name: "Olive", joinedAt: clock }]);
    at(11); expect((await c.get(`/api/chat/calls/${call.meeting.id}`)).body.minutes).toMatchObject({ warn: "eighty", used: 801 });
    await ctx.db.update(usageCounters).set({ count: 990 }).where(eq(usageCounters.orgId, id));
    at(12); clearCallCache(); rooms.set(room, [{ identity: "member-a", name: "Olive", joinedAt: clock - 6 * 60_000 }]);
    expect((await c.get(`/api/chat/calls/${call.meeting.id}`)).body.minutes).toMatchObject({ warn: "last_minutes", remaining: 4 });
    // Used up: someone joining the running call still gets in.
    await ctx.db.update(usageCounters).set({ count: 1000 }).where(eq(usageCounters.orgId, id));
    at(13); clearCallCache(); rooms.set(room, [{ identity: "member-a", name: "Olive", joinedAt: clock }]);
    expect((await c.post(`/api/meetings/${call.meeting.id}/join`)).status).toBe(200);
    // A new meeting (empty room) is refused with a plain message.
    const m2 = (await c.post("/api/meetings", { title: "Weekly sync", startsAt: new Date(clock + 3600_000).toISOString(), durationMin: 30 })).body;
    const r = await c.post(`/api/meetings/${(m2.meeting ?? m2).id}/join`);
    expect(r.status).toBe(429);
    expect(r.body.error).toMatchObject({ code: "meeting_minutes_used" });
    expect(r.body.error.message).toMatch(/used its 1,000 free call minutes for October/);
  });

  it("paid workspaces have no cap unless the operator sets one", async () => {
    const id = await orgId();
    await ctx.db.update(organizations).set({ plan: "pro" }).where(eq(organizations.id, id));
    expect((await c.get("/api/chat/call-minutes")).body).toMatchObject({ cap: null });
    await ctx.db.update(organizations).set({ meetingMinutesCap: 0 }).where(eq(organizations.id, id));
    const g = await general();
    const call = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body;
    expect((await c.post(`/api/meetings/${call.meeting.id}/join`)).status).toBe(429);
  });
});
