/** R121: the Customise menu dialog opens from anywhere (the View menu, the phone More sheet) through this one event. */
export const OPEN_CUSTOMISE_MENU_EVENT = "multies:customise-menu";
/** F13: `returnTo` is a selector for the control that gets focus back after Done (the View menu button, the More tab),
 *  because the menu item that opened the dialog is gone by then. */
export function openCustomiseMenu(returnTo?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_CUSTOMISE_MENU_EVENT, { detail: { returnTo } }));
}
