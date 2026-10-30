import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { COMPACT_AFTER, CollabRoom, MESSAGE_AWARENESS, MESSAGE_SYNC, collabDocId, type CollabStore } from "../src/server/collab/room";
import { collabAccess } from "../src/server/collab/access";

/** A browser-side client speaking the y-websocket protocol to a room, synchronously. */
function client(room: CollabRoom, opts: { readOnly?: boolean } = {}) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  clearInterval((awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
  const conn = {
    readOnly: opts.readOnly,
    send(data: Uint8Array) {
      const dec = decoding.createDecoder(data);
      const type = decoding.readVarUint(dec);
      if (type === MESSAGE_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(dec, enc, doc, "server");
        if (encoding.length(enc) > 1) room.receive(conn, encoding.toUint8Array(enc));
      } else if (type === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), "server");
      }
    },
  };
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "server") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    room.receive(conn, encoding.toUint8Array(enc));
  });
  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === "server") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
    room.receive(conn, encoding.toUint8Array(enc));
  });
  room.join(conn);
  // Client sync step 1, as y-websocket sends on open.
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  room.receive(conn, encoding.toUint8Array(enc));
  return { doc, awareness, conn, text: () => doc.getText("t").toString() };
}

function memoryStore() {
  let rows: Uint8Array[] = [];
  const store: CollabStore & { rows: () => Uint8Array[] } = {
    load: () => [...rows], append: (u) => { rows.push(u); }, replace: (s) => { rows = [s]; }, clear: () => { rows = []; }, rows: () => rows,
  };
  return store;
}

describe("co-editing room", () => {
  it("two clients converge, both ways", () => {
    const room = new CollabRoom();
    const a = client(room), b = client(room);
    a.doc.getText("t").insert(0, "Hello from Ana. ");
    expect(b.text()).toBe("Hello from Ana. ");
    b.doc.getText("t").insert(b.text().length, "Hi from Ben.");
    expect(a.text()).toBe("Hello from Ana. Hi from Ben.");
    // Concurrent edits made while apart still merge to the same text.
    const late = client(room);
    expect(late.text()).toBe(a.text());
  });

  it("keeps its state across a reload and compacts the stored log", () => {
    const store = memoryStore();
    const room = new CollabRoom({ store });
    const a = client(room);
    for (let i = 0; i < COMPACT_AFTER + 20; i++) a.doc.getText("t").insert(a.text().length, "x");
    expect(store.rows().length).toBeLessThan(COMPACT_AFTER);
    const woken = new CollabRoom({ store });
    const b = client(woken);
    expect(b.text()).toBe("x".repeat(COMPACT_AFTER + 20));
  });

  it("shares presence and drops it when a client leaves", () => {
    const room = new CollabRoom();
    const a = client(room), b = client(room);
    a.awareness.setLocalStateField("user", { name: "Ana", color: "#e8590c" });
    expect([...b.awareness.getStates().values()].some((s) => (s as { user?: { name: string } }).user?.name === "Ana")).toBe(true);
    room.leave(a.conn);
    expect(b.awareness.getStates().has(a.doc.clientID)).toBe(false);
  });

  it("ignores edits from a read-only connection but still sends it the doc", () => {
    const room = new CollabRoom();
    const a = client(room);
    a.doc.getText("t").insert(0, "Brief");
    const guest = client(room, { readOnly: true });
    expect(guest.text()).toBe("Brief");
    guest.doc.getText("t").insert(0, "Changed ");
    expect(a.text()).toBe("Brief");
    expect(room.doc.getText("t").toString()).toBe("Brief");
  });

  it("survives a malformed message", () => {
    const room = new CollabRoom();
    const a = client(room);
    room.receive(a.conn, new Uint8Array([0, 2, 255, 255, 255]));
    a.doc.getText("t").insert(0, "still fine");
    expect(room.doc.getText("t").toString()).toBe("still fine");
  });

  it("matches only the collab path", () => {
    expect(collabDocId("/api/docs/doc_123/collab")).toBe("doc_123");
    expect(collabDocId("/api/docs/doc_123")).toBeNull();
    expect(collabDocId("/api/docs//collab")).toBeNull();
    expect(collabDocId("/api/docs/a/b/collab")).toBeNull();
  });
});

describe("co-editing access", () => {
  const ws = { upgrade: "websocket", host: "app.test", origin: "https://app.test" };
  const app = (status: number) => ({ fetch: async () => new Response("{}", { status }) });
  const deps = {} as never;
  it("wants a WebSocket upgrade from the same site", async () => {
    expect(await collabAccess(app(200), deps, new Request("https://app.test/api/docs/d1/collab"), "d1")).toMatchObject({ ok: false, status: 426 });
    expect(await collabAccess(app(200), deps, new Request("https://app.test/api/docs/d1/collab", { headers: { ...ws, origin: "https://evil.test" } }), "d1")).toMatchObject({ ok: false, status: 403 });
  });
  it("follows the docs route: no session or another workspace's doc is refused", async () => {
    expect(await collabAccess(app(401), deps, new Request("https://app.test/api/docs/d1/collab", { headers: ws }), "d1")).toMatchObject({ ok: false, status: 401 });
    expect(await collabAccess(app(404), deps, new Request("https://app.test/api/docs/d1/collab", { headers: ws }), "d1")).toMatchObject({ ok: false, status: 404 });
  });
});
