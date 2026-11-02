/**
 * R46 mobile web: the phone tab bar. Five tabs at the foot of the screen like a native app (Home, Mail, Tasks,
 * Calendar, More), sitting on the home indicator's safe area. Shown below 768 px; wider screens keep the sidebar.
 * Patterns compared with open source mobile web apps first (files/teardowns/oss/multies/mobile-web.md).
 */
import { Link, useLocation } from "react-router";
import { IconCalendar, IconDocs, IconHome, IconInbox, IconMegaphone, IconMessageCircle, IconMore, IconTasks, type IconComponent } from "@/web/components/ui/icon";
import type { FourthTab } from "@/shared/nav-menu"; // R121
import { readStoredTaskView } from "@/web/lib/phone";
import { cn } from "@/web/lib/cn";

export type PhoneTabId = "home" | "mail" | "tasks" | "calendar" | "more" | "chat" | "social" | "docs"; // R121: chat, social, docs

/** Which tab a route belongs to. Pages without a tab of their own (Docs, Chat, Settings...) light up More. */
export function activePhoneTab(pathname: string, search: string): PhoneTabId {
  const view = new URLSearchParams(search).get("view");
  if (pathname === "/app" || pathname === "/app/" || pathname.startsWith("/app/my-work")) return "home";
  if (/^\/app\/mail(\/|$)/.test(pathname)) return "mail";
  if (/^\/app\/tasks(\/|$)/.test(pathname)) return view === "calendar" ? "calendar" : "tasks";
  return "more";
}

/**
 * R121 (layout plan P2, section 9): Home, Mail, Chat, the person's fourth tab (Tasks, Social, Calendar or Docs), More.
 * A page whose tab is not on the bar lights up More.
 */
export function activePhoneTabP2(pathname: string, search: string, fourth: FourthTab): PhoneTabId {
  const view = new URLSearchParams(search).get("view");
  if (pathname === "/app" || pathname === "/app/" || pathname.startsWith("/app/my-work")) return "home";
  if (/^\/app\/mail(\/|$)/.test(pathname)) return "mail";
  if (/^\/app\/chat(\/|$)/.test(pathname)) return "chat";
  const own: PhoneTabId | null = /^\/app\/tasks(\/|$)/.test(pathname) ? (view === "calendar" ? "calendar" : "tasks")
    : /^\/app\/social(\/|$)/.test(pathname) ? "social" : /^\/app\/docs(\/|$)/.test(pathname) ? "docs" : null;
  return own && own === fourth ? own : "more";
}

/** The Tasks tab opens the person's last task view, never the calendar (the Calendar tab owns that one). */
export function tasksTabHref(stored: string | null): string {
  return stored && stored !== "calendar" ? `/app/tasks?view=${encodeURIComponent(stored)}` : "/app/tasks";
}

/** Badge text the way the system shows it: nothing at 0, 99+ past 99.
 * R54: the badge red is #D70015 (white text 5.4:1); the brighter #FF3B30 gave 3.5:1, under the 4.5:1 small text needs.
 * The number is drawn by CSS (data-badge), not a text node, so the tab's visible words stay its label and the
 * link's name ("Mail, 10 unread") contains them (axe label-content-name-mismatch). */
export function badgeText(n: number | undefined): string | null {
  if (!n || n <= 0) return null;
  return n > 99 ? "99+" : String(n);
}

type Tab = { id: PhoneTabId; label: string; icon: IconComponent; to?: string; badge?: string | null };

export function PhoneTabBar({ mailUnread, moreOpen, onMore, p2, chatUnread = 0, fourth = "tasks" }: { mailUnread: number; moreOpen: boolean; onMore: () => void;
  /** R121: the P2 bar (NAV_P2_R121). */ p2?: boolean; chatUnread?: number; fourth?: FourthTab }) {
  const loc = useLocation();
  const active = moreOpen ? "more" : p2 ? activePhoneTabP2(loc.pathname, loc.search, fourth) : activePhoneTab(loc.pathname, loc.search);
  const FOURTH: Record<FourthTab, Tab> = {
    tasks: { id: "tasks", label: "Tasks", icon: IconTasks, to: tasksTabHref(readStoredTaskView()) },
    social: { id: "social", label: "Social", icon: IconMegaphone, to: "/app/social" },
    calendar: { id: "calendar", label: "Calendar", icon: IconCalendar, to: "/app/tasks?view=calendar" },
    docs: { id: "docs", label: "Docs", icon: IconDocs, to: "/app/docs" },
  };
  const tabs: Tab[] = p2 ? [
    { id: "home", label: "Home", icon: IconHome, to: "/app/my-work" },
    { id: "mail", label: "Mail", icon: IconInbox, to: "/app/mail", badge: badgeText(mailUnread) },
    { id: "chat", label: "Chat", icon: IconMessageCircle, to: "/app/chat", badge: badgeText(chatUnread) },
    FOURTH[fourth],
    { id: "more", label: "More", icon: IconMore },
  ] : [
    { id: "home", label: "Home", icon: IconHome, to: "/app/my-work" },
    { id: "mail", label: "Mail", icon: IconInbox, to: "/app/mail", badge: badgeText(mailUnread) },
    { id: "tasks", label: "Tasks", icon: IconTasks, to: tasksTabHref(readStoredTaskView()) },
    { id: "calendar", label: "Calendar", icon: IconCalendar, to: "/app/tasks?view=calendar" },
    { id: "more", label: "More", icon: IconMore },
  ];
  const cls = (on: boolean) => cn(
    "pressable relative flex h-[52px] w-full flex-col items-center justify-center gap-[3px] text-[10.5px] font-medium tracking-[0.01em] transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand",
    on ? "text-brand-hover" : "text-subtle hover:text-muted", // R79: the workspace brand, AA in light and dark
  );
  return (
    <nav data-testid="phone-tabbar" aria-label="Tabs" className="glass hairline-t relative z-30 shrink-0 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:hidden">
      <ul className="mx-auto grid max-w-xl grid-cols-5">
        {tabs.map(({ id, label, icon: Glyph, to, badge }) => {
          const on = active === id;
          const inner = (
            <>
              <span className="relative" aria-hidden>
                <Glyph size={25} filled={on} />
                {badge && <span className="absolute -right-2.5 -top-1 min-w-[18px] rounded-full bg-[#D70015] px-1 text-center text-[11px] font-semibold leading-[18px] text-white tabular-nums ring-2 ring-[var(--color-surface)] before:content-[attr(data-badge)]" data-badge={badge} />}
              </span>
              <span>{label}</span>
            </>
          );
          return (
            <li key={id}>
              {to
                ? <Link to={to} className={cls(on)} aria-current={on ? "page" : undefined} aria-label={badge ? `${label}, ${badge} unread` : label} data-testid={`tab-${id}`}>{inner}</Link>
                : <button type="button" className={cls(on)} onClick={onMore} aria-expanded={moreOpen} aria-label="More" data-testid={`tab-${id}`}>{inner}</button>}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
