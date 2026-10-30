/**
 * Doc co-editing rooms: one Yjs document per Multies doc, speaking the standard
 * y-websocket protocol (sync plus awareness, from y-protocols). The Cloudflare
 * Durable Object (worker) and the in-memory rooms of the Node entry both use this
 * class, so the message handling lives in one place.
 *
 * Storage is optional. With a store, every update is appended and the log is
 * folded into one merged update once it passes COMPACT_AFTER entries, so the
 * stored state stays the size of the document rather than its edit history.
 */
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_QUERY_AWARENESS = 3;

/** Close code a room uses when its state was thrown away; clients reload the saved doc. */
export const CLOSE_RESET = 4000;

export const COMPACT_AFTER = 100;

/** One connected client, as the room sees it. */
export interface CollabConn {
  send(data: Uint8Array): void;
  /** Read-only people receive edits but their updates are dropped. */
  readOnly?: boolean;
}

/** Where a room keeps its state between wakes. */
export interface CollabStore {
  /** Every stored update, oldest first. */
  load(): Uint8Array[];
  append(update: Uint8Array): void;
  /** Replaces everything stored with one merged update. */
  replace(state: Uint8Array): void;
  clear(): void;
}

export interface CollabRoomOptions {
  store?: CollabStore;
  /** Called when the awareness client ids a connection controls change (for hibernation). */
  onClientIds?(conn: CollabConn, ids: number[]): void;
}

export class CollabRoom {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private readonly conns = new Map<CollabConn, Set<number>>();
  private stored = 0;

  constructor(private readonly opts: CollabRoomOptions = {}) {
    this.doc = new Y.Doc({ gc: true });
    const saved = opts.store?.load() ?? [];
    if (saved.length) Y.applyUpdate(this.doc, saved.length === 1 ? saved[0] : Y.mergeUpdates(saved));
    this.stored = saved.length;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    // The server holds no presence of its own, and no timer: a timer would keep a
    // hibernating Durable Object awake. Clients renew their state every 15 seconds.
    this.awareness.setLocalState(null);
    clearInterval((this.awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.persist(update);
      const msg = encodeSyncUpdate(update);
      for (const conn of this.conns.keys()) if (conn !== origin) safeSend(conn, msg);
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const owned = origin instanceof Object ? this.conns.get(origin as CollabConn) : undefined;
      if (owned) {
        const before = owned.size;
        for (const id of added) owned.add(id);
        for (const id of removed) owned.delete(id);
        if (owned.size !== before) this.opts.onClientIds?.(origin as CollabConn, [...owned]);
      }
      const msg = encodeAwareness(this.awareness, changed);
      for (const conn of this.conns.keys()) safeSend(conn, msg);
    });
  }

  get size() { return this.conns.size; }

  /** A new connection: send sync step 1 and everyone's presence. */
  join(conn: CollabConn) {
    this.conns.set(conn, new Set());
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    safeSend(conn, encoding.toUint8Array(enc));
    const states = this.awareness.getStates();
    if (states.size) safeSend(conn, encodeAwareness(this.awareness, [...states.keys()]));
  }

  /** A connection that was open before the room woke up (Durable Object hibernation). */
  restore(conn: CollabConn, clientIds: number[] = []) {
    this.conns.set(conn, new Set(clientIds));
  }

  /** Handles one binary message from a connection. Malformed input is ignored. */
  receive(conn: CollabConn, data: Uint8Array) {
    if (!this.conns.has(conn)) this.conns.set(conn, new Set());
    try {
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        // Read-only connections may ask for the state (step 1) but never change it.
        if (conn.readOnly && decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, enc, this.doc, conn);
        if (encoding.length(enc) > 1) safeSend(conn, encoding.toUint8Array(enc));
      } else if (type === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), conn);
      } else if (type === MESSAGE_QUERY_AWARENESS) {
        const states = this.awareness.getStates();
        if (states.size) safeSend(conn, encodeAwareness(this.awareness, [...states.keys()]));
      }
    } catch {
      // A broken message from one client must not take the room down.
    }
  }

  /** A connection closed: drop it and the presence it controlled. */
  leave(conn: CollabConn, knownIds: number[] = []) {
    const ids = new Set([...(this.conns.get(conn) ?? []), ...knownIds]);
    this.conns.delete(conn);
    const present = [...ids].filter((id) => this.awareness.getStates().has(id));
    if (present.length) awarenessProtocol.removeAwarenessStates(this.awareness, present, null);
  }

  /** The whole document as one update. */
  encodeState() { return Y.encodeStateAsUpdate(this.doc); }

  private persist(update: Uint8Array) {
    const store = this.opts.store;
    if (!store) return;
    if (this.stored + 1 >= COMPACT_AFTER) {
      store.replace(Y.encodeStateAsUpdate(this.doc));
      this.stored = 1;
    } else {
      store.append(update);
      this.stored += 1;
    }
  }
}

function encodeSyncUpdate(update: Uint8Array) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

function encodeAwareness(awareness: awarenessProtocol.Awareness, clients: number[]) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(enc);
}

function safeSend(conn: CollabConn, data: Uint8Array) {
  try { conn.send(data); } catch { /* the close handler tidies up */ }
}

/** Matches /api/docs/<id>/collab and returns the doc id. */
export function collabDocId(pathname: string): string | null {
  const parts = pathname.split("/");
  if (parts.length !== 5 || parts[1] !== "api" || parts[2] !== "docs" || parts[4] !== "collab") return null;
  const id = decodeURIComponent(parts[3]);
  return id && id.length <= 100 ? id : null;
}
