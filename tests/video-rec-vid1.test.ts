import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { loadConfig } from "@/server/config";
import { decodeSignal, encodeSignal } from "@/web/lib/call-recorder";
import {
  CANVAS_H, CANVAS_W, FileSink, HARD_BYTES, MAX_GRID, MemorySink, VideoRecording, WARN_BYTES, cleanFilePart, initials, layoutTiles, pickVideoType, sizeText, videoFileName,
  type Placement, type RecorderCtor, type Sink, type RecorderLike, type TileInput, type VideoEvent,
} from "@/web/lib/video-rec-vid1";

/** VID1: a whole call recorded as video in the admin's browser and saved on their device; nothing uploaded. */

const cams = (n: number, from = 0): TileInput[] => Array.from({ length: n }, (_, i) => ({ id: `p${i + from}:camera`, kind: "camera", name: `Person ${i + from}`, speaking: false, hasVideo: i % 2 === 0 }));
const screen = (who: string): TileInput => ({ id: `${who}:screen`, kind: "screen", name: who, speaking: false, hasVideo: true });

function noOverlapInside(out: Placement[]) {
  for (const p of out) {
    expect(p.rect.w).toBeGreaterThan(0);
    expect(p.rect.h).toBeGreaterThan(0);
    expect(p.rect.x).toBeGreaterThanOrEqual(0);
    expect(p.rect.y).toBeGreaterThanOrEqual(0);
    expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(CANVAS_W);
    expect(p.rect.y + p.rect.h).toBeLessThanOrEqual(CANVAS_H);
  }
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i].rect, b = out[j].rect;
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(overlap, `${out[i].id} overlaps ${out[j].id}`).toBe(false);
  }
}

