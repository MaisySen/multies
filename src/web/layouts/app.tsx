import { Fragment, lazy, Suspense, useEffect, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconActivity, IconAgent, IconBell, IconBriefcase, IconCalendarClock, IconChart, IconChats, IconCheck, IconChevronsUpDown, IconClipboardCheck, IconClipboardList, IconClose, IconContacts, IconDashboard, IconDocs, IconFlask, IconGlobe, IconInbox, IconKeyboard, IconLogOut, IconMenu, IconMessageCircle, IconPlug, IconPlus, IconSearch, IconSettings, IconShield, IconShieldCheck, IconTarget, IconTasks, IconTeam, IconTemplate, IconTimer, IconToday, IconTodo, IconUserCog, IconVideo, IconZap, type IconComponent } from "@/web/components/ui/icon";
import { Logo } from "@/web/components/logo";
import { AppearanceControl } from "@/web/components/theme";
import { Avatar, Kbd } from "@/web/components/ui/misc";
import { UpdatePill } from "@/web/components/update-pill"; // R32
import { PaletteHost } from "@/web/components/palette-host"; // R31: the menu itself loads on demand
import { ShortcutsHost } from "@/web/components/shortcuts-sheet"; // R30
import { openPalette, openShortcutsSheet } from "@/web/lib/shortcuts";
import { TimerChip } from "@/web/pages/app/work/time";
// R31: the call dock and onboarding load on demand (their code is not on the first paint path).
const CallDockHost = lazy(() => import("@/web/pages/app/work/call-r23").then((m) => ({ default: m.CallDockHost })));
const Onboarding = lazy(() => import("@/web/pages/app/onboarding").then((m) => ({ default: m.Onboarding })));
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { useConfig, useMe, useWorkspaces } from "@/web/lib/queries";
import { useDemoSeedCatchUp } from "@/web/lib/demo";
import type { Me } from "@/web/lib/types";
import { Dialog } from "@/web/components/ui/dialog";
import { ReadOnlyBanner } from "@/web/lib/read-only";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import { authClient, signOutEverywhere, type AuthProviders } from "@/web/lib/auth-client";
import { clearOfflineData } from "@/web/lib/sw-client"; // R32
import { scopeOf, setOfflineScope } from "@/web/lib/offline-lists"; // R33
import { OfflineBanner } from "@/web/components/offline-banner-r32"; // R32
import { PendingInviteBanner } from "@/web/components/pending-invite-banner-r39"; // R39 (MB-202)
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
import { useOpenReportCount } from "../pages/app/admin-moderation-r35"; // R35

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
  { to: "/app/templates", label: "Templates", icon: IconTemplate, group: "work" },
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
  "/app/integrations": "#BF5AF2", "/app/activity": "#FF453A", "/app/settings": "#8E8E93", "/app/admin": "#1C1C1E",
};
// "Workspace", not "Admin": everyone sees this group (settings, people, billing); the operator's console is gated separately.
const GROUP_LABEL = { work: "Work", mail: "Mail", admin: "Workspace" } as const;

/** The booking page sits under Meetings when the server has scheduling switched on. */
const withScheduling: NavItem[] = nav.flatMap((n) => (n.to === "/app/meetings" ? [n, { to: "/app/scheduling", label: "Booking page", icon: IconCalendarClock, group: "work" as const }] : [n]));

