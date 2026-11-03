/**
 * R104 (LANG_R104): the small language switch at the foot of the public pages and the sign in card. Shown only while
 * languages are on. The pick is kept on this browser (and becomes the starting language in the app until the person
 * saves one of their own in Settings > Appearance).
 */
import { useConfig } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { LANG_NAMES, setLanguage, t, UI_LANGS, useLang } from "./index";

export function LanguageSwitch({ className }: { className?: string }) {
  const on = !!useConfig().data?.langR104;
  const lang = useLang();
  if (!on) return null;
  return (
    <nav aria-label={t("common.language")} className={cn("flex flex-wrap items-center gap-1 text-[13px]", className)} data-testid="language-switch">
      {UI_LANGS.map((l) => (
        <button key={l} type="button" lang={l} aria-current={l === lang ? "true" : undefined} onClick={() => void setLanguage(l, { remember: true })}
          className={cn("inline-flex min-h-11 items-center rounded-md px-2.5 transition-colors duration-150 hover:bg-hover focus-visible:outline-2 focus-visible:outline-brand",
            l === lang ? "font-semibold text-fg" : "text-muted hover:text-fg")} data-testid={`language-switch-${l}`}>{LANG_NAMES[l]}</button>
      ))}
    </nav>
  );
}
