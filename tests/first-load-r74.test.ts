/**
 * R74: first load on a slow phone network. The first screens carry only the glyphs they draw, the footer line does
 * not pull in the legal documents, and the command menu's code waits until the page has loaded.
 */
import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { criticalIconFiles, criticalIconNames } from "../scripts/critical-icons";
import { warmPaletteWhenSettled } from "@/web/components/palette-host";
import { prefetchWhenIdle } from "@/web/lib/prefetch";

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "src");

describe("critical icons (R74)", () => {
  it("finds the glyphs the app frame imports, and not every glyph", () => {
    const names = criticalIconNames([path.join(src, "web/layouts/app.tsx")], src);
    expect(names.has("IconInbox")).toBe(true);
    expect(names.has("IconSettings")).toBe(true);
    const files = criticalIconFiles(root);
    expect(files.size).toBeGreaterThan(20);
    expect(files.size).toBeLessThan(160);
    expect([...files].every((f) => f.includes(`${path.sep}icons${path.sep}`))).toBe(true);
  });
  it("skips lazy imports (a lazily loaded page's glyphs are not first screen glyphs)", () => {
    const names = criticalIconNames([path.join(src, "web/router.tsx")], src);
    // The page editor is only ever imported lazily, and IconGrip is used there.
    const editor = readFileSync(path.join(src, "web/pages/app/tools-editors/page-editor.tsx"), "utf8");
    expect(editor).toMatch(/IconGrip/);
    expect(names.has("IconGrip")).toBe(false);
  });
  it("the build keeps two icon files", () => {
    const cfg = readFileSync(path.join(root, "vite.config.ts"), "utf8");
    expect(cfg).toMatch(/name: "icons",/);
    expect(cfg).toMatch(/name: "icons-more"/);
  });
});

describe("footer legal line (R74)", () => {
  it("imports the small entity module, not the documents", () => {
    const line = readFileSync(path.join(src, "web/components/legal-line.tsx"), "utf8");
    expect(line).toMatch(/@\/shared\/legal-entity/);
    const entity = readFileSync(path.join(src, "shared/legal-entity.ts"), "utf8");
    expect(entity).not.toMatch(/Privacy policy/);
  });
  it("legal.ts still exports the same company facts", async () => {
    const a = await import("@/shared/legal");
    const b = await import("@/shared/legal-entity");
    expect(a.LEGAL_ENTITY).toBe(b.LEGAL_ENTITY);
    expect(a.LEGAL_LINE_TEXT).toBe(b.LEGAL_LINE_TEXT);
  });
});

function fakeWin() {
  const listeners: Record<string, (() => void)[]> = {};
  const timers: (() => void)[] = [];
  return {
    listeners, timers,
    addEventListener: (k: string, fn: () => void) => { (listeners[k] ||= []).push(fn); },
    removeEventListener: (k: string, fn: () => void) => { listeners[k] = (listeners[k] || []).filter((f) => f !== fn); },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: vi.fn(),
    requestIdleCallback: (fn: () => void) => { timers.push(fn); return timers.length; },
  };
}

describe("command menu warm up (R74)", () => {
  it("waits for the load event, then a pause, then idle", () => {
    const w = fakeWin();
    const warm = vi.fn();
    warmPaletteWhenSettled(w as never, { readyState: "loading" }, {}, warm);
    expect(w.timers.length).toBe(0);
    w.listeners.load[0]();
    w.timers.shift()!();
    expect(warm).not.toHaveBeenCalled();
    w.timers.shift()!();
    expect(warm).toHaveBeenCalledTimes(1);
  });
  it("never warms on a slow or data saving connection", () => {
    const w = fakeWin();
    const warm = vi.fn();
    warmPaletteWhenSettled(w as never, { readyState: "complete" }, { connection: { effectiveType: "3g" } }, warm);
    warmPaletteWhenSettled(w as never, { readyState: "complete" }, { connection: { saveData: true } }, warm);
    expect(w.timers.length).toBe(0);
    expect(warm).not.toHaveBeenCalled();
  });
  it("stop before load removes the listener", () => {
    const w = fakeWin();
    const stop = warmPaletteWhenSettled(w as never, { readyState: "loading" }, {}, vi.fn());
    stop();
    expect(w.listeners.load.length).toBe(0);
  });
});

describe("next page prefetch waits for load (R74)", () => {
  it("holds until the load event when the page is still loading", () => {
    const w = { ...fakeWin(), document: { readyState: "loading" } };
    const table: [string, () => Promise<unknown>][] = [["/app/inbox", vi.fn(() => Promise.resolve())]];
    prefetchWhenIdle(["/app/inbox"], w as never, {}, table as never, null);
    expect(w.timers.length).toBe(0);
    w.listeners.load[0]();
    w.timers.shift()!();
    expect(table[0][1]).toHaveBeenCalled();
  });
});
