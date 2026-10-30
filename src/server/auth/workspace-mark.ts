/**
 * Multiws (27 Oct 2026): a small cookie that names the workspace this browser or phone last switched to.
 *
 * The signed in read cache in guards.ts lives in each isolate's memory. A switch (or joining a workspace, or
 * creating one) drops the copy only in the isolate that handled it, so before this a page load right after a
 * switch could be answered by another isolate's copy and show the old workspace for up to 15 s, which looked like
 * the switch had failed. Every request now carries this mark, and a cached copy is used only when it was made
 * under the same mark, so a switch is seen at once everywhere. It is not a credential: the session row in the
 * database still decides the workspace, and a planted or stale mark only means a fresh read.
 */
import type { Context } from "hono";

export const WORKSPACE_MARK_COOKIE = "mymail.ws";
const MAX_AGE = 30 * 24 * 60 * 60;

/** The mark this request carries ("" when none). */
export function workspaceMark(headers: Headers): string {
  const cookie = headers.get("cookie");
  if (!cookie || !cookie.includes(`${WORKSPACE_MARK_COOKIE}=`)) return "";
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === WORKSPACE_MARK_COOKIE) return part.slice(i + 1).trim().slice(0, 64);
  }
  return "";
}

/** The Set-Cookie line for a mark (the workspace id plus the time, so switching back and forth changes it too). */
export function workspaceMarkCookie(orgId: string, secure: boolean, now = Date.now()): string {
  const value = `${orgId}.${now.toString(36)}`.replace(/[^A-Za-z0-9_.-]/g, "");
  return `${WORKSPACE_MARK_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? "; Secure" : ""}`;
}

/** Adds the mark to the response of a request that changed the session's workspace. */
export function markWorkspace(c: Context, orgId: string) {
  const secure = (c.var as { deps?: { config?: { mode?: string } } }).deps?.config?.mode === "production";
  c.header("Set-Cookie", workspaceMarkCookie(orgId, secure), { append: true });
}
