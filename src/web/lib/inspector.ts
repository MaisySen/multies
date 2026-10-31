/**
 * R79: the shell's inspector, a resizable side panel beside the page (task details today). A page asks for it by
 * mounting a claim; the shell shows the panel while any claim is held and hands back the element to portal into.
 */
import { useEffect, useSyncExternalStore } from "react";

let claims = 0;
let el: HTMLElement | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** The shell's callback ref for the panel body. */
export function setInspectorEl(node: HTMLElement | null) { if (node !== el) { el = node; emit(); } }

/** True while a page holds the inspector (the shell renders the panel). */
export function useInspectorOpen(): boolean { return useSyncExternalStore(subscribe, () => claims > 0, () => false); }

/** Hold the inspector while mounted (when active); returns the element to portal into once the shell has it. */
export function useInspector(active: boolean): HTMLElement | null {
  useEffect(() => {
    if (!active) return;
    claims += 1; emit();
    return () => { claims = Math.max(0, claims - 1); emit(); };
  }, [active]);
  return useSyncExternalStore(subscribe, () => (active ? el : null), () => null);
}
