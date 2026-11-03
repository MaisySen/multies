/**
 * VID2: the IndexedDB home for recording pieces on this device (crash safe). Each second of video is stored as it
 * comes, so a crash, a closed tab or a lost power cut leaves everything up to the last second; "Recover last
 * recording" rebuilds the file from here. Pieces are removed once the video is saved. Nothing leaves the device.
 * Dynamic import only.
 */
import type { PieceBackend, StoredMeta } from "./video-rec-vid2";

const DB = "multies-recordings-vid2";
const META = "meta";
const PIECES = "pieces";

let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((res, rej) => {
    if (typeof indexedDB === "undefined") { rej(new Error("This browser can't keep recordings on the device.")); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PIECES)) db.createObjectStore(PIECES);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error("The recording store did not open."));
    r.onblocked = () => rej(new Error("The recording store is busy in another tab."));
  });
  opening.catch(() => { opening = null; });
  return opening;
}

const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error ?? new Error("aborted")); });
const ask = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const key = (id: string, seq: number) => `${id}:${String(seq).padStart(8, "0")}`;

export const idbBackend: PieceBackend = {
  async putMeta(m: StoredMeta) {
    const db = await open();
    const t = db.transaction(META, "readwrite");
    t.objectStore(META).put(m);
    await done(t);
  },
  async metas() {
    const db = await open();
    return (await ask(db.transaction(META, "readonly").objectStore(META).getAll())) as StoredMeta[];
  },
  async putPiece(id: string, seq: number, b: Blob) {
    const db = await open();
    const t = db.transaction(PIECES, "readwrite");
    t.objectStore(PIECES).put(b, key(id, seq));
    await done(t);
  },
  async pieces(id: string) {
    const db = await open();
    const range = IDBKeyRange.bound(`${id}:`, `${id}:\uffff`);
    const store = db.transaction(PIECES, "readonly").objectStore(PIECES);
    const [keys, values] = await Promise.all([ask(store.getAllKeys(range)), ask(store.getAll(range))]);
    return keys.map((k, i) => ({ seq: Number(String(k).split(":").pop()), blob: values[i] as Blob }));
  },
  async remove(id: string) {
    const db = await open();
    const t = db.transaction([META, PIECES], "readwrite");
    t.objectStore(META).delete(id);
    t.objectStore(PIECES).delete(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`));
    await done(t);
  },
};

/** Asks the browser to keep this site's storage under pressure (best effort; no prompt in Chrome or Edge). */
export async function keepStorage() {
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
}
