import { describe, expect, it } from "vitest";
import { canOffer1080, chatLog, FrameMeter, layoutFor, layoutSpeaker, MemoryBackend, noSpeaker, PauseClock, pickSpeaker, PieceStore, rebuild, recoverable, sideName, STALE_MS, KEEP_MS, sweep, transcriptText, type StoredMeta } from "../src/web/lib/video-rec-vid2";
import { layoutTiles, VideoRecording, MemorySink, type RecorderLike, type TileInput } from "../src/web/lib/video-rec-vid1";

const cam = (id: string, speaking = false, hasVideo = true): TileInput => ({ id, kind: "camera", name: id, speaking, hasVideo });
const scr = (id: string): TileInput => ({ id, kind: "screen", name: id, speaking: false, hasVideo: true });
const inside = (r: { x: number; y: number; w: number; h: number }) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 1280 && r.y + r.h <= 720;
const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("VID2 speaker view", () => {
  it("one person fills the frame", () => {
    const p = layoutSpeaker([cam("a")], "a");
    expect(p).toHaveLength(1);
    expect(p[0].rect.w).toBeGreaterThan(1200);
  });
  it("the speaker is big and everyone else sits in a strip below, no overlaps, all inside", () => {
    const tiles = [cam("a"), cam("b"), cam("c")];
    const p = layoutSpeaker(tiles, "b");
    expect(p[0].id).toBe("b");
    expect(p[0].rect.h).toBeGreaterThan(500);
    for (const x of p.slice(1)) { expect(x.rect.y).toBeGreaterThanOrEqual(p[0].rect.y + p[0].rect.h); expect(x.rect.h).toBeLessThan(200); }
    for (const x of p) expect(inside(x.rect)).toBe(true);
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) expect(overlap(p[i].rect, p[j].rect)).toBe(false);
    expect(p.map((x) => x.id).slice(1)).toEqual(["a", "c"]);
  });
  it("past six in the strip the last cell says how many more", () => {
    const tiles = Array.from({ length: 10 }, (_, i) => cam(`p${i}`));
    const p = layoutSpeaker(tiles, "p0");
    expect(p).toHaveLength(7);
    expect(p[6].kind).toBe("more");
    expect(p[6].name).toBe("+4 more");
  });
  it("an unknown speaker falls back to the first tile", () => {
    expect(layoutSpeaker([cam("a"), cam("b")], "zz")[0].id).toBe("a");
  });
  it("a screen share always takes the big area, in both views", () => {
    const tiles = [cam("a", true), scr("b:screen"), cam("b")];
    expect(layoutSpeaker(tiles, "a")[0].id).toBe("b:screen");
    expect(layoutFor("gallery", tiles, "a")[0].id).toBe("b:screen");
    expect(layoutFor("speaker", tiles, "a")).toEqual(layoutTiles(tiles));
  });
  it("gallery view is VID1's grid exactly", () => {
    const tiles = [cam("a"), cam("b"), cam("c"), cam("d")];
    expect(layoutFor("gallery", tiles, "c")).toEqual(layoutTiles(tiles));
  });
});

describe("VID2 who has the big tile", () => {
  it("first camera with video until someone speaks, then switches only after the hold", () => {
    const tiles = [cam("a", false, false), cam("b"), cam("c")];
    let s = pickSpeaker(tiles, noSpeaker(), 0);
    expect(s.id).toBe("b");
    tiles[2] = cam("c", true);
    s = pickSpeaker(tiles, s, 100);
    expect(s.id).toBe("b");
    s = pickSpeaker(tiles, s, 1000);
    expect(s.id).toBe("b");
    s = pickSpeaker(tiles, s, 1700);
    expect(s.id).toBe("c");
    tiles[2] = cam("c", false);
    s = pickSpeaker(tiles, s, 5000);
    expect(s.id).toBe("c"); // keeps it through silence
  });
  it("a cough shorter than the hold does not switch", () => {
    const tiles = [cam("a"), cam("b")];
    let s = pickSpeaker(tiles, noSpeaker(), 0);
    tiles[1] = cam("b", true); s = pickSpeaker(tiles, s, 100);
    tiles[1] = cam("b", false); s = pickSpeaker(tiles, s, 400);
    tiles[1] = cam("b", true); s = pickSpeaker(tiles, s, 500);
    s = pickSpeaker(tiles, s, 1200);
    expect(s.id).toBe("a");
  });
  it("the speaker leaving hands the tile on", () => {
    let s = pickSpeaker([cam("a"), cam("b", true)], noSpeaker(), 0);
    expect(s.id).toBe("b");
    s = pickSpeaker([cam("a")], s, 10);
    expect(s.id).toBe("a");
  });
});

