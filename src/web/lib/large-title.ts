/**
 * R35 Premium pass 2: large titles that fold into the top bar on scroll (mobile web, the main list pages). The page
 * keeps its own large title (an h1 with class large-title); once that title scrolls under the bar, the bar shows the
 * same words small and centred. No layout change and no extra heading: the bar title is aria-hidden.
 */
import { useEffect, useState } from "react";

export function useCollapsingTitle(scroller: HTMLElement | null, path: string): string | null {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    setTitle(null);
    if (!scroller || typeof IntersectionObserver === "undefined") return;
    let io: IntersectionObserver | null = null;
    // The page draws after the route changes; look for its title on the next frames.
    const find = (tries: number) => {
      const h = scroller.querySelector<HTMLElement>("h1.large-title, h1[data-large-title]");
      if (!h) { if (tries > 0) raf = requestAnimationFrame(() => find(tries - 1)); return; }
      const top = scroller.getBoundingClientRect().top;
      io = new IntersectionObserver(([e]) => setTitle(e.isIntersecting ? null : (h.textContent ?? "").trim() || null), { root: scroller, rootMargin: `${-Math.max(0, top)}px 0px 0px 0px`, threshold: 0 });
      io.observe(h);
    };
    let raf = requestAnimationFrame(() => find(30));
    return () => { cancelAnimationFrame(raf); io?.disconnect(); };
  }, [scroller, path]);
  return title;
}
