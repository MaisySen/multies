/**
 * R121 (layout plan P2, NAV_P2_R121): the phone More sheet (every section as a tile with its count, then New social
 * post and Settings) and the Customise menu dialog (hide rail sections, pick the fourth phone tab, reset). Both read
 * the one menu model (src/shared/nav-menu.ts), so the rail, the sheet and the app list the same places.
 */
import { useEffect, useRef, useState } from "react";
import { badgeCount } from "@/web/lib/format-count";
import { Link, NavLink } from "react-router";
import { IconBack, IconChevronRight, IconMegaphone, IconSettings, IconSliders } from "@/web/components/ui/icon";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { Switch } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { resetMenu, setLayout, setRailHidden, useLayout } from "@/web/lib/layout-prefs";
import { OPEN_CUSTOMISE_MENU_EVENT, openCustomiseMenu } from "@/web/lib/customise-menu";
import { canHide, FOURTH_TABS, sectionBadge, withoutHidden, type FourthTab, type NavCount, type Section, type SectionId } from "@/shared/nav-menu";
import { NAV_ICONS } from "@/web/layouts/shell";
import { SOCIAL_NEW } from "@/web/layouts/shell-nav";
import { tl } from "@/web/i18n"; // R104

const fmt = (n: number) => badgeCount(n);

function Badge({ n, alert, label }: { n: number; alert: boolean; label: string }) {
  if (n <= 0) return null;
  return <span data-badge aria-label={label} className={cn("min-w-[20px] rounded-full px-1.5 text-center text-[11px] font-semibold leading-[18px] tabular-nums",
    alert ? "bg-brand text-brand-fg" : "bg-fill text-muted")}>{fmt(n)}</span>;
}

