import { describe, it, expect } from "vitest";
import { API_SWR_PATHS, cacheNames, clickTarget, isStorable, isStorableApi, notificationFor, staleCaches, swStrategy, typeMatches } from "@/web/sw/sw-routes";
import { precacheList } from "@/shared/sw-precache";
import { appCsp } from "@/server/lib/security-headers";
import { CLEAR_CACHES_MESSAGE } from "@/web/lib/sw-client";

const O = "https://multies.si";
const req = (url: string, init: { method?: string; mode?: string; auth?: string } = {}) => ({ method: init.method ?? "GET", url, mode: init.mode, headers: { get: (n: string) => (n === "authorization" ? init.auth ?? null : null) } });
const res = (status: number, headers: Record<string, string> = {}, type = "basic") => ({ ok: status >= 200 && status < 300, status, type, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });

describe("service worker routes (R32)", () => {
  it("serves /app page loads network first with the cached shell behind", () => {
    expect(swStrategy(req(`${O}/app`, { mode: "navigate" }), O)).toBe("shell");
    expect(swStrategy(req(`${O}/app/mail?m=1`, { mode: "navigate" }), O)).toBe("shell");
    expect(swStrategy(req(`${O}/login`, { mode: "navigate" }), O)).toBe("network");
    expect(swStrategy(req(`${O}/`, { mode: "navigate" }), O)).toBe("network");
    expect(swStrategy(req(`${O}/apples`, { mode: "navigate" }), O)).toBe("network");
  });

  it("keeps hashed files and icons cache first", () => {
    expect(swStrategy(req(`${O}/assets/index-abc123.js`), O)).toBe("static");
    expect(swStrategy(req(`${O}/icon-192.png`), O)).toBe("static");
    expect(swStrategy(req(`${O}/offline.html`), O)).toBe("static");
    expect(swStrategy(req(`${O}/route-chunks.json`), O)).toBe("network");
  });

  it("stores only the short allow list the frame needs, network first, and never auth, mail or work lists", () => {
    expect(API_SWR_PATHS).toEqual(["/api/config", "/api/account/providers", "/api/account/me"]);
    expect(swStrategy(req(`${O}/api/config`), O)).toBe("api-offline");
    expect(swStrategy(req(`${O}/api/account/me`), O)).toBe("api-offline");
    expect(swStrategy(req(`${O}/api/config?x=1`), O)).toBe("network");
    for (const p of ["/api/auth/get-session", "/api/mail/messages", "/api/me", "/api/messages/msg_1", "/api/push/web", "/api/tasks", "/api/account/me/sessions"]) expect(swStrategy(req(`${O}${p}`), O)).toBe("network");
    expect(swStrategy(req(`${O}/api/config`, { method: "POST" }), O)).toBe("network");
    expect(swStrategy(req(`${O}/api/config`, { auth: "Bearer x" }), O)).toBe("network");
  });

  it("keeps an allow listed API answer only when it is a plain JSON 200 with no cookie", () => {
    const json = { "content-type": "application/json", "cache-control": "no-store" };
    expect(isStorableApi(res(200, json))).toBe(true);
    expect(isStorableApi(res(200, { ...json, "set-cookie": "a=b" }))).toBe(false);
    expect(isStorableApi(res(401, json))).toBe(false);
    expect(isStorableApi(res(200, { "content-type": "text/html" }))).toBe(false);
    expect(isStorableApi(res(200, json, "opaque"))).toBe(false);
    // The general rule still refuses no-store everywhere else.
    expect(isStorable(res(200, json))).toBe(false);
  });

  it("ignores other origins and anything that is not a GET", () => {
    expect(swStrategy(req("https://cdn.example.com/assets/a.js"), O)).toBe("network");
    expect(swStrategy(req(`${O}/assets/a.js`, { method: "HEAD" }), O)).toBe("network");
    expect(swStrategy(req("not a url"), O)).toBe("network");
  });

  it("stores only plain 200s that are not private, no-store, cookie bound or opaque", () => {
    expect(isStorable(res(200, { "cache-control": "public, no-cache" }))).toBe(true);
    expect(isStorable(res(200, { "cache-control": "private, no-cache" }))).toBe(false);
    expect(isStorable(res(200, { "cache-control": "no-store" }))).toBe(false);
    expect(isStorable(res(200, { "set-cookie": "a=b" }))).toBe(false);
    expect(isStorable(res(200, { vary: "Cookie, Authorization" }))).toBe(false);
    expect(isStorable(res(200, {}, "opaque"))).toBe(false);
    expect(isStorable(res(206))).toBe(false);
    expect(isStorable(res(404))).toBe(false);
  });

  it("names caches by release and deletes only our other versions on activate", () => {
    expect(cacheNames("r32")).toEqual({ shell: "multies-shell-r32", static: "multies-static-r32", api: "multies-api-r32" });
    expect(staleCaches(["multies-shell-r31", "multies-static-r31", "multies-shell-r32", "other-app"], "r32")).toEqual(["multies-shell-r31", "multies-static-r31"]);
  });

  it("opens only same origin /app paths from a notification and stacks by tag", () => {
    expect(clickTarget("/app/tasks?task=t1")).toBe("/app/tasks?task=t1");
    expect(clickTarget("https://evil.example/app")).toBe("/app/notifications");
    expect(clickTarget("//evil.example/app")).toBe("/app/notifications");
    expect(clickTarget("/apples")).toBe("/app/notifications");
    expect(clickTarget(undefined)).toBe("/app/notifications");
    const n = notificationFor({ title: "Maya assigned you Q3 plan", url: "/app/tasks?task=t1", tag: "task:t1" });
    expect(n).toEqual({ title: "Maya assigned you Q3 plan", options: { body: "Open in Multies", icon: "/icon-192.png", badge: "/favicon-32.png", tag: "task:t1", renotify: false, data: { url: "/app/tasks?task=t1" } } });
    expect(notificationFor(null).title).toBe("Multies");
  });

  it("sign out asks the worker to clear its caches", () => {
    expect(CLEAR_CACHES_MESSAGE).toEqual({ type: "CLEAR_CACHES" });
  });

  it("precaches the entry, its static imports, CSS and fonts, not lazy pages", () => {
    const list = precacheList({
      "index.html": { file: "assets/index-a.js", isEntry: true, imports: ["_vendor-react"], css: ["assets/index-a.css"], assets: ["assets/inter-latin.woff2", "assets/x.map"] },
      _vendor: { file: "assets/vendor-react-b.js" },
      "_vendor-react": { file: "assets/vendor-react-b.js", imports: ["index.html"] },
      "src/web/pages/app/mail.tsx": { file: "assets/mail-c.js" },
    });
    expect(list).toEqual(["/assets/index-a.css", "/assets/index-a.js", "/assets/inter-latin.woff2", "/assets/vendor-react-b.js"]);
    expect(() => precacheList({})).toThrow();
  });

  it("CSP lets our own service worker run, with no wildcard", () => {
    const csp = appCsp();
    const worker = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("worker-src"));
    expect(worker).toBe("worker-src 'self' blob:");
    expect(csp).not.toMatch(/worker-src[^;]*\*/);
    expect(csp).toContain("manifest-src 'self'");
  });

  it("keeps a body only when it is what the path says (no HTML stored as a chunk, only HTML as the shell)", () => {
    expect(typeMatches("/assets/index-abc.js", "text/javascript; charset=utf-8")).toBe(true);
    expect(typeMatches("/assets/index-abc.js", "text/html")).toBe(false);
    expect(typeMatches("/assets/index-abc.css", "text/css")).toBe(true);
    expect(typeMatches("/assets/index-abc.css", "text/html")).toBe(false);
    expect(typeMatches("/app", "text/html; charset=utf-8")).toBe(true);
    expect(typeMatches("/app", "application/json")).toBe(false);
    expect(typeMatches("/offline.html", "text/plain")).toBe(false);
    expect(typeMatches("/api/config", "application/json")).toBe(true);
    expect(typeMatches("/icon-192.png", "image/png")).toBe(true);
  });
});
