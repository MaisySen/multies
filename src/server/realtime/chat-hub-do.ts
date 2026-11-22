/**
 * Round 32: the ChatHub Durable Object (binding CHAT_HUB, one object per workspace, named
 * hubName(orgId)). It uses the WebSocket Hibernation API: sockets are accepted with
 * state.acceptWebSocket, the browser's "ping" is answered by setWebSocketAutoResponse without
 * waking the object, and there are no timers. An idle hub is evicted and costs nothing.
 * It stores nothing (the SQLite backend is declared only because it is the Free plan kind).
 *
 * Two requests reach it, both from the Worker entry (never from a browser directly):
 * - GET with Upgrade: websocket, after chatLiveAccess passed. x-chat-user names the person.
 * - POST /publish { audience, event } from publishChat after a chat write.
 */
import { CLOSE_FULL, deliver, helloFrame, kickSessionConns, kickUser, MAX_SOCKETS, type ChatAudience, type ChatLiveEvent, type HubConn } from "./hub";

interface HibernatingSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
export interface ChatHubState {
  acceptWebSocket(ws: HibernatingSocket): void;
  getWebSockets(): HibernatingSocket[];
  setWebSocketAutoResponse?(pair: unknown): void;
}
declare const WebSocketPair: { new (): { 0: HibernatingSocket; 1: HibernatingSocket } };
declare const WebSocketRequestResponsePair: { new (request: string, response: string): unknown } | undefined;

type Attachment = { userId: string; openedAt: number; sessionId?: string; until?: number }; // OPS1 security (L2): sessionId, until

/** The ping the browser sends and the answer the runtime gives without waking the object. */
export const PING = "ping";
export const PONG = "pong";

export class ChatHub {
  /** R33: events published since this object woke (in memory only; see ChatHello). */
  private seq = 0;
  constructor(private readonly ctx: ChatHubState, _env: unknown, private readonly now: () => number = () => Date.now()) {
    try {
      if (typeof WebSocketRequestResponsePair !== "undefined" && ctx.setWebSocketAutoResponse) ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    } catch { /* runtimes without auto response answer in webSocketMessage */ }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/publish") {
      const body = (await request.json().catch(() => null)) as { audience?: ChatAudience; event?: ChatLiveEvent } | null;
      if (!body?.audience || !body.event) return Response.json({ error: "bad_publish" }, { status: 400 });
      this.seq++;
      const sent = deliver(this.conns(), body.audience, body.event, this.now());
      return Response.json({ sent });
    }
    if (request.method === "POST" && url.pathname === "/kick") {
      // PRIV1b (P65): the person left the workspace or their sessions ended.
      // OPS1 security (L2): or one session's sockets (an ended impersonation).
      const body = (await request.json().catch(() => null)) as { userId?: string; sessionId?: string } | null;
      if (body?.sessionId) return Response.json({ closed: kickSessionConns(this.conns(), body.sessionId) });
      if (!body?.userId) return Response.json({ error: "bad_kick" }, { status: 400 });
      return Response.json({ closed: kickUser(this.conns(), body.userId) });
    }
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
    const userId = request.headers.get("x-chat-user") ?? "";
    if (!userId) return new Response("Missing person.", { status: 400 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    if (this.ctx.getWebSockets().length > MAX_SOCKETS) {
      server.close(CLOSE_FULL, "full");
    } else {
      const sessionId = request.headers.get("x-chat-session") || undefined;
      const until = Number(request.headers.get("x-chat-until") ?? "");
      server.serializeAttachment({ userId, openedAt: this.now(), ...(sessionId ? { sessionId } : {}), ...(Number.isFinite(until) && until > 0 ? { until } : {}) } satisfies Attachment);
      // R33: the first frame on the socket (the browser holds its sends until it arrives).
      try { server.send(JSON.stringify(helloFrame(this.seq, this.now()))); } catch { /* closed */ }
    }
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  /** Only reached when auto response is unavailable: answer the ping, ignore anything else. */
  webSocketMessage(ws: HibernatingSocket, message: ArrayBuffer | string) {
    if (message === PING) { try { ws.send(PONG); } catch { /* closed */ } }
  }

  webSocketClose(ws: HibernatingSocket, code: number, reason: string) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  webSocketError(ws: HibernatingSocket) {
    try { ws.close(1011, "error"); } catch { /* already closed */ }
  }

  private conns(): HubConn[] {
    const out: HubConn[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att?.userId) continue;
      out.push({ userId: att.userId, openedAt: att.openedAt, sessionId: att.sessionId, until: att.until, send: (d) => ws.send(d), close: (code, reason) => ws.close(code, reason) });
    }
    return out;
  }
}

/** Durable Object namespace binding, as far as the chat hub uses it. */
export interface ChatHubNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
