/**
 * The read only notice. When the database's daily write limit is reached (Cloudflare D1, reset at
 * 00:00 UTC) the API answers writes with 503 and code `read_only`; reading keeps working. Any request
 * that gets that answer marks the app read only for a while, and a banner says so instead of each
 * screen failing on its own.
 */
import { useSyncExternalStore } from "react";

export const READ_ONLY_MESSAGE = "Multies is read only for a short while. Your data is safe, and you can keep reading. Changes and new sign ins work again soon.";
const SHOW_MS = 10 * 60_000;
let until = 0;
const listeners = new Set<() => void>();

export function markReadOnly() {
  until = Date.now() + SHOW_MS;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  const timer = setInterval(l, 30_000);
  return () => { listeners.delete(l); clearInterval(timer); };
}

export function useReadOnly() {
  return useSyncExternalStore(subscribe, () => until > Date.now(), () => false);
}

export function ReadOnlyBanner() {
  const on = useReadOnly();
  if (!on) return null;
  return (
    <div role="status" className="border-b border-line bg-surface px-4 py-2 text-center text-[13px] text-muted">
      {READ_ONLY_MESSAGE}
    </div>
  );
}
