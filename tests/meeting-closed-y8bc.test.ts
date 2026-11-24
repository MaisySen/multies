/**
 * Wave 3 review Y8 (b, c): closedReason fails closed on a recurrence it can't read (it used to answer open), and the
 * "so far" summary reads a meeting's state through closedReason, so a series between its meetings is ended there too.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { meetings } from "@/server/db/schema";
import { CALL_EMPTY_GRACE_MS, clearCallCache, type CallParticipant } from "@/server/services/suite/calls";
import { closedReason } from "@/server/services/suite/meeting-open-meet";

describe("Y8 (b): closedReason", () => {
  it("an unreadable recurrence after a call ended is closed, not open", () => {
    const m = { status: "scheduled", startsAt: new Date("2026-11-12T02:00:00Z"), recurrence: "FREQ=NONSENSE;;", recurrenceTz: "Not/AZone", endedAt: new Date("2026-11-12T02:40:00Z") };
    expect(closedReason(m, new Date("2026-11-19T02:00:00Z"))).toBe("ended");
    // Before any call ended it is open, as before.
    expect(closedReason({ ...m, endedAt: null }, new Date("2026-11-19T02:00:00Z"))).toBeNull();
  });
});

describe("Y8 (c): so far uses closedReason", () => {
  it("a weekly series whose call ended reads as ended until its next meeting", async () => {
    const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) };
    const ctx = await makeTestApp(LK);
    let clock = new Date("2026-11-12T01:00:00.000Z").getTime();
    ctx.deps.now = () => new Date(clock);
    const rooms = new Map<string, CallParticipant[]>();
    clearCallCache();
    ctx.deps.callRooms = { list: async (room) => rooms.get(room) ?? [] };
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    const startsAt = new Date(clock + 3600_000).toISOString();
    const m = (await c.post("/api/meetings", { title: "Weekly", startsAt, durationMin: 30, recurrence: { days: ["th"], timezone: "UTC" } })).body.meeting;
    const room = (await ctx.db.select({ room: meetings.room }).from(meetings).where(eq(meetings.id, m.id)).get())!.room;
    clock = Date.parse(startsAt) + 60_000;
    rooms.set(room, [{ identity: "member-o", name: "Olive Owner", joinedAt: null }]);
    await c.get(`/api/chat/calls/${m.id}`);
    rooms.set(room, []);
    clock += 11_000;
    await c.get(`/api/chat/calls/${m.id}`);
    clock += CALL_EMPTY_GRACE_MS;
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("ended");
    expect((await ctx.db.select().from(meetings).where(eq(meetings.id, m.id)).get())!.status).toBe("scheduled");
    // After this week's meeting time, with people still in the room (a stale page): so far says ended, lists nobody.
    clock = Date.parse(startsAt) + 31 * 60_000;
    rooms.set(room, [{ identity: "member-o", name: "Olive Owner", joinedAt: null }]);
    clearCallCache();
    const s = (await c.get(`/api/meeting-live/${m.id}/so-far`)).body;
    expect(s.state).toBe("ended");
    expect(s.participants).toEqual([]);
  });
});