/** The More sheet: section tiles; a tile with several pages opens its list here, a one page section opens directly. */
export function MoreSheet({ sections, counts, active, canPost, onNavigate }: {
  sections: Section[]; counts: Record<string, NavCount | undefined>; active?: SectionId; canPost: boolean; onNavigate: () => void;
}) {
  const layout = useLayout();
  const [open, setOpen] = useState<SectionId | null>(null);
  const firstRef = useRef<HTMLElement | null>(null);
  const shown = withoutHidden(sections, layout.railHidden, active).filter((s) => s.id !== "workspace");
  const settings = sections.find((s) => s.id === "workspace");
  const openSection = open ? sections.find((s) => s.id === open) : null;
  // Moving in or out of a section's list puts focus on its first control, so a keyboard or screen reader follows.
  useEffect(() => { firstRef.current?.focus(); }, [open]);
  if (openSection) {
    return (
      <nav aria-label={tl("nav", openSection.label)} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3" data-testid="more-section">
        <button type="button" ref={(el) => { firstRef.current = el; }} onClick={() => setOpen(null)} data-testid="more-back"
          className="mb-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-[16px] text-brand-hover focus-visible:outline-2 focus-visible:outline-brand">
          <IconBack className="h-5 w-5" aria-hidden />All sections
        </button>
        <h2 className="mb-2 px-1 text-[20px] font-semibold tracking-[-0.01em]">{tl("nav", openSection.label)}</h2>
        <ul className="overflow-hidden rounded-[14px] bg-surface shadow-[var(--shadow-e1)]">
          {openSection.pages.map((p, i) => {
            const Icon = NAV_ICONS[p.icon];
            const c = counts[p.to];
            return (
              <li key={p.to}>
                <NavLink to={p.to} end={p.end} onClick={onNavigate} className={({ isActive }) => cn("flex min-h-12 items-center gap-3 px-3 text-[16px] transition-colors duration-150 active:bg-hover",
                  i > 0 && "border-t border-line", isActive ? "font-medium text-fg" : "text-fg/90")}>
                  <Icon className="h-5 w-5 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{tl("nav", p.label)}</span>
                  {c && <Badge n={c.n} alert={!!c.alert} label={c.label} />}
                  <IconChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }
  return (
    <nav aria-label="App" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3" data-testid="more-sheet">
      <ul className="grid grid-cols-3 gap-2" data-testid="more-tiles">
        {shown.map((s, i) => {
          const Icon = NAV_ICONS[s.icon];
          const b = sectionBadge(s, counts);
          const label = b.n > 0 ? `${tl("nav", s.label)}, ${b.n} ${b.alert ? "need you" : "unread"}` : tl("nav", s.label);
          const cls = cn("relative flex min-h-[76px] w-full flex-col items-center justify-center gap-1.5 rounded-[14px] bg-surface px-1 text-[12.5px] font-medium shadow-[var(--shadow-e1)] transition-colors duration-150 active:bg-hover focus-visible:outline-2 focus-visible:outline-brand",
            s.id === active ? "text-brand-hover ring-1 ring-brand/40" : "text-fg");
          const inner = (<>
            <Icon className="h-6 w-6" filled={s.id === active} aria-hidden />
            <span className="max-w-full truncate">{tl("nav", s.label)}</span>
            {/* The number is drawn by CSS (data-badge), so the tile's visible words stay its label and its name contains them. */}
            {b.n > 0 && <span data-badge={fmt(b.n)} className={cn("absolute right-1.5 top-1.5 min-w-[18px] rounded-full px-1 text-center text-[11px] font-semibold leading-[18px] tabular-nums before:content-[attr(data-badge)]",
              b.alert ? "bg-brand text-brand-fg" : "bg-fill text-muted")} aria-hidden />}
          </>);
          const ref = (el: HTMLElement | null) => { if (i === 0) firstRef.current = el; };
          return (
            <li key={s.id}>
              {s.pages.length > 1
                ? <button type="button" ref={ref} className={cls} aria-label={label} data-testid={`more-tile-${s.id}`} onClick={() => setOpen(s.id)}>{inner}</button>
                : <Link to={s.pages[0].to} ref={ref} className={cls} aria-label={label} data-testid={`more-tile-${s.id}`} onClick={onNavigate}>{inner}</Link>}
            </li>
          );
        })}
      </ul>
      <div className="mt-4 space-y-2">
        {canPost && (
          <Link to={SOCIAL_NEW} onClick={onNavigate} data-testid="more-new-post"
            className="flex min-h-12 items-center gap-3 rounded-[14px] bg-brand px-3 text-[16px] font-medium text-brand-fg shadow-[var(--shadow-e1)] transition-colors hover:bg-brand-press">
            <IconMegaphone className="h-5 w-5" aria-hidden />New social post
          </Link>
        )}
        <div className="overflow-hidden rounded-[14px] bg-surface shadow-[var(--shadow-e1)]">
          {settings && (
            <Link to={settings.to} onClick={onNavigate} data-testid="more-settings" className="flex min-h-12 items-center gap-3 px-3 text-[16px] text-fg active:bg-hover">
              <IconSettings className="h-5 w-5 shrink-0 text-muted" aria-hidden /><span className="flex-1">Settings</span><IconChevronRight className="h-4 w-4 text-subtle" aria-hidden />
            </Link>
          )}
          <button type="button" onClick={() => { onNavigate(); openCustomiseMenu('[data-testid="tab-more"]'); }} data-testid="more-customise"
            className="flex min-h-12 w-full items-center gap-3 border-t border-line px-3 text-left text-[16px] text-fg active:bg-hover">
            <IconSliders className="h-5 w-5 shrink-0 text-muted" aria-hidden /><span className="flex-1">Customise menu</span><IconChevronRight className="h-4 w-4 text-subtle" aria-hidden />
          </button>
        </div>
      </div>
    </nav>
  );
}

/** The Customise menu dialog: one switch per section, the fourth phone tab, and Reset. Mounted once by the app shell. */
export function CustomiseMenuHost({ sections }: { sections: Section[] }) {
  const [open, setOpen] = useState(false);
  const returnTo = useRef<string | undefined>(undefined);
  const layout = useLayout();
  useEffect(() => {
    const on = (e: Event) => { returnTo.current = (e as CustomEvent<{ returnTo?: string } | undefined>).detail?.returnTo; setOpen(true); };
    window.addEventListener(OPEN_CUSTOMISE_MENU_EVENT, on);
    return () => window.removeEventListener(OPEN_CUSTOMISE_MENU_EVENT, on);
  }, []);
  const hideable = sections.filter((s) => canHide(s.id));
  const tabs = FOURTH_TABS.filter((t) => t.id !== "social" || sections.some((s) => s.id === "social"));
  const changed = layout.railHidden.length > 0 || layout.fourthTab !== "tasks";
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Customise menu"
      returnFocus={() => (returnTo.current ? document.querySelector<HTMLElement>(returnTo.current) : null)}
      description="Hide sections you never use. Hidden sections still open from search and from links."
      footer={<>
        <Button variant="secondary" onClick={resetMenu} disabled={!changed} data-testid="customise-reset">Reset to default</Button>
        <Button onClick={() => setOpen(false)} data-testid="customise-done">Done</Button>
      </>}>
      <div data-testid="customise-menu">
        <h3 className="mb-1.5 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">Show in the menu</h3>
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {hideable.map((s) => {
            const Icon = NAV_ICONS[s.icon];
            const shown = !layout.railHidden.includes(s.id);
            return (
              <li key={s.id} className="flex min-h-11 items-center gap-3 px-3">
                <Icon className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
                <span className="flex-1 text-[14px]">{tl("nav", s.label)}</span>
                <Switch checked={shown} onChange={(v) => setRailHidden(s.id, !v)} label={`Show ${tl("nav", s.label)}`} />
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[12.5px] text-muted">Home and Settings always stay.</p>
        <h3 className="mb-1.5 mt-5 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle" id="fourth-tab-label">Fourth tab on phones</h3>
        <div role="radiogroup" aria-labelledby="fourth-tab-label" className="inline-flex flex-wrap gap-0.5 rounded-lg bg-fill p-0.5" data-testid="fourth-tab">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={layout.fourthTab === t.id} onClick={() => setLayout({ fourthTab: t.id as FourthTab })}
              className={cn("min-h-9 rounded-md px-3 text-[13px] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-brand",
                layout.fourthTab === t.id ? "bg-surface font-medium text-fg shadow-[var(--shadow-e1)]" : "text-muted hover:text-fg")}>{tl("nav", t.label)}</button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