describe("VID1 compositor layout", () => {
  it("nobody yet: no tiles (the canvas says it is waiting)", () => {
    expect(layoutTiles([])).toEqual([]);
  });
  it("one person fills the frame", () => {
    const out = layoutTiles(cams(1));
    expect(out).toHaveLength(1);
    expect(out[0].rect).toEqual({ x: 8, y: 8, w: CANVAS_W - 16, h: CANVAS_H - 16 });
  });
  it.each([2, 4, 9, 16])("%i people: a grid of equal 16:9 tiles, no overlap, inside the frame", (n) => {
    const out = layoutTiles(cams(n));
    expect(out).toHaveLength(n);
    noOverlapInside(out);
    const sizes = new Set(out.map((p) => `${p.rect.w}x${p.rect.h}`));
    expect(sizes.size).toBe(1);
    expect(Math.abs(out[0].rect.w / out[0].rect.h - 16 / 9)).toBeLessThan(0.02);
    expect(out.some((p) => p.kind === "more")).toBe(false);
  });
  it("2 people side by side, 4 in a 2x2, 9 in a 3x3, 16 in a 4x4", () => {
    const rows = (n: number) => new Set(layoutTiles(cams(n)).map((p) => p.rect.y)).size;
    const colsOf = (n: number) => new Set(layoutTiles(cams(n)).map((p) => p.rect.x)).size;
    expect([rows(2), colsOf(2)]).toEqual([1, 2]);
    expect([rows(4), colsOf(4)]).toEqual([2, 2]);
    expect([rows(9), colsOf(9)]).toEqual([3, 3]);
    expect([rows(16), colsOf(16)]).toEqual([4, 4]);
  });
  it("a short last row is centred", () => {
    const out = layoutTiles(cams(3));
    const last = out[2].rect;
    expect(Math.abs(last.x + last.w / 2 - CANVAS_W / 2)).toBeLessThanOrEqual(1);
  });
  it("more than 16 people: 15 tiles and a +N more tile", () => {
    const out = layoutTiles(cams(20));
    expect(out).toHaveLength(MAX_GRID);
    expect(out[15]).toMatchObject({ kind: "more", more: 5, name: "+5 more" });
    noOverlapInside(out);
  });
  it("a screen share gets the big tile and people go in a column beside it", () => {
    const tiles = [...cams(3), screen("p1")];
    const out = layoutTiles(tiles);
    expect(out[0]).toMatchObject({ id: "p1:screen", kind: "screen" });
    expect(out[0].rect.w).toBeGreaterThan(CANVAS_W * 0.7);
    expect(out.slice(1).map((p) => p.id)).toEqual(["p0:camera", "p1:camera", "p2:camera"]);
    for (const p of out.slice(1)) expect(p.rect.x).toBeGreaterThan(out[0].rect.x + out[0].rect.w);
    noOverlapInside(out);
  });
  it("a screen share alone fills the frame", () => {
    expect(layoutTiles([screen("p0")])[0].rect).toEqual({ x: 8, y: 8, w: CANVAS_W - 16, h: CANVAS_H - 16 });
  });
  it("two shares: the newest is big, the other joins the column", () => {
    const out = layoutTiles([...cams(2), screen("p0"), screen("p1")]);
    expect(out[0].id).toBe("p1:screen");
    expect(out.map((p) => p.id)).toContain("p0:screen");
    noOverlapInside(out);
  });
  it("a share with many people: 4 beside it and +N more", () => {
    const out = layoutTiles([...cams(8), screen("p3")]);
    expect(out).toHaveLength(6);
    expect(out[5]).toMatchObject({ kind: "more", more: 4 });
    noOverlapInside(out);
  });
  it("joins and leaves rebuild the layout in join order (no jumping when someone speaks)", () => {
    const four = cams(4);
    expect(layoutTiles(four).map((p) => p.id)).toEqual(four.map((t) => t.id));
    const spoke = four.map((t, i) => ({ ...t, speaking: i === 3 }));
    expect(layoutTiles(spoke).map((p) => p.id)).toEqual(four.map((t) => t.id));
    expect(layoutTiles(spoke)[3].speaking).toBe(true);
    const left = four.filter((t) => t.id !== "p1:camera");
    expect(layoutTiles(left).map((p) => p.id)).toEqual(["p0:camera", "p2:camera", "p3:camera"]);
    const joined = [...left, ...cams(1, 9)];
    expect(layoutTiles(joined)).toHaveLength(4);
    // A camera turning off keeps the tile (it shows initials instead).
    const off = four.map((t) => ({ ...t, hasVideo: false }));
    expect(layoutTiles(off).every((p) => !p.hasVideo)).toBe(true);
    expect(layoutTiles(off)).toHaveLength(4);
  });
  it("initials for camera off tiles", () => {
    expect(initials("Olive Owner")).toBe("OO");
    expect(initials("  sam  ")).toBe("S");
    expect(initials("Ana María de la Cruz")).toBe("AC");
    expect(initials("")).toBe("?");
  });
});

