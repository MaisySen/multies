/**
 * Round 32: the Worker side of live chat. publish goes to the workspace's ChatHub object;
 * the upgrade checks the session and Origin here, then hands the socket to that object.
 * Hosts without the CHAT_HUB binding answer 503 and chat keeps polling.
 */
import type { Deps } from "../context";
import { chatLiveAccess } from "./access";
import type { ChatHubNamespace } from "./chat-hub-do";
import { hubName, type ChatLiveBus } from "./hub";

export function isChatHubNamespace(ns: unknown): ns is ChatHubNamespace {
  return !!ns && typeof (ns as ChatHubNamespace).idFromName === "function";
}

/** deps.chatLive on Workers. */
export function durableChatLive(ns: unknown): ChatLiveBus | undefined {
  if (!isChatHubNamespace(ns)) return undefined;
  return {
    async publish(orgId, audience, event) {
      const res = await ns.get(ns.idFromName(hubName(orgId))).fetch(new Request("https://chat-hub/publish", { method: "POST", body: JSON.stringify({ audience, event }) }));
      if (!res.ok) throw new Error(`chat hub answered ${res.status}`);
    },
    async kick(orgId, userId) { // PRIV1b (P65)
      const res = await ns.get(ns.idFromName(hubName(orgId))).fetch(new Request("https://chat-hub/kick", { method: "POST", body: JSON.stringify({ userId }) }));
      if (!res.ok) throw new Error(`chat hub answered ${res.status}`);
    },
    async kickSession(orgId, sessionId) { // OPS1 security (L2): the same /kick, by session
      const res = await ns.get(ns.idFromName(hubName(orgId))).fetch(new Request("https://chat-hub/kick", { method: "POST", body: JSON.stringify({ sessionId }) }));
      if (!res.ok) throw new Error(`chat hub answered ${res.status}`);
    },
  };
}

/** GET /api/chat/live on Workers. */
export async function chatLiveUpgrade(request: Request, ns: unknown, deps: Deps): Promise<Response> {
  if (!isChatHubNamespace(ns)) return Response.json({ error: { code: "live_off", message: "Live chat is not set up on this host." } }, { status: 503 });
  const access = await chatLiveAccess(deps, request);
  if (!access.ok) return Response.json({ error: { code: "live_denied", message: access.message } }, { status: access.status });
  const headers = new Headers({ upgrade: "websocket", "x-chat-user": access.userId, "x-chat-session": access.sessionId });
  if (access.until !== undefined) headers.set("x-chat-until", String(access.until)); // OPS1 security (L2)
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  return ns.get(ns.idFromName(hubName(access.orgId))).fetch(new Request(request.url, { method: "GET", headers }));
}
