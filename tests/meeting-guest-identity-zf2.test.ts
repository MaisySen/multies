/**
 * Final review F2: a guest let in through the waiting room joined the room as guest-<request id>. Everyone in the call
 * sees room identities, and the request id is the secret a guest joins with, so a removed guest could read another
 * guest's identity, join on their admission and push them out of the call (same identity). A second tab of the same
 * guest also pushed the first one out. Now each join gets its own identity, made from a separate random room key on
 * the request plus a random suffix; the request id never reaches the room; Remove disconnects every identity of that
 * guest and nobody else.
 */
import { it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { meetings } from "@/server/db/schema";
import { clearCallCache, type CallParticipant } from "@/server/services/suite/calls";
import { clearLobbyLimits } from "@/server/services/suite/meeting-lobby-r32";

const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) };
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let host: Client;
let removed: string[];
let inRoom: CallParticipant[];

beforeEach(async () => {
  ctx = await makeTestApp(LK);
  clearLobbyLimits(); clearCallCache();
  removed = []; inRoom = [];
  ctx.deps.callRooms = {
    list: async () => inRoom.slice(),
    remove: async (_r, id) => { removed.push(id); inRoom = inRoom.filter((p) => p.identity !== id); },
  };
  host = new Client(ctx.app);
  await host.signup("owner@acme.io", "Olive Owner");
});

async function setup() {
  const m = (await host.post("/api/meetings", { title: "Sync" })).body.meeting;
  const token = m.guestUrl.split("/m/")[1] as string;
  const ask = async (name: string) => {
    const g = new Client(ctx.app);
    const lobbyId = (await g.post(`/api/public/meeting-lobby/${token}`, { name })).body.lobbyId as string;
    await host.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId, decision: "admit" });
    const join = async () => {
      const r = await g.post(`/api/public/meetings/${token}/join`, { name, lobbyId });
      if (r.status === 200) inRoom.push({ identity: claims(r.body.token).sub, name, joinedAt: Date.now() });
      return r;
    };
    return { g, lobbyId, join };
  };
  return { m, token, ask };
}

it("the room identity never contains the request id, and another guest's identity doesn't let anyone in", async () => {
  const { token, ask } = await setup();
  const alice = await ask("Alice");
  const mallory = await ask("Mallory");
  const ja = await alice.join();
  expect(ja.status).toBe(200);
  const aliceIdentity = claims(ja.body.token).sub as string;
  expect(aliceIdentity).toMatch(/^guest-/);
  expect(aliceIdentity).not.toContain(alice.lobbyId);
  expect(aliceIdentity).not.toContain(alice.lobbyId.replace(/^lby_/, ""));
  expect(JSON.stringify(claims(ja.body.token))).not.toContain(alice.lobbyId);
  // Mallory tries what she can see in the room as a request id.
  for (const guess of [aliceIdentity, aliceIdentity.replace(/^guest-/, ""), `lby_${aliceIdentity.replace(/^guest-/, "")}`]) {
    expect((await mallory.g.post(`/api/public/meetings/${token}/join`, { name: "Mallory", lobbyId: guess })).status).toBe(403);
  }
});

it("a second tab of the same guest gets its own identity, so it doesn't push the first one out", async () => {
  const { ask } = await setup();
  const alice = await ask("Alice");
  const one = claims((await alice.join()).body.token).sub;
  const two = claims((await alice.join()).body.token).sub;
  expect(one).not.toBe(two);
});

it("Remove disconnects every identity of that guest, and nobody else", async () => {
  const { m, token, ask } = await setup();
  const alice = await ask("Alice");
  const mallory = await ask("Mallory");
  const a1 = claims((await alice.join()).body.token).sub;
  const m1 = claims((await mallory.join()).body.token).sub;
  const m2 = claims((await mallory.join()).body.token).sub;
  const room = (await ctx.db.select({ room: meetings.room }).from(meetings).where(eq(meetings.id, m.id)).get())!.room;
  expect(room).toBeTruthy();
  expect((await host.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId: mallory.lobbyId, decision: "remove" })).body.decided).toBe(1);
  expect(removed).toEqual(expect.arrayContaining([m1, m2]));
  expect(removed).not.toContain(a1);
  expect(inRoom.map((p) => p.identity)).toEqual([a1]);
  expect((await mallory.g.post(`/api/public/meetings/${token}/join`, { name: "Mallory", lobbyId: mallory.lobbyId })).status).toBe(403);
});

it("a request made before the room key existed gets one on its first join, and Remove still finds it", async () => {
  const { meetingLobby } = await import("@/server/db/schema");
  const { m, ask } = await setup();
  const alice = await ask("Alice");
  await ctx.db.update(meetingLobby).set({ roomKey: null }).where(eq(meetingLobby.id, alice.lobbyId));
  const one = claims((await alice.join()).body.token).sub as string;
  const two = claims((await alice.join()).body.token).sub as string;
  expect(one).not.toContain(alice.lobbyId);
  expect(one.slice(0, one.lastIndexOf("-"))).toBe(two.slice(0, two.lastIndexOf("-")));
  expect(one).not.toBe(two);
  // A guest still in the call under the identity used before this change is disconnected too.
  inRoom.push({ identity: `guest-${alice.lobbyId}`, name: "Alice", joinedAt: Date.now() });
  await host.post(`/api/meeting-lobby/${m.id}/decide`, { lobbyId: alice.lobbyId, decision: "remove" });
  expect(inRoom).toEqual([]);
});
