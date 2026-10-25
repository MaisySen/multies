import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loaderFor, prefetchOnIntent, prefetchRoute, prefetchWhenIdle, resetPrefetch, ROUTE_LOADERS, shouldHoldBack, type Loader } from "../src/web/lib/prefetch";

const table = () => {
  const calls: string[] = [];
  const mk = (name: string, fail = false): Loader => () => { calls.push(name); return fail ? Promise.reject(new Error("offline")) : Promise.resolve({}); };
  const t: [string, Loader][] = [["/app/my-work", mk("my-work")], ["/app/tasks", mk("tasks")], ["/app/mail", mk("mail", true)], ["/app", mk("dashboard")]];
  return { t, calls };
};

describe("R25 route prefetch", () => {
  beforeEach(() => resetPrefetch());

  it("matches the longest route prefix, and nothing outside the app pages", () => {
    const { t } = table();
    expect(loaderFor("/app/my-work", t)).toBe(t[0][1]);
    expect(loaderFor("/app/tasks?view=list&task=abc", t)).toBe(t[1][1]);
    expect(loaderFor("/app", t)).toBe(t[3][1]);
    expect(loaderFor("/app/unknown-page", t)).toBe(t[3][1]);
    expect(loaderFor("/apple", t)).toBeNull();
    expect(loaderFor("/api/tasks", t)).toBeNull();
    expect(loaderFor("/pricing", t)).toBeNull();
  });

  it("starts each page's code once", () => {
    const { t, calls } = table();
    expect(prefetchRoute("/app/tasks", t)).toBe(true);
    expect(prefetchRoute("/app/tasks?view=board", t)).toBe(false);
    expect(calls).toEqual(["tasks"]);
  });

  it("forgets a failed fetch so the next try runs", async () => {
    const { t, calls } = table();
    prefetchRoute("/app/mail", t);
    await new Promise((r) => setTimeout(r, 0));
    expect(prefetchRoute("/app/mail", t)).toBe(true);
    expect(calls).toEqual(["mail", "mail"]);
  });

  it("holds back on Save-Data and 2G", () => {
    expect(shouldHoldBack({ connection: { saveData: true } })).toBe(true);
    expect(shouldHoldBack({ connection: { effectiveType: "2g" } })).toBe(true);
    expect(shouldHoldBack({ connection: { effectiveType: "slow-2g" } })).toBe(true);
    expect(shouldHoldBack({ connection: { effectiveType: "4g" } })).toBe(false);
    expect(shouldHoldBack({})).toBe(false);
    expect(shouldHoldBack(undefined)).toBe(false);
  });

  it("warms the likely next pages when idle, and not at all on Save-Data", () => {
    const { t, calls } = table();
    const idle = vi.fn((cb: () => void) => { cb(); return 1; });
    prefetchWhenIdle(["/app/my-work", "/app/tasks"], { requestIdleCallback: idle, setTimeout: vi.fn() }, {}, t);
    expect(idle).toHaveBeenCalledOnce();
    expect(calls).toEqual(["my-work", "tasks"]);
    resetPrefetch();
    const idle2 = vi.fn();
    prefetchWhenIdle(["/app/my-work"], { requestIdleCallback: idle2, setTimeout: vi.fn() }, { connection: { saveData: true } }, t);
    expect(idle2).not.toHaveBeenCalled();
  });

  it("falls back to a timer where there is no idle callback", () => {
    const { t } = table();
    const timer = vi.fn();
    prefetchWhenIdle(["/app/tasks"], { setTimeout: timer }, {}, t);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 2000);
  });

  it("hover, touch or focus on a link to one of our pages warms it; other links do nothing", () => {
    const { t, calls } = table();
    const handlers: Record<string, (e: Event) => void> = {};
    const doc = { addEventListener: (k: string, h: (e: Event) => void) => { handlers[k] = h; }, removeEventListener: vi.fn() };
    const stop = prefetchOnIntent(doc as never, t);
    const link = (href: string) => ({ target: { closest: () => ({ getAttribute: () => href }) } }) as unknown as Event;
    handlers.pointerover(link("/app/tasks"));
    handlers.focusin(link("https://example.com/app/mail"));
    handlers.touchstart(link("//evil.example/app/my-work"));
    handlers.pointerover({ target: null } as unknown as Event);
    expect(calls).toEqual(["tasks"]);
    stop();
    expect(doc.removeEventListener).toHaveBeenCalledTimes(3);
  });

  it("every prefetched module is one the router lazy loads (same chunk), and sign-in is not in the first bundle", () => {
    const router = readFileSync("src/web/router.tsx", "utf8");
    const src = readFileSync("src/web/lib/prefetch.ts", "utf8");
    const modules = [...src.matchAll(/import\("\.\.\/(pages\/[^"]+)"\)/g)].map((m) => m[1]);
    expect(modules.length).toBe(ROUTE_LOADERS.length);
    for (const m of modules) expect(router, m).toContain(`import("./${m}")`);
    expect(router).not.toMatch(/^import .* from "\.\/pages\/(auth|pricing|agents|oauth-authorize)";$/m);
  });
});