describe("VID2 quality", () => {
  it("1080p needs 4 cores and 4 GB when known", () => {
    expect(canOffer1080(8, 8)).toBe(true);
    expect(canOffer1080(8, undefined)).toBe(true);
    expect(canOffer1080(2, 8)).toBe(false);
    expect(canOffer1080(8, 2)).toBe(false);
    expect(canOffer1080(undefined, undefined)).toBe(false);
  });
  it("a steady 30 fps stays at 30", () => {
    const m = new FrameMeter(30);
    let out: number | null = null;
    for (let t = 0; t <= 6000; t += 1000 / 30) out = m.tick(t, 4) ?? out;
    expect(out).toBeNull();
    expect(m.fps).toBe(30);
  });
  it("late frames step down 30 to 24 to 20 to 15 and never below", () => {
    const m = new FrameMeter(30);
    const steps: number[] = [];
    for (let t = 0; t <= 40_000; t += 80) { const n = m.tick(t, 30); if (n) steps.push(n); }
    expect(steps).toEqual([24, 20, 15]);
    expect(m.dropped).toBeGreaterThan(0);
  });
  it("slow draws step down even when ticks are on time", () => {
    const m = new FrameMeter(30);
    let out: number | null = null;
    for (let t = 0; t <= 5100; t += 1000 / 30) out = m.tick(t, 30) ?? out;
    expect(out).toBe(24);
  });
});

describe("VID2 pause clock and recorder pause", () => {
  it("paused time is left out", () => {
    const c = new PauseClock();
    c.start(0); c.pause(10_000); expect(c.paused).toBe(true);
    expect(c.elapsedMs(25_000)).toBe(10_000);
    c.resume(30_000); expect(c.elapsedMs(40_000)).toBe(20_000);
  });
  it("VideoRecording pauses and resumes the recorder and its clock", async () => {
    let now = 1000;
    const calls: string[] = [];
    class Rec implements RecorderLike {
      state = "inactive"; mimeType = "video/webm"; ondataavailable: ((e: { data: Blob }) => void) | null = null; onerror = null;
      private stopFn: (() => void) | null = null;
      start() { this.state = "recording"; calls.push("start"); }
      stop() { this.state = "inactive"; calls.push("stop"); this.ondataavailable?.({ data: new Blob(["x"]) }); this.stopFn?.(); }
      pause() { this.state = "paused"; calls.push("pause"); }
      resume() { this.state = "recording"; calls.push("resume"); }
      addEventListener(_t: "stop", fn: () => void) { this.stopFn = fn; }
    }
    const kept: Blob[] = [];
    const r = new VideoRecording({ stream: {} as MediaStream, mime: "video/webm", sink: new MemorySink("video/webm"), Recorder: Rec, now: () => now, keep: { put: async (b) => { kept.push(b); } } });
    r.start();
    now = 11_000; expect(r.pause()).toBe(true); expect(r.pause()).toBe(false);
    now = 71_000; expect(r.elapsedSec).toBe(10);
    expect(r.resume()).toBe(true);
    now = 76_000; expect(r.elapsedSec).toBe(15);
    const saved = await r.stop();
    expect(calls).toEqual(["start", "pause", "resume", "stop"]);
    expect(saved.blob?.size).toBe(1);
    expect(kept).toHaveLength(1);
  });
  it("a browser without pause answers false", () => {
    class Rec implements RecorderLike { state = "inactive"; mimeType = ""; ondataavailable = null; onerror = null; start() { this.state = "recording"; } stop() {} addEventListener() {} }
    const r = new VideoRecording({ stream: {} as MediaStream, mime: "", sink: new MemorySink("video/webm"), Recorder: Rec });
    r.start();
    expect(r.pause()).toBe(false);
  });
});

