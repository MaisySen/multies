import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { MemorySink, VideoRecording, type RecorderCtor, type RecorderLike, type VideoEvent } from "@/web/lib/video-rec-vid1";
import {
  backgroundAction, extFor, iosTooOld, iosVersion, isPhoneDevice, partFileName, phoneBudget, pickPhoneVideoType, PHONE_QUALITY, ReadyList, saveMode, shareGroups, type ShareNav,
} from "@/web/lib/video-phone-vid3";

/** VID3: a meeting recording that starts, runs and saves on a phone browser; nothing uploaded. */

const UA = {
  iphone17: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphone144: "Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1",
  iphone145: "Mozilla/5.0 (iPhone; CPU iPhone OS 14_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1 Mobile/15E148 Safari/604.1",
  iphone12: "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  pixel: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  winEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
};

describe("VID3 phone detection", () => {
  it("knows iPhone, iPad (desktop mode with touch), Android phones and tablets; desktops are not phones", () => {
    expect(isPhoneDevice({ ua: UA.iphone17 })).toBe(true);
    expect(isPhoneDevice({ ua: UA.pixel })).toBe(true);
    expect(isPhoneDevice({ ua: UA.androidTablet })).toBe(true);
    expect(isPhoneDevice({ ua: UA.ipadDesktop, maxTouchPoints: 5 })).toBe(true);
    expect(isPhoneDevice({ ua: UA.ipadDesktop, maxTouchPoints: 0 })).toBe(false);
    expect(isPhoneDevice({ ua: UA.macChrome, maxTouchPoints: 0 })).toBe(false);
    expect(isPhoneDevice({ ua: UA.winEdge, maxTouchPoints: 10 })).toBe(false);
    expect(isPhoneDevice({ ua: "" })).toBe(false);
  });
  it("reads the iOS version and says plainly when it is too old to record (before 14.5)", () => {
    expect(iosVersion(UA.iphone17)).toEqual([17, 5]);
    expect(iosVersion(UA.pixel)).toBeNull();
    expect(iosTooOld(UA.iphone144)).toBe(true);
    expect(iosTooOld(UA.iphone12)).toBe(true);
    expect(iosTooOld(UA.iphone145)).toBe(false);
    expect(iosTooOld(UA.iphone17)).toBe(false);
    expect(iosTooOld(UA.pixel)).toBe(false);
    expect(iosTooOld(UA.ipadDesktop)).toBe(false);
  });
});

