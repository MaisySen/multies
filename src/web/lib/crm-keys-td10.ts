/**
 * TD10: small helpers the CRM pages share for their keys (J and K walk the rows marked data-crm-row) and the
 * offline note (every new screen says when it is offline instead of looking stuck).
 */
import { useEffect, useState } from "react";

export function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-crm-row]")].filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
}

/** The row that holds focus, or null. */
export function focusedRow(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  return a?.closest<HTMLElement>("[data-crm-row]") ?? null;
}

/** Moves focus to the next or previous row and keeps it in view; stops at the ends. */
export function walkRows(dir: 1 | -1): boolean {
  const list = rows();
  if (!list.length) return false;
  const cur = focusedRow();
  const i = cur ? list.indexOf(cur) : -1;
  const next = list[i < 0 ? (dir === 1 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + dir))];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  return true;
}

export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine !== false);
  useEffect(() => {
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}
