/**
 * Wave 3 review Y8 (f): joinMeeting looked the meeting up by id in the workspace only, so any member, or an agent key,
 * could join a private DM's call by its id and get a room token with roomAdmin. It now checks the call's chat the way
 * every other meeting read does (visibleMeeting): someone who can't open that DM or private channel gets 404.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) };

describe("Y8 (f): joining a DM's call needs access to the DM", () => {
  it("a member outside the DM gets 404; the two people in it join", async () => {
    const ctx = await makeTestApp(LK);
    const owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    const join = async (email: string, name: string) => {
      const inv = await owner.post("/api/team/invites", { email, role: "member" });
      const m = new Client(ctx.app);
      await m.signup(email, name, "");
      await m.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
      return { c: m, id: (await m.get("/api/account/me")).body.user.id as string };
    };
    const sam = await join("sam@acme.io", "Sam Mate");
    const eve = await join("eve@acme.io", "Eve Other");
    const dm = (await owner.post("/api/chat/dms", { userIds: [sam.id] })).body.channel;
    const call = (await owner.post(`/api/chat/channels/${dm.id}/call`, {})).body;
    const id = call.meeting.id as string;
    expect((await owner.post(`/api/meetings/${id}/join`)).status).toBe(200);
    expect((await sam.c.post(`/api/meetings/${id}/join`)).status).toBe(200);
    const no = await eve.c.post(`/api/meetings/${id}/join`);
    expect(no.status).toBe(404);
    expect(no.body.token).toBeUndefined();
  });
});
