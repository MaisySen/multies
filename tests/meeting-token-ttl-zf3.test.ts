/**
 * Final review F3: room tokens lasted 6 hours, so a guest removed from the waiting room (Z8) or a member removed from
 * the workspace (Z9) could rejoin with a token they kept until it expired. Room tokens now last ROOM_TOKEN_TTL_S
 * (10 minutes). A token only matters when connecting: the video service sends people already in the call fresh tokens
 * for their reconnects (livekit-client 2.23 applies the signal's refreshToken; see the note on ROOM_TOKEN_TTL_S), so a
 * call longer than that does not drop, and anyone rejoining through us is checked again. Remove also takes the person's
 * publish and subscribe rights away before disconnecting them, so a token refreshed in between carries no rights.
 */
import { it, expect, beforeEach, vi } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { clearLobbyLimits } from "@/server/services/suite/meeting-lobby-r32";
import { clearWebinarLimits } from "@/server/services/suite/webinar-r114";
import { ROOM_TOKEN_TTL_S } from "@/server/services/suite/meetings";

const calls: string[] = [];
vi.mock("livekit-server-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("livekit-server-sdk")>();
  class FakeRooms {
    async listParticipants() { return []; }
    async updateParticipant(room: string, identity: string, opts: { permission?: Record<string, unknown> }) { calls.push(`update ${room} ${identity} ${JSON.stringify(opts.permission)}`); return {}; }
    async removeParticipant(room: string, identity: string) { calls.push(`remove ${room} ${identity}`); }
  }
  return { ...real, RoomServiceClient: FakeRooms };
});

const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40), WEBINAR_R114: "on" };
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()) as { exp: number; nbf: number; sub: string };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let host: Client;

beforeEach(async () => {
  ctx = await makeTestApp(LK);
  clearLobbyLimits(); clearWebinarLimits(); calls.length = 0;
  host = new Client(ctx.app);
  await host.signup("owner@acme.io", "Olive Owner");
});

const life = (jwt: string) => { const c = claims(jwt); return c.exp - c.nbf; };

it("the token is ten minutes", () => { expect(ROOM_TOKEN_TTL_S).toBe(600); });

it("a member's, an admitted guest's and a webinar attendee's room tokens last at most ten minutes", async () => {
  const m = (await host.post("/api/meetings", { title: "Sync" })).body.meeting;
  const member = await host.post(`/api/meetings/${m.id}/join`, {});
  expect(member.status).toBe(200);
  expect(life(member.body.token)).toBeLessThanOrEqual(600);
  expect(life(member.body.token)).toBeGreaterThan(60);

  const token = m.guestUrl.split("/m/")[1];
  const g = new Client(ctx.app);
  const lobbyId = (await g.post(`/api/public/meeting-lobby/${token}`, { name: "Grace" })).body.lobbyId as string;
  await host.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId, decision: "admit" });
  const guest = await g.post(`/api/public/meetings/${token}/join`, { name: "Grace", lobbyId });
  expect(guest.status).toBe(200);
  expect(life(guest.body.token)).toBeLessThanOrEqual(600);

  const w = await host.patch(`/api/webinars/${m.id}`, { enabled: true });
  const slug = (w.body.webinar.registrationUrl as string).split("/w/")[1];
  const reg = await new Client(ctx.app).post(`/api/public/webinars/r/${slug}/register`, { name: "Ann", email: "ann@example.com", openedAt: Date.now() - 10_000 });
  const att = (reg.body.joinUrl as string).split("/w/a/")[1];
  const j = await new Client(ctx.app).post(`/api/public/webinars/a/${att}/join`, {});
  expect(j.status).toBe(200);
  expect(life(j.body.token)).toBeLessThanOrEqual(600);
});

it("rejoining after Remove is checked again and refused", async () => {
  const m = (await host.post("/api/meetings", { title: "Sync" })).body.meeting;
  const token = m.guestUrl.split("/m/")[1];
  const g = new Client(ctx.app);
  const lobbyId = (await g.post(`/api/public/meeting-lobby/${token}`, { name: "Grace" })).body.lobbyId as string;
  await host.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId, decision: "admit" });
  expect((await g.post(`/api/public/meetings/${token}/join`, { name: "Grace", lobbyId })).status).toBe(200);
  await host.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId, decision: "remove" });
  expect((await g.post(`/api/public/meetings/${token}/join`, { name: "Grace", lobbyId })).status).toBe(403);
});

it("removing someone through the video service takes their rights away first, then disconnects them", async () => {
  const { livekitRooms } = await import("@/server/services/suite/calls");
  const rooms = livekitRooms({ url: "wss://example.livekit.cloud", apiKey: "k", apiSecret: "s".repeat(40) });
  await rooms.remove!("room-1", "member-u1");
  expect(calls).toEqual([
    `update room-1 member-u1 ${JSON.stringify({ canSubscribe: false, canPublish: false, canPublishData: false, canPublishSources: [] })}`,
    "remove room-1 member-u1",
  ]);
});