describe("VID1 recording type", () => {
  it("prefers webm vp9, then vp8, then mp4 where only that works (Safari), none when nothing does", () => {
    expect(pickVideoType(() => true)).toEqual({ mime: "video/webm;codecs=vp9,opus", ext: "webm" });
    expect(pickVideoType((t) => !t.includes("vp9"))).toEqual({ mime: "video/webm;codecs=vp8,opus", ext: "webm" });
    expect(pickVideoType((t) => t.startsWith("video/mp4"))).toEqual({ mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4" });
    expect(pickVideoType((t) => t === "video/mp4")).toEqual({ mime: "video/mp4", ext: "mp4" });
    expect(pickVideoType(() => false)).toBeNull();
    expect(pickVideoType(undefined)).toBeNull();
    expect(pickVideoType(() => { throw new Error("no"); })).toBeNull();
  });
});

describe("VID1 file name", () => {
  const d = new Date(2026, 10, 3, 9, 5);
  it("Meeting <title> <date>, sentence case kept, no dashes", () => {
    expect(videoFileName("Weekly sync", d, "webm")).toBe("Meeting Weekly sync 3 Nov 2026 09.05.webm");
    expect(videoFileName("Q4 plan - draft", d, "mp4")).toBe("Meeting Q4 plan draft 3 Nov 2026 09.05.mp4");
    expect(videoFileName("Launch \u2014 final", d, "webm")).toBe("Meeting Launch final 3 Nov 2026 09.05.webm");
  });
  it("removes characters file systems refuse, and path tricks", () => {
    const n = videoFileName('../../etc/pass:wd*?"<>|\u0000\nx', d, "webm");
    expect(n).toBe("Meeting etc pass wd x 3 Nov 2026 09.05.webm");
    expect(n).not.toMatch(/[\\/:*?"<>|]/);
    expect(cleanFilePart("...hidden.")).toBe("hidden");
  });
  it("an empty title or one that already says Meeting does not repeat it", () => {
    expect(videoFileName("", d, "webm")).toBe("Meeting 3 Nov 2026 09.05.webm");
    expect(videoFileName(null, d, "webm")).toBe("Meeting 3 Nov 2026 09.05.webm");
    expect(videoFileName("Meeting", d, "webm")).toBe("Meeting 3 Nov 2026 09.05.webm");
    expect(videoFileName("Meeting with Ana", d, "webm")).toBe("Meeting with Ana 3 Nov 2026 09.05.webm");
  });
  it("long titles are cut to keep the name under 130 characters", () => {
    const n = videoFileName("x".repeat(400), d, "webm");
    expect(n.length).toBeLessThanOrEqual(125);
    expect(n.endsWith(".webm")).toBe(true);
  });
});

describe("VID1 banner signal", () => {
  it("carries video only when on; older signals decode as before", () => {
    const s = { on: true, by: "Olive", recordingId: null, startedAt: "2026-11-03T00:00:00.000Z", video: true };
    expect(decodeSignal(encodeSignal(s))).toEqual(s);
    const old = { on: true, by: "Olive", recordingId: "rec_1", startedAt: "2026-11-03T00:00:00.000Z" };
    expect(decodeSignal(encodeSignal(old))).toEqual(old);
    expect(decodeSignal(new TextEncoder().encode(JSON.stringify({ v: 1, on: true, by: "x", video: "yes" })))).not.toHaveProperty("video");
  });
});

// ---------------------------------------------------------------- the recorder state machine

class FakeRecorder implements RecorderLike {
  static last: FakeRecorder | null = null;
  static failStart = false;
  state = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  timeslice = 0;
  private stops: (() => void)[] = [];
  constructor(_s: MediaStream, o: { mimeType?: string }) { this.mimeType = o.mimeType ?? ""; FakeRecorder.last = this; }
  start(t?: number) { if (FakeRecorder.failStart) throw new Error("NotSupportedError"); this.state = "recording"; this.timeslice = t ?? 0; }
  stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["end"]) }); for (const f of this.stops) f(); }
  addEventListener(_t: "stop", fn: () => void) { this.stops.push(fn); }
  emit(bytes: number) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); }
}
const Recorder = FakeRecorder as unknown as RecorderCtor;
const stream = {} as MediaStream;
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("VID1 recording state machine", () => {
  let events: VideoEvent[];
  beforeEach(() => { events = []; FakeRecorder.failStart = false; });
  const make = (sink: Sink = new MemorySink("video/webm"), o: { warnBytes?: number; hardBytes?: number } = {}) =>
    new VideoRecording({ stream, mime: "video/webm;codecs=vp9,opus", sink, Recorder, onEvent: (e) => events.push(e), ...o });

  it("start, chunks every second, stop: one video in memory", async () => {
    const r = make();
    r.start();
    expect(r.state).toBe("recording");
    expect(FakeRecorder.last!.timeslice).toBe(1000);
    expect(FakeRecorder.last!.mimeType).toBe("video/webm;codecs=vp9,opus");
    FakeRecorder.last!.emit(100);
    FakeRecorder.last!.emit(50);
    const saved = await r.stop();
    expect(saved.kind).toBe("memory");
    expect(saved.reason).toBe("stopped");
    expect(saved.blob!.size).toBe(153);
    expect(saved.blob!.type).toBe("video/webm");
    expect(r.state).toBe("saved");
    expect(events.filter((e) => e.type === "state").map((e) => (e as { state: string }).state)).toEqual(["recording", "stopping", "saved"]);
    expect(await r.stop()).toBe(saved);
  });
  it("cannot start twice", () => {
    const r = make();
    r.start();
    expect(() => r.start()).toThrow();
  });
  it("a recorder that refuses to start: failed, says why, nothing saved", async () => {
    FakeRecorder.failStart = true;
    const r = make();
    expect(() => r.start()).toThrow("NotSupportedError");
    expect(r.state).toBe("failed");
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect((await r.stop()).blob).toBeNull();
  });
  it("warns once near the memory limit, then stops and saves on its own at the hard limit", async () => {
    const r = make(new MemorySink("video/webm"), { warnBytes: 1000, hardBytes: 3000 });
    r.start();
    FakeRecorder.last!.emit(600); await tick();
    expect(events.some((e) => e.type === "warn")).toBe(false);
    FakeRecorder.last!.emit(600); await tick();
    FakeRecorder.last!.emit(600); await tick();
    expect(events.filter((e) => e.type === "warn")).toHaveLength(1);
    FakeRecorder.last!.emit(2000); await tick(); await tick();
    expect(events.some((e) => e.type === "limit")).toBe(true);
    expect(r.state).toBe("saved");
    const saved = await r.stop();
    expect(saved.reason).toBe("limit");
    expect(saved.blob!.size).toBeGreaterThanOrEqual(3800);
  });
  it("the real limits: warn at 1.5 GB, stop at 2 GB", () => {
    expect(WARN_BYTES).toBe(1.5 * 1024 ** 3);
    expect(HARD_BYTES).toBe(2 * 1024 ** 3);
    expect(sizeText(WARN_BYTES)).toBe("1.5 GB");
    expect(sizeText(HARD_BYTES)).toBe("2 GB");
    expect(sizeText(5 * 1024 ** 2)).toBe("5 MB");
  });
  it("a recorder error mid call stops and saves what was recorded", async () => {
    const r = make();
    r.start();
    FakeRecorder.last!.emit(80);
    FakeRecorder.last!.onerror!({ error: new Error("GPU lost") });
    await tick(); await tick();
    const saved = await r.stop();
    expect(saved.reason).toBe("error");
    expect(saved.error).toBe("GPU lost");
    expect(saved.blob!.size).toBe(83);
    expect(events.find((e) => e.type === "error")).toEqual({ type: "error", message: "GPU lost" });
  });
  it("file sink: writes each chunk in order and keeps nothing in memory; no warning however big", async () => {
    const written: number[] = [];
    let closed = false;
    const sink = new FileSink({ write: async (b) => { await tick(); written.push((b as Blob).size); }, close: async () => { closed = true; } });
    const r = make(sink, { warnBytes: 10, hardBytes: 20 });
    r.start();
    FakeRecorder.last!.emit(30);
    FakeRecorder.last!.emit(40);
    const saved = await r.stop();
    expect(written).toEqual([30, 40, 3]);
    expect(closed).toBe(true);
    expect(saved).toMatchObject({ kind: "file", blob: null, bytes: 73, reason: "stopped" });
    expect(events.some((e) => e.type === "warn" || e.type === "limit")).toBe(false);
  });
  it("file write failure: stops, closes the file with what was written, says why", async () => {
    let n = 0;
    let closed = false;
    const sink = new FileSink({ write: async () => { if (++n === 2) throw new Error("disk full"); }, close: async () => { closed = true; } });
    const r = make(sink);
    r.start();
    FakeRecorder.last!.emit(10);
    FakeRecorder.last!.emit(10);
    await tick(); await tick(); await tick();
    const saved = await r.stop();
    expect(saved.reason).toBe("error");
    expect(saved.error).toContain("disk full");
    expect(closed).toBe(true);
    expect(r.state).toBe("saved");
  });
});