describe("VID3 recording type on a phone (asked of the browser, never assumed)", () => {
  const only = (...ok: string[]) => (t: string) => ok.includes(t);
  it("iPhone Safari records mp4 (h264 and aac)", () => {
    const safari = only("video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4");
    expect(pickPhoneVideoType(safari)).toEqual({ mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4" });
    expect(pickPhoneVideoType(only("video/mp4"))).toEqual({ mime: "video/mp4", ext: "mp4" });
  });
  it("Android Chrome takes mp4 where it records it (Photos and the gallery play it), else webm with opus", () => {
    expect(pickPhoneVideoType(only("video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4;codecs=avc1,mp4a", "video/mp4"))?.ext).toBe("mp4");
    expect(pickPhoneVideoType(only("video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"))).toEqual({ mime: "video/webm;codecs=vp9,opus", ext: "webm" });
    expect(pickPhoneVideoType(only("video/webm;codecs=vp8,opus"))).toEqual({ mime: "video/webm;codecs=vp8,opus", ext: "webm" });
  });
  it("no recorder, nothing supported, or a browser that throws: no type (the plain unsupported message shows)", () => {
    expect(pickPhoneVideoType(undefined)).toBeNull();
    expect(pickPhoneVideoType(() => false)).toBeNull();
    expect(pickPhoneVideoType((t) => { if (t.includes("mp4")) throw new Error("NotSupported"); return t === "video/webm"; })).toEqual({ mime: "video/webm", ext: "webm" });
  });
  it("the file extension follows what the recorder really made", () => {
    expect(extFor("video/mp4", "webm")).toBe("mp4");
    expect(extFor("video/quicktime", "webm")).toBe("mp4");
    expect(extFor("video/webm;codecs=vp8", "mp4")).toBe("webm");
    expect(extFor("", "mp4")).toBe("mp4");
  });
  it("phones record 720p at 24 frames and 2 Mbit/s (about 15 MB a minute)", () => {
    expect(PHONE_QUALITY).toMatchObject({ w: 1280, h: 720, fps: 24, videoBits: 2_000_000 });
    expect(Math.round((PHONE_QUALITY.videoBits + 128_000) * 60 / 8 / 1024 ** 2)).toBe(15);
  });
});

describe("VID3 memory budget and parts", () => {
  const MB = 1024 ** 2;
  it("iPhone keeps up to 400 MB in a part; Android follows the device memory; the warning comes at three quarters", () => {
    expect(phoneBudget({ ua: UA.iphone17 })).toEqual({ part: 400 * MB, warn: 300 * MB });
    expect(phoneBudget({ ua: UA.ipadDesktop, maxTouchPoints: 5 }).part).toBe(400 * MB);
    expect(phoneBudget({ ua: UA.pixel, deviceMemoryGb: 8 }).part).toBe(700 * MB);
    expect(phoneBudget({ ua: UA.pixel, deviceMemoryGb: 4 }).part).toBe(450 * MB);
    expect(phoneBudget({ ua: UA.pixel, deviceMemoryGb: 2 }).part).toBe(250 * MB);
    expect(phoneBudget({ ua: UA.pixel }).part).toBe(400 * MB);
    for (const b of [phoneBudget({ ua: UA.iphone17 }), phoneBudget({ ua: UA.pixel, deviceMemoryGb: 2 })]) expect(b.warn).toBeLessThan(b.part);
  });
  it("names parts after the recording; part 1 keeps the plain name", () => {
    expect(partFileName("Meeting Weekly sync 4 Nov 2026 01.30.mp4", 1)).toBe("Meeting Weekly sync 4 Nov 2026 01.30.mp4");
    expect(partFileName("Meeting Weekly sync 4 Nov 2026 01.30.mp4", 2)).toBe("Meeting Weekly sync 4 Nov 2026 01.30 part 2.mp4");
    expect(partFileName("Meeting", 3)).toBe("Meeting part 3");
    expect(partFileName("Meeting 4 Nov.webm", 2)).not.toMatch(/[\u2010-\u2015-]/);
  });
  it("in the background a phone pauses when it can, else stops and keeps what was recorded", () => {
    expect(backgroundAction(true)).toBe("pause");
    expect(backgroundAction(false)).toBe("stop");
  });

  class FakeRecorder implements RecorderLike {
    static last: FakeRecorder | null = null;
    state = "inactive";
    mimeType: string;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private stops: (() => void)[] = [];
    constructor(_s: MediaStream, o: { mimeType?: string }) { this.mimeType = o.mimeType ?? ""; FakeRecorder.last = this; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["end"]) }); for (const f of this.stops) f(); }
    pause() { this.state = "paused"; }
    resume() { this.state = "recording"; }
    addEventListener(_t: "stop", fn: () => void) { this.stops.push(fn); }
    emit(bytes: number) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); }
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));
  it("a phone's budget warns once, then the part closes with everything recorded so far (the next part starts after)", async () => {
    const all: VideoEvent[] = [];
    const events = { get length() { return all.filter((e) => e.type !== "state").length; }, map: <T,>(f: (e: VideoEvent) => T) => all.filter((e) => e.type !== "state").map(f) };
    const rec = new VideoRecording({ stream: {} as MediaStream, mime: "video/mp4", sink: new MemorySink("video/mp4"), Recorder: FakeRecorder as unknown as RecorderCtor, onEvent: (e) => all.push(e), warnBytes: 300, hardBytes: 400 });
    rec.start();
    const r1 = FakeRecorder.last!;
    r1.emit(200); await tick();
    expect(events.length).toBe(0);
    r1.emit(150); await tick();
    expect(events.map((e) => e.type)).toEqual(["warn"]);
    r1.emit(10); await tick();
    expect(events.map((e) => e.type)).toEqual(["warn"]);
    r1.emit(100); await tick();
    expect(events.map((e) => e.type)).toEqual(["warn", "limit"]);
    const saved = await rec.stop();
    expect(saved.reason).toBe("limit");
    expect(saved.blob?.type).toBe("video/mp4");
    expect(saved.blob?.size).toBe(200 + 150 + 10 + 100 + 3);
    // The next part is a new recording on the same stream: a fresh warning, its own bytes.
    const next = new VideoRecording({ stream: {} as MediaStream, mime: "video/mp4", sink: new MemorySink("video/mp4"), Recorder: FakeRecorder as unknown as RecorderCtor, onEvent: (e) => all.push(e), warnBytes: 300, hardBytes: 400 });
    next.start();
    expect(FakeRecorder.last).not.toBe(r1);
    FakeRecorder.last!.emit(50); await tick();
    expect(next.bytes).toBe(50);
    expect(events.length).toBe(2);
    await next.stop();
  });
});

