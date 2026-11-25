/**
 * R74: a file picked in a Tools screen survives a reload of that tab.
 *
 * The picked file is copied into this browser's IndexedDB under the screen's key, tagged with this tab's own id (kept
 * in sessionStorage, which a reload keeps and a new tab does not). After a reload the screen takes it back; a new tab,
 * another screen, or anything older than an hour gets nothing, and a stale copy is deleted when found. Sign out wipes
 * them all (lib/sw-client.ts clearOfflineData). Files over 50 MB are not kept. Every call fails quietly: private mode or
 * a full disk only means no restore.
 */
import { randomId } from "@/shared/random";
const DB = "multies-kept-files";
const STORE = "files";
const TAB_KEY = "multies-tab-id";
export const KEEP_MAX_BYTES = 50 * 1024 * 1024;
export const KEEP_MAX_AGE_MS = 60 * 60 * 1000;

interface Row { key: string; tab: string; at: number; files: { name: string; type: string; lastModified: number; blob: Blob }[] }

/** This tab's id: the same across reloads of this tab, new in every other tab. */
export function tabId(store: Pick<Storage, "getItem" | "setItem"> | null = safeSession()): string {
  try {
    const have = store?.getItem(TAB_KEY);
    if (have) return have;
    const id = `${Date.now().toString(36)}${randomId(8)}`;
    store?.setItem(TAB_KEY, id);
    return id;
  } catch { return "none"; }
}
function safeSession(): Storage | null { try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; } }

/** Whether a stored copy may be restored here and now. */
export function usable(row: Pick<Row, "tab" | "at"> | undefined, tab: string, now = Date.now()): boolean {
  return !!row && row.tab === tab && tab !== "none" && now - row.at >= 0 && now - row.at < KEEP_MAX_AGE_MS;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "key" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req ? (req.result as T) : undefined); };
      tx.onerror = () => { db.close(); resolve(undefined); };
      tx.onabort = () => { db.close(); resolve(undefined); };
    } catch { db.close(); resolve(undefined); }
  });
}

/** Keeps these files for this screen in this tab (replacing what was kept). An empty list forgets. */
export async function keepFiles(key: string, files: File[]): Promise<void> {
  if (!files.length) { await forgetFiles(key); return; }
  if (files.reduce((n, f) => n + f.size, 0) > KEEP_MAX_BYTES) { await forgetFiles(key); return; }
  const row: Row = { key, tab: tabId(), at: Date.now(), files: files.map((f) => ({ name: f.name, type: f.type, lastModified: f.lastModified, blob: f })) };
  await run("readwrite", (s) => s.put(row));
}

/** The files kept for this screen in this tab, or null. A copy from another tab or older than an hour is deleted. */
export async function keptFiles(key: string): Promise<File[] | null> {
  const row = await run<Row | undefined>("readonly", (s) => s.get(key));
  if (!row) return null;
  if (!usable(row, tabId())) { if (Date.now() - row.at >= KEEP_MAX_AGE_MS) await forgetFiles(key); return null; }
  try { return row.files.map((f) => new File([f.blob], f.name, { type: f.type, lastModified: f.lastModified })); } catch { return null; }
}

export async function forgetFiles(key: string): Promise<void> { await run("readwrite", (s) => s.delete(key)); }

/** Sign out: every kept file in this browser goes. */
export async function forgetAllKeptFiles(): Promise<void> {
  try { if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase(DB); } catch { /* nothing kept */ }
}