describe("VID2 pieces kept on the device", () => {
  const meta = { id: "r1", meetingId: "m1", title: "Weekly sync", fileName: "Meeting Weekly sync 3 Nov 2026 14.05.webm", mime: "video/webm;codecs=vp9,opus", startedAt: 1000 };
  it("pieces are kept in order and rebuild the whole file; finish removes them", async () => {
    let now = 1000;
    const db = new MemoryBackend();
    const s = new PieceStore(db, meta, () => now);
    await s.begin();
    for (const t of ["aa", "bbb", "c"]) { now += 1000; void s.put(new Blob([t])); }
    await s.flushed();
    const [m] = await db.metas();
    expect(m.pieces).toBe(3);
    expect(m.bytes).toBe(6);
    expect(m.updatedAt).toBe(4000);
    const blob = await rebuild(db, m);
    expect(await blob!.text()).toBe("aabbbc");
    expect(blob!.type).toBe("video/webm");
    await s.finish();
    expect(await db.metas()).toEqual([]);
    expect(await db.pieces("r1")).toEqual([]);
  });
  it("only a recording whose tab went quiet is offered, newest first, and old ones are swept", async () => {
    const base: StoredMeta = { ...meta, updatedAt: 0, pieces: 2, bytes: 10, done: false };
    const now = 10 * 24 * 3600_000;
    const list = [
      { ...base, id: "live", updatedAt: now - 1000 },
      { ...base, id: "old", startedAt: 1, updatedAt: now - STALE_MS - 5 },
      { ...base, id: "newer", startedAt: 9, updatedAt: now - STALE_MS - 5 },
      { ...base, id: "empty", pieces: 0, bytes: 0, updatedAt: now - STALE_MS - 5 },
      { ...base, id: "ancient", updatedAt: now - KEEP_MS - 1 },
    ];
    expect(recoverable(list, now).map((m) => m.id)).toEqual(["newer", "old"]);
    const db = new MemoryBackend();
    for (const m of list) await db.putMeta(m);
    await sweep(db, now);
    expect((await db.metas()).map((m) => m.id).sort()).toEqual(["empty", "live", "newer", "old"]);
  });
  it("a failing store never stops the recording (it only marks itself failed)", async () => {
    const db = new MemoryBackend();
    db.putPiece = async () => { throw new Error("quota"); };
    const s = new PieceStore(db, meta);
    await s.begin();
    await s.put(new Blob(["x"]));
    expect(s.failed).toBe(true);
  });
});

describe("VID2 side files", () => {
  it("same base name as the video", () => {
    expect(sideName("Meeting Weekly sync 3 Nov 2026 14.05.webm", "chat")).toBe("Meeting Weekly sync 3 Nov 2026 14.05 chat.txt");
    expect(sideName("Meeting.mp4", "transcript")).toBe("Meeting transcript.txt");
    expect(sideName("", "chat")).toBe("Meeting chat.txt");
  });
  it("chat log: time into the recording, who, what, in order, multi line kept readable", () => {
    const t = chatLog("Weekly sync", 10_000, [{ at: 75_000, from: "Sam", text: "second" }, { at: 12_000, from: "Olive", text: "hello\nthere" }], "3 Nov 2026, 14:05");
    expect(t.split("\n")).toEqual(["Chat from Weekly sync", "Recording started 3 Nov 2026, 14:05", "", "[00:00:02] Olive: hello", "    there", "[00:01:05] Sam: second", ""]);
    expect(chatLog("", 0, [], "now")).toContain("No chat messages while this was recorded.");
  });
  it("transcript file", () => {
    expect(transcriptText("Weekly sync", "3 Nov", " Hi all \n")).toBe("Transcript of Weekly sync\nRecording started 3 Nov\n\nHi all\n");
  });
});
