import { useEffect, useState, useSyncExternalStore } from "react";
import { Toaster } from "sonner";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/web/lib/cn";

export type Appearance = "system" | "light" | "dark";
const KEY = "mymail-theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function read(): Appearance {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}

const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  const m = media();
  m.addEventListener("change", fn);
  return () => { listeners.delete(fn); m.removeEventListener("change", fn); };
}

/** The person's appearance choice and the scheme in effect. Public/theme.js applies the choice before first paint. */
export function useAppearance() {
  const choice = useSyncExternalStore(subscribe, read, () => "system" as Appearance);
  const systemDark = useSyncExternalStore(subscribe, () => media().matches, () => false);
  const resolved: "light" | "dark" = choice === "system" ? (systemDark ? "dark" : "light") : choice;
  const set = (next: Appearance) => {
    try { if (next === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch { /* storage blocked */ }
    if (next === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
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

const OPTIONS: { id: Appearance; label: string; Icon: typeof Sun }[] = [
  { id: "system", label: "System", Icon: Monitor },
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
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
