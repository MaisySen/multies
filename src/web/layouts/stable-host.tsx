/**
 * R100 (follow up from R86): the app shell shows the page inside the desktop panel group at 1024 px and wider, and
 * straight in the row below that. Moving the page between the two trees made React mount it again, so crossing the
 * breakpoint lost picked files and unsaved edits. The page now renders once, through a portal, into one host node
 * that never changes; each layout only gives that node a place to sit (HostSlot), so the page itself never remounts.
 */
import { useLayoutEffect, useRef, useState } from "react";

/** One detached element for the life of the shell. */
export function useStableHost(className: string): HTMLDivElement {
  const [host] = useState(() => {
    const el = document.createElement("div");
    el.className = className;
    el.dataset.shellHost = "";
    return el;
  });
  return host;
}

/** What had focus inside a host when its slot let it go, so the next slot can give it back. */
const focusInHost = new WeakMap<HTMLElement, HTMLElement>();

/**
 * Where the host sits in the current layout. Unmounting the slot only takes the node out; the page stays mounted.
 * Taking a node out of the document drops its focus, so focus inside the host is put back once the next slot holds
 * it (the desktop panes arriving after the first render, R40, or crossing the 1024 px breakpoint).
 */
export function HostSlot({ host, className }: { host: HTMLElement; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(host);
    const back = focusInHost.get(host);
    focusInHost.delete(host);
    if (back && host.contains(back) && document.activeElement !== back) back.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && host.contains(active)) focusInHost.set(host, active);
      if (host.parentNode === slot) slot.removeChild(host);
    };
  }, [host]);
  return <div ref={ref} className={className} data-shell-slot="" />;
}
