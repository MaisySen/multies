import { Platform } from "react-native";
import { kv, type KV } from "./kv";
import { LEGACY_KEY } from "./tasks";
import { commandQueue } from "./command-queue";
import { resetToolRunCache } from "./tool-run";
import { LAST_QUERY_KEY } from "./task-query";

/**
 * PRIV1b (P53): the one list of what this phone keeps for one person in one workspace. Sign out, a workspace
 * switch and Settings, Clear saved mail all clear it, so nothing (cached mail, snoozed items, tabs, rules, the
 * tool run, recent searches, visit plans) is shown to the next account or in the next workspace.
 * Device settings (language, theme, lock, undo send, the nav menu kept per person) are not on it.
 */
export const USER_CACHE_PREFIXES: readonly string[] = [
  "list:", "thread:", "meta:", "task:", "worklist:", "tabs:", "snoozed:", "rules:", "tools:", "search:recent", "visits:", LAST_QUERY_KEY,
];
/** Folders under the phone's cache with downloaded files (Files, Tools) and the document picker's copies. */
export const USER_CACHE_DIRS: readonly string[] = ["drive", "tools", "DocumentPicker"];
const TEMP_FILE_PREFIX = "tools-upload-";

export interface CacheEntry { name: string; delete(): void }
export type CacheFolder = () => CacheEntry[];

/** The entries in the phone's cache folder; none on the web or where the file system is not there. */
function phoneCache(): CacheEntry[] {
  if (Platform.OS === "web") return [];
  try {
    // Loaded lazily so the web build and tests never touch the native module (see lib/tools-files.ts for the path).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("../../node_modules/expo/node_modules/expo-file-system") as typeof import("../../node_modules/expo/node_modules/expo-file-system");
    const root = fs.Paths.cache;
    return root.exists ? root.list() : [];
  } catch { return []; }
}

/** Deletes downloaded files, tool uploads and picked file copies. Best effort: a file in use stays until next time. */
export function clearUserFiles(folder: CacheFolder = phoneCache): void {
  let entries: CacheEntry[] = [];
  try { entries = folder(); } catch { return; }
  for (const e of entries) {
    if (!USER_CACHE_DIRS.includes(e.name) && !e.name.startsWith(TEMP_FILE_PREFIX)) continue;
    try { e.delete(); } catch { /* best effort */ }
  }
}

/**
 * "cache": Settings, Clear saved mail (changes waiting to sync stay).
 * "workspace": a workspace switch, which also drops the waiting changes made in the workspace just left.
 * "signOut": sign out, which also drops waiting changes and the old on-phone task list.
 */
export async function clearUserData(scope: "cache" | "workspace" | "signOut", store: KV = kv(), folder?: CacheFolder): Promise<void> {
  const prefixes = [...USER_CACHE_PREFIXES, ...(scope === "cache" ? [] : ["queue:"]), ...(scope === "signOut" ? [LEGACY_KEY] : [])];
  for (const p of prefixes) await store.clear(p).catch(() => {});
  if (scope !== "cache") await commandQueue()?.clear().catch(() => {});
  resetToolRunCache(); // the run, the file carried to the next tool and results parked for Compose live in memory too
  clearUserFiles(folder);
}
