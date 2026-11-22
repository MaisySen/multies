/**
 * Co-editing on the Node entry (dev, self host and the Playwright E2E): the same
 * route as the Worker, served with the ws package, one in-memory room per doc.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Deps } from "../context";
import { collabAccess, impersonationStillActive } from "./access";
import { CLOSE_IMPERSONATION_ENDED, CollabRoom, collabDocId, isWriteMessage, type CollabConn } from "./room";

type FetchApp = { fetch(request: Request): Response | Promise<Response> };

export function attachCollab(server: Server, app: FetchApp, deps: Deps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const rooms = new Map<string, CollabRoom>();
  // OPS1 security (L2): the sockets each session opened, so an ended impersonation's are closed at once.
  const bySession = new Map<string, Set<WebSocket>>();
  deps.collabLive = {
    kickSession(sessionId: string) {
      for (const ws of bySession.get(sessionId) ?? []) { try { ws.close(CLOSE_IMPERSONATION_ENDED, "impersonation ended"); } catch { /* gone */ } }
      bySession.delete(sessionId);
    },
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const docId = collabDocId(url.pathname);
    // R32: the live chat socket has its own upgrade handler (realtime/node.ts).
    if (!docId) { if (url.pathname !== "/api/chat/live") socket.destroy(); return; }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(url.toString(), { method: "GET", headers });
    collabAccess(app, deps, request, docId).then((access) => {
      if (!access.ok) {
        socket.end(`HTTP/1.1 ${access.status} ${access.message}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => join(ws, docId, access.readOnly, !!access.silent, access.sessionId, access.impersonation));
    }).catch(() => socket.destroy());
  });

  function join(ws: WebSocket, docId: string, readOnly: boolean, silent = false, sessionId?: string, imp?: { id: string; until: number }) {
    let room = rooms.get(docId);
    if (!room) { room = new CollabRoom(); rooms.set(docId, room); }
    const ended = () => { try { ws.close(CLOSE_IMPERSONATION_ENDED, "impersonation ended"); } catch { /* gone */ } };
    const conn: CollabConn = {
      readOnly, silent,
      send: (data) => {
        // OPS1 security (L2): nothing reaches an impersonation socket past the impersonation's expiry.
        if (imp && Date.now() >= imp.until) { ended(); return; }
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
    };
    if (sessionId) {
      let set = bySession.get(sessionId);
      if (!set) { set = new Set(); bySession.set(sessionId, set); }
      set.add(ws);
    }
    ws.binaryType = "nodebuffer";
    // OPS1 security (L2): an impersonation socket's edits wait for a fresh check of its row (in order, one chain).
    let chain: Promise<void> = Promise.resolve();
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const msg = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (!imp) { room.receive(conn, msg); return; }
      chain = chain.then(async () => {
        if (ws.readyState !== ws.OPEN) return;
        if (Date.now() >= imp.until) { ended(); return; }
        if (!readOnly && isWriteMessage(msg) && !(await impersonationStillActive(deps, imp.id, Date.now()).catch(() => false))) { ended(); return; }
        room.receive(conn, msg);
      });
    });
    ws.on("close", () => {
      room.leave(conn);
      if (sessionId) { const set = bySession.get(sessionId); set?.delete(ws); if (set && !set.size) bySession.delete(sessionId); }
    });
    ws.on("error", () => ws.terminate());
    room.join(conn);
  }

  return { rooms, close: () => wss.close() };
}
