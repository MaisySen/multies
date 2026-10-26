import { describe, expect, it, vi } from "vitest";
import { AUTH_CONFIG_PRELOAD, AUTH_PROVIDERS_PRELOAD, BRAND_CACHE, htmlCacheControl, originHintsFor, withOriginHints, withProvidersPreload } from "../src/shared/prerender-shell";
import { captureError, queueEarlyErrors, queuedErrorCount, scheduleSentry } from "../src/web/lib/sentry";

const shell = "<html><head><title>x</title></head><body><div id=\"root\"></div></body></html>";

describe("R34 sign in shell hints", () => {
  it("preloads the providers answer once, inside head", () => {
    const html = withProvidersPreload(withProvidersPreload(shell));
    expect(html.split(AUTH_PROVIDERS_PRELOAD)).toHaveLength(2);
    expect(html.indexOf(AUTH_PROVIDERS_PRELOAD)).toBeLessThan(html.indexOf("</head>"));
    expect(AUTH_PROVIDERS_PRELOAD).toContain('as="fetch"');
    expect(AUTH_PROVIDERS_PRELOAD).toContain("crossorigin");
    expect(html.split(AUTH_CONFIG_PRELOAD)).toHaveLength(2);
    expect(html.indexOf(AUTH_CONFIG_PRELOAD)).toBeLessThan(html.indexOf("</head>"));
  });

  it("preconnects to the error tracker host from the DSN, and to nothing else", () => {
    const hints = originHintsFor("https://abc123@o4512303523299328.ingest.us.sentry.io/4512303530000000");
    expect(hints).toBe('<link rel="preconnect" href="https://o4512303523299328.ingest.us.sentry.io" crossorigin><link rel="dns-prefetch" href="https://o4512303523299328.ingest.us.sentry.io">');
    expect(originHintsFor(undefined)).toBe("");
    expect(originHintsFor("not a url")).toBe("");
    expect(originHintsFor("http://k@o1.ingest.sentry.io/1")).toBe("");
    expect(originHintsFor("https://k@evil.example/1")).toBe("");
    expect(originHintsFor("https://k@sentry.io.evil.example/1")).toBe("");
    const html = withOriginHints(shell, hints);
    expect(withOriginHints(html, hints)).toBe(html);
    expect(html).toContain(`${hints}</head>`);
    expect(withOriginHints(shell, "")).toBe(shell);
  });

  it("HTML documents carry no-transform, keeping their directives", () => {
    expect(htmlCacheControl("no-cache")).toBe("no-cache, no-transform");
    expect(htmlCacheControl()).toBe("no-cache, no-transform");
    expect(htmlCacheControl("no-cache, no-transform")).toBe("no-cache, no-transform");
    expect(BRAND_CACHE).toMatch(/max-age=31536000/);
  });
});

describe("R34 error tracking after first paint", () => {
  it("queues errors raised before the SDK loads, up to 10, and stops listening when told", () => {
    const target = new EventTarget() as unknown as Window;
    const before = queuedErrorCount();
    const stop = queueEarlyErrors(target);
    const err = Object.assign(new Event("error"), { error: new Error("boom") });
    target.dispatchEvent(err);
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("nope") }));
    expect(queuedErrorCount()).toBe(Math.min(10, before + 2));
    stop();
    target.dispatchEvent(Object.assign(new Event("error"), { error: new Error("late") }));
    expect(queuedErrorCount()).toBe(Math.min(10, before + 2));
    for (let i = 0; i < 20; i++) captureError(new Error(String(i)));
    expect(queuedErrorCount()).toBe(10);
  });

  it("waits for the load event, then for idle, before starting", () => {
    const listeners: Record<string, () => void> = {};
    const idle = vi.fn();
    const win = {
      document: { readyState: "loading" },
      addEventListener: vi.fn((type: string, fn: () => void) => { listeners[type] = fn; }),
      removeEventListener: vi.fn(),
      requestIdleCallback: idle,
      setTimeout: vi.fn(),
    } as unknown as Window & typeof globalThis;
    scheduleSentry(win);
    expect(idle).not.toHaveBeenCalled();
    listeners.load();
    expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 4000 });
  });

  it("starts at once (when idle) on a page that has already loaded", () => {
    const idle = vi.fn();
    const win = { document: { readyState: "complete" }, addEventListener: vi.fn(), removeEventListener: vi.fn(), requestIdleCallback: idle, setTimeout: vi.fn() } as unknown as Window & typeof globalThis;
    scheduleSentry(win);
    expect(idle).toHaveBeenCalledTimes(1);
  });
});
