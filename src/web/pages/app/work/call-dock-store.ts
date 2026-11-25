/**
 * R23: which call is shown in the docked window. A tiny store of its own, so the app frame can tell whether a call is
 * open (and only then load the dock, its page and the meetings wording) without loading them on every first screen.
 */
import { useSyncExternalStore } from "react";

export interface DockCall { meetingId: string; title: string; path: string }
let docked: DockCall | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
export function openCallDock(c: DockCall) { docked = c; emit(); }
export function closeCallDock() { docked = null; emit(); }
const subscribe = (f: () => void) => { listeners.add(f); return () => listeners.delete(f); };
export const useCallDock = () => useSyncExternalStore(subscribe, () => docked, () => null);
