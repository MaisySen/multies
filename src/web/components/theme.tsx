import { useEffect, useState, useSyncExternalStore } from "react";
import { Toaster } from "sonner";
import { IconMonitor, IconMoon, IconToday, type IconComponent } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";

export type Appearance = "system" | "light" | "dark";
export const THEME_KEY = "multies-theme";
const KEY = THEME_KEY;
/** R81B: a light or dark choice saved under the key from before the rename moves to THEME_KEY once, on the first
 *  load of the app code; public/theme.js and the inline script read THEME_KEY only. Remove after 30 Nov 2026. */
const LEGACY_KEY = "mymail-theme";
(function carryOverLegacyChoice() {
  try {
    if (typeof localStorage === "undefined") return;
    const old = localStorage.getItem(LEGACY_KEY);
    if (old === null) return;
    if (localStorage.getItem(KEY) === null && (old === "light" || old === "dark")) {
      localStorage.setItem(KEY, old);
      document.documentElement.dataset.theme = old;
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* storage blocked */ }
})();
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function read(): Appearance {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}

const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  const m = media();
  m.addEventListener("change", fn);
  window.addEventListener("multies-appearance", fn); // R77: the workspace default appearance changed
  return () => { listeners.delete(fn); m.removeEventListener("change", fn); window.removeEventListener("multies-appearance", fn); };
}

/** R77: the workspace's default appearance (from the cached brand), used while the person has not picked one. */
function workspaceDefault(): "light" | "dark" | null {
  try {
    const raw = localStorage.getItem("multies-brand");
    const a = raw ? (JSON.parse(raw) as { a?: string }).a : null;
    return a === "light" || a === "dark" ? a : null;
  } catch { return null; }
}
const inApp = () => typeof location !== "undefined" && location.pathname.startsWith("/app");

/** The person's appearance choice and the scheme in effect. Public/theme.js applies the choice before first paint. */
export function useAppearance() {
  const choice = useSyncExternalStore(subscribe, read, () => "system" as Appearance);
  const systemDark = useSyncExternalStore(subscribe, () => media().matches, () => false);
  const wsDefault = useSyncExternalStore(subscribe, () => (inApp() ? workspaceDefault() : null), () => null);
  const resolved: "light" | "dark" = choice === "system" ? (wsDefault ?? (systemDark ? "dark" : "light")) : choice;
  const set = (next: Appearance) => {
    try { if (next === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch { /* storage blocked */ }
    // R77: "System" goes back to the workspace default when the workspace set one, else the device setting.
    const fallback = inApp() ? workspaceDefault() : null;
    if (next === "system") { if (fallback) document.documentElement.dataset.theme = fallback; else delete document.documentElement.dataset.theme; } else document.documentElement.dataset.theme = next;
    listeners.forEach((fn) => fn());
  };
  return { choice, resolved, set };
}

/** Sonner, themed with the app tokens and following the appearance. */
export function ThemedToaster() {
  const { resolved } = useAppearance();
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 639px)");
    const on = () => setPhone(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return (
    <Toaster
      theme={resolved}
      position={phone ? "top-center" : "bottom-right"}
      gap={8}
      toastOptions={{
        classNames: {
          toast: "!rounded-xl !border !border-line !bg-elevated !text-fg !shadow-pop !font-sans !text-[13px] motion-reduce:!transition-none", // R33: no slide with reduced motion
          description: "!text-muted",
          actionButton: "!bg-brand !text-brand-fg !rounded-md",
          cancelButton: "!bg-fill !text-fg !rounded-md",
          error: "[&_[data-icon]]:!text-bad",
          success: "[&_[data-icon]]:!text-ok",
          warning: "[&_[data-icon]]:!text-warn",
        },
      }}
    />
  );
}

const OPTIONS: { id: Appearance; label: string; Icon: IconComponent }[] = [
  { id: "system", label: "System", Icon: IconMonitor },
  { id: "light", label: "Light", Icon: IconToday },
  { id: "dark", label: "Dark", Icon: IconMoon },
];

/** A segmented control for System, Light and Dark. */
export function AppearanceControl({ className }: { className?: string }) {
  const { choice, set } = useAppearance();
  return (
    <div role="radiogroup" aria-label="Appearance" className={cn("inline-flex rounded-lg bg-fill p-0.5", className)}>
      {OPTIONS.map(({ id, label, Icon }) => (
        <button key={id} type="button" role="radio" aria-checked={choice === id} onClick={() => set(id)}
          className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] transition-[background,color,box-shadow] duration-150",
            choice === id ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