// ---------------------------------------------------------------- the server: who may start one

const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "lk-test-key", LIVEKIT_API_SECRET: "s".repeat(40) };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
const count = (t: string) => (ctx.db as unknown as { $client: { prepare: (q: string) => { get: () => { n: number } } } }).$client.prepare(`select count(*) n from ${t}`).get().n;
async function setup(env: Record<string, string>) {
  ctx = await makeTestApp(env);
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
}
async function callMeeting(cl: Client = c) {
  const g = ((await cl.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
  return (await cl.post(`/api/chat/channels/${g.id}/call`, {})).body.meeting.id as string;
}
async function teammate(role: "member" | "admin", email: string) {
  const invite = await c.post("/api/team/invites", { email, role });
  const m = new Client(ctx.app);
  await m.signup(email, "Sam Mate", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return m;
}

describe("VID1 permit route (POST /api/meetings/:id/recordings/video)", () => {
  it("owner and admin get the permit with the title; it writes nothing; config says on", async () => {
    await setup({ ...LK, VIDEO_REC_VID1: "on" });
    const id = await callMeeting();
    const before = count("meeting_recordings");
    const r = await c.post(`/api/meetings/${id}/recordings/video`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, meeting: { id } });
    expect(typeof r.body.meeting.title).toBe("string");
    expect(count("meeting_recordings")).toBe(before);
    const admin = await teammate("admin", "ada@acme.io");
    expect((await admin.post(`/api/meetings/${id}/recordings/video`, {})).status).toBe(200);
    expect((await c.get("/api/config")).body.videoRecVid1).toBe(true);
  });
  it("a member is refused with 403, signed out 401", async () => {
    await setup({ ...LK, VIDEO_REC_VID1: "on" });
    const id = await callMeeting();
    const member = await teammate("member", "mate@acme.io");
    const r = await member.post(`/api/meetings/${id}/recordings/video`, {});
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("video_recording_admin_only");
    expect((await new Client(ctx.app).post(`/api/meetings/${id}/recordings/video`, {})).status).toBe(401);
  });
  it("another workspace's meeting is 404", async () => {
    await setup({ ...LK, VIDEO_REC_VID1: "on" });
    const id = await callMeeting();
    const other = new Client(ctx.app);
    await other.signup("boss@other.io", "Other Boss");
    expect((await other.post(`/api/meetings/${id}/recordings/video`, {})).status).toBe(404);
    expect((await c.post(`/api/meetings/nope/recordings/video`, {})).status).toBe(404);
  });
  it("flag off = today: the path is 404 and config does not offer video", async () => {
    await setup({ ...LK });
    const id = await callMeeting();
    expect((await c.post(`/api/meetings/${id}/recordings/video`, {})).status).toBe(404);
    expect((await c.get("/api/config")).body.videoRecVid1).toBe(false);
  });
  it("the page security policy is byte for byte the same with the flag on and off", async () => {
    await setup({ ...LK });
    const off = (await ctx.app.request("/api/health")).headers.get("content-security-policy");
    await setup({ ...LK, VIDEO_REC_VID1: "on" });
    const on = (await ctx.app.request("/api/health")).headers.get("content-security-policy");
    expect(off).toBeTruthy();
    expect(on).toBe(off);
    expect(on).not.toMatch(/'unsafe-eval'|'unsafe-inline' 'self' blob:/);
  });
});

describe("VID1 local LiveKit for tests", () => {
  const base = { APP_SECRET: "t".repeat(40), LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret" };
  it("ws://localhost is allowed outside production only", () => {
    expect(loadConfig({ ...base, LIVEKIT_URL: "ws://localhost:9583" }).meetings?.url).toBe("ws://localhost:9583");
    expect(() => loadConfig({ ...base, LIVEKIT_URL: "ws://example.com" })).toThrow();
    expect(() => loadConfig({ ...base, APP_MODE: "production", LIVEKIT_URL: "ws://localhost:9583" })).toThrow();
    expect(loadConfig({ ...base, LIVEKIT_URL: "wss://x.livekit.cloud" }).meetings?.url).toBe("wss://x.livekit.cloud");
  });
});
