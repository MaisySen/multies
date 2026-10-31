import { useEffect, useState } from "react";

/** 1.10.8: the time now, read outside render and moved on every half minute (for countdowns like the reply window). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
