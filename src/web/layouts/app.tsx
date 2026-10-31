import { setDisplayLocale } from "@/web/lib/date-input";
import { pageFrameClass, pageWidth } from "@/web/lib/page-width"; // R75: page widths next to the sidebar
import { Suspense, useEffect, useState, type ReactElement } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconActivity, IconAgent, IconAttachment, IconBell, IconBriefcase, IconCalendarClock, IconChart, IconChats, IconCheck, IconChevronsUpDown, IconClipboardCheck, IconClipboardList, IconClose, IconContacts, IconDashboard, IconDocs, IconFlask, IconGlobe, IconInbox, IconKeyboard, IconLogOut, IconMenu, IconMessageCircle, IconPlug, IconPlus, IconSearch, IconSettings, IconShield, IconShieldCheck, IconTarget, IconTasks, IconTeam, IconTemplate, IconTimer, IconToday, IconTodo, IconUserCog, IconVideo, IconWrench, IconZap, type IconComponent } from "@/web/components/ui/icon";
import { Logo } from "@/web/components/logo";
import { BrandTokens, WorkspaceMark, WorkspaceWideLogo } from "@/web/lib/brand"; // R77: workspace brand
import { AppearanceControl } from "@/web/components/theme";
import { Avatar, Kbd } from "@/web/components/ui/misc";
import { UpdatePill } from "@/web/components/update-pill"; // R32
import { PaletteHost } from "@/web/components/palette-host"; // R31: the menu itself loads on demand
import { ShortcutsHost } from "@/web/components/shortcuts-sheet"; // R30
import { openPalette, openShortcutsSheet } from "@/web/lib/shortcuts";
import { TimerChip } from "@/web/pages/app/work/time";
import { PhoneTabBar } from "@/web/components/phone-tab-bar"; // R46 mobile web
import { watchKeyboardInset } from "@/web/lib/keyboard-inset"; // R49 mobile web
// R31: the call dock and onboarding load on demand (their code is not on the first paint path).
const CallDockHost = lazyPage(() => import("@/web/pages/app/work/call-r23"), "CallDockHost", { quiet: true });
const Onboarding = lazyPage(() => import("@/web/pages/app/onboarding"), "Onboarding");
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { useWhatsNew } from "@/web/lib/whats-new"; // R53 (MB-133)
import { useConfig, useMe, useWorkspaces } from "@/web/lib/queries";
import { useDemoSeedCatchUp } from "@/web/lib/demo";
import type { Me } from "@/web/lib/types";
import { Dialog } from "@/web/components/ui/dialog";
import { ReadOnlyBanner } from "@/web/lib/read-only";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import type { AuthProviders } from "@/web/lib/auth-client";
// R45 (MB-203): the auth client (14 KB) loads when someone signs out, not with every page's first load.
const authClientModule = () => import("@/web/lib/auth-client");
import { clearOfflineData } from "@/web/lib/sw-client"; // R32
import { scopeOf, setOfflineScope } from "@/web/lib/offline-lists"; // R33
import { OfflineBanner } from "@/web/components/offline-banner-r32"; // R32
import { useAnnounceWorkspace, WorkspaceSwitchedBanner } from "@/web/components/workspace-switched-banner-r58"; // R58 (MB-245)
import { workspaceTabs } from "@/web/lib/workspace-tabs-r58"; // R58 (MB-245)
import { PendingInviteBanner } from "@/web/components/pending-invite-banner-r39"; // R39 (MB-202)
import { JoinInvitePrompt } from "@/web/components/join-invite-prompt-r41"; // R41 (MB-221)
import { api } from "@/web/lib/api";
import { clearMeCache, isSignedOut } from "@/web/lib/me-cache"; // R40 (MB-200)
import { ReconnectingPill, ReconnectScreen } from "@/web/components/reconnecting-r40"; // R40 (MB-200)
import { browserTimeZone, initials, setDisplayTimeZone } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { AppSkeleton } from "./app-skeleton";
import { PLANS } from "@/shared/plans";
import { prefetchWhenIdle } from "@/web/lib/prefetch";
import { useCollapsingTitle } from "@/web/lib/large-title";
import { badgeTotal, useCounts, useTitleCount } from "@/web/lib/counts"; // R34: one counts query for every badge
import { useOpenReportCount } from "@/web/lib/open-report-count"; // R35 (R45: its own module, not the moderation page)
import { lazyPage } from "@/web/components/lazy-page";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type NavItem = { to: string; label: string; icon: IconComponent; end?: boolean; group: "work" | "mail" | "admin" };
const nav: NavItem[] = [
  { to: "/app/my-work", label: "My Work", icon: IconToday, group: "work" },
  { to: "/app", label: "Overview", icon: IconDashboard, end: true, group: "work" },
  { to: "/app/notifications", label: "Notifications", icon: IconBell, group: "work" },
  { to: "/app/chat", label: "Chat", icon: IconMessageCircle, group: "work" },
  { to: "/app/tasks", label: "Tasks", icon: IconTasks, group: "work" },
  { to: "/app/triage", label: "Triage", icon: IconTodo, group: "work" },
  { to: "/app/docs", label: "Docs", icon: IconDocs, group: "work" },
  { to: "/app/meetings", label: "Meetings", icon: IconVideo, group: "work" },
  { to: "/app/goals", label: "Goals", icon: IconTarget, group: "work" },
  { to: "/app/contacts", label: "Contacts", icon: IconContacts, group: "work" },
  { to: "/app/time", label: "Timesheet", icon: IconTimer, group: "work" },
  { to: "/app/forms", label: "Forms", icon: IconClipboardList, group: "work" },
  { to: "/app/dashboards", label: "Dashboards", icon: IconDashboard, group: "work" }, // R24.3
  { to: "/app/reports", label: "Reports", icon: IconChart, group: "work" },
  { to: "/app/portfolio", label: "Portfolio", icon: IconBriefcase, group: "work" },
  { to: "/app/templates", label: "Project templates", icon: IconTemplate, group: "work" },
  { to: "/app/automations", label: "Automations", icon: IconZap, group: "work" },
  { to: "/app/mail", label: "Mail", icon: IconInbox, group: "mail" },
  { to: "/app/inbox", label: "Shared inbox", icon: IconChats, group: "mail" },
  { to: "/app/mailboxes", label: "Mailboxes", icon: IconTeam, group: "mail" },
  { to: "/app/domains", label: "Domains", icon: IconGlobe, group: "mail" },
  { to: "/app/deliverability", label: "Deliverability", icon: IconShieldCheck, group: "mail" },
  { to: "/app/agents", label: "Agents", icon: IconAgent, group: "admin" },
  { to: "/app/approvals", label: "Approvals", icon: IconClipboardCheck, group: "admin" },
  { to: "/app/integrations", label: "Integrations", icon: IconPlug, group: "admin" },
  { to: "/app/activity", label: "Activity", icon: IconActivity, group: "admin" },
  { to: "/app/settings", label: "Settings", icon: IconSettings, group: "admin" },
];
/** R35: section tile colours (system palette, white glyphs pass 3:1 for non-text contrast). */
const NAV_TINT: Record<string, string> = {
  "/app/my-work": "#FF9500", "/app": "#5856D6", "/app/notifications": "#FF3B30", "/app/chat": "#34C759", "/app/tasks": "#0071E3",
  "/app/triage": "#5AC8FA", "/app/docs": "#007AFF", "/app/meetings": "#30B0C7", "/app/scheduling": "#30B0C7", "/app/goals": "#FF2D55",
  "/app/contacts": "#A2845E", "/app/time": "#FF9F0A", "/app/forms": "#AF52DE", "/app/dashboards": "#5856D6", "/app/reports": "#32ADE6",
  "/app/portfolio": "#8E6CEF", "/app/templates": "#64D2FF", "/app/automations": "#FFCC00", "/app/mail": "#0071E3", "/app/inbox": "#5E5CE6",
  "/app/mailboxes": "#34C759", "/app/domains": "#0A84FF", "/app/deliverability": "#30D158", "/app/agents": "#636366", "/app/approvals": "#FF9500",
  "/app/integrations": "#BF5AF2", "/app/tools": "#FF6482", "/app/files": "#FF9F0A", "/app/activity": "#FF453A", "/app/settings": "#8E8E93", "/app/admin": "#1C1C1E",
};
// "Workspace", not "Admin": everyone sees this group (settings, people, billing); the operator's console is gated separately.
const GROUP_LABEL = { work: "Work", mail: "Mail", admin: "Workspace" } as const;

