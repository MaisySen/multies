/**
 * R79: the person's own layout (sidebar, mail reading pane, task details, timeline people column, density, favourites).
 * Kept per person on this device (localStorage, keyed by user id), read synchronously so the first paint already
 * has it; "Reset layout" clears every key this module owns, including the panel sizes the resizable groups save.
 * No server round trip and no new D1 query: layout is a device matter, like the appearance setting.
 */
import { useSyncExternalStore } from "react";

import { cleanFourthTab, cleanHidden, type FourthTab, type SectionId } from "@/shared/nav-menu"; // R121
export type MailPane = "right" | "bottom" | "off";
export type TaskDetails = "side" | "overlay";
export type Density = "comfortable" | "compact";
export interface Favourite { kind: "project" | "page"; id: string; label: string; to: string }

export interface LayoutPrefs {
  sidebarCollapsed: boolean;
  /** Mail has its own folder list, so the shell sidebar is folded there unless the person shows it. */
  sidebarOnMail: boolean;
  mailPane: MailPane;
  taskDetails: TaskDetails;
  timelinePeople: boolean;
  /** null: follow the workspace (its branding may choose compact). */
  density: Density | null;
  favourites: Favourite[];
  /** Sidebar sections the person folded (Favourites, Projects). */
  folded: string[];
  /** R121: rail sections the person hid (P2 menu); Home and Settings cannot be hidden. */
  railHidden: SectionId[];
  /** R121: the phone's fourth tab (P2 menu): Tasks, Social, Calendar or Docs. */
  fourthTab: FourthTab;
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  sidebarCollapsed: false, sidebarOnMail: false, mailPane: "right", taskDetails: "side", timelinePeople: false, density: null, favourites: [], folded: [], railHidden: [], fourthTab: "tasks",
};

const PREFIX = "multies.layout.";
let userKey = "anon";
let cache: LayoutPrefs | null = null;
const listeners = new Set<() => void>();

const storage = (): Storage | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
const key = () => `${PREFIX}${userKey}`;

/** Only known values survive a read, so an old or edited copy can never break the shell. */
export function sanitize(raw: unknown): LayoutPrefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  const favs = Array.isArray(o.favourites) ? o.favourites : [];
  return {
    sidebarCollapsed: o.sidebarCollapsed === true,
    sidebarOnMail: o.sidebarOnMail === true,
    mailPane: pick(o.mailPane, ["right", "bottom", "off"] as const, "right"),
    taskDetails: pick(o.taskDetails, ["side", "overlay"] as const, "side"),
    timelinePeople: o.timelinePeople === true,
    density: o.density === "compact" || o.density === "comfortable" ? o.density : null,
    favourites: favs.filter((f): f is Favourite => !!f && typeof f === "object"
      && ((f as Favourite).kind === "project" || (f as Favourite).kind === "page")
      && typeof (f as Favourite).id === "string" && typeof (f as Favourite).label === "string"
      && typeof (f as Favourite).to === "string" && (f as Favourite).to.startsWith("/app")).slice(0, 30)
      .map((f) => ({ kind: f.kind, id: f.id.slice(0, 80), label: f.label.slice(0, 80), to: f.to.slice(0, 300) })),
    folded: Array.isArray(o.folded) ? o.folded.filter((x): x is string => typeof x === "string").slice(0, 20) : [],
    railHidden: cleanHidden(o.railHidden), // R121
    fourthTab: cleanFourthTab(o.fourthTab), // R121
  };
}

export function readLayout(): LayoutPrefs {
  if (cache) return cache;
  let parsed: unknown;
  try { parsed = JSON.parse(storage()?.getItem(key()) ?? "null"); } catch { parsed = null; }
  cache = sanitize(parsed);
  return cache;
}

function emit() { for (const l of listeners) l(); }
function applyDensity(p: LayoutPrefs) {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  if (p.density) el.dataset.density = p.density; else delete el.dataset.density;
}

