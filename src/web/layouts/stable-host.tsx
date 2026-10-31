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

/** Where the host sits in the current layout. Unmounting the slot only takes the node out; the page stays mounted. */
export function HostSlot({ host, className }: { host: HTMLElement; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(host);
    return () => { if (host.parentNode === slot) slot.removeChild(host); };
  }, [host]);
  return <div ref={ref} className={className} data-shell-slot="" />;
}
