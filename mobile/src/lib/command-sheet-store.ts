import { useSyncExternalStore } from "react";

/** R31: whether the command sheet is open. Any header button or a long-press on the tab bar opens it. */
let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openCommandSheet() { open = true; emit(); }
export function closeCommandSheet() { open = false; emit(); }
export function useCommandSheetOpen(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => open, () => open);
}
