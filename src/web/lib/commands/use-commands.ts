import { useEffect, useRef } from "react";
import { bindCommand } from "./registry";

/**
 * A page binds the registry commands it handles while it is mounted. Handlers read the latest render
 * (a ref), so callers pass a fresh object each render without rebinding. Return false to pass.
 */
export function useCommandHandlers(map: Record<string, () => boolean | void>, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  const ids = Object.keys(map).sort().join("|");
  useEffect(() => {
    if (!enabled) return;
    const offs = ids.split("|").filter(Boolean).map((id) => bindCommand(id, () => ref.current[id]?.()));
    return () => { for (const off of offs) off(); };
  }, [ids, enabled]);
}
