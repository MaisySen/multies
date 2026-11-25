/**
 * R30 names, R31 source: the keys now live in the one command registry (lib/commands). This file keeps
 * the sheet helpers and the names other code imports; SHORTCUTS and GO_TO are read from the registry.
 */
import { COMMANDS, COMMAND_GROUPS, GO_KEYS, inSheet, displayKeys as registryDisplayKeys, type Command, type CommandGroup, type CommandScope } from "@/web/lib/commands";
import { PALETTE_PAGES } from "@/web/lib/palette-registry";
import { crmScopeOn } from "@/web/lib/shortcut-pref-td10"; // TD10

export type ShortcutGroup = CommandGroup;
export const SHORTCUT_GROUPS: ShortcutGroup[] = COMMAND_GROUPS;

export interface Shortcut {
  id: string;
  /** Keys pressed together, e.g. ["Mod", "K"]. "Mod" is Cmd on a Mac and Ctrl elsewhere. */
  keys: string[];
  /** Pressed one after the other ("G then T") instead of together. */
  sequence?: boolean;
  label: string;
  group: ShortcutGroup;
  scope: CommandScope;
  /** Go to shortcuts: where the second key takes you. */
  to?: string;
  /** Extra words people search for. */
  keywords?: string[];
}

const toShortcut = (c: Command): Shortcut => ({ id: c.id, keys: c.keys ?? [], sequence: c.sequence, label: c.title, group: c.group, scope: c.scope, to: c.to, keywords: c.keywords });

/** Every command with keys, as the sheet lists it (read from the registry each time, so modules added later show). */
export function sheetShortcuts(): Shortcut[] { return COMMANDS.filter(inSheet).filter((c) => c.flag !== "crmTd10" || crmScopeOn()).map(toShortcut); } // TD10: CRM keys only while CRM_TD10 is on
export const SHORTCUTS: Shortcut[] = sheetShortcuts();

/** Second key after G, and where it goes. */
export const GO_TO: { key: string; label: string; to: string }[] = GO_KEYS.map((g) => {
  const p = PALETTE_PAGES.find((x) => x.id === g.page)!;
  return { key: g.key, label: g.label ?? p.label, to: p.to };
});

/** Key labels as this computer shows them. */
export const displayKeys = (s: Pick<Shortcut, "keys">, mac: boolean): string[] => registryDisplayKeys(s, mac);

/** The sheet's search: every word must appear in the label, the group, a key or a keyword. */
export function filterShortcuts(list: Shortcut[], query: string): Shortcut[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((s) => {
    const hay = [s.label, s.group, ...s.keys, ...(s.keywords ?? [])].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Shortcuts grouped in the sheet's order, empty groups left out; `first` (the current page's group) leads. */
export function groupShortcuts(list: Shortcut[], first?: ShortcutGroup): { group: ShortcutGroup; items: Shortcut[] }[] {
  const order = first ? [first, ...SHORTCUT_GROUPS.filter((g) => g !== first)] : SHORTCUT_GROUPS;
  return order.map((group) => ({ group, items: list.filter((s) => s.group === group) })).filter((g) => g.items.length > 0);
}

/** The sheet group for the page you are on. */
export function groupForPath(pathname: string): ShortcutGroup | undefined {
  if (pathname.startsWith("/app/mail")) return "Mail";
  if (pathname.startsWith("/app/tasks") || pathname.startsWith("/app/my-work")) return "Tasks";
  if (pathname.startsWith("/app/chat") || pathname.startsWith("/app/docs")) return "Writing";
  if (crmScopeOn() && /^\/app\/(contacts|deals|analyses)(\/|$)/.test(pathname)) return "CRM"; // TD10
  return undefined;
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

export { OPEN_PALETTE_EVENT, OPEN_SHORTCUTS_EVENT, openPalette, openShortcutsSheet } from "./shortcut-events";
