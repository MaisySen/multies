import { describe, it, expect } from "vitest";
import { deviceLabel, levelOf, loadPrefs, minutesLabel, pickDevice, PREJOIN_KEY, roomMedia, savePrefs, shouldShowSoFar } from "@/web/lib/prejoin-prefs";

/** Round 31: the pre-join choices and helpers. */
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };

describe("pre-join prefs", () => {
  it("defaults to camera and mic on, and remembers devices and toggles", () => {
    const s = mem();
    expect(loadPrefs(s)).toEqual({ cam: true, mic: true });
    savePrefs({ cam: false, mic: true, videoDeviceId: "cam-2", audioDeviceId: "mic-1", speakerDeviceId: "spk-3", name: "Gail" }, s);
    expect(JSON.parse(s.m.get(PREJOIN_KEY)!)).toMatchObject({ cam: false, videoDeviceId: "cam-2" });
    expect(loadPrefs(s)).toEqual({ cam: false, mic: true, videoDeviceId: "cam-2", audioDeviceId: "mic-1", speakerDeviceId: "spk-3", name: "Gail" });
  });
  it("survives junk and missing storage", () => {
    const s = mem(); s.setItem(PREJOIN_KEY, "{not json");
    expect(loadPrefs(s)).toEqual({ cam: true, mic: true });
    expect(loadPrefs(null)).toEqual({ cam: true, mic: true });
    s.setItem(PREJOIN_KEY, JSON.stringify({ cam: "yes", videoDeviceId: 5, name: "x".repeat(80) }));
    const p = loadPrefs(s);
    expect(p.cam).toBe(true); expect(p.videoDeviceId).toBeUndefined(); expect(p.name).toHaveLength(60);
    expect(() => savePrefs({ cam: true, mic: true }, { getItem: () => null, setItem: () => { throw new Error("quota"); } })).not.toThrow();
  });
  it("carries the choices into the room", () => {
    expect(roomMedia({ cam: false, mic: true })).toEqual({ video: false, audio: true, options: undefined });
    expect(roomMedia({ cam: true, mic: false, videoDeviceId: "c1", speakerDeviceId: "s1" })).toEqual({ video: { deviceId: "c1" }, audio: false, options: { audioOutput: { deviceId: "s1" } } });
  });
});

describe("helpers", () => {
  it("reads a level from analyser bytes", () => {
    expect(levelOf(new Uint8Array(64).fill(128))).toBe(0);
    expect(levelOf([])).toBe(0);
    expect(levelOf(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 255 : 0)))).toBe(1);
    const mid = levelOf(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 140 : 116)));
    expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(1);
  });
  it("labels devices before permission and picks a device still plugged in", () => {
    expect(deviceLabel({ label: "", kind: "videoinput" }, 1)).toBe("Camera 2");
    expect(deviceLabel({ label: "", kind: "audiooutput" }, 0)).toBe("Speaker 1");
    expect(deviceLabel({ label: "FaceTime HD", kind: "videoinput" }, 0)).toBe("FaceTime HD");
    expect(pickDevice([{ deviceId: "a" }, { deviceId: "b" }], "b")).toBe("b");
    expect(pickDevice([{ deviceId: "a" }], "gone")).toBe("a");
    expect(pickDevice([], "x")).toBeUndefined();
  });
  it("opens So far on its own only for a late join that was not dismissed", () => {
    const start = "2026-10-26T01:00:00.000Z", t = Date.parse(start);
    expect(shouldShowSoFar(start, t + 6 * 60_000, 5 * 60_000, false)).toBe(true);
    expect(shouldShowSoFar(start, t + 4 * 60_000, 5 * 60_000, false)).toBe(false);
    expect(shouldShowSoFar(start, t + 6 * 60_000, 5 * 60_000, true)).toBe(false);
    expect(shouldShowSoFar("nope", t, 1, false)).toBe(false);
  });
  it("says minutes in the call plainly", () => {
    expect(minutesLabel(null)).toBe(""); expect(minutesLabel(0)).toBe("just joined"); expect(minutesLabel(12)).toBe("12 min"); expect(minutesLabel(75)).toBe("1 h 15 min");
  });
});
