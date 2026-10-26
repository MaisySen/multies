/**
 * Co-editing on the Node entry (dev, self host and the Playwright E2E): the same
 * route as the Worker, served with the ws package, one in-memory room per doc.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Deps } from "../context";
import { collabAccess } from "./access";
import { CollabRoom, collabDocId, type CollabConn } from "./room";

type FetchApp = { fetch(request: Request): Response | Promise<Response> };

export function attachCollab(server: Server, app: FetchApp, deps: Deps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const rooms = new Map<string, CollabRoom>();

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
      wss.handleUpgrade(req, socket, head, (ws) => join(ws, docId, access.readOnly));
    }).catch(() => socket.destroy());
  });

  function join(ws: WebSocket, docId: string, readOnly: boolean) {
    let room = rooms.get(docId);
    if (!room) { room = new CollabRoom(); rooms.set(docId, room); }
    const conn: CollabConn = { readOnly, send: (data) => { if (ws.readyState === ws.OPEN) ws.send(data); } };
    ws.binaryType = "nodebuffer";
    ws.on("message", (data: Buffer, isBinary: boolean) => { if (isBinary) room.receive(conn, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); });
    ws.on("close", () => room.leave(conn));
    ws.on("error", () => ws.terminate());
    room.join(conn);
  }

  return { rooms, close: () => wss.close() };
}
