/**
 * The events that open the shortcuts sheet and the command menu from anywhere. Apart from ./shortcuts (the key
 * registry) so the app frame and its buttons can fire them without loading every command on a phone's first screen.
 */

/** The sheet opens from anywhere (the command menu, the account menu) through this one event. */
export const OPEN_SHORTCUTS_EVENT = "multies:shortcuts";
export function openShortcutsSheet() {
  window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT));
}

/** R31: the command menu opens from anywhere (a single key, a button) through this event; `page` opens a nested picker. */
export const OPEN_PALETTE_EVENT = "multies:palette";
export function openPalette(page?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { page } }));
}
