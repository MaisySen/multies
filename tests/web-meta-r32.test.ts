import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { makeTestApp } from "./helpers";
import { versionPayload } from "@/server/routes/web-meta-r32";
import { LLMS_FULL_TXT, LLMS_TXT } from "@/server/generated/llms.generated";
import { buildLlms, LINKS, PUBLIC_DOCS, renderModule, SITE } from "../scripts/build-llms";
import { compareRelease, POLL_MS, watchRelease, type VersionInfo } from "@/web/lib/update-check";
import { firstOpenStatus, snoozePresets } from "@/web/pages/app/work/triage";

describe("R32 /version.json", () => {
  it("answers the release, critical only when CRITICAL_RELEASE matches, never cached", async () => {
    expect(versionPayload("abc", undefined)).toEqual({ release: "abc", critical: false });
    expect(versionPayload("abc", "old")).toEqual({ release: "abc", critical: false });
    expect(versionPayload("abc", "abc")).toEqual({ release: "abc", critical: true });
    const ctx = await makeTestApp({ RELEASE: "r32test", CRITICAL_RELEASE: "r32test" });
    const res = await ctx.app.request("/version.json", { headers: { host: "localhost" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ release: "r32test", critical: true });
  });
});

describe("R32 update prompt logic", () => {
  const v = (release: string, critical = false): VersionInfo => ({ release, critical });
  it("compares releases", () => {
    expect(compareRelease("a", v("a"), null)).toBe("none");
    expect(compareRelease("a", v("b"), null)).toBe("prompt");
    expect(compareRelease("a", v("b"), "b")).toBe("none");
    expect(compareRelease("a", v("b", true), "b")).toBe("critical");
    expect(compareRelease(null, v("b"), null)).toBe("none");
    expect(compareRelease("a", null, null)).toBe("none");
  });
  it("polls every 10 minutes and on focus, skips hidden tabs, and stops", async () => {
    vi.useFakeTimers();
    try {
      let release = "one"; let hidden = false; let focus: () => void = () => {};
      const fetchVersion = vi.fn(async () => v(release));
      const onChange = vi.fn();
      const stop = watchRelease({
        fetchVersion, onChange, isHidden: () => hidden, dismissed: () => null,
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
        onFocus: (fn) => { focus = fn; return () => { focus = () => {}; }; },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchVersion).toHaveBeenCalledTimes(1);
      release = "two";
      hidden = true;
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(fetchVersion).toHaveBeenCalledTimes(1);
      hidden = false;
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(fetchVersion).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith("prompt", v("two"));
      focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchVersion).toHaveBeenCalledTimes(3);
      stop();
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(fetchVersion).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});

describe("R32 llms.txt", () => {
  it("serves both files as text/plain, cached an hour, and they match the docs (no drift)", async () => {
    const ctx = await makeTestApp();
    for (const p of ["/llms.txt", "/llms-full.txt"]) {
      const r = await ctx.app.request(p, { headers: { host: "localhost" } });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(r.headers.get("cache-control")).toContain("max-age=3600");
    }
    const fresh = buildLlms();
    expect(fresh.llms).toBe(LLMS_TXT);
    expect(fresh.full).toBe(LLMS_FULL_TXT);
    expect(readFileSync("src/server/generated/llms.generated.ts", "utf8")).toBe(renderModule(fresh));
    expect(LLMS_TXT.startsWith("# Multies\n\n> ")).toBe(true);
  });
  it("holds public docs only: no runbooks, notes, credentials or secret-looking values", () => {
    for (const d of PUBLIC_DOCS) expect(d.file).not.toMatch(/runbook|NOTES|CREDENTIALS|plan|strategy|qa\//i);
    for (const t of [LLMS_TXT, LLMS_FULL_TXT]) {
      expect(t).not.toMatch(/docs\/runbooks|CREDENTIALS\.local|tab\.bot/i);
      expect(t).not.toMatch(/\b(sk|rk)_live_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY/);
    }
  });
  it("links only public routes on the site, each answering without sign-in", async () => {
    const ctx = await makeTestApp();
    const urls = [...LLMS_TXT.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(3);
    for (const u of urls) {
      expect(u.startsWith(SITE + "/")).toBe(true);
      const path = new URL(u).pathname;
      expect(LINKS.map((l) => l.path)).toContain(path);
      if (path === "/") continue; // the SPA home is served by the static assets
      const r = await ctx.app.request(path, { headers: { host: "localhost" } });
      expect(r.status, path).toBe(200);
    }
  });
});

describe("R32 triage page helpers", () => {
  it("picks the first open status and snooze presets in the future", () => {
    expect(firstOpenStatus([{ id: "d", category: "done", position: 2 }, { id: "t", category: "todo", position: 1 }, { id: "x", category: "todo", position: 0 }])).toBe("x");
    expect(firstOpenStatus(undefined)).toBe("");
    const now = new Date("2026-10-28T15:00:00");
    const p = snoozePresets(now);
    expect(p.map((x) => x.label)).toEqual(["Tomorrow", "Next Monday", "In a week"]);
    for (const x of p) expect(x.until.getTime()).toBeGreaterThan(now.getTime());
    expect(p[1].until.getDay()).toBe(1);
  });
});
