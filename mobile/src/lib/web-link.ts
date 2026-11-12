/**
 * MFIX1 (1.10.16): the router free half of web-open.ts (sign in links, which pages leave the app, the phone's own
 * browser), so meetings.ts can use it without loading the router. web-open.ts re-exports all of it.
 */
import { Linking, Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import type { Transport } from "@/api/transport";
import { isApiError } from "@/api/transport";
import { API_BASE } from "@/config";
import { colors } from "@/theme";

// PRIV1b (P35): a 404 or 405 is remembered for 10 minutes, not until the app restarts; sign in and sign out forget it.
export const LINK_MISSING_MS = 10 * 60_000;
let linkMissingAt = 0;
export function resetWebLink() { linkMissingAt = 0; }

/** Only pages inside the app (never another host, never a full URL from outside). */
export const safeAppPath = (p: string) => (typeof p === "string" && /^\/app(\/|$|\?|#)/.test(p) && !p.includes("//") ? p : "/app");

/**
 * The URL to open: the server's one time sign in link (MH1: POST /api/auth/mobile/web-link answers a code good for
 * 60 s, then /auth/mobile/web?code=..&next=/app/.. signs the browser in and goes to the page), else the page itself.
 * A fresh code per tap, never kept, logged or reported. 404 (switched off or an older server) is remembered for ten
 * minutes; anything else (signed out, rate limited) just opens the plain page this time.
 */
export async function signedInUrl(transport: Pick<Transport, "request">, path: string, base = API_BASE): Promise<string> {
  const next = safeAppPath(path);
  const plain = `${base}${next}`;
  if (linkMissingAt && Date.now() - linkMissingAt < LINK_MISSING_MS) return plain;
  try {
    const r = await transport.request<{ code?: string }>("POST", "/auth/mobile/web-link", { next });
    const code = typeof r?.code === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(r.code) ? r.code : null;
    return code ? `${base}/auth/mobile/web?code=${code}&next=${encodeURIComponent(next)}` : plain;
  } catch (e) {
    if (isApiError(e) && (e.status === 404 || e.status === 405)) linkMissingAt = Date.now();
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

/**
 * MFIX1 (1.10.16): pages that record, download or export a file open in the phone's own browser (Safari or Chrome),
 * because the in-app browser cannot hand the finished file to the save or share sheet (a meeting recording got stuck on
 * "Saving the video"). PRIV1b (P33): an explicit list of the web's /app routes (src/web/router.tsx) whose job is to hand
 * over a file: meetings (the room, its recording and notes), the Files list, Convert, Edit PDF, Fix PDF, and the mail archive and
 * data request exports in Settings. A guessed pattern matched no real route. Everything else stays inside the app.
 */
const FILE_ROUTES = ["/app/meetings", "/app/tools/convert", "/app/tools/edit-pdf", "/app/tools/pdf-fix", "/app/settings/mail-archive", "/app/settings/data-requests"];
/** PRIV1b (P33): routes matched only as themselves: the Files list hands off downloads, its office editor (/app/files/edit/:id) stays in the app. */
const FILE_ROUTES_EXACT = ["/app/files"];
export function opensInSystemBrowser(path: string): boolean {
  if (typeof path !== "string") return false;
  const bare = path.split(/[?#]/)[0].replace(/\/+$/, "");
  return FILE_ROUTES_EXACT.includes(bare) || FILE_ROUTES.some((r) => bare === r || bare.startsWith(`${r}/`));
}

/** Opens a page in the phone's own browser; if the phone refuses, the in-app browser instead. https only (or this server). */
export async function openInSystemBrowser(url: string): Promise<"system" | "in_app" | "none"> {
  if (typeof url !== "string" || !(/^https:\/\//i.test(url) || url.startsWith(`${API_BASE}/`))) return "none";
  try {
    await Linking.openURL(url);
    return "system";
  } catch {
    await WebBrowser.openBrowserAsync(url, inAppOptions()).catch(() => {});
    return "in_app";
  }
}

/** The /app path of a URL on this server ("https://multies.si/app/x?y" or "/app/x?y"), else null. */
export function appPathOf(urlOrPath: string, base = API_BASE): string | null {
  if (typeof urlOrPath !== "string") return null;
  let rest = urlOrPath;
  if (rest.startsWith(base)) rest = rest.slice(base.length);
  if (!rest.startsWith("/")) return null;
  return safeAppPath(rest) === rest ? rest : null;
}

