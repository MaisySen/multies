import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isPageLoadError, isPageLoadFailure, loadPageModule, newerRelease, PageLoadError, reloadIntoRelease, RELOAD_KEY, type PageLoadDeps } from "../src/web/lib/page-load";
import { downgradePageLoadFailures } from "../src/web/lib/sentry";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
const fetchFail = () => new TypeError("Failed to fetch dynamically imported module: https://multies.si/assets/docs-AbC123.js");

function deps(over: Partial<PageLoadDeps> = {}) {
  const store = mem();
  const d: PageLoadDeps & { reload: ReturnType<typeof vi.fn>; wait: ReturnType<typeof vi.fn> } = {
    wait: vi.fn(async () => undefined),
    online: () => true,
    ownRelease: () => "aaa111",
    latestRelease: async () => "aaa111",
    storage: () => store,
    now: () => 1_000_000,
    reload: vi.fn(),
    ...over,
  } as never;
  return d;
}

describe("page load (R73)", () => {
  it("returns the named export on the first try", async () => {
    const d = deps();
    const C = () => null;
    await expect(loadPageModule(async () => ({ DocsPage: C }), "DocsPage", d)).resolves.toBe(C);
    expect(d.wait).not.toHaveBeenCalled();
  });

  it("retries once after a failed page file and then succeeds", async () => {
    const d = deps();
    const C = () => null;
    const load = vi.fn().mockRejectedValueOnce(fetchFail()).mockResolvedValueOnce({ DocsPage: C });
    await expect(loadPageModule(load, "DocsPage", d)).resolves.toBe(C);
    expect(load).toHaveBeenCalledTimes(2);
    expect(d.wait).toHaveBeenCalledTimes(1);
  });

  it("never yields undefined: a module without the export (or an undefined module) is a PageLoadError", async () => {
    // The Sentry case MYMAIL-WEB-B: the old preload handler made the import resolve to undefined, then m.DocsPage threw.
    const d = deps();
    const e1 = await loadPageModule(async () => undefined, "DocsPage", d).catch((e) => e);
    expect(isPageLoadError(e1)).toBe(true);
    const e2 = await loadPageModule(async () => ({ Other: () => null }), "DocsPage", d).catch((e) => e);
    expect(isPageLoadError(e2)).toBe(true);
    expect((e2 as PageLoadError).reason).toBe("missing");
    expect(String(e2)).not.toMatch(/Cannot read properties/);
  });

  it("offline: two tries, no version check, no reload, an offline PageLoadError", async () => {
    const latest = vi.fn(async () => "bbb222");
    const d = deps({ online: () => false, latestRelease: latest });
    const load = vi.fn().mockRejectedValue(fetchFail());
    const e = await loadPageModule(load, "DocsPage", d).catch((x) => x);
    expect(load).toHaveBeenCalledTimes(2);
    expect(latest).not.toHaveBeenCalled();
    expect(d.reload).not.toHaveBeenCalled();
    expect(isPageLoadError(e) && e.reason).toBe("offline");
  });

  it("online, same release live: no reload, a network PageLoadError", async () => {
    const d = deps();
    const e = await loadPageModule(vi.fn().mockRejectedValue(fetchFail()), "ToolsPage", d).catch((x) => x);
    expect(d.reload).not.toHaveBeenCalled();
    expect(isPageLoadError(e) && e.reason).toBe("network");
  });

  it("online, a newer release live: one reload, and the page stays pending", async () => {
    const d = deps({ latestRelease: async () => "bbb222" });
    let settled = false;
    void loadPageModule(vi.fn().mockRejectedValue(fetchFail()), "DocsPage", d).then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  });

  it("version.json unreachable or this build's release unknown: no reload", async () => {
    const d1 = deps({ latestRelease: async () => { throw new Error("offline"); } });
    await loadPageModule(vi.fn().mockRejectedValue(fetchFail()), "DocsPage", d1).catch(() => undefined);
    expect(d1.reload).not.toHaveBeenCalled();
    const d2 = deps({ ownRelease: () => null, latestRelease: async () => "bbb222" });
    await loadPageModule(vi.fn().mockRejectedValue(fetchFail()), "DocsPage", d2).catch(() => undefined);
    expect(d2.reload).not.toHaveBeenCalled();
  });

  it("a page whose own code throws is passed on untouched (a real bug, not a load failure)", async () => {
    const bug = new TypeError("x is not a function");
    const e = await loadPageModule(vi.fn().mockRejectedValue(bug), "DocsPage", deps()).catch((x) => x);
    expect(e).toBe(bug);
    expect(isPageLoadFailure(bug)).toBe(false);
  });

  it("reload guard: once per 30 s, once per release per 10 minutes, none when storage is blocked", () => {
    const store = mem(); const reload = vi.fn();
    let now = 1_000_000;
    const d = { storage: () => store, now: () => now, reload };
    expect(reloadIntoRelease("r2", d)).toBe(true);
    now += 5_000; expect(reloadIntoRelease("r3", d)).toBe(false);
    now += 60_000; expect(reloadIntoRelease("r2", d)).toBe(false);
    expect(reloadIntoRelease("r3", d)).toBe(true);
    now += 11 * 60_000; expect(reloadIntoRelease("r3", d)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(3);
    expect(JSON.parse(store.m.get(RELOAD_KEY) ?? "{}").release).toBe("r3");
    const blocked = { storage: () => ({ getItem: () => { throw new Error("blocked"); }, setItem: () => undefined }), now: () => 1, reload };
    expect(reloadIntoRelease("r9", blocked)).toBe(false);
  });

  it("newerRelease compares the build's release with version.json", async () => {
    expect(await newerRelease({ online: () => true, ownRelease: () => "a", latestRelease: async () => "b" })).toBe("b");
    expect(await newerRelease({ online: () => true, ownRelease: () => "a", latestRelease: async () => "a" })).toBe(null);
    expect(await newerRelease({ online: () => false, ownRelease: () => "a", latestRelease: async () => "b" })).toBe(null);
  });

  it("Sentry: page load failures go out as warnings, other errors stay errors", () => {
    const ev = (type: string, value: string) => ({ level: "error" as string | undefined, exception: { values: [{ type, value }] } });
    expect(downgradePageLoadFailures(ev("PageLoadError", "Could not load the page code for DocsPage (offline)")).level).toBe("warning");
    expect(downgradePageLoadFailures(ev("TypeError", "Failed to fetch dynamically imported module: https://x/a.js")).level).toBe("warning");
    expect(downgradePageLoadFailures(ev("TypeError", "Cannot read properties of undefined (reading 'x')")).level).toBe("error");
  });
});

// Every lazily loaded page goes through lazyPage, so none can skip the retry, the boundary or the named export check.
describe("lazy pages use lazyPage (R73)", () => {
  const root = path.resolve(__dirname, "../src/web");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(f) ? [p] : []; });
  const files = walk(root);
  it("no React.lazy outside components/lazy-page.tsx", () => {
    const offenders = files.filter((f) => !f.endsWith(path.join("components", "lazy-page.tsx"))).filter((f) => /(^|[^\w.])lazy\(|React\.lazy\(/.test(readFileSync(f, "utf8").replace(/z\.lazy\(/g, "")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
  it("every named page export exists in its module", () => {
    const router = readFileSync(path.join(root, "router.tsx"), "utf8");
    const helpers = new Map<string, string>();
    for (const m of router.matchAll(/const (\w+) = \(\) => import\("([^"]+)"\)/g)) helpers.set(m[1], m[2]);
    const pairs: [string, string][] = [];
    for (const m of router.matchAll(/lazyPage\(\(\) => (?:import\("([^"]+)"\)|(\w+)\(\)), "(\w+)"/g)) pairs.push([m[1] ?? helpers.get(m[2]) ?? "", m[3]]);
    expect(pairs.length).toBeGreaterThan(60);
    const missing = pairs.filter(([spec, name]) => {
      const base = path.resolve(root, spec.replace(/^\.\//, ""));
      const file = [".tsx", ".ts", "/index.tsx", "/index.ts"].map((e) => base + e).find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
      if (!file) return true;
      const src = readFileSync(file, "utf8");
      return !new RegExp(`export (?:async )?(?:function|const|class) ${name}\\b|export \\{[^}]*\\b${name}\\b`).test(src);
    });
    expect(missing).toEqual([]);
  });
});
