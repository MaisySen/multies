/**
 * M2 (1.10.10): open a web page inside the app, signed in. The app asks the server for a one time code
 * (POST /api/auth/mobile/web-link) and opens the sign in link with it in the in-app browser, so there is no
 * second sign in. A server without that route (404) gets the plain page, which may ask the person to sign in; the
 * app remembers that for this session and stops asking.
 */
import * as WebBrowser from "expo-web-browser";
import type { Transport } from "@/api/transport";
import { API_BASE, FEATURES } from "@/config";
import { appPathOf, inAppOptions, openInSystemBrowser, opensInSystemBrowser, signedInUrl } from "./web-link";
import { router } from "expo-router";
import { nativeRoute } from "./nav-menu";
import { webTransport } from "./web-transport";

/** Opens any https page (policies, help, a public page) inside the app. Never another app. */
export async function openInApp(url: string): Promise<void> {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return;
  await WebBrowser.openBrowserAsync(url, inAppOptions()).catch(() => {});
}

/** Opens one of the web app's own pages inside the app, already signed in. */
export async function openWebPage(transport: Pick<Transport, "request">, path: string): Promise<void> {
  const url = await signedInUrl(transport, path);
  if (opensInSystemBrowser(path)) { await openInSystemBrowser(url); return; }
  await WebBrowser.openBrowserAsync(url, inAppOptions()).catch(() => {});
}

export { registerWebTransport } from "./web-transport";
export { appPathOf, inAppOptions, openInSystemBrowser, opensInSystemBrowser, resetWebLink, safeAppPath, signedInUrl } from "./web-link";

/** Any page: the web app's own pages open signed in, anything else https opens inside the app. */
export async function openWeb(urlOrPath: string): Promise<void> {
  const path = appPathOf(urlOrPath);
  if (path) {
    const current = webTransport();
    if (current) return openWebPage(current, path);
    if (opensInSystemBrowser(path)) { await openInSystemBrowser(`${API_BASE}${path}`); return; }
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
