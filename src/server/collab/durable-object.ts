/**
 * Cloudflare Durable Object hosting one doc's co-editing room (binding DOC_ROOMS,
 * class DocRoom). It uses the WebSocket Hibernation API, so a room with nobody
 * typing is evicted from memory and costs nothing; the Yjs state lives in the
 * object's SQLite storage and is loaded again on wake. A room with no connections
 * for 30 days clears its storage, and the next visitor seeds it from the saved doc.
 */
import { CollabRoom, type CollabConn, type CollabStore } from "./room";

interface SqlCursor extends Iterable<Record<string, unknown>> { toArray(): Record<string, unknown>[] }
interface DurableObjectStorage {
  sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
  transactionSync<T>(fn: () => T): T;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}
interface HibernatingSocket {
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
export interface DurableObjectStateLike {
  storage: DurableObjectStorage;
  acceptWebSocket(ws: HibernatingSocket): void;
  getWebSockets(): HibernatingSocket[];
}
declare const WebSocketPair: { new (): { 0: HibernatingSocket; 1: HibernatingSocket } };

type Attachment = { readOnly: boolean; ids: number[] };
type SocketConn = CollabConn & { ws: HibernatingSocket };

const IDLE_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000;

export class DocRoom {
  private room: CollabRoom | null = null;
  private readonly conns = new Map<HibernatingSocket, SocketConn>();

  constructor(private readonly ctx: DurableObjectStateLike, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    const att: Attachment = { readOnly: request.headers.get("x-collab-read-only") === "1", ids: [] };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(att);
    const room = this.getRoom();
    room.join(this.connOf(server));
    await this.ctx.storage.deleteAlarm();
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  webSocketMessage(ws: HibernatingSocket, message: ArrayBuffer | string) {
    if (typeof message === "string") return;
    const room = this.getRoom();
    room.receive(this.connOf(ws), new Uint8Array(message));
  }

  async webSocketClose(ws: HibernatingSocket, code: number, reason: string) {
    await this.drop(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  async webSocketError(ws: HibernatingSocket) {
    await this.drop(ws);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length) return;
    this.room = null;
    await this.ctx.storage.deleteAll();
  }

  private async drop(ws: HibernatingSocket) {
    const att = (ws.deserializeAttachment() ?? { ids: [] }) as Attachment;
    this.getRoom().leave(this.connOf(ws), att.ids);
    this.conns.delete(ws);
    if (!this.ctx.getWebSockets().some((s) => s !== ws)) await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);
  }

  private connOf(ws: HibernatingSocket): SocketConn {
    let conn = this.conns.get(ws);
    if (!conn) {
      const att = (ws.deserializeAttachment() ?? { readOnly: false, ids: [] }) as Attachment;
      conn = { ws, readOnly: att.readOnly, send: (data) => ws.send(data) };
      this.conns.set(ws, conn);
    }
    return conn;
  }

  private getRoom(): CollabRoom {
    if (this.room) return this.room;
    const { storage } = this.ctx;
    storage.sql.exec("CREATE TABLE IF NOT EXISTS yjs_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)");
    const store: CollabStore = {
      load: () => storage.sql.exec("SELECT data FROM yjs_updates ORDER BY id").toArray().map((r) => new Uint8Array(r.data as ArrayBuffer)),
      append: (update) => { storage.sql.exec("INSERT INTO yjs_updates (data) VALUES (?)", update); },
      replace: (state) => storage.transactionSync(() => {
        storage.sql.exec("DELETE FROM yjs_updates");
        storage.sql.exec("INSERT INTO yjs_updates (data) VALUES (?)", state);
      }),
      clear: () => { storage.sql.exec("DELETE FROM yjs_updates"); },
    };
    const room = new CollabRoom({
      store,
      onClientIds: (conn, ids) => {
        const ws = (conn as SocketConn).ws;
        ws.serializeAttachment({ ...((ws.deserializeAttachment() ?? {}) as Attachment), ids });
      },
    });
    // Connections that were open while the object hibernated.
    for (const ws of this.ctx.getWebSockets()) {
      const att = (ws.deserializeAttachment() ?? { ids: [] }) as Attachment;
      room.restore(this.connOf(ws), att.ids);
    }
    this.room = room;
    return room;
  }
}

/** Durable Object namespace binding, as far as MyMail uses it. */
export interface DocRoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
