/**
 * M2 (1.10.10): open a web page inside the app, signed in. The app asks the server for a short lived, single use
 * sign in link to that page (POST /api/auth/mobile/web-link) and opens it in the in-app browser, so there is no
 * second sign in. A server without that route (404) gets the plain page, which may ask the person to sign in; the
 * app remembers that for this session and stops asking.
 */
import * as WebBrowser from "expo-web-browser";
import type { Transport } from "@/api/transport";
import { isApiError } from "@/api/transport";
import { API_BASE } from "@/config";
import { colors } from "@/theme";

let linkMissing = false;
export function resetWebLink() { linkMissing = false; }

/** Only pages inside the app (never another host, never a full URL from outside). */
export const safeAppPath = (p: string) => (typeof p === "string" && /^\/app(\/|$|\?|#)/.test(p) && !p.includes("//") ? p : "/app");

/** The URL to open: the server's sign in link when it gives one on our own host, else the page itself. */
export async function signedInUrl(transport: Pick<Transport, "request">, path: string, base = API_BASE): Promise<string> {
  const next = safeAppPath(path);
  const plain = `${base}${next}`;
  if (linkMissing) return plain;
  try {
    const r = await transport.request<{ url?: string }>("POST", "/auth/mobile/web-link", { next });
    const url = typeof r?.url === "string" ? r.url : "";
    return url.startsWith(`${base}/`) ? url : plain;
  } catch (e) {
    if (isApiError(e) && (e.status === 404 || e.status === 405)) linkMissing = true;
    return plain;
  }
}

export async function openWebPage(transport: Pick<Transport, "request">, path: string): Promise<void> {
  const url = await signedInUrl(transport, path);
  await WebBrowser.openBrowserAsync(url, { dismissButtonStyle: "done", controlsColor: colors.brand }).catch(() => {});
}
