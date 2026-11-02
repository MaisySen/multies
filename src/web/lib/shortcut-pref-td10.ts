/**
 * TD10 (CRM_TD10): the per person "Single key shortcuts" switch (WCAG 2.1.4 character key shortcuts can be turned off).
 * Off means single keys and G sequences do nothing anywhere; chords like Ctrl K, Escape, Enter, Tab, arrows and Space
 * keep working, and keys typed into fields, menus, lists and grids are never touched.
 */
let off = false;
let crmOn = false;
/** The CRM keys scope is live only while CRM_TD10 is on (set from /api/config by the shortcuts host). */
export function crmScopeOn() { return crmOn; }
export function setCrmScopeOn(v: boolean) { crmOn = v; }
const listeners = new Set<() => void>();

export function singleKeysOff() { return off; }
export function setSingleKeysOff(v: boolean) { if (off !== v) { off = v; listeners.forEach((l) => l()); } }
export function subscribeSingleKeys(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/** A printable key with no Ctrl, Cmd or Alt (Shift allowed: "?" and Shift+E are single keys too). Space is not a shortcut key. */
export function isSingleKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }) {
  return !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.key !== " ";
}

/** Widgets that use letters for their own typeahead: a key there is never blocked. */
export function inKeyWidget(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && typeof t.closest === "function" && !!t.closest('[role="menu"],[role="menubar"],[role="listbox"],[role="tree"],[role="grid"],[role="combobox"],[role="slider"],dialog');
}

/**
 * Chords the browser or a screen reader owns. No command may use them (the registry test reads this list).
 * Plain arrows, Tab and Insert or Caps Lock combinations belong to screen readers and to focus movement.
 */
export const RESERVED_CHORDS: string[][] = [
  ["Mod", "T"], ["Mod", "W"], ["Mod", "N"], ["Mod", "L"], ["Mod", "R"], ["Mod", "Q"], ["Mod", "P"], ["Mod", "F"], ["Mod", "D"], ["Mod", "H"], ["Mod", "J"],
  ["Mod", "Tab"], ["Mod", "Shift", "T"], ["Mod", "Shift", "N"], ["Mod", "Shift", "Delete"], ["Alt", "F4"], ["Alt", "Left"], ["Alt", "Right"], ["Alt", "Home"],
];
export const RESERVED_SINGLE = ["Tab", "Insert", "CapsLock", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "F1", "F3", "F5", "F6", "F7", "F11", "F12", " "];
