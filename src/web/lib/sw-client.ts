/**
 * R32: the page side of the service worker (public/ built from src/web/sw/sw.ts) and browser notifications.
 *  - registerServiceWorker: production builds only, on https or localhost, after load. Automated browsers
 *    skip it unless localStorage "mymail-sw" is "1" (the E2E sets it).
 *  - A new worker waits; "mymail:sw-update" fires on window so the update prompt can offer a reload, and
 *    applyServiceWorkerUpdate() tells it to take over (SKIP_WAITING), then the page reloads once.
 *  - clearOfflineData() runs on sign out: this browser's push subscription is removed and every Multies
 *    cache is deleted, so the next person on this device sees nothing of the last one's.
 */
import { api } from "./api";
import { clearMeCache } from "./me-cache";
import { wipeOfflineLists } from "./offline-lists"; // R33

export const SW_UPDATE_EVENT = "mymail:sw-update";
/** R33: fired on window when the worker skipped a notification because this page is already showing it. */
export const PUSH_ON_PAGE_EVENT = "mymail:push-on-page";
const CACHE_PREFIX = "multies-";

function allowedHere(): boolean {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return false;
  const { protocol, hostname } = window.location;
  if (protocol !== "https:" && hostname !== "localhost" && hostname !== "127.0.0.1") return false;
  let forced = false;
  try { forced = localStorage.getItem("mymail-sw") === "1"; } catch { /* storage blocked */ }
  if (navigator.webdriver && !forced) return false;
  return true;
}

let registration: ServiceWorkerRegistration | null = null;

export function registerServiceWorker(opts: { navigate?: (url: string) => void } = {}) {
  if (!import.meta.env.PROD || !allowedHere()) return;
  const start = async () => {
    try {
      registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const announce = () => window.dispatchEvent(new CustomEvent(SW_UPDATE_EVENT));
      if (registration.waiting && navigator.serviceWorker.controller) announce();
      registration.addEventListener("updatefound", () => {
        const next = registration?.installing;
        next?.addEventListener("statechange", () => { if (next.state === "installed" && navigator.serviceWorker.controller) announce(); });
      });
    } catch { /* the app runs without offline support */ }
  };
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: string } | null;
    if (d?.type === "OPEN_URL" && typeof d.url === "string" && d.url.startsWith("/app")) opts.navigate?.(d.url);
    // R33: a push for the page already open was not shown; the page refreshes what it shows instead.
    if (d?.type === "PUSH_ON_PAGE") window.dispatchEvent(new CustomEvent(PUSH_ON_PAGE_EVENT, { detail: { url: d.url } }));
  });
  if (document.readyState === "complete") void start();
  else window.addEventListener("load", () => void start(), { once: true });
}

/** True when a newer version is installed and waiting. */
export function serviceWorkerUpdateWaiting(): boolean {
  return !!registration?.waiting;
}

/** The update prompt calls this: the waiting worker takes over and the page reloads once. */
export function applyServiceWorkerUpdate() {
  const waiting = registration?.waiting;
  if (!waiting) { window.location.reload(); return; }
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded) { reloaded = true; window.location.reload(); } });
  waiting.postMessage({ type: "SKIP_WAITING" });
}

/** The message a page posts so the worker drops every cache it holds (also done from the page itself). */
export const CLEAR_CACHES_MESSAGE = { type: "CLEAR_CACHES" } as const;

/** Sign out: forget this browser's push subscription, then delete every Multies cache. Never throws. */
export async function clearOfflineData(): Promise<void> {
  await wipeOfflineLists(); // R33: stored list copies go with the caches
  clearMeCache(); // R40 (MB-200): and the saved account copy
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager?.getSubscription();
      if (sub) {
        await api.del("/push/web", { endpoint: sub.endpoint }).catch(() => null);
        await sub.unsubscribe().catch(() => false);
      }
      navigator.serviceWorker.controller?.postMessage(CLEAR_CACHES_MESSAGE);
    }
  } catch { /* nothing to clear */ }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
    }
  } catch { /* storage blocked */ }
}

export type BrowserPushState = "unsupported" | "denied" | "on" | "off";

export function browserPushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function browserPushState(): Promise<BrowserPushState> {
  if (!browserPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

/** base64url to bytes, for applicationServerKey. */
export function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const norm = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** Asks for permission, subscribes this browser and saves it. Returns the new state. */
export async function enableBrowserPush(publicKey: string): Promise<BrowserPushState> {
  if (!browserPushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await readyRegistration();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.post("/push/web", { endpoint: json.endpoint, keys: json.keys });
  return "on";
}

export async function disableBrowserPush(): Promise<BrowserPushState> {
  if (!browserPushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.del("/push/web", { endpoint: sub.endpoint }).catch(() => null);
    await sub.unsubscribe().catch(() => false);
  }
  return "off";
}
