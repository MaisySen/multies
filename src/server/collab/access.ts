/**
 * Who may join a doc's co-editing room. The check runs the app's own
 * GET /api/docs/:id with the caller's cookie, so the room follows exactly the
 * same session, workspace and guest rules as the docs routes.
 */
import type { Deps } from "../context";
import { resolveAuth } from "../middleware";

type FetchApp = { fetch(request: Request): Response | Promise<Response> };

/** Roles that may change a doc. Anyone else who can read it joins read-only. */
const EDITORS = new Set(["owner", "admin", "member"]);

export type CollabAccess = { ok: true; readOnly: boolean } | { ok: false; status: number; message: string };

export async function collabAccess(app: FetchApp, deps: Deps, request: Request, docId: string): Promise<CollabAccess> {
  if (request.method !== "GET" || (request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return { ok: false, status: 426, message: "Expected a WebSocket upgrade." };
  }
  // Browsers always send Origin on a WebSocket handshake. A page on another site must
  // not ride the person's cookie into the room.
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!origin || !sameHost(origin, request.headers.get("host") ?? url.host)) {
    return { ok: false, status: 403, message: "Cross site connections are not allowed." };
  }
  const headers = new Headers();
  for (const name of ["cookie", "authorization", "user-agent", "cf-connecting-ip", "x-forwarded-for", "x-real-ip"]) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  const probe = await app.fetch(new Request(new URL(`/api/docs/${encodeURIComponent(docId)}`, url).toString(), { headers }));
  if (probe.status !== 200) return { ok: false, status: probe.status === 401 ? 401 : probe.status === 403 ? 403 : 404, message: "No access to that doc." };
  const auth = await resolveAuth(deps, headers);
  if (!auth) return { ok: false, status: 401, message: "Sign in first." };
  return { ok: true, readOnly: !EDITORS.has(String(auth.role)) };
}

function sameHost(origin: string, host: string) {
  try { return new URL(origin).host === host; } catch { return false; }
}
