/**
 * R58 (MB-245): one browser, one session, one active workspace. Switching workspace in one tab changes it for every
 * tab, so a tab still showing the old workspace would send its saves to projects the server no longer opens
 * ("Project not found."). The tab that switched announces the workspace it opened (BroadcastChannel, with a storage
 * event as the fallback); a tab showing a different workspace becomes "behind": it shows a calm banner with Reload and
 * stops its own writes before they are sent, so nothing can go to the wrong workspace. No server request is added.
 */

export interface WorkspaceNote { orgId: string; name: string; tab: string; at: number }
export interface Behind { orgId: string; name: string }

export const CHANNEL = "multies-workspace";
export const STORAGE_KEY = "mm-active-workspace";
export const CARRY_KEY = "mm-carry-text";

interface ChannelLike { postMessage(m: unknown): void; addEventListener(t: "message", f: (e: { data: unknown }) => void): void }
interface StorageLike { setItem(k: string, v: string): void; getItem?(k: string): string | null; removeItem?(k: string): void }

export interface WorkspaceTabsEnv {
  channel?: ChannelLike | null;
  storage?: StorageLike | null;
  /** Registers the storage event fallback (other tabs' writes to STORAGE_KEY). */
  onStorage?: (f: (key: string | null, value: string | null) => void) => void;
  tabId?: string;
  now?: () => number;
}

/** Writes a behind tab may still make: switching or making a workspace (which brings it up to date) and signing out. */
export function writeAllowedWhileBehind(path: string): boolean {
  return /^\/account\/workspaces(\/|$|\?)/.test(path) || /^\/auth\//.test(path);
}

export function blockedMessage(name: string): string {
  return `You switched to ${name || "another workspace"} in another tab. Reload to keep working here.`;
}

export function parseNote(raw: unknown): WorkspaceNote | null {
  let v = raw;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  const n = v as Partial<WorkspaceNote> | null;
  if (!n || typeof n !== "object" || typeof n.orgId !== "string" || !n.orgId || typeof n.tab !== "string") return null;
  return { orgId: n.orgId, name: typeof n.name === "string" ? n.name : "", tab: n.tab, at: typeof n.at === "number" ? n.at : 0 };
}

export function createWorkspaceTabs(env: WorkspaceTabsEnv = {}) {
  const tab = env.tabId ?? Math.random().toString(36).slice(2, 10);
  const now = env.now ?? Date.now;
  let shown: { orgId: string; name: string } | null = null;
  let behind: Behind | null = null;
  const subs = new Set<() => void>();
  const emit = () => { for (const f of subs) f(); };

  const receive = (raw: unknown) => {
    const n = parseNote(raw);
    if (!n || n.tab === tab || !shown) return;
    if (n.orgId === shown.orgId) { if (behind) { behind = null; emit(); } return; } // switched back: up to date again
    if (behind?.orgId === n.orgId && behind.name === n.name) return;
    behind = { orgId: n.orgId, name: n.name };
    emit();
  };
  env.channel?.addEventListener("message", (e) => receive(e.data));
  env.onStorage?.((key, value) => { if (key === STORAGE_KEY && value) receive(value); });

  return {
    tab,
    /** This tab now shows `orgId` (its first load, or a switch made here): tell the other tabs. */
    adopt(orgId: string, name: string) {
      if (behind) return; // a behind tab keeps waiting for Reload; a refetch here must not hide the banner
      if (shown?.orgId === orgId && shown.name === name) return;
      shown = { orgId, name };
      const note: WorkspaceNote = { orgId, name, tab, at: now() };
      try { env.channel?.postMessage(note); } catch { /* closed channel */ }
      try { env.storage?.setItem(STORAGE_KEY, JSON.stringify(note)); } catch { /* storage full or blocked */ }
    },
    /** A switch made in this tab: it is up to date again whatever it showed, and adopts what the server opens next. */
    switchedHere() { shown = null; if (behind) { behind = null; emit(); } },
    behind: (): Behind | null => behind,
    /** The message for a write this tab must not send, or null when it may. */
    blockWrite(method: string, path: string): string | null {
      if (!behind || method === "GET" || method === "HEAD" || writeAllowedWhileBehind(path)) return null;
      return blockedMessage(behind.name);
    },
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
    receive,
  };
}

export type WorkspaceTabs = ReturnType<typeof createWorkspaceTabs>;

let single: WorkspaceTabs | null = null;
/** The one instance for this page (null outside a browser). */
export function workspaceTabs(): WorkspaceTabs | null {
  if (single) return single;
  if (typeof window === "undefined") return null;
  let storage: StorageLike | null = null;
  try { storage = window.localStorage; } catch { /* blocked */ }
  single = createWorkspaceTabs({
    channel: typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL),
    storage,
    onStorage: (f) => window.addEventListener("storage", (e) => f(e.key, e.newValue)),
  });
  return single;
}

/** Text typed into open dialogs or the focused field, so Reload can keep it. */
export function typedText(doc: Document): string {
  const out: string[] = [];
  const seen = new Set<Element>();
  const add = (el: Element | null) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|email|url|)$/.test(el.type))) { if (el.value.trim()) out.push(el.value.trim()); }
    else if (el instanceof HTMLElement && el.isContentEditable && el.innerText.trim()) out.push(el.innerText.trim());
  };
  doc.querySelectorAll('[role="dialog"] input, [role="dialog"] textarea, [role="dialog"] [contenteditable="true"]').forEach(add);
  add(doc.activeElement);
  return out.join("\n\n");
}
