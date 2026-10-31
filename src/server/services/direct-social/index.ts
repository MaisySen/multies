/**
 * R83: our own TikTok and Threads connections (Connections > Social posts). Status, disconnect and the TikTok
 * webhook live here; the network calls are in tiktok.ts and threads.ts.
 */
import type { AuthContext, Deps } from "../../context";
import { audit } from "../audit";
import { hmacSha256Hex, safeEqual } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import { DIRECT_PROVIDERS, type DirectProvider, type DirectStatusResponse } from "../../../shared/direct-social";
import { deleteByProviderUser, deleteLink, getLink, isAdmin, requireManager, viewOf } from "./store";
import { revokeTikTok, setPublishStatus } from "./tiktok";

export async function directStatus(deps: Deps, auth: AuthContext): Promise<DirectStatusResponse> {
  const links = await Promise.all(DIRECT_PROVIDERS.map((p) => getLink(deps, auth.orgId, p)));
  const test = deps.config.socialTestNetwork === true ? (await (await import("../integrations/social-p2b")).testStatus(deps, auth)).account : null; // R118
  return { canManage: isAdmin(auth), accounts: DIRECT_PROVIDERS.map((p, i) => viewOf(deps, p, links[i])), test };
}

export async function disconnect(deps: Deps, auth: AuthContext, p: DirectProvider) {
  requireManager(auth);
  const link = await getLink(deps, auth.orgId, p);
  if (!link) return { removed: false, revoked: false };
  const revoked = p === "tiktok" ? await revokeTikTok(deps, link) : false;
  await deleteLink(deps, link.id);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "connection.direct_removed", targetType: "connection", targetId: link.id, metadata: { provider: p, revoked } });
  return { removed: true, revoked };
}

export function parseProvider(p: string): DirectProvider {
  if (p === "tiktok" || p === "threads") return p;
  throw new HttpError(404, "not_found", "No such connection.");
}

/* ---------------------------------------------------------------- TikTok webhook */

/** TikTok signs each webhook: header TikTok-Signature "t=<unix>,s=<hex hmac of `${t}.${body}` with the client secret>". */
export async function verifyTikTokSignature(header: string | undefined, body: string, secrets: string[], nowMs: number, toleranceSec = 300) {
  if (!header || !secrets.length) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
  const t = Number(parts.t); const s = String(parts.s ?? "").toLowerCase();
  if (!Number.isFinite(t) || !s) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  for (const secret of secrets) if (safeEqual(await hmacSha256Hex(secret, `${t}.${body}`), s)) return true;
  return false;
}

interface TikTokEvent { client_key?: string; event?: string; create_time?: number; user_openid?: string; content?: string }

/** Applies one verified TikTok event. Unknown events are ignored. */
export async function handleTikTokEvent(deps: Deps, ev: TikTokEvent) {
  let content: Record<string, unknown>;
  try { content = typeof ev.content === "string" ? JSON.parse(ev.content) as Record<string, unknown> : (ev.content as unknown as Record<string, unknown>) ?? {}; } catch { content = {}; }
  const publishId = typeof content.publish_id === "string" ? content.publish_id : null;
  switch (ev.event) {
    case "authorization.removed":
      if (ev.user_openid) return { done: "removed", links: (await deleteByProviderUser(deps, "tiktok", ev.user_openid)).length };
      return { done: "ignored" };
    case "post.publish.complete":
    case "post.publish.publicly_available":
      if (publishId) await setPublishStatus(deps, publishId, "published", { postId: content.post_id != null ? String(content.post_id) : null, error: null });
      return { done: "published" };
    case "post.publish.failed":
      if (publishId) await setPublishStatus(deps, publishId, "failed", { error: typeof content.reason === "string" ? content.reason.slice(0, 120) : "failed" });
      return { done: "failed" };
    case "post.publish.no_longer_publicaly_available":
    case "post.publish.no_longer_publicly_available":
      if (publishId) await setPublishStatus(deps, publishId, "removed");
      return { done: "removed_post" };
    case "post.publish.inbox_delivered":
    default:
      return { done: "ignored" };
  }
}
