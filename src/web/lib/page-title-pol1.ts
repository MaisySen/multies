/**
 * POL1 (MB-321): a page names the thing it shows in the browser tab ("Jobs board · Docs · Multies").
 * The app frame sets the section title on every navigation; this runs just after it, so the page's own name wins,
 * and the unread count prefix ("(3) ") is put back by the frame's title watcher.
 */
import { useEffect } from "react";
import { useLocation } from "react-router";

export function titleText(parts: (string | null | undefined)[]): string {
  const clean = parts.map((p) => (p ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).map((p) => (p.length > 80 ? `${p.slice(0, 79)}…` : p));
  return [...clean, "Multies"].join(" · ");
}

/** Sets the tab title once the name is known (pass null while loading to keep the section title). */
export function usePageTitle(parts: (string | null | undefined)[] | null) {
  const loc = useLocation();
  const text = parts ? titleText(parts) : null;
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => { if (document.title.replace(/^\(\d+\+?\) /, "") !== text) document.title = text; }, 0);
    return () => clearTimeout(t);
  }, [text, loc.pathname, loc.search]);
}
