/**
 * Round 32: who may open the live chat socket. A signed in person (cookie session, not an API
 * key) on a page of this same site. Which channels they hear is decided per event by its
 * audience (see hub.ts), so private channels and DMs only ever reach their members.
 */
import type { Deps } from "../context";
import { resolveAuth } from "../middleware";

export type ChatLiveAccess = { ok: true; userId: string; orgId: string } | { ok: false; status: number; message: string };

export async function chatLiveAccess(deps: Deps, request: Request): Promise<ChatLiveAccess> {
  if (request.method !== "GET" || (request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return { ok: false, status: 426, message: "Expected a WebSocket upgrade." };
  }
  // Browsers always send Origin on a WebSocket handshake. A page on another site must not
  // ride the person's cookie into their workspace's chat.
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!origin || !sameHost(origin, request.headers.get("host") ?? url.host)) {
    return { ok: false, status: 403, message: "Cross site connections are not allowed." };
  }
  if (!request.headers.get("cookie")) return { ok: false, status: 401, message: "Sign in first." };
  const headers = new Headers();
  for (const name of ["cookie", "user-agent", "cf-connecting-ip", "x-forwarded-for", "x-real-ip"]) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  const auth = await resolveAuth(deps, headers).catch(() => null);
  if (!auth?.userId || !auth.orgId || !auth.sessionId || auth.ssoBlocked) return { ok: false, status: 401, message: "Sign in first." };
  return { ok: true, userId: auth.userId, orgId: auth.orgId };
}

export function sameHost(origin: string, host: string) {
  try { return new URL(origin).host === host; } catch { return false; }
}
