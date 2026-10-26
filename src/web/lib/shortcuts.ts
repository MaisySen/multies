/**
 * R30: the one list of keyboard shortcuts. The "?" sheet, the "G then key" navigation and the
 * command menu all read it, so the sheet never drifts from what the keys really do
 * (tests/shortcuts-r30.test.ts checks the mail keys against webmail.tsx).
 */

export type ShortcutGroup = "General" | "Go to" | "Mail" | "Tasks" | "Writing";
export const SHORTCUT_GROUPS: ShortcutGroup[] = ["General", "Go to", "Mail", "Tasks", "Writing"];

export interface Shortcut {
  id: string;
  /** Keys pressed together, e.g. ["Mod", "K"]. "Mod" is Cmd on a Mac and Ctrl elsewhere. */
  keys: string[];
  /** Pressed one after the other ("G then T") instead of together. */
  sequence?: boolean;
  label: string;
  group: ShortcutGroup;
  /** Go to shortcuts: where the second key takes you. */
  to?: string;
  /** Extra words people search for. */
  keywords?: string[];
}

/** Second key after G, and where it goes. */
export const GO_TO: { key: string; label: string; to: string }[] = [
  { key: "w", label: "My Work", to: "/app/my-work" },
  { key: "o", label: "Overview", to: "/app" },
  { key: "n", label: "Notifications", to: "/app/notifications" },
  { key: "i", label: "Mail", to: "/app/mail" },
  { key: "u", label: "Shared inbox", to: "/app/inbox" },
  { key: "c", label: "Chat", to: "/app/chat" },
  { key: "t", label: "Tasks", to: "/app/tasks" },
  { key: "d", label: "Docs", to: "/app/docs" },
  { key: "m", label: "Meetings", to: "/app/meetings" },
  { key: "p", label: "Contacts", to: "/app/contacts" },
  { key: "a", label: "Agents", to: "/app/agents" },
  { key: "s", label: "Settings", to: "/app/settings" },
];

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", keys: ["Mod", "K"], label: "Open the command menu", group: "General", keywords: ["search", "jump", "palette"] },
  { id: "sheet", keys: ["?"], label: "Show keyboard shortcuts", group: "General", keywords: ["help", "keys"] },
  { id: "escape", keys: ["Esc"], label: "Close a menu, dialog or message", group: "General" },
  ...GO_TO.map((g): Shortcut => ({ id: `go-${g.key}`, keys: ["G", g.key.toUpperCase()], sequence: true, label: `Go to ${g.label}`, group: "Go to", to: g.to, keywords: ["navigate", "open"] })),
  { id: "mail-next", keys: ["J"], label: "Next message", group: "Mail", keywords: ["down"] },
  { id: "mail-prev", keys: ["K"], label: "Previous message", group: "Mail", keywords: ["up"] },
  { id: "mail-compose", keys: ["C"], label: "Write an email", group: "Mail", keywords: ["compose", "new"] },
  { id: "mail-search", keys: ["/"], label: "Search mail", group: "Mail", keywords: ["find"] },
  { id: "mail-archive", keys: ["E"], label: "Archive", group: "Mail" },
  { id: "mail-trash", keys: ["#"], label: "Move to trash", group: "Mail", keywords: ["delete"] },
  { id: "mail-star", keys: ["S"], label: "Star or unstar", group: "Mail", keywords: ["flag"] },
  { id: "mail-task", keys: ["T"], label: "Make a task from the open email", group: "Mail", keywords: ["todo"] },
  { id: "check-move", keys: ["Alt", "Up or Down"], label: "Move a checklist item", group: "Tasks", keywords: ["reorder", "checklist"] },
  { id: "check-next", keys: ["Enter"], label: "Add the next checklist item", group: "Tasks", keywords: ["checklist"] },
  { id: "comment-send", keys: ["Mod", "Enter"], label: "Post a comment or note", group: "Writing", keywords: ["submit", "send"] },
  { id: "snippet", keys: ["/shortcut", "Tab"], label: "Insert a saved reply in Compose", group: "Writing", keywords: ["snippet", "template"] },
  { id: "chat-send", keys: ["Enter"], label: "Send a chat message", group: "Writing", keywords: ["chat"] },
  { id: "chat-newline", keys: ["Shift", "Enter"], label: "New line in a chat message", group: "Writing", keywords: ["chat"] },
];

/** Key labels as this computer shows them. */
export function displayKeys(s: Pick<Shortcut, "keys">, mac: boolean): string[] {
  return s.keys.map((k) => (k === "Mod" ? (mac ? "⌘" : "Ctrl") : k === "Alt" && mac ? "⌥" : k === "Shift" && mac ? "⇧" : k));
}

/** The sheet's search: every word must appear in the label, the group, a key or a keyword. */
export function filterShortcuts(list: Shortcut[], query: string): Shortcut[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((s) => {
    const hay = [s.label, s.group, ...s.keys, ...(s.keywords ?? [])].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Shortcuts grouped in the sheet's order, empty groups left out. */
export function groupShortcuts(list: Shortcut[]): { group: ShortcutGroup; items: Shortcut[] }[] {
  return SHORTCUT_GROUPS.map((group) => ({ group, items: list.filter((s) => s.group === group) })).filter((g) => g.items.length > 0);
}

/** Where "G then key" goes, or null. */
export function goToTarget(key: string): string | null {
  return GO_TO.find((g) => g.key === key.toLowerCase())?.to ?? null;
}

/** Keys typed into a field, or with a modifier, are not shortcuts. */
export function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!t || typeof t.tagName !== "string") return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || !!t.isContentEditable;
}

export type KeyState = { pendingG: number | null };
export type KeyAction = { kind: "sheet" } | { kind: "go"; to: string } | { kind: "arm" } | { kind: "none" };
/** How long after G the second key still counts, in ms. */
export const SEQUENCE_MS = 1200;

/**
 * The global key reducer, pure so it is tested without a browser: "?" opens the sheet,
 * G arms a go to, and a second key within SEQUENCE_MS goes there.
 */
export function readKey(state: KeyState, e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }, now: number): { state: KeyState; action: KeyAction } {
  if (e.metaKey || e.ctrlKey || e.altKey) return { state: { pendingG: null }, action: { kind: "none" } };
  const armed = state.pendingG !== null && now - state.pendingG <= SEQUENCE_MS;
  if (armed) {
    const to = goToTarget(e.key);
    return { state: { pendingG: null }, action: to ? { kind: "go", to } : { kind: "none" } };
  }
  if (e.key === "?") return { state: { pendingG: null }, action: { kind: "sheet" } };
  if (e.key === "g" || e.key === "G") return { state: { pendingG: now }, action: { kind: "arm" } };
  return { state: { pendingG: null }, action: { kind: "none" } };
}

/** The sheet opens from anywhere (the command menu, the account menu) through this one event. */
export const OPEN_SHORTCUTS_EVENT = "multies:shortcuts";
export function openShortcutsSheet() {
  window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT));
}
