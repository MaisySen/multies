/**
 * Doc co-editing in the browser: a Yjs document per doc, synced through
 * GET /api/docs/:id/collab with y-websocket. The saved doc row (Tiptap JSON plus
 * plain text) stays the record that search, agents and the API read.
 *
 * Rules, so the room and the row never drift apart for good:
 * - One client saves: the leader, the connected client with the lowest Yjs client id.
 * - The room's "meta" map remembers the row version its content matches, plus a hash
 *   of the row's plain text. A row version the room has not seen with different text
 *   means the doc was changed through the API or MCP, and the leader loads that
 *   content into the room. A different version with the same text (a title change)
 *   is only adopted.
 * - An empty room is seeded from the saved JSON with a fixed client id, so two
 *   people opening a doc at the same moment produce the same seed instead of two.
 */
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import type { Schema } from "@tiptap/pm/model";

export const FIELD = "default";
const SEED_CLIENT_ID = 1;
const CONNECT_TIMEOUT_MS = 5000;

export interface CollabSession { ydoc: Y.Doc; provider: WebsocketProvider }
export interface Peer { clientId: number; name: string; color: string }

/** Opens the room and waits for the first sync. Null when co-editing is not available. */
export function connectCollab(docId: string): Promise<CollabSession | null> {
  if (typeof WebSocket === "undefined") return Promise.resolve(null);
  const ydoc = new Y.Doc();
  const base = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/docs`;
  const provider = new WebsocketProvider(base, `${encodeURIComponent(docId)}/collab`, ydoc, { disableBc: true, maxBackoffTime: 5000 });
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      provider.off("sync", onSync);
      provider.off("connection-close", onFail);
      provider.off("connection-error", onFail);
      if (ok) { resolve({ ydoc, provider }); return; }
      provider.destroy();
      ydoc.destroy();
      resolve(null);
    };
    const onSync = (synced: boolean) => { if (synced) finish(true); };
    const onFail = () => finish(false);
    const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    provider.on("sync", onSync);
    provider.on("connection-close", onFail);
    provider.on("connection-error", onFail);
  });
}

export const meta = (ydoc: Y.Doc) => ydoc.getMap<unknown>("meta");

/** Fills an empty room from the saved Tiptap JSON. Returns true when it seeded. */
export function seedIfEmpty(ydoc: Y.Doc, schema: Schema, doc: { content: unknown; text: string; version: number }) {
  const m = meta(ydoc);
  if (ydoc.getXmlFragment(FIELD).length > 0 || m.has("version")) return false;
  const seed = new Y.Doc();
  seed.clientID = SEED_CLIENT_ID;
  const content = doc.content as { content?: unknown[] } | null;
  if (content && Array.isArray(content.content) && content.content.length) prosemirrorJSONToYXmlFragment(schema, content, seed.getXmlFragment(FIELD));
  seed.getMap("meta").set("version", doc.version);
  seed.getMap("meta").set("rowText", hashText(doc.text));
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seed));
  seed.destroy();
  return true;
}

/** The connected client with the lowest id saves the doc row. */
export function isLeader(session: CollabSession) {
  const ids = [...session.provider.awareness.getStates().keys()];
  if (!ids.includes(session.ydoc.clientID)) ids.push(session.ydoc.clientID);
  return Math.min(...ids) === session.ydoc.clientID;
}

export function peersOf(session: CollabSession): Peer[] {
  const out: Peer[] = [];
  session.provider.awareness.getStates().forEach((state, clientId) => {
    const user = (state as { user?: { name?: string; color?: string } }).user;
    if (clientId !== session.ydoc.clientID && user?.name) out.push({ clientId, name: user.name, color: user.color ?? "#888" });
  });
  return out;
}

/** FNV-1a, enough to tell whether two texts differ. */
export function hashText(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

const COLOURS = ["#e8590c", "#1971c2", "#2f9e44", "#9c36b5", "#c2255c", "#0c8599", "#f08c00", "#5f3dc4"];
export const colourFor = (key: string) => COLOURS[parseInt(hashText(key), 16) % COLOURS.length];