export function AppLayout() {
  const me = useMe();
  // R33: stored list copies are keyed by this person and workspace; set during render so lists started now see it.
  if (me.data) setOfflineScope(scopeOf(me.data));
  const config = useConfig();
  useDemoSeedCatchUp(!!me.data?.organization?.isDemo);
  const loc = useLocation();
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  const barTitle = useCollapsingTitle(mainEl, loc.pathname); // R35: large title folds into the bar on phones
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState(false);
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
            onClick={async () => { await clearOfflineData(); try { await authClient.signOut(); } catch { /* already signed out */ } await clearOfflineData(); qc.clear(); navigate("/login?sso=required"); }}>
            Sign out and use SSO
          </button>
        </div>
      </div>
    );
  }
  if (me.data.onboarding?.needed) return <Suspense fallback={<AppSkeleton />}><Onboarding me={me.data} /></Suspense>;
  const isMail = /^\/app\/mail(\/|$)/.test(loc.pathname);

  const signOut = async () => {
    clearMeCache(); // R40: the saved account copy goes with the session
    const providers = qc.getQueryData<AuthProviders>(["auth-providers"]) ?? await api.get<AuthProviders>("/account/providers").catch(() => null);
    qc.clear();
    if (await signOutEverywhere({ idp: !!providers?.idp }) === "done") navigate("/login");
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <Link to="/app" aria-label="Multies overview"><Logo className="h-6" /></Link>
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
      <nav className="mt-3 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3" aria-label="App">
        {([...(config.data?.scheduling ? withScheduling : nav), ...(me.data?.user.platformAdmin ? [{ to: "/app/admin", label: "Operator", icon: IconShield, end: false, group: "admin" as const }] : [])] as NavItem[]).map(({ to, label, icon: Icon, end, group }, i, all) => (
          <Fragment key={to}>
          {(i === 0 || all[i - 1].group !== group) && <div data-testid="nav-group" className={cn("px-2.5 pb-1 text-[11.5px] font-semibold text-subtle", i > 0 && "pt-4")}>{GROUP_LABEL[group]}</div>}
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
          </Fragment>
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
        <Menu align="start" trigger={
          <button className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-hover">
            <Avatar label={initials(user.name)} className="h-7 w-7" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{user.name}</div>
              <div className="truncate text-[11.5px] text-subtle">{user.email}</div>
            </div>
            <IconChevronsUpDown className="h-4 w-4 text-subtle" />
          </button>
        }>
          <MenuLabel>{user.email}</MenuLabel>
          <div className="px-1.5 pb-1.5 pt-0.5"><AppearanceControl className="w-full [&>button]:flex-1 [&>button]:justify-center" /></div>
          <MenuItem icon={<IconUserCog />} onSelect={() => navigate("/app/settings/account")}>Account & security</MenuItem>
          <MenuItem icon={<IconSettings />} onSelect={() => navigate("/app/settings")}>Workspace settings</MenuItem>
          <MenuItem icon={<IconKeyboard />} onSelect={openShortcutsSheet}>Keyboard shortcuts</MenuItem>
          <MenuItem icon={<IconLogOut />} onSelect={signOut} danger>Sign out</MenuItem>
        </Menu>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside aria-label="Sidebar" className="glass-sidebar hairline-r hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 animate-fade-in bg-black/40" onClick={() => setDrawer(false)} />
          <aside aria-label="Sidebar" className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-drawer-in border-r border-line bg-surface pt-[env(safe-area-inset-top)] elev-3">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 glass hairline-b px-2 pt-[env(safe-area-inset-top)] lg:hidden" data-topbar>
          <button className="grid h-11 w-11 place-items-center rounded-full text-brand-hover transition-colors hover:bg-hover" onClick={() => setDrawer(true)} aria-label="Open navigation"><IconMenu className="h-[22px] w-[22px]" /></button>
          {barTitle
            ? <span className="absolute left-1/2 max-w-[60%] -translate-x-1/2 animate-fade-in truncate text-[16px] font-semibold tracking-[-0.01em] text-fg" aria-hidden data-testid="bar-title">{barTitle}</span>
            : <Link to="/app" aria-label="Multies overview" className="absolute left-1/2 -translate-x-1/2"><Logo className="h-[22px]" /></Link>}
        </header>
        <ReadOnlyBanner />
        <OfflineBanner />
        {!!me.error && <ReconnectingPill onRetry={() => void me.refetch()} />}
        <PendingInviteBanner />
        <main ref={setMainEl} className={cn("min-h-0 flex-1", isMail ? "overflow-hidden" : "overflow-y-auto")}>
          {isMail ? <Outlet /> : <div key={loc.pathname.split("/").slice(0, 3).join("/")} className="route-in mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8"><Outlet /></div>}
        </main>
        <PaletteHost onSignOut={signOut} />
        <UpdatePill />{/* R32: new version prompt */}
        <ShortcutsHost />
        <div className="pointer-events-none fixed bottom-4 right-4 z-30 [&>*]:pointer-events-auto"><TimerChip /></div>
        <Suspense fallback={null}><CallDockHost /></Suspense>
      </div>
    </div>
  );
}

function WorkspaceSwitcher({ current }: { current: Me["organization"] }) {
  const ws = useWorkspaces();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (id: string) => {
    if (id === current?.id) return;
    await api.post(`/account/workspaces/${id}/switch`);
    qc.clear();
    navigate("/app");
  };
  const create = async () => {
    setBusy(true); setError(null);
    try { await api.post("/account/workspaces", { name }); qc.clear(); setCreating(false); setName(""); navigate("/app"); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't create it."); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Menu align="start" trigger={
        <button className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-elevated/60 px-2.5 py-2 text-left transition-colors hover:border-line-strong">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line-strong bg-elevated text-[11px] font-bold text-fg">{current?.name[0]?.toUpperCase()}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{current?.name}</span>
            <span className="block text-[11px] text-subtle">{current ? PLANS[current.plan].name : ""} plan</span>
          </span>
          <IconChevronsUpDown className="h-4 w-4 shrink-0 text-subtle" />
        </button>
      }>
        <MenuLabel>Workspaces</MenuLabel>
        {(ws.data?.workspaces ?? []).map((w) => (
          <MenuItem key={w.id} icon={w.id === current?.id ? <IconCheck /> : <span className="grid h-4 w-4 place-items-center rounded bg-fill text-[9px] font-bold">{w.name[0]?.toUpperCase()}</span>} onSelect={() => go(w.id)}>
            <span className="truncate">{w.name}</span>
          </MenuItem>
        ))}
        <div className="my-1 border-t border-line" />
        <MenuItem icon={<IconPlus />} onSelect={() => setCreating(true)}>New workspace</MenuItem>
      </Menu>
      <Dialog open={creating} onClose={() => setCreating(false)} title="Create a workspace" description="A separate space with its own domains, mailboxes, team and plan."
        footer={<><Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button><Button loading={busy} disabled={!name.trim()} onClick={create}>Create workspace</Button></>}>
        <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Field label="Name" error={error ?? undefined}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." autoFocus />}</Field>
        </form>
      </Dialog>
    </>
  );
}
