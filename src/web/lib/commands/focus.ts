/**
 * R31: the current focus. Which task or message has keyboard focus (j/k moves it on lists), or which
 * item is open. Single key actions (S, A, P, E, R, ...) act on it; the command menu lists its actions first.
 */
import { useSyncExternalStore } from "react";

export type FocusKind = "task" | "mail";
export interface Focus { kind: FocusKind | null; id: string | null; /** The visible rows, in order, for j/k. */ list: string[]; listKind: FocusKind | null }

let focus: Focus = { kind: null, id: null, list: [], listKind: null };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export const getFocus = (): Focus => focus;
export function setFocus(kind: FocusKind | null, id: string | null) {
  if (focus.kind === kind && focus.id === id) return;
  focus = { ...focus, kind: id ? kind : null, id };
  emit();
}
/** A list page says which rows it shows, so j/k can walk them. */
export function setFocusList(kind: FocusKind | null, list: string[]) {
  if (focus.listKind === kind && focus.list.length === list.length && focus.list.every((v, i) => v === list[i])) return;
  focus = { ...focus, list, listKind: kind };
  emit();
}
export function clearFocus() { focus = { kind: null, id: null, list: [], listKind: null }; emit(); }

/** The next row for j (+1) or k (-1), clamped; the first row when nothing has focus yet. */
export function stepFocus(f: Focus, dir: 1 | -1): string | null {
  if (!f.list.length) return null;
  const at = f.id ? f.list.indexOf(f.id) : -1;
  if (at < 0) return dir === 1 ? f.list[0] : f.list[f.list.length - 1];
  return f.list[Math.min(Math.max(at + dir, 0), f.list.length - 1)];
}

export function subscribeFocus(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function useFocus(): Focus { return useSyncExternalStore(subscribeFocus, getFocus, getFocus); }
