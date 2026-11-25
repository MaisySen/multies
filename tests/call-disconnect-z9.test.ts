/**
 * Review Z9: a member removed from the workspace, or whose sessions were revoked, kept their place in a live call until
 * their room token ran out. Now both disconnect them from the workspace's calls that may be live, through the room
 * service.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { meetings } from "@/server/db/schema";
import { clearCallCache } from "@/server/services/suite/calls";

const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) };

async function world() {
  const ctx = await makeTestApp(LK);
  const removed: [string, string][] = [];
  clearCallCache();
  ctx.deps.callRooms = { list: async () => [], remove: async (room, identity) => { removed.push([room, identity]); } };
  const owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  const inv = await owner.post("/api/team/invites", { email: "sam@acme.io", role: "member" });
  const sam = new Client(ctx.app);
  await sam.signup("sam@acme.io", "Sam Mate", "");
  await sam.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
  const samId = (await sam.get("/api/account/me")).body.user.id as string;
  const m = (await owner.post("/api/meetings", { title: "Live now" })).body.meeting;
  expect((await sam.post(`/api/meetings/${m.id}/join`)).status).toBe(200);
  const room = (await ctx.db.select({ room: meetings.room }).from(meetings).where(eq(meetings.id, m.id)).get())!.room;
  return { ctx, owner, sam, samId, room, removed };
}

describe("Z9: leaving the workspace or revoking sessions ends live calls", () => {
  it("a removed member is disconnected from the workspace's live call", async () => {
    const w = await world();
    expect((await w.owner.del(`/api/team/members/${w.samId}`)).status).toBeLessThan(300);
    expect(w.removed).toContainEqual([w.room, `member-${w.samId}`]);
  });

  it("revoking every session disconnects the person from live calls", async () => {
    const w = await world();
    const r = await w.sam.post("/api/auth/revoke-sessions", {});
    expect(r.status).toBe(200);
    expect(w.removed).toContainEqual([w.room, `member-${w.samId}`]);
  });
});