/** Called once the person is known; their own copy replaces the anonymous one. */
export function setLayoutUser(userId: string | null | undefined, opts: { silent?: boolean } = {}) {
  const next = userId ? userId.replace(/[^\w-]/g, "").slice(0, 64) || "anon" : "anon";
  if (next === userKey) return;
  userKey = next; cache = null;
  applyDensity(readLayout());
  // Silent while rendering (the shell sets the person before its children read); a later switch tells everyone.
  if (!opts.silent) emit();
}

export function setLayout(patch: Partial<LayoutPrefs>) {
  const next = sanitize({ ...readLayout(), ...patch });
  cache = next;
  try { storage()?.setItem(key(), JSON.stringify(next)); } catch { /* private mode: this tab only */ }
  applyDensity(next);
  emit();
}

/** Storage the resizable groups use for their sizes: per person, under the same prefix, so Reset clears them. */
export const panelStorage = {
  getItem: (k: string) => { try { return storage()?.getItem(`${key()}.panels.${k}`) ?? null; } catch { return null; } },
  setItem: (k: string, v: string) => { try { storage()?.setItem(`${key()}.panels.${k}`, v); } catch { /* ignore */ } },
};

/** Bumped by Reset layout so the resizable groups remount at their default sizes. */
let generation = 0;
export const layoutGeneration = () => generation;

export function resetLayout() {
  const s = storage();
  if (s) {
    const mine = key();
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && (k === mine || k.startsWith(`${mine}.panels.`))) doomed.push(k); }
    for (const k of doomed) s.removeItem(k);
  }
  // Favourites are content, not layout: they stay.
  const favourites = readLayout().favourites;
  cache = { ...DEFAULT_LAYOUT, favourites };
  try { s?.setItem(key(), JSON.stringify(cache)); } catch { /* ignore */ }
  generation += 1;
  applyDensity(cache);
  emit();
}

/** R121: hide or show one rail section (Home and Settings always stay). */
export function setRailHidden(id: SectionId, hide: boolean) {
  const now = readLayout().railHidden;
  setLayout({ railHidden: cleanHidden(hide ? [...now, id] : now.filter((x) => x !== id)) });
}
/** R121: back to the default menu (every section shown, Tasks as the fourth phone tab). The rest of the layout stays. */
export function resetMenu() { setLayout({ railHidden: [], fourthTab: "tasks" }); }

export function toggleFavourite(f: Favourite) {
  const cur = readLayout().favourites;
  const has = cur.some((x) => x.kind === f.kind && x.id === f.id);
  setLayout({ favourites: has ? cur.filter((x) => !(x.kind === f.kind && x.id === f.id)) : [...cur, f] });
}
export const isFavourite = (p: LayoutPrefs, kind: Favourite["kind"], id: string) => p.favourites.some((x) => x.kind === kind && x.id === id);

const onMailPath = (pathname: string) => /^\/app\/mail(\/|$)/.test(pathname);
/** Is the shell sidebar folded on this page? */
/** P1 layout: Settings has one sidebar, its own grouped list, so the shell's section sidebar stays away there. */
export const ownsSidebar = (pathname: string) => /^\/app\/settings(\/|$)/.test(pathname);
export const sidebarHiddenOn = (p: LayoutPrefs, pathname: string) => (ownsSidebar(pathname) ? true : onMailPath(pathname) ? !p.sidebarOnMail : p.sidebarCollapsed);
export function toggleSidebar(pathname = typeof location === "undefined" ? "/app" : location.pathname) {
  if (ownsSidebar(pathname)) return;
  const p = readLayout();
  if (onMailPath(pathname)) setLayout({ sidebarOnMail: !p.sidebarOnMail });
  else setLayout({ sidebarCollapsed: !p.sidebarCollapsed });
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => { if (e.key === key()) { cache = null; applyDensity(readLayout()); emit(); } };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => { listeners.delete(fn); if (typeof window !== "undefined") window.removeEventListener("storage", onStorage); };
}

export function useLayout(): LayoutPrefs {
  return useSyncExternalStore(subscribe, readLayout, () => DEFAULT_LAYOUT);
}
export function useLayoutGeneration(): number {
  return useSyncExternalStore(subscribe, layoutGeneration, () => 0);
}
