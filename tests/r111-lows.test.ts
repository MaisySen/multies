import { describe, it, expect, vi } from "vitest";
import { PALETTE_ACTIONS, paletteScore } from "@/web/lib/palette-registry";
import { colourTokens, contrast, hoveredFills, hoverSafeFill, PRESETS, readableOn } from "@/shared/branding";
import { createProductAnalytics, flushOnPageHide } from "@/web/lib/product-analytics";

/** R111 continuation: the open lows from R100b (Ctrl K Slides, Forest hover contrast) and ANALYTICS-PH (pagehide flush). */
describe("Ctrl K finds Slides (R100b low)", () => {
  const slides = PALETTE_ACTIONS.find((a) => a.id === "tools-slides")!;
  it("has an entry that opens Slides and drawings in Tools, behind the same features", () => {
    expect(slides).toBeDefined();
    expect(slides.to).toBe("/app/tools?op=slides-convert");
    expect(slides.flag).toBe("tools");
    expect(slides.toolFeature).toEqual(["tools_c2"]);
  });
  it("matches what people type", () => {
    for (const q of ["slides", "Slides", "powerpoint", "pptx", "presentation", "drawing", "slids"]) {
      expect(paletteScore(`${slides.label}|${slides.id}`, q, slides.keywords), q).toBeGreaterThan(0);
    }
  });
});

describe("Forest hover contrast (R100b low)", () => {
  it("every preset keeps its button text at AA at rest and on hover, light and dark", () => {
    for (const p of PRESETS) {
      for (const scheme of ["light", "dark"] as const) {
        const t = colourTokens(p.primary, p.accent, scheme);
        const fill = t["--color-brand"]; const fg = t["--color-brand-fg"];
        if (!fill) continue;
        expect(contrast(fill, fg), `${p.id} ${scheme} rest`).toBeGreaterThanOrEqual(4.5);
        for (const h of hoveredFills(fill, scheme)) expect(contrast(h, fg), `${p.id} ${scheme} hover`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("Forest was 4.22:1 on hover before; its fill now deepens only a little and stays green", () => {
    const forest = PRESETS.find((p) => p.id === "forest")!;
    expect(contrast(hoveredFills(forest.primary!, "light")[0]!, "#ffffff")).toBeLessThan(4.5);
    const fixed = hoverSafeFill(forest.primary!, "light");
    expect(readableOn(fixed)).toBe("#ffffff");
    expect(contrast(fixed, "#ffffff")).toBeLessThan(6.5); // close to the original, not near black
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(fixed.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r!); expect(g).toBeGreaterThan(b!);
  });
  it("a fill that already passes on hover is left alone", () => {
    expect(hoverSafeFill("#0b3d91", "light")).toBe("#0b3d91");
  });
});

describe("analytics flush on pagehide (ANALYTICS-PH low)", () => {
  function fakeTarget() {
    const m = new Map<string, Set<() => void>>();
    return {
      addEventListener: (t: string, f: () => void) => { if (!m.has(t)) m.set(t, new Set()); m.get(t)!.add(f); },
      removeEventListener: (t: string, f: () => void) => { m.get(t)?.delete(f); },
      emit: (t: string) => m.get(t)?.forEach((f) => f()),
      count: () => [...m.values()].reduce((n, s) => n + s.size, 0),
    };
  }
  it("pagehide sends the queued events with keepalive, once", () => {
    const sender = vi.fn(async () => undefined);
    const pa = createProductAnalytics({ sender, optedOut: () => false });
    pa.pageOpened("/app/mail");
    pa.pageOpened("/app/tasks");
    const win = fakeTarget(); const doc = Object.assign(fakeTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const off = flushOnPageHide(pa, win as never, doc as never);
    win.emit("pagehide");
    expect(sender).toHaveBeenCalledTimes(1);
    const [body, keepalive] = sender.mock.calls[0] as unknown as [string, boolean];
    expect(keepalive).toBe(true);
    expect(JSON.parse(body).events).toHaveLength(2);
    win.emit("pagehide");
    expect(sender).toHaveBeenCalledTimes(1); // nothing left to send
    off();
    expect(win.count() + doc.count()).toBe(0);
  });
  it("visibilitychange flushes only when hidden", () => {
    const flush = vi.fn();
    const win = fakeTarget(); const doc = Object.assign(fakeTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    flushOnPageHide({ flush }, win as never, doc as never);
    doc.emit("visibilitychange");
    expect(flush).not.toHaveBeenCalled();
    doc.visibilityState = "hidden";
    doc.emit("visibilitychange");
    expect(flush).toHaveBeenCalledWith(true);
  });
});