/** Nav items in their groups, in the order the groups first appear. */
function navGroups(items: NavItem[]): { group: NavItem["group"]; items: NavItem[] }[] {
  const out: { group: NavItem["group"]; items: NavItem[] }[] = [];
  for (const it of items) { const last = out[out.length - 1]; if (last && last.group === it.group) last.items.push(it); else out.push({ group: it.group, items: [it] }); }
  return out;
}

/** Tools P1: Tools sits under Docs when the server has Tools on. */
const withTools = (items: NavItem[], files = false): NavItem[] => items.flatMap((n) => (n.to === "/app/docs" ? [n, { to: "/app/tools", label: "Tools", icon: IconWrench, group: "work" as const },
  // Tools P2 (16): Files (smart folders of mail attachments) under Tools, while the folders feature is on.
  ...(files ? [{ to: "/app/files", label: "Files", icon: IconAttachment, group: "work" as const }] : [])] : [n]));

/** The booking page sits under Meetings when the server has scheduling switched on. */
const withScheduling: NavItem[] = nav.flatMap((n) => (n.to === "/app/meetings" ? [n, { to: "/app/scheduling", label: "Booking page", icon: IconCalendarClock, group: "work" as const }] : [n]));

export function AppLayout() {
  const me = useMe();
  const [skipInvite, setSkipInvite] = useState(false); // R41: "Set up my own workspace instead"
  // R33: stored list copies are keyed by this person and workspace; set during render so lists started now see it.
  if (me.data) setOfflineScope(scopeOf(me.data));
  const config = useConfig();
  useDemoSeedCatchUp(!!me.data?.organization?.isDemo);
  useAnnounceWorkspace(me.data?.organization); // R58 (MB-245): other tabs learn which workspace is open
  const loc = useLocation();
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  const barTitle = useCollapsingTitle(mainEl, loc.pathname); // R35: large title folds into the bar on phones
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const whatsNew = useWhatsNew(); // R53 (MB-133): unread dot, localStorage only
  useEffect(() => watchKeyboardInset(), []); // R49 mobile: composers stay above the on screen keyboard
  const approvals = useQuery({
    queryKey: ["approvals", "pending"], enabled: !!me.data?.organization, refetchInterval: 30_000,
    queryFn: async () => (await api.get<{ approvals: unknown[] }>("/approvals?status=pending")).approvals,
  });
  const pendingCount = approvals.data?.length ?? 0;
  // R34: every badge reads GET /api/counts (one query, 304 when nothing moved) instead of one request per area.
  const counts = useCounts(!!me.data?.organization);
  const unreadNotes = { data: counts.data?.notifications.unread };
  const triageCount = { data: counts.data?.triage };
  const openReports = useOpenReportCount(!!me.data?.user.platformAdmin); // R35: moderation queue badge
  const chatUnread = { data: counts.data ? { total: counts.data.chat.unread, mentions: counts.data.chat.mentions } : undefined };
  const mailUnread = counts.data?.mail.inbox ?? 0;
  useTitleCount(badgeTotal(counts.data));
  useEffect(() => setDrawer(false), [loc.pathname]);
  // R25: the likely next pages load once the browser is idle (links warm their own page on hover, see main.tsx).
  useEffect(() => prefetchWhenIdle(), []);
  // Assigned during render so the first paint already uses the person's zone: their own, their browser's, else the workspace's.
  setDisplayTimeZone(me.data?.user?.timezone, browserTimeZone(), me.data?.organization?.timezone);
  // R67 (MB-250): date fields follow the workspace's country (dd/mm/yyyy in Australia), in the person's language.
  setDisplayLocale(me.data?.user?.locale, me.data?.organization?.country);

  // R40 (MB-200): only a 401 means signed out. A failed check with a saved copy keeps the app on screen
  // (Reconnecting pill, background retries); with no copy at all the shell frame stays with a calm Retry.
  if (me.error && isSignedOut(me.error)) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (!me.data) {
    if (me.isPending) return <AppSkeleton />;
    return <ReconnectScreen retrying={me.isFetching} onRetry={() => void me.refetch()} />;
  }
  const { user, organization } = me.data;
  if (me.data.session?.ssoBlocked) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="max-w-sm">
          <h1 className="text-lg font-semibold">{organization?.name} requires single sign on</h1>
          <p className="mt-2 text-sm text-muted">You signed in with a password. Sign out, then choose your company's SSO on the sign in page.</p>
          <button className="mt-5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-fg hover:bg-brand/90"
            onClick={async () => { await clearOfflineData(); try { await (await authClientModule()).authClient.signOut(); } catch { /* already signed out */ } await clearOfflineData(); qc.clear(); navigate("/login?sso=required"); }}>
            Sign out and use SSO
          </button>
        </div>
      </div>
    );
  }
  // R41 (MB-221, MB-202): a pending invite comes before setting up a personal workspace.
  const firstInvite = me.data.pendingInvites?.[0];
  if (firstInvite && me.data.onboarding?.workspace && !skipInvite) return <JoinInvitePrompt invite={firstInvite} onSkip={() => setSkipInvite(true)} />;
  if (me.data.onboarding?.needed) return <Suspense fallback={<AppSkeleton />}><Onboarding me={me.data} /></Suspense>;
  const isMail = /^\/app\/mail(\/|$)/.test(loc.pathname);

  const signOut = async () => {
    clearMeCache(); // R40: the saved account copy goes with the session
    const providers = qc.getQueryData<AuthProviders>(["auth-providers"]) ?? await api.get<AuthProviders>("/account/providers").catch(() => null);
    qc.clear();
    if (await (await authClientModule()).signOutEverywhere({ idp: !!providers?.idp }) === "done") navigate("/login");
  };

  /** The account menu: in the sidebar footer, and behind the avatar in the phone top bar (R46 mobile). */
  const accountMenu = (trigger: ReactElement, align: "start" | "end") => (
    <Menu align={align} trigger={trigger}>
          <MenuLabel>{user.email}</MenuLabel>
          <div className="px-1.5 pb-1.5 pt-0.5"><AppearanceControl className="w-full [&>button]:flex-1 [&>button]:justify-center" /></div>
          <MenuItem icon={<IconUserCog />} onSelect={() => navigate("/app/settings/account")}>Account & security</MenuItem>
          <MenuItem icon={<IconSettings />} onSelect={() => navigate("/app/settings")}>Workspace settings</MenuItem>
          <MenuItem icon={<IconKeyboard />} onSelect={openShortcutsSheet}>Keyboard shortcuts</MenuItem>
          <MenuItem icon={<IconZap />} onSelect={() => { whatsNew.markSeen(); navigate("/changelog"); }}>
            What's new
            {whatsNew.unread && <span className="ml-auto flex items-center" data-testid="whats-new-dot"><span className="h-2 w-2 rounded-full bg-brand" aria-hidden /><span className="sr-only">(new)</span></span>}
          </MenuItem>
          <MenuItem icon={<IconLogOut />} onSelect={signOut} danger>Sign out</MenuItem>
    </Menu>
  );

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <Link to="/app" aria-label="Multies overview"><WorkspaceWideLogo onSidebar markName={me.data?.organization?.name ?? ""} fallback={<Logo className="h-6" />} /></Link>
        <button className="grid h-11 w-11 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg lg:hidden" onClick={() => setDrawer(false)} aria-label="Close navigation"><IconClose className="h-5 w-5" /></button>
      </div>
      <div className="shrink-0 px-3">
        <WorkspaceSwitcher current={organization} />
      </div>
      <div className="mt-3 shrink-0 px-3">
        <button onClick={() => { setDrawer(false); openPalette(); }} className="flex w-full items-center gap-2.5 rounded-lg bg-fill px-2.5 py-[6px] text-[13px] text-subtle transition-colors hover:bg-hover hover:text-muted max-sm:min-h-11">
          <IconSearch className="h-4 w-4" aria-hidden /><span className="flex-1 text-left">Search</span><span className="[@media(hover:none)]:hidden"><Kbd>{isMac ? "⌘" : "Ctrl"} K</Kbd></span>
        </button>
      </div>
      <nav className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 max-lg:pb-[calc(0.75rem+env(safe-area-inset-bottom))]" aria-label="App">
        {navGroups(([...((config.data?.tools ? (x: NavItem[]) => withTools(x, !!config.data?.toolFeatures?.includes("folders")) : (x: NavItem[]) => x)(config.data?.scheduling ? withScheduling : nav)), ...(me.data?.user.platformAdmin ? [{ to: "/app/admin", label: "Operator", icon: IconShield, end: false, group: "admin" as const }] : [])] as NavItem[])).map(({ group, items }, gi) => (
          <div key={group} className={cn(gi > 0 && "pt-4 max-lg:pt-5")}>
          <div data-testid="nav-group" className="px-2.5 pb-1 text-[11.5px] font-semibold text-subtle max-lg:pb-1.5 max-lg:text-[12px] max-lg:uppercase max-lg:tracking-[0.05em]">{GROUP_LABEL[group]}</div>
          {/* R46 mobile: on a phone each group is one rounded card, like the system settings lists. */}
          <div className="space-y-0.5 max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:bg-surface max-lg:p-1 max-lg:shadow-[var(--shadow-e1)]">
          {items.map(({ to, label, icon: Icon, end }) => (
            <NavLink to={to} end={end} className={({ isActive }) => cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] transition-colors duration-150 max-lg:min-h-11 max-lg:text-[15px]",
              isActive ? "bg-brand font-medium text-brand-fg shadow-[var(--shadow-e1)] [&_[data-badge]]:bg-white/25 [&_[data-badge]]:text-white" : "text-fg/85 hover:bg-hover hover:text-fg",
            )}>
              {({ isActive }) => (<>
              {/* R35: a tinted rounded tile per section, like the system settings sidebar; the glyph fills when active. */}
              <span className="nav-tile" style={{ background: NAV_TINT[to] ?? "#8E8E93" }}><Icon filled={isActive} /></span>{label}
              {to === "/app/notifications" && (unreadNotes.data ?? 0) > 0 && <span className="ml-auto rounded-full bg-brand px-1.5 text-[11px] font-semibold tabular-nums text-brand-fg" data-badge aria-label={`${unreadNotes.data} unread`}>{unreadNotes.data}</span>}
              {to === "/app/mail" && mailUnread > 0 && <span className="ml-auto rounded-full bg-fill px-1.5 text-[11px] font-semibold tabular-nums text-fg" data-badge aria-label={`${mailUnread} unread in Inbox`}>{mailUnread > 999 ? "999+" : mailUnread}</span>}
              {to === "/app/chat" && (chatUnread.data?.total ?? 0) > 0 && <span className="ml-auto rounded-full bg-fill px-1.5 text-[11px] font-semibold tabular-nums text-fg" data-badge aria-label={`${chatUnread.data?.total} unread messages`}>{chatUnread.data?.total}</span>}
              {to === "/app/triage" && (triageCount.data ?? 0) > 0 && <span className="ml-auto rounded-full bg-brand px-1.5 text-[11px] font-semibold tabular-nums text-brand-fg" data-badge aria-label={`${triageCount.data} waiting in Triage`}>{triageCount.data}</span>}
              {to === "/app/admin" && (openReports.data ?? 0) > 0 && <span className="ml-auto rounded-full bg-bad px-1.5 text-[11px] font-semibold tabular-nums text-white" data-badge aria-label={`${openReports.data} reports to review`} data-testid="nav-reports-badge">{openReports.data}</span>}
              {to === "/app/approvals" && pendingCount > 0 && <span className="ml-auto rounded-full bg-brand px-1.5 text-[11px] font-semibold tabular-nums text-brand-fg" data-badge aria-label={`${pendingCount} waiting`}>{pendingCount}</span>}
              </>)}
            </NavLink>
          ))}
          </div>
          </div>
        ))}
      </nav>
      {organization?.isDemo && (
        <div className="mx-3 mb-3 shrink-0 rounded-lg bg-fill p-3 text-[12.5px]">
          <div className="flex items-center gap-1.5 font-medium text-fg"><IconFlask className="h-3.5 w-3.5 text-muted" aria-hidden />Demo workspace</div>
          <p className="mt-1 text-muted">Sample data, private to you, deleted after 24 hours.</p>
          <Link to="/signup" onClick={signOut} className="mt-2 inline-block font-medium text-fg hover:underline">Create a real account</Link>
        </div>
      )}
      <div className="shrink-0 border-t border-line p-3">
        {accountMenu(<button className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-hover" data-testid="sidebar-account">
            <span className="relative shrink-0"><Avatar label={initials(user.name)} className="h-7 w-7" />{whatsNew.unread && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-surface" aria-hidden data-testid="whats-new-unread" />}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{user.name}</div>
              <div className="truncate text-[11.5px] text-subtle">{user.email}</div>
            </div>
            <IconChevronsUpDown className="h-4 w-4 text-subtle" />
          </button>, "start")}
      </div>
    </div>
  );

  return (
    <div className="app-shell flex h-dvh overflow-hidden">
      <BrandTokens orgId={organization?.id} />
      <aside aria-label="Sidebar" className="glass-sidebar hairline-r hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 animate-fade-in bg-black/40" onClick={() => setDrawer(false)} />
          <aside aria-label="Sidebar" className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-drawer-in border-r border-line bg-surface pt-[env(safe-area-inset-top)] elev-3 max-md:w-[min(20rem,88vw)] max-md:bg-bg">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 glass hairline-b pl-[max(0.375rem,env(safe-area-inset-left))] pr-[max(0.375rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] lg:hidden" data-topbar>
          {/* R46 mobile: phones get the tab bar (More opens the menu); a tablet keeps the menu button here. */}
          <button className="hidden h-11 w-11 shrink-0 place-items-center rounded-full text-brand-hover transition-colors hover:bg-hover md:grid" onClick={() => setDrawer(true)} aria-label="Open navigation"><IconMenu className="h-[22px] w-[22px]" /></button>
          <div className="min-w-0"><WorkspaceSwitcher current={organization} variant="chip" compact={!!barTitle} /></div>
          {barTitle && <span className="pointer-events-none absolute left-1/2 top-[env(safe-area-inset-top)] flex h-12 max-w-[46%] -translate-x-1/2 animate-fade-in items-center text-[16px] font-semibold tracking-[-0.01em] text-fg" aria-hidden data-testid="bar-title"><span className="truncate">{barTitle}</span></span>}
          <div className="ml-auto flex shrink-0 items-center">
            <button onClick={() => openPalette()} className="grid h-11 w-11 place-items-center rounded-full text-fg/80 transition-colors hover:bg-hover hover:text-fg" aria-label="Search" data-testid="topbar-search"><IconSearch className="h-[22px] w-[22px]" /></button>
            {accountMenu(<button className="grid h-11 w-11 place-items-center rounded-full transition-colors hover:bg-hover" aria-label="Account" data-testid="topbar-account"><span className="relative"><Avatar label={initials(user.name)} className="h-8 w-8" drawn />{whatsNew.unread && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-surface" aria-hidden data-testid="whats-new-unread" />}</span></button>, "end")}
          </div>
        </header>
        <WorkspaceSwitchedBanner />
        <ReadOnlyBanner />
        <OfflineBanner />
        {!!me.error && <ReconnectingPill onRetry={() => void me.refetch()} />}
        <PendingInviteBanner />
        <main ref={setMainEl} className={cn("min-h-0 flex-1 overflow-x-hidden", isMail ? "overflow-hidden" : "overflow-y-auto overscroll-y-contain")}>
          {isMail ? <Outlet /> : <div key={loc.pathname.split("/").slice(0, 3).join("/")} className={pageFrameClass(loc.pathname)} data-page-width={pageWidth(loc.pathname)}><Outlet /></div>}
        </main>
        <PhoneTabBar mailUnread={mailUnread} moreOpen={drawer} onMore={() => setDrawer((d) => !d)} />
        <PaletteHost onSignOut={signOut} />
        <UpdatePill />{/* R32: new version prompt */}
        <ShortcutsHost />
        <div className="pointer-events-none fixed bottom-[calc(1rem+var(--tabbar-h,0px))] right-4 z-30 [&>*]:pointer-events-auto"><TimerChip /></div>
        <Suspense fallback={null}><CallDockHost /></Suspense>
      </div>
    </div>
  );
}

function WorkspaceSwitcher({ current, variant = "sidebar", compact = false }: { current: Me["organization"]; /** R46 mobile: "chip" is the phone top bar's workspace button. */ variant?: "sidebar" | "chip"; compact?: boolean }) {
  const ws = useWorkspaces();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // Multiws: a switch that fails says so (before, nothing happened and the person stayed put without a word).
  const go = async (id: string) => {
    if (id === current?.id || switching) return;
    setSwitching(id); setSwitchError(null);
    try {
      await api.post(`/account/workspaces/${id}/switch`);
      workspaceTabs()?.switchedHere(); // R58 (MB-245): up to date again; other tabs hear the workspace opened
      qc.clear();
      navigate("/app");
    } catch (e) {
      setSwitchError(e instanceof Error && e.message ? e.message : "Couldn't open that workspace. Try again.");
      void ws.refetch();
    } finally { setSwitching(null); }
  };
  const create = async () => {
    setBusy(true); setError(null);
    try { await api.post("/account/workspaces", { name }); workspaceTabs()?.switchedHere(); qc.clear(); setCreating(false); setName(""); navigate("/app"); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't create it."); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Menu align="start" trigger={variant === "chip" ? (
        <button className="flex h-11 min-w-0 max-w-[58vw] items-center gap-2 rounded-full pl-1 pr-2 text-left transition-colors hover:bg-hover" aria-label={`${current?.name ?? "Workspace"}, switch workspace`} /* R54: the name a screen reader hears starts with the words on the button (WCAG 2.5.3) */ data-testid="topbar-workspace">
          <WorkspaceMark name={current?.name} rounded="rounded-[9px]" className="h-8 w-8 text-[14px] shadow-[var(--shadow-e1)]" /* R54: the initial is drawn by CSS, not a text node; R77: the workspace logo when it has one */ />
          {!compact && <span className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">{current?.name}</span>}
          {!compact && <IconChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />}
        </button>
      ) : (
        <button className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-elevated/60 px-2.5 py-2 text-left transition-colors hover:border-line-strong">
          <WorkspaceMark name={current?.name} className="h-6 w-6 text-[11px]" onSidebar />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{current?.name}</span>
            <span className="block text-[11px] text-subtle">{current ? PLANS[current.plan].name : ""} plan</span>
          </span>
          <IconChevronsUpDown className="h-4 w-4 shrink-0 text-subtle" />
        </button>)      }>
        <MenuLabel>Workspaces</MenuLabel>
        {(ws.data?.workspaces ?? []).map((w) => (
          <MenuItem key={w.id} icon={w.id === current?.id ? <IconCheck /> : <span className="grid h-4 w-4 place-items-center rounded bg-fill text-[9px] font-bold">{w.name[0]?.toUpperCase()}</span>} onSelect={() => go(w.id)}>
            <span className="truncate" data-testid="workspace-option">{w.name}{switching === w.id ? "…" : ""}</span>
          </MenuItem>
        ))}
        <div className="my-1 border-t border-line" />
        <MenuItem icon={<IconPlus />} onSelect={() => setCreating(true)}>New workspace</MenuItem>
      </Menu>
      {switchError && <p role="alert" className={variant === "chip" ? "fixed inset-x-3 top-[calc(3.5rem+env(safe-area-inset-top))] z-40 rounded-xl bg-elevated p-3 text-[13px] text-bad elev-3" : "mt-1.5 px-1 text-[12px] text-bad"} data-testid="workspace-switch-error">{switchError}</p>}
      <Dialog open={creating} onClose={() => setCreating(false)} title="Create a workspace" description="A separate space with its own domains, mailboxes, team and plan."
        footer={<><Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button><Button loading={busy} disabled={!name.trim()} onClick={create}>Create workspace</Button></>}>
        <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Field label="Name" error={error ?? undefined}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." autoFocus />}</Field>
        </form>
      </Dialog>
    </>
  );
}