describe("VID3 saving on a phone: the share sheet, else a download link", () => {
  const mp4 = new File([new Uint8Array(10)], "Meeting.mp4", { type: "video/mp4" });
  const chat = new File(["hi"], "Meeting chat.txt", { type: "text/plain" });
  const transcript = new File(["words"], "Meeting transcript.txt", { type: "text/plain" });
  const nav = (accept: (f: File[]) => boolean, share = true): ShareNav => ({ canShare: (d) => accept(d.files ?? []), share: share ? async () => undefined : undefined });
  it("shares when the browser can share the video file (iPhone Safari, Android Chrome)", () => {
    expect(saveMode(nav(() => true), [mp4])).toBe("share");
  });
  it("downloads when it can't: no Web Share, no files in it, a refusal, or a throw", () => {
    expect(saveMode(undefined, [mp4])).toBe("download");
    expect(saveMode({}, [mp4])).toBe("download");
    expect(saveMode(nav(() => true, false), [mp4])).toBe("download");
    expect(saveMode(nav(() => false), [mp4])).toBe("download");
    expect(saveMode({ canShare: () => { throw new TypeError("bad"); }, share: async () => undefined }, [mp4])).toBe("download");
    expect(saveMode(nav(() => true), [])).toBe("download");
  });
  it("chat and transcript go in the same share when the browser takes several files; else they are a second step", () => {
    expect(shareGroups(nav(() => true), mp4, [chat, transcript])).toEqual({ now: [mp4, chat, transcript], later: [] });
    const videoOnly = nav((f) => f.every((x) => x.type.startsWith("video/")));
    expect(shareGroups(videoOnly, mp4, [chat, transcript])).toEqual({ now: [mp4], later: [chat, transcript] });
    expect(shareGroups(nav(() => true), mp4, [])).toEqual({ now: [mp4], later: [] });
  });
});

describe("VID3 videos waiting for a Save tap", () => {
  const blob = (n: number) => new Blob([new Uint8Array(n)], { type: "video/mp4" });
  it("keeps each part, joins side files to the recording's last part, and lets the kept pieces go once saved", () => {
    const l = new ReadyList();
    let seen = 0;
    const off = l.subscribe(() => seen++);
    const released: string[] = [];
    const a = l.add("Meeting.mp4", blob(5), { group: "Meeting.mp4", keepId: "k1", release: () => released.push("k1") });
    const b = l.add("Meeting part 2.mp4", blob(6), { group: "Meeting.mp4", keepId: "k2", release: () => released.push("k2") });
    expect(l.list().map((x) => x.name)).toEqual(["Meeting.mp4", "Meeting part 2.mp4"]);
    expect(l.keepIds()).toEqual(["k1", "k2"]);
    expect(l.addSide("Meeting.mp4", { name: "Meeting chat.txt", text: "hi" })).toBe(true);
    expect(l.addSide("Meeting.mp4", { name: "Meeting chat.txt", text: "hi" })).toBe(true);
    expect(l.list().find((x) => x.id === b)!.sides.map((s) => s.name)).toEqual(["Meeting chat.txt"]);
    expect(l.list().find((x) => x.id === a)!.sides).toEqual([]);
    expect(l.addSide("Other.mp4", { name: "Other chat.txt", text: "x" })).toBe(false);
    l.saved(a, false);
    l.saved(a, false);
    expect(released).toEqual(["k1"]);
    expect(l.list().find((x) => x.id === a)!.saves).toBe(2);
    l.saved(b, true);
    expect(l.list().find((x) => x.id === b)!.sidesSaved).toBe(true);
    l.remove(a);
    l.remove(b);
    expect(released).toEqual(["k1", "k2"]);
    expect(l.list()).toEqual([]);
    expect(seen).toBeGreaterThan(5);
    off();
  });
  it("discarding an unsaved video lets its kept pieces go too", () => {
    const l = new ReadyList();
    let gone = 0;
    const id = l.add("Meeting.mp4", blob(3), { keepId: "k", release: () => gone++ });
    l.remove(id);
    l.remove(id);
    expect(gone).toBe(1);
  });
});

describe("VID3 switch", () => {
  const LK = { LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "lk-test-key", LIVEKIT_API_SECRET: "s".repeat(40) };
  async function cfg(env: Record<string, string>) {
    const ctx = await makeTestApp(env);
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    return (await c.get("/api/config")).body as Record<string, unknown>;
  }
  it("is off unless named in FEATURES (or its own var), and needs VID2 and VID1", async () => {
    expect((await cfg({ ...LK, VIDEO_REC_VID1: "on", FEATURES: "VIDEO_REC_VID2" })).videoPhoneVid3).toBe(false);
    expect((await cfg({ ...LK, VIDEO_REC_VID1: "on", FEATURES: "VIDEO_REC_VID2,VIDEO_PHONE_VID3" })).videoPhoneVid3).toBe(true);
    expect((await cfg({ ...LK, VIDEO_REC_VID1: "on", FEATURES: "VIDEO_PHONE_VID3" })).videoPhoneVid3).toBe(false);
    expect((await cfg({ ...LK, FEATURES: "VIDEO_REC_VID2,VIDEO_PHONE_VID3" })).videoPhoneVid3).toBe(false);
  });
});
