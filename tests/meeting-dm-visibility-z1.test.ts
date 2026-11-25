/**
 * Review Z1: a call from a DM or private channel is visible only to the people in that chat. Y8 (f) guarded only the
 * join; the list (app, v1, MCP), get, edit, delete, invite, .ics, notes and the waiting room found it by id in the
 * workspace, so another member or an API key could read its guest link, let themselves in and get a room token.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";

const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client, sam: Client, eve: Client;
let callId = "", token = "", publicId = "", key = "";

async function mcpFor(k: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${k}` } }, fetch: fetchViaApp }));
  return client;
}

beforeAll(async () => {
  ctx = await makeTestApp(LK);
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  const join = async (email: string, name: string) => {
    const inv = await owner.post("/api/team/invites", { email, role: "member" });
    const m = new Client(ctx.app);
    await m.signup(email, name, "");
    await m.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
    return { c: m, id: (await m.get("/api/account/me")).body.user.id as string };
  };
  const s = await join("sam@acme.io", "Sam Mate");
  sam = s.c;
  eve = (await join("eve@acme.io", "Eve Other")).c;
  const dm = (await owner.post("/api/chat/dms", { userIds: [s.id] })).body.channel;
  callId = (await owner.post(`/api/chat/channels/${dm.id}/call`, {})).body.meeting.id as string;
  publicId = (await owner.post("/api/meetings", { title: "Team sync" })).body.meeting.id as string;
  const got = await owner.get(`/api/meetings/${callId}`);
  expect(got.status).toBe(200);
  token = (got.body.meeting.guestUrl as string).split("/m/")[1];
  key = (await owner.post("/api/developer/keys", { name: "k", scope: "full" })).body.secret as string;
});

describe("Z1: a DM's call is hidden from people outside the DM", () => {
  it("the people in the DM list and open it", async () => {
    for (const c of [owner, sam]) {
      expect(((await c.get("/api/meetings")).body.meetings as { id: string }[]).map((m) => m.id)).toContain(callId);
      expect((await c.get(`/api/meetings/${callId}`)).status).toBe(200);
    }
  });

  it("another member does not see it in the list, and get, edit, delete, invite, .ics and notes are 404", async () => {
    const list = (await eve.get("/api/meetings")).body.meetings as { id: string; guestUrl: string }[];
    expect(list.map((m) => m.id)).toContain(publicId);
    expect(list.map((m) => m.id)).not.toContain(callId);
    expect(JSON.stringify(list)).not.toContain(token);
    expect((await eve.get("/api/meetings?upcoming=1")).body.meetings.map((m: { id: string }) => m.id)).not.toContain(callId);
    expect((await eve.get(`/api/meetings/${callId}`)).status).toBe(404);
    expect((await eve.patch(`/api/meetings/${callId}`, { title: "Mine now" })).status).toBe(404);
    expect((await eve.post(`/api/meetings/${callId}/invite`, {})).status).toBe(404);
    expect((await eve.get(`/api/meetings/${callId}/ics`)).status).toBe(404);
    expect((await eve.get(`/api/meeting-notes/${callId}`)).status).toBe(404);
    expect((await eve.post(`/api/meeting-notes/${callId}`, {})).status).toBe(404);
    expect((await eve.del(`/api/meetings/${callId}`)).status).toBe(404);
    expect((await owner.get(`/api/meetings/${callId}`)).body.meeting.title).not.toBe("Mine now");
  });

  it("another member can't read or decide its waiting room, or turn the waiting room off", async () => {
    const guest = new Client(ctx.app);
    const ask = await guest.post(`/api/public/meeting-lobby/${token}`, { name: "Eve In Disguise" });
    expect(ask.status).toBe(200);
    const lobbyId = ask.body.lobbyId as string;
    expect((await eve.get(`/api/meeting-lobby/${callId}`)).status).toBe(404);
    expect((await eve.post(`/api/meeting-lobby/${callId}/decide`, { lobbyId, decision: "admit" })).status).toBe(404);
    expect((await eve.patch(`/api/meeting-lobby/${callId}/settings`, { guestsWait: false })).status).toBe(404);
    expect((await guest.get(`/api/public/meeting-lobby/${token}/${lobbyId}`)).body.status).toBe("pending");
    const join = await guest.post(`/api/public/meetings/${token}/join`, { name: "Eve In Disguise", lobbyId });
    expect(join.status).toBe(403);
    // Someone in the DM still runs it.
    expect((await owner.get(`/api/meeting-lobby/${callId}`)).body.waiting.map((w: { id: string }) => w.id)).toContain(lobbyId);
  });

  it("an API key (v1 and MCP) does not list or open it", async () => {
    const api = new Client(ctx.app);
    const h = { authorization: `Bearer ${key}` };
    const v1 = await api.call("GET", "/api/v1/meetings", undefined, h);
    expect(v1.status).toBe(200);
    expect(v1.body.meetings.map((m: { id: string }) => m.id)).toContain(publicId);
    expect(v1.body.meetings.map((m: { id: string }) => m.id)).not.toContain(callId);
    expect((await api.call("GET", `/api/v1/meetings/${callId}`, undefined, h)).status).toBe(404);
    const mcp = await mcpFor(key);
    const r = await mcp.callTool({ name: "list_meetings", arguments: {} });
    const listed = JSON.parse((r as { content: { text: string }[] }).content[0].text).meetings as { id: string; guestUrl: string }[];
    expect(listed.map((m) => m.id)).toContain(publicId);
    expect(listed.map((m) => m.id)).not.toContain(callId);
    await mcp.close();
  });
});
