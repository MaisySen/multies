/**
 * Round 32: live chat on the Node entry (dev, self host and the Playwright E2E): the same
 * GET /api/chat/live socket as the Worker, served with the ws package, one MemoryChatHub
 * for the process. The browser's "ping" is answered with "pong", like the Durable Object's
 * auto response.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Deps } from "../context";
import { chatLiveAccess } from "./access";
import { CHAT_LIVE_PATH, CLOSE_FULL, MemoryChatHub, type HubConn } from "./hub";
import { PING, PONG } from "./chat-hub-do";

export function attachChatLive(server: Server, deps: Deps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const hub = new MemoryChatHub();
  deps.chatLive = hub;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== CHAT_LIVE_PATH) return;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    chatLiveAccess(deps, new Request(url.toString(), { method: "GET", headers })).then((access) => {
      if (!access.ok) {
        socket.end(`HTTP/1.1 ${access.status} ${access.message}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => join(ws, access.orgId, access.userId));
    }).catch(() => socket.destroy());
  });

  function join(ws: WebSocket, orgId: string, userId: string) {
    const conn: HubConn = {
      userId, openedAt: Date.now(),
      send: (data) => { if (ws.readyState === ws.OPEN) ws.send(data); },
      close: (code, reason) => ws.close(code, reason),
    };
    if (!hub.join(orgId, conn)) { ws.close(CLOSE_FULL, "full"); return; }
    ws.on("message", (data: Buffer, isBinary: boolean) => { if (!isBinary && data.toString() === PING) conn.send(PONG); });
    ws.on("close", () => hub.leave(orgId, conn));
    ws.on("error", () => ws.terminate());
  }

  return { hub, close: () => wss.close() };
}
