/**
 * Who may join a doc's co-editing room. The check runs the app's own
 * GET /api/docs/:id with the caller's cookie, so the room follows exactly the
 * same session, workspace and guest rules as the docs routes.
 */
import type { Deps } from "../context";
import { receiveOnly, resolveAuthFor } from "../middleware";
import { HttpError } from "../lib/errors";
import { eq } from "drizzle-orm";
import { operatorImpersonations } from "../db/schema";

type FetchApp = { fetch(request: Request): Response | Promise<Response> };

/** Roles that may change a doc. Anyone else who can read it joins read-only. */
const EDITORS = new Set(["owner", "admin", "member"]);

/**
 * silent: the connection's presence (cursor, name) is never shown to others (an operator viewing as someone).
 * OPS1 security (L2): sessionId opened it; impersonation is set for an operator's impersonation session (its row id and
 * expiry), so the room can close the socket when it ends and re-check the row before applying an edit.
 */
export type CollabAccess = { ok: true; readOnly: boolean; silent?: boolean; sessionId?: string; impersonation?: { id: string; until: number } } | { ok: false; status: number; message: string };

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
  // OPS1 impersonation: through the shared check. View mode joins read only and silent (no edits, no presence as the person).
  let auth;
  try {
    auth = await resolveAuthFor(deps, headers, { method: "GET", path: `/api/docs/${docId}/collab` });
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, status: err.status === 401 ? 401 : 403, message: err.message };
    throw err;
  }
  if (!auth) return { ok: false, status: 401, message: "Sign in first." };
  const viewOnly = receiveOnly(auth);
  return {
    ok: true, readOnly: !EDITORS.has(String(auth.role)) || viewOnly, ...(viewOnly ? { silent: true } : {}), sessionId: auth.sessionId,
    ...(auth.impersonation ? { impersonation: { id: auth.impersonation.id, until: auth.impersonation.expiresAt.getTime() } } : {}),
  };
}

/** OPS1 security (L2): true when the impersonation row still allows its session (not ended, not past its expiry). */
export async function impersonationStillActive(deps: Pick<Deps, "db">, id: string, now: number): Promise<boolean> {
  const row = await deps.db.select({ endedAt: operatorImpersonations.endedAt, expiresAt: operatorImpersonations.expiresAt }).from(operatorImpersonations).where(eq(operatorImpersonations.id, id)).get();
  return !!row && !row.endedAt && row.expiresAt.getTime() > now;
}

function sameHost(origin: string, host: string) {
  try { return new URL(origin).host === host; } catch { return false; }
}
