/**
 * Cloudflare Durable Object hosting one doc's co-editing room (binding DOC_ROOMS,
 * class DocRoom). It uses the WebSocket Hibernation API, so a room with nobody
 * typing is evicted from memory and costs nothing; the Yjs state lives in the
 * object's SQLite storage and is loaded again on wake. A room with no connections
 * for 30 days clears its storage, and the next visitor seeds it from the saved doc.
 */
import { CLOSE_IMPERSONATION_ENDED, CollabRoom, isWriteMessage, type CollabConn, type CollabStore } from "./room";

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

// OPS1 impersonation: silent. OPS1 security (L2): imp, an operator's impersonation (its row id and expiry).
type Attachment = { readOnly: boolean; silent?: boolean; ids: number[]; imp?: { id: string; until: number } };
/** The D1 binding, as far as the room uses it (the impersonation re-check). */
interface D1Like { prepare(q: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } } }
type SocketConn = CollabConn & { ws: HibernatingSocket };

const IDLE_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000;

export class DocRoom {
  private room: CollabRoom | null = null;
  private readonly conns = new Map<HibernatingSocket, SocketConn>();

  private readonly db: D1Like | undefined;

  constructor(private readonly ctx: DurableObjectStateLike, env: unknown) {
    const d = (env as { DB?: D1Like } | undefined)?.DB;
    this.db = d && typeof d.prepare === "function" ? d : undefined;
  }

  async fetch(request: Request): Promise<Response> {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    const impId = request.headers.get("x-collab-impersonation") ?? "";
    const impUntil = Number(request.headers.get("x-collab-until") ?? "");
    const att: Attachment = {
      readOnly: request.headers.get("x-collab-read-only") === "1", silent: request.headers.get("x-collab-silent") === "1", ids: [],
      ...(impId && Number.isFinite(impUntil) ? { imp: { id: impId, until: impUntil } } : {}),
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(att);
    const room = this.getRoom();
    room.join(this.connOf(server));
    await this.ctx.storage.deleteAlarm();
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async webSocketMessage(ws: HibernatingSocket, message: ArrayBuffer | string) {
    if (typeof message === "string") return;
    const data = new Uint8Array(message);
    // OPS1 security (L2): an impersonation socket is closed past its expiry, and its edits wait for a fresh read of the
    // impersonation row (ended by Stop, the console, or a demoted operator): the socket closes instead.
    const imp = ((ws.deserializeAttachment() ?? {}) as Attachment).imp;
    if (imp) {
      if (Date.now() >= imp.until) return this.endImpersonation(ws);
      const att = (ws.deserializeAttachment() ?? {}) as Attachment;
      if (!att.readOnly && isWriteMessage(data) && !(await this.impersonationActive(imp.id))) return this.endImpersonation(ws);
    }
    const room = this.getRoom();
    room.receive(this.connOf(ws), data);
  }

  private async impersonationActive(id: string): Promise<boolean> {
    if (!this.db) return false;
    const row = await this.db.prepare("select ended_at, expires_at from operator_impersonations where id = ?").bind(id).first<{ ended_at: number | null; expires_at: number }>().catch(() => null);
    return !!row && row.ended_at == null && Number(row.expires_at) > Date.now();
  }

  private async endImpersonation(ws: HibernatingSocket) {
    await this.drop(ws);
    try { ws.close(CLOSE_IMPERSONATION_ENDED, "impersonation ended"); } catch { /* already closed */ }
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
      const until = att.imp?.until;
      conn = {
        ws, readOnly: att.readOnly, silent: !!att.silent,
        // OPS1 security (L2): nothing reaches an impersonation socket past the impersonation's expiry.
        send: (data) => { if (until !== undefined && Date.now() >= until) { try { ws.close(CLOSE_IMPERSONATION_ENDED, "impersonation ended"); } catch { /* gone */ } return; } ws.send(data); },
      };
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

/** Durable Object namespace binding, as far as Multies uses it. */
export interface DocRoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
