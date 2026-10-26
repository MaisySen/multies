/**
 * R32: the Multies service worker. Built to dist/web/sw.js by scripts/build-sw.ts (esbuild, one file, no
 * imports at run time). The decisions live in sw-routes.ts so the tests cover them.
 * Messages from the page: {type:"SKIP_WAITING"} (the update prompt), {type:"CLEAR_CACHES"} (sign out).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { cacheNames, clickTarget, isStorable, isStorableApi, typeMatches, NAV_TIMEOUT_MS, notificationFor, OFFLINE_PATH, pushDecision, SHELL_KEY, staleCaches, swStrategy, CACHE_PREFIX } from "./sw-routes";

declare const __SW_VERSION__: string;
declare const __SW_PRECACHE__: string[];
const sw = self as any;
const VERSION = __SW_VERSION__;
const NAMES = cacheNames(VERSION);

/** Stores a copy only when the body is what the path says; a full quota drops our caches instead of failing. */
async function keep(cacheName: string, key: string | Request, res: Response, storable: (r: Response) => boolean = isStorable): Promise<void> {
  const path = typeof key === "string" ? key : new URL(key.url).pathname;
  if (!storable(res) || !typeMatches(path, res.headers.get("content-type"))) return;
  try { await (await caches.open(cacheName)).put(key, res); }
  catch (e) {
    if ((e as { name?: string })?.name === "QuotaExceededError") {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
    }
  }
}

sw.addEventListener("install", (event: any) => {
  event.waitUntil((async () => {
    // The shell and the offline page; a failure here must not block the install (the next visit fills it).
    await Promise.all([SHELL_KEY, OFFLINE_PATH].map(async (p) => {
      try { await keep(NAMES.shell, p, await fetch(p, { credentials: "same-origin", cache: "no-cache" })); } catch { /* offline at install */ }
    }));
    await Promise.all(__SW_PRECACHE__.map(async (p) => {
      try { await keep(NAMES.static, p, await fetch(p)); } catch { /* fetched on first use instead */ }
    }));
  })());
  // A new worker waits until the page says so (the update prompt posts SKIP_WAITING).
});

sw.addEventListener("activate", (event: any) => {
  event.waitUntil((async () => {
    await Promise.all(staleCaches(await caches.keys(), VERSION).map((k) => caches.delete(k)));
    await sw.clients.claim();
  })());
});

sw.addEventListener("message", (event: any) => {
  const type = event.data?.type;
  if (type === "SKIP_WAITING") void sw.skipWaiting();
  if (type === "CLEAR_CACHES") {
    event.waitUntil?.((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
      event.ports?.[0]?.postMessage({ ok: true });
    })());
  }
});

sw.addEventListener("fetch", (event: any) => {
  const req: Request = event.request;
  const strategy = swStrategy(req, sw.location.origin);
  if (strategy === "network") return;
  if (strategy === "shell") event.respondWith(shellFirst(event));
  else if (strategy === "static") event.respondWith(cacheFirst(req));
  else event.respondWith(networkThenStored(event));
});

async function shellFirst(event: any): Promise<Response> {
  const network = fetch(event.request).then(async (res) => {
    if (res.ok) event.waitUntil(keep(NAMES.shell, SHELL_KEY, res.clone()));
    return res;
  });
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), NAV_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch { /* offline */ }
  const shell = await caches.open(NAMES.shell);
  const cached = (await shell.match(SHELL_KEY)) ?? (await shell.match(OFFLINE_PATH));
  if (cached) return cached;
  try { return await network; } catch { return offlineFallback(); }
}

async function cacheFirst(req: Request): Promise<Response> {
  const cache = await caches.open(NAMES.static);
  const hit = await cache.match(req, { ignoreSearch: false });
  if (hit) return hit;
  const res = await fetch(req);
  void keep(NAMES.static, req, res.clone());
  return res;
}

/** api-offline: fresh from the network; the stored copy only when the network fails. */
async function networkThenStored(event: any): Promise<Response> {
  const req: Request = event.request;
  try {
    const res = await fetch(req);
    event.waitUntil(keep(NAMES.api, req, res.clone(), isStorableApi));
    return res;
  } catch (e) {
    const hit = await (await caches.open(NAMES.api)).match(req);
    if (hit) return hit;
    throw e;
  }
}

function offlineFallback(): Response {
  return new Response("<!doctype html><meta charset=utf-8><title>You are offline</title><p style=\"font:15px system-ui;padding:40px;text-align:center\">You are offline. Multies opens again when you reconnect.</p>", {
    status: 503, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
  });
}

sw.addEventListener("push", (event: any) => {
  let data: unknown;
  try { data = event.data?.json() ?? {}; } catch { data = {}; }
  const n = notificationFor(data);
  // R33: skip the banner when the page is already open and in front; drop pushes past their TTL.
  event.waitUntil((async () => {
    const wins = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    const decision = pushDecision(data, wins.map((w: any) => ({ url: w.url, focused: w.focused, visibilityState: w.visibilityState })), sw.location.origin);
    if (decision.action === "drop") return;
    if (decision.action === "skip" && decision.client !== undefined) {
      wins[decision.client].postMessage({ type: "PUSH_ON_PAGE", url: n.options.data.url, tag: n.options.tag });
      return;
    }
    await sw.registration.showNotification(n.title, n.options);
  })());
});

sw.addEventListener("notificationclick", (event: any) => {
  event.notification.close();
  const url = clickTarget(event.notification.data?.url);
  event.waitUntil((async () => {
    const wins = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find((w: any) => new URL(w.url).origin === sw.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: "OPEN_URL", url });
      return;
    }
    await sw.clients.openWindow(url);
  })());
});

// The browser rotated this subscription: save the new one (the cookie rides along).
sw.addEventListener("pushsubscriptionchange", (event: any) => {
  event.waitUntil((async () => {
    const opts = event.oldSubscription?.options;
    if (!opts) return;
    const sub = await sw.registration.pushManager.subscribe(opts);
    await fetch("/api/push/web", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
  })());
});
