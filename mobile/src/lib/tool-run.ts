/**
 * Tools P2 on the phone: what outlives one screen.
 * - The run in progress (job token, tool, the original size) is kept on the phone, so a run survives the app going
 *   to the background or being closed: the Tools screen offers it again and the tool screen picks it back up.
 * - Recent tools, newest first.
 * - A file carried from one tool's result to the next tool ("Use in another tool").
 * - Results handed to Compose ("Attach to a new email") as the server's download tokens, so nothing is downloaded
 *   or uploaded again (the server reads each result from the document engine when the email is sent).
 */
import { useSyncExternalStore } from "react";
import { kv, type KV } from "./kv";
import type { PickedFile, ToolJob } from "./tools";

// ---------------------------------------------------------------- the run in progress

export interface SavedRun {
  token: string;
  op: string;
  /** The first file's name, for the line on the Tools screen. */
  name: string;
  /** The original size, so a compress result still says what it saved after the app was closed. */
  before?: number | null;
  /** When the run started (ms). The server keeps a job for an hour. */
  at: number;
  /** The finished job, once it is done (kept until Start over, so the result screen comes back too). */
  done?: ToolJob | null;
}

const RUN_KEY = "tools:run";
/** Results are kept on the server for an hour; a saved run older than that is dropped. */
export const RUN_MAX_AGE_MS = 55 * 60 * 1000;

let runCache: SavedRun | null | undefined;
const runListeners = new Set<() => void>();
const emitRun = () => runListeners.forEach((l) => l());

export async function loadRun(store: KV = kv(), now = Date.now()): Promise<SavedRun | null> {
  if (runCache !== undefined) return runCache && now - runCache.at < RUN_MAX_AGE_MS ? runCache : null;
  try {
    const raw = await store.get(RUN_KEY);
    const v = raw ? (JSON.parse(raw) as SavedRun) : null;
    runCache = v && typeof v.token === "string" && typeof v.op === "string" && now - Number(v.at) < RUN_MAX_AGE_MS ? v : null;
  } catch { runCache = null; }
  return runCache;
}

export async function saveRun(run: SavedRun, store: KV = kv()): Promise<void> {
  runCache = run;
  emitRun();
  await store.set(RUN_KEY, JSON.stringify(run)).catch(() => {});
}

export async function clearRun(store: KV = kv()): Promise<void> {
  runCache = null;
  emitRun();
  await store.remove(RUN_KEY).catch(() => {});
}

/** The saved run as React state (null until loaded or when there is none). */
export function useSavedRun(): SavedRun | null {
  return useSyncExternalStore((l) => { runListeners.add(l); if (runCache === undefined) void loadRun().then(emitRun); return () => runListeners.delete(l); },
    () => (runCache && Date.now() - runCache.at < RUN_MAX_AGE_MS ? runCache : null), () => null);
}

/** Forgets what is cached in memory (sign out, workspace switch, Clear saved mail; tests). */
export function resetToolRunCache() {
  runCache = undefined; carried = null; pendingTools = null; recentCache = null;
  emitRun(); // PRIV1b (MH3): a mounted Tools screen drops the old run too
}

// ---------------------------------------------------------------- recent tools

const RECENT_KEY = "tools:recent";
let recentCache: string[] | null = null;

export async function recentKeys(store: KV = kv()): Promise<string[]> {
  if (recentCache) return recentCache;
  try { const v = JSON.parse((await store.get(RECENT_KEY)) ?? "[]"); recentCache = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 6) : []; } catch { recentCache = []; }
  return recentCache;
}

export async function rememberRecent(key: string, store: KV = kv()): Promise<string[]> {
  const next = [key, ...(await recentKeys(store)).filter((k) => k !== key)].slice(0, 6);
  recentCache = next;
  await store.set(RECENT_KEY, JSON.stringify(next)).catch(() => {});
  return next;
}

// ---------------------------------------------------------------- a file carried to the next tool

let carried: PickedFile | null = null;
/** Hands a result file to the next tool picked on the Tools screen. */
export function carryFile(f: PickedFile) { carried = f; }
export function peekCarried(): PickedFile | null { return carried; }
export function takeCarried(): PickedFile | null { const f = carried; carried = null; return f; }
export function dropCarried() { carried = null; }

// ---------------------------------------------------------------- results handed to Compose

export interface ToolFileRef { token: string; name: string; bytes?: number }
let pendingTools: ToolFileRef[] | null = null;

/** The download token inside a result's downloadUrl ("/api/tools/jobs/<token>/download"). */
export function tokenFromDownloadUrl(url: string | undefined): string | null {
  const m = url ? /\/api\/tools\/(?:editors\/)?jobs\/([^/]+)\/download$/.exec(url) : null;
  return m ? decodeURIComponent(m[1]) : null;
}

/** Parks finished results for the next Compose to pick up. Returns false when the job has no result to attach. */
export function attachToNewEmail(jobs: Pick<ToolJob, "downloadUrl" | "name" | "bytes">[]): boolean {
  const refs: ToolFileRef[] = [];
  for (const j of jobs) { const token = tokenFromDownloadUrl(j.downloadUrl); if (token) refs.push({ token, name: j.name, bytes: j.bytes }); }
  pendingTools = refs.length ? refs.slice(0, 10) : null;
  return !!pendingTools;
}
export function takePendingToolFiles(): ToolFileRef[] { const v = pendingTools ?? []; pendingTools = null; return v; }
