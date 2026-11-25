/**
 * Final review F1: webinar mode found its meeting by workspace and id only, so an owner or admin outside a DM could
 * turn webinar mode on for the DM's call, register on the public page and get a room token for the DM's room, and
 * share its transcript as the replay. Webinar settings now follow the Z1 visibility rule (a plain 404), and webinar
 * mode is refused (409) on any call that came from a chat, even for the people in it.
 */
import { it, expect, beforeAll } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { clearWebinarLimits } from "../src/server/services/suite/webinar-r114";

const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40), WEBINAR_R114: "on" };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client, sam: Client;
let callId = "", channelCallId = "";

beforeAll(async () => {
  ctx = await makeTestApp(LK);
  clearWebinarLimits();
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
  const e = await join("eve@acme.io", "Eve Other");
  sam = s.c;
  // A DM between Sam and Eve; the owner (admin) is not in it.
  const dm = (await sam.post("/api/chat/dms", { userIds: [e.id] })).body.channel;
  callId = (await sam.post(`/api/chat/channels/${dm.id}/call`, {})).body.meeting.id as string;
  const ch = (await owner.post("/api/chat/channels", { name: "town-hall" })).body.channel;
  channelCallId = (await owner.post(`/api/chat/channels/${ch.id}/call`, {})).body.meeting.id as string;
});

it("an admin outside the DM gets a 404 for every webinar route on the DM's call", async () => {
  expect((await owner.get(`/api/webinars/${callId}`)).status).toBe(404);
  expect((await owner.patch(`/api/webinars/${callId}`, { enabled: true })).status).toBe(404);
  expect((await owner.get(`/api/webinars/${callId}/live`)).status).toBe(404);
  expect((await owner.get(`/api/webinars/${callId}/report`)).status).toBe(404);
  expect((await owner.put(`/api/webinars/${callId}/replay`, { recordingId: null, shared: false })).status).toBe(404);
});

it("the people in the DM can't turn webinar mode on for its call either (409)", async () => {
  const r = await sam.patch(`/api/webinars/${callId}`, { enabled: true });
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe("chat_call");
});

it("a call from a public channel can't become a webinar", async () => {
  const r = await owner.patch(`/api/webinars/${channelCallId}`, { enabled: true });
  expect(r.status).toBe(409);
});

it("a webinar row already on a chat's call is closed to the public", async () => {
  const { webinars, meetings } = await import("../src/server/db/schema");
  const { eq } = await import("drizzle-orm");
  const m = await ctx.deps.db.select({ orgId: meetings.orgId }).from(meetings).where(eq(meetings.id, callId)).get();
  const now = new Date();
  await ctx.deps.db.insert(webinars).values({ meetingId: callId, orgId: m!.orgId, enabled: true, registrationOpen: true, slug: "oldDmSlug123", chatMode: "everyone", panelists: "[]", description: "", createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: webinars.meetingId, set: { enabled: true, slug: "oldDmSlug123" } });
  const anon = new Client(ctx.app);
  expect((await anon.get(`/api/public/webinars/r/oldDmSlug123`)).status).toBe(404);
  const reg = await anon.post(`/api/public/webinars/r/oldDmSlug123/register`, { name: "Spy", email: "spy@evil.example", openedAt: Date.now() - 10_000 });
  expect(reg.status).toBe(404);
});

it("an ordinary meeting still becomes a webinar", async () => {
  const id = (await owner.post("/api/meetings", { title: "Launch" })).body.meeting.id as string;
  const r = await owner.patch(`/api/webinars/${id}`, { enabled: true });
  expect(r.status).toBe(200);
  expect(r.body.webinar.enabled).toBe(true);
});
