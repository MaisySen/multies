/**
 * Wave 3 review Y4: the wait for an empty room to stay empty started from each Worker isolate's own memory, so an
 * isolate holding an old first empty read ended a live meeting on one momentary empty read (the live reads in between
 * were served by other isolates). The start is now the meeting's empty_since in D1, cleared by any read that sees
 * people. And an owner or admin can reopen an ended meeting.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { meetings, members, users } from "@/server/db/schema";
import { CALL_EMPTY_GRACE_MS, clearCallCache, type CallParticipant } from "@/server/services/suite/calls";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
const rooms = new Map<string, CallParticipant[]>();
const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) };
const at = (ms: number) => { clock = ms; };

beforeEach(async () => {
  ctx = await makeTestApp(LK);
  const base = new Date("2026-11-12T01:00:00.000Z").getTime();
  clock = base;
  ctx.deps.now = () => new Date(clock);
  rooms.clear(); clearCallCache();
  ctx.deps.callRooms = { list: async (room) => rooms.get(room) ?? [] };
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

const person = (name: string): CallParticipant => ({ identity: `member-${name}`, name, joinedAt: null });
const row = (id: string) => ctx.db.select().from(meetings).where(eq(meetings.id, id)).get();

describe("Y4: the empty room grace is shared, not per isolate", () => {
  it("a live read elsewhere clears the wait, so one later empty read doesn't end a live meeting", async () => {
    const m = (await c.post("/api/meetings", { title: "Design review" })).body.meeting;
    const room = (await row(m.id))!.room;
    const t0 = clock;
    rooms.set(room, [person("Olive Owner")]);
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("live");
    // This isolate reads the room empty once (a reload): the wait starts, in D1.
    rooms.set(room, []);
    at(t0 + 11_000);
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("waiting");
    expect((await row(m.id))!.emptySince?.getTime()).toBe(t0 + 11_000);
    // Another isolate serves the next reads, with people in the room: it clears the wait (as its read would).
    await ctx.db.update(meetings).set({ emptySince: null }).where(eq(meetings.id, m.id));
    // Ten minutes on, this isolate catches one momentary empty read: the wait starts again, the meeting stays open.
    at(t0 + 10 * 60_000);
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("waiting");
    expect((await row(m.id))!.status).toBe("scheduled");
    // Still empty past the grace from that start: now it ends.
    at(t0 + 10 * 60_000 + CALL_EMPTY_GRACE_MS + 11_000);
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("ended");
    const ended = (await row(m.id))!;
    expect(ended.status).toBe("ended");
    expect(ended.emptySince).toBeNull();
  });

  it("a read that sees people clears the stored start", async () => {
    const m = (await c.post("/api/meetings", { title: "Sync" })).body.meeting;
    const room = (await row(m.id))!.room;
    rooms.set(room, [person("Olive Owner")]);
    await c.get(`/api/chat/calls/${m.id}`);
    rooms.set(room, []);
    at(clock + 11_000);
    await c.get(`/api/chat/calls/${m.id}`);
    expect((await row(m.id))!.emptySince).not.toBeNull();
    rooms.set(room, [person("Olive Owner")]);
    at(clock + 11_000);
    expect((await c.get(`/api/chat/calls/${m.id}`)).body.state).toBe("live");
    expect((await row(m.id))!.emptySince).toBeNull();
  });
});

describe("Y4: reopening an ended meeting", () => {
  it("an owner or admin reopens it and the guest link works again; a member can't", async () => {
    const m = (await c.post("/api/meetings", { title: "Board" })).body.meeting;
    const token = m.guestUrl.split("/m/")[1] as string;
    expect((await c.patch(`/api/meetings/${m.id}`, { status: "ended" })).status).toBe(200);
    expect((await new Client(ctx.app).post(`/api/public/meetings/${token}/join`, { name: "Grace" })).status).toBe(409);

    const inv = await c.post("/api/team/invites", { email: "mia@acme.io", role: "member" });
    const mia = new Client(ctx.app);
    await mia.signup("mia@acme.io", "Mia", "");
    await mia.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
    const miaId = (await ctx.db.select().from(users).where(eq(users.email, "mia@acme.io")).get())!.id;
    expect((await ctx.db.select().from(members).where(eq(members.userId, miaId)).all()).some((x) => x.role === "member")).toBe(true);
    const no = await mia.patch(`/api/meetings/${m.id}`, { status: "scheduled" });
    expect(no.status).toBe(403);
    expect((await row(m.id))!.status).toBe("ended");

    const yes = await c.patch(`/api/meetings/${m.id}`, { status: "scheduled" });
    expect(yes.status).toBe(200);
    const r = (await row(m.id))!;
    expect(r.status).toBe("scheduled");
    expect(r.endedAt).toBeNull();
    // With the waiting room on, the guest asks again; the link itself is open.
    expect((await new Client(ctx.app).post(`/api/public/meeting-lobby/${token}`, { name: "Grace" })).status).toBe(200);
  });
});
