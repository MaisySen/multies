/**
 * M2 (1.10.10): the menu for the More grid. Asks GET /api/nav/menu (the web's menu model) with the app's own session,
 * keeps the last good answer on the phone for offline, and falls back to what the app can open today when the server
 * has no menu (an older server answers 404) or cannot be reached. Pages the server shows only once used (Sites) ask
 * their own route. The person's hidden sections live on this phone, as they do on the web (per device there too).
 */
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "./session";
import { kv } from "./kv";
import { isApiError } from "@/api/transport";
import { cleanHidden, FALLBACK_MENU, parseMenu, withUsed, type NavMenu } from "./nav-menu";

export type MenuSource = "server" | "saved" | "fallback";
/** old: the server has no menu yet. offline: no connection. error: anything else (Retry helps). */
export type MenuProblem = "old" | "offline" | "error" | null;
export interface MenuState { menu: NavMenu; source: MenuSource; problem: MenuProblem }

export const navMenuKey = (who: string) => ["nav-menu", who] as const;
const savedKey = (who: string) => `nav.menu.${who}`;
const hiddenKey = (who: string) => `nav.hidden.${who}`;

function problemOf(e: unknown): MenuProblem {
  if (isApiError(e)) {
    if (e.status === 404 || e.status === 405) return "old";
    if (e.status === 0) return "offline";
    return "error";
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /network|offline|fetch|timed? ?out|abort/i.test(msg) ? "offline" : "error";
}

/** Whose menu: the signed in user (or the sample workspace). */
export function useMenuOwner(): string {
  const { me, mode } = useSession();
  const id = (me as { user?: { id?: string } } | null)?.user?.id;
  return mode === "sample" ? "sample" : id ? String(id).slice(0, 80) : "me";
}

export function useNavMenu() {
  const { transport, status } = useSession();
  const who = useMenuOwner();
  return useQuery<MenuState>({
    queryKey: navMenuKey(who),
    enabled: status === "signedIn",
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      let problem: MenuProblem = null;
      let menu: NavMenu | null = null;
      try {
        menu = parseMenu(await transport.request<unknown>("GET", "/nav/menu"));
        if (!menu) problem = "old";
      } catch (e) { problem = problemOf(e); }
      if (menu) {
        // Pages shown once used (Sites): ask their own route; a failed ask leaves the page out, as on the web.
        const urls = [...new Set(menu.sections.flatMap((s) => s.pages.flatMap((p) => (p.whenUsed ? [p.whenUsed] : []))))];
        const used: Record<string, boolean> = {};
        await Promise.all(urls.map(async (u) => {
          try { used[u] = (await transport.request<{ inUse?: boolean }>("GET", u.replace(/^\/api/, "")))?.inUse === true; } catch { used[u] = false; }
        }));
        menu = withUsed(menu, used);
        kv().set(savedKey(who), JSON.stringify(menu)).catch(() => {});
        return { menu, source: "server", problem: null };
      }
      if (problem !== "old") {
        try {
          const saved = parseMenu(JSON.parse((await kv().get(savedKey(who))) ?? "null"));
          if (saved) return { menu: saved, source: "saved", problem };
        } catch { /* nothing saved */ }
      }
      return { menu: FALLBACK_MENU, source: "fallback", problem };
    },
  });
}

/** The sections this person hid from More on this phone. Home and Settings cannot be hidden. */
export function useHiddenSections(): { hidden: string[]; ready: boolean; toggle: (id: string) => void; reset: () => void } {
  const who = useMenuOwner();
  const [hidden, setHidden] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    kv().get(hiddenKey(who)).then((raw) => {
      let v: unknown = null;
      try { v = JSON.parse(raw ?? "null"); } catch { v = null; }
      if (live) { setHidden(cleanHidden(v)); setReady(true); }
    }).catch(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [who]);
  const save = useCallback((next: string[]) => {
    const clean = cleanHidden(next);
    setHidden(clean);
    kv().set(hiddenKey(who), JSON.stringify(clean)).catch(() => {});
  }, [who]);
  const toggle = useCallback((id: string) => save(hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]), [hidden, save]);
  const reset = useCallback(() => save([]), [save]);
  return { hidden, ready, toggle, reset };
}
