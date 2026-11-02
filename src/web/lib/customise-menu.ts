/** R121: the Customise menu dialog opens from anywhere (the View menu, the phone More sheet) through this one event. */
export const OPEN_CUSTOMISE_MENU_EVENT = "multies:customise-menu";
export function openCustomiseMenu() {
  window.dispatchEvent(new CustomEvent(OPEN_CUSTOMISE_MENU_EVENT));
}
