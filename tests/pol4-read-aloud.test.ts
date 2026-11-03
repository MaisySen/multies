import { describe, it, expect, vi, beforeAll } from "vitest";

/** POL4 (HQ MB-355): Read aloud on a device with no speech voice at all says so plainly, in the language on screen. */

vi.mock("@/web/lib/api", () => ({ api: { post: vi.fn(), get: vi.fn() } }));
vi.mock("@/web/lib/queries", () => ({ useMe: () => ({ data: null }) }));

type Utt = { text: string; onend?: () => void; onerror?: (e: { error: string }) => void; voice?: unknown; lang?: string; rate?: number };
let spoken: Utt[] = [];
let voices: { lang: string; name: string; default?: boolean; localService?: boolean; voiceURI?: string }[] = [];
let failWith: string | null = null;

beforeAll(() => {
  const synth = {
    getVoices: () => voices,
    addEventListener: () => {}, removeEventListener: () => {},
    speak: (u: Utt) => { spoken.push(u); setTimeout(() => (failWith ? u.onerror?.({ error: failWith }) : u.onend?.()), 0); },
    cancel: () => {}, pause: () => {}, resume: () => {},
  };
  class SpeechSynthesisUtterance { text: string; constructor(t: string) { this.text = t; } }
  vi.stubGlobal("window", { speechSynthesis: synth, SpeechSynthesisUtterance, addEventListener: () => {}, localStorage: undefined });
  vi.stubGlobal("SpeechSynthesisUtterance", SpeechSynthesisUtterance);
});

const settle = () => new Promise((r) => setTimeout(r, 1_400));

describe("read aloud with no voice", () => {
  it("names the missing voice for a device with no voices, and keeps the retry note for other failures", async () => {
    const { readingStoppedNote } = await import("@/web/lib/translate-r116");
    expect(readingStoppedNote("synthesis-failed", true)).toMatch(/no voice for reading aloud/);
    expect(readingStoppedNote("synthesis-unavailable", false)).toMatch(/no voice for reading aloud/);
    expect(readingStoppedNote("voice-unavailable", false)).toMatch(/no voice for reading aloud/);
    expect(readingStoppedNote("synthesis-failed", false)).toBe("Reading stopped. Try Read aloud again.");
    expect(readingStoppedNote("network", false)).not.toMatch(/no voice/);
  });

  it("a device with no voices at all ends with the no voice note, not Reading stopped", async () => {
    const m = await import("@/web/lib/translate-r116");
    voices = []; failWith = "synthesis-failed"; spoken = [];
    const p = m.startReading("mail", "Hello there, this is a short message to read.");
    await settle(); await p; await new Promise((r) => setTimeout(r, 10));
    const state = (m as unknown as { __speechForTest: () => { status: string; note: string | null } }).__speechForTest();
    expect(spoken.length).toBe(1);
    expect(state?.status).toBe("idle");
    expect(state?.note).toMatch(/no voice for reading aloud/);
  });

  it("a device with voices that fails mid read keeps the retry note", async () => {
    const m = await import("@/web/lib/translate-r116");
    voices = [{ lang: "en-AU", name: "Karen", default: true, localService: true, voiceURI: "k" }]; failWith = "synthesis-failed"; spoken = [];
    await m.startReading("mail", "Hello there, this is a short message to read.");
    await new Promise((r) => setTimeout(r, 20));
    const state = (m as unknown as { __speechForTest: () => { note: string | null } }).__speechForTest();
    expect(state.note).toBe("Reading stopped. Try Read aloud again.");
  });

  it("the note is in Nepali and Hindi bundles", async () => {
    const { ne } = await import("@/web/i18n/ne");
    const { hi } = await import("@/web/i18n/hi");
    expect(String(ne["read.no_voice"])).toMatch(/आवाज/);
    expect(String(hi["read.no_voice"])).toMatch(/आवाज़/);
  });
});
