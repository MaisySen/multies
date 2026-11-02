/**
 * M2 (1.10.10): open a web page inside the app, signed in. The app asks the server for a one time code
 * (POST /api/auth/mobile/web-link) and opens the sign in link with it in the in-app browser, so there is no
 * second sign in. A server without that route (404) gets the plain page, which may ask the person to sign in; the
 * app remembers that for this session and stops asking.
 */
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import type { Transport } from "@/api/transport";
import { isApiError } from "@/api/transport";
import { API_BASE, FEATURES } from "@/config";
import { colors } from "@/theme";
import { router } from "expo-router";
import { nativeRoute } from "./nav-menu";
import { webTransport } from "./web-transport";

let linkMissing = false;
export function resetWebLink() { linkMissing = false; }

/** Only pages inside the app (never another host, never a full URL from outside). */
export const safeAppPath = (p: string) => (typeof p === "string" && /^\/app(\/|$|\?|#)/.test(p) && !p.includes("//") ? p : "/app");

/**
 * The URL to open: the server's one time sign in link (MH1: POST /api/auth/mobile/web-link answers a code good for
 * 60 s, then /auth/mobile/web?code=..&next=/app/.. signs the browser in and goes to the page), else the page itself.
 * A fresh code per tap, never kept, logged or reported. 404 (switched off or an older server) is remembered for this
 * session; anything else (signed out, rate limited) just opens the plain page this time.
 */
export async function signedInUrl(transport: Pick<Transport, "request">, path: string, base = API_BASE): Promise<string> {
  const next = safeAppPath(path);
  const plain = `${base}${next}`;
  if (linkMissing) return plain;
  try {
    const r = await transport.request<{ code?: string }>("POST", "/auth/mobile/web-link", { next });
    const code = typeof r?.code === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(r.code) ? r.code : null;
    return code ? `${base}/auth/mobile/web?code=${code}&next=${encodeURIComponent(next)}` : plain;
  } catch (e) {
    if (isApiError(e) && (e.status === 404 || e.status === 405)) linkMissing = true;
    return plain;
  }
}

/**
 * M3 (1.10.11): how every page opens inside the app. iOS: a sheet over the app with a Done button in the app's colours.
 * Android: a custom tab in the app's own task (createTask false), so it never shows up as a separate Chrome window and
 * the back button returns to the screen it came from. Toolbar follows light and dark.
 */
export function inAppOptions(): WebBrowser.WebBrowserOpenOptions {
  return {
    dismissButtonStyle: "done", controlsColor: colors.brand, toolbarColor: colors.bg, secondaryToolbarColor: colors.bg,
    showTitle: true, enableBarCollapsing: true, createTask: false,
    ...(Platform.OS === "ios" ? { presentationStyle: (WebBrowser.WebBrowserPresentationStyle?.PAGE_SHEET ?? "pageSheet") as WebBrowser.WebBrowserPresentationStyle } : {}),
  };
}

/** Opens any https page (policies, help, a public page) inside the app. Never another app. */
export async function openInApp(url: string): Promise<void> {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return;
  await WebBrowser.openBrowserAsync(url, inAppOptions()).catch(() => {});
}

/** Opens one of the web app's own pages inside the app, already signed in. */
export async function openWebPage(transport: Pick<Transport, "request">, path: string): Promise<void> {
  const url = await signedInUrl(transport, path);
  await WebBrowser.openBrowserAsync(url, inAppOptions()).catch(() => {});
}

export { registerWebTransport } from "./web-transport";

/** The /app path of a URL on this server ("https://multies.si/app/x?y" or "/app/x?y"), else null. */
export function appPathOf(urlOrPath: string, base = API_BASE): string | null {
  if (typeof urlOrPath !== "string") return null;
  let rest = urlOrPath;
  if (rest.startsWith(base)) rest = rest.slice(base.length);
  if (!rest.startsWith("/")) return null;
  return safeAppPath(rest) === rest ? rest : null;
}

/** Any page: the web app's own pages open signed in, anything else https opens inside the app. */
export async function openWeb(urlOrPath: string): Promise<void> {
  const path = appPathOf(urlOrPath);
  if (path) {
    const current = webTransport();
    if (current) return openWebPage(current, path);
    return openInApp(`${API_BASE}${path}`);
  }
  return openInApp(urlOrPath);
}

/** A web app page: its app screen when there is one, else the page inside the app, signed in. */
export async function openAppPath(urlOrPath: string): Promise<void> {
  const path = appPathOf(urlOrPath);
  const screen = path ? nativeRoute(path, { tasks: FEATURES.tasks }) : null;
  if (screen) { router.push(screen as never); return; }
  return openWeb(urlOrPath);
}
