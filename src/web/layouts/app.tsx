import { Fragment, useEffect, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Plug, Bell, MessageCircle, Target, LayoutTemplate, BarChart3, Briefcase, ClipboardList, Timer, Video, Activity, CheckSquare, Contact, FileText, Zap, Bot, Check, ClipboardCheck, MessagesSquare, Search, ShieldCheck, ChevronsUpDown, Plus, UserCog, Globe, Inbox, LayoutDashboard, LogOut, Menu as MenuIcon, Settings, Shield, FlaskConical, Users, X } from "lucide-react";
import { Logo } from "@/web/components/logo";
import { AppearanceControl } from "@/web/components/theme";
import { Avatar, Kbd } from "@/web/components/ui/misc";
import { CommandPalette } from "@/web/components/command-palette";
import { TimerChip } from "@/web/pages/app/work/time";
import { useUnreadNotifications } from "@/web/pages/app/notifications";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { useConfig, useMe, useWorkspaces } from "@/web/lib/queries";
import { useDemoSeedCatchUp } from "@/web/lib/demo";
import type { Me } from "@/web/lib/types";
import { Dialog } from "@/web/components/ui/dialog";
import { ReadOnlyBanner } from "@/web/lib/read-only";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import { authClient, signOutEverywhere, type AuthProviders } from "@/web/lib/auth-client";
import { api, ApiError } from "@/web/lib/api";
import { browserTimeZone, initials, setDisplayTimeZone } from "@/web/lib/format";
import { Onboarding } from "@/web/pages/app/onboarding";
import { cn } from "@/web/lib/cn";
import { AppSkeleton } from "./app-skeleton";
import { PLANS } from "@/shared/plans";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type NavItem = { to: string; label: string; icon: typeof Inbox; end?: boolean; group: "work" | "mail" | "admin" };
const nav: NavItem[] = [
  { to: "/app", label: "Overview", icon: LayoutDashboard, end: true, group: "work" },
  { to: "/app/notifications", label: "Notifications", icon: Bell, group: "work" },
  { to: "/app/chat", label: "Chat", icon: MessageCircle, group: "work" },
  { to: "/app/tasks", label: "Tasks", icon: CheckSquare, group: "work" },
  { to: "/app/docs", label: "Docs", icon: FileText, group: "work" },
  { to: "/app/meetings", label: "Meetings", icon: Video, group: "work" },
  { to: "/app/goals", label: "Goals", icon: Target, group: "work" },
  { to: "/app/contacts", label: "Contacts", icon: Contact, group: "work" },
  { to: "/app/time", label: "Timesheet", icon: Timer, group: "work" },
  { to: "/app/forms", label: "Forms", icon: ClipboardList, group: "work" },
  { to: "/app/reports", label: "Reports", icon: BarChart3, group: "work" },
  { to: "/app/portfolio", label: "Portfolio", icon: Briefcase, group: "work" },
  { to: "/app/templates", label: "Templates", icon: LayoutTemplate, group: "work" },
  { to: "/app/automations", label: "Automations", icon: Zap, group: "work" },
  { to: "/app/mail", label: "Mail", icon: Inbox, group: "mail" },
  { to: "/app/inbox", label: "Shared inbox", icon: MessagesSquare, group: "mail" },
  { to: "/app/mailboxes", label: "Mailboxes", icon: Users, group: "mail" },
  { to: "/app/domains", label: "Domains", icon: Globe, group: "mail" },
  { to: "/app/deliverability", label: "Deliverability", icon: ShieldCheck, group: "mail" },
  { to: "/app/agents", label: "Agents", icon: Bot, group: "admin" },
  { to: "/app/approvals", label: "Approvals", icon: ClipboardCheck, group: "admin" },
  { to: "/app/integrations", label: "Integrations", icon: Plug, group: "admin" },
  { to: "/app/activity", label: "Activity", icon: Activity, group: "admin" },
  { to: "/app/settings", label: "Settings", icon: Settings, group: "admin" },
];
// "Workspace", not "Admin": everyone sees this group (settings, people, billing); the operator's console is gated separately.
const GROUP_LABEL = { work: "Work", mail: "Mail", admin: "Workspace" } as const;

/** The booking page sits under Meetings when the server has scheduling switched on. */
const withScheduling: NavItem[] = nav.flatMap((n) => (n.to === "/app/meetings" ? [n, { to: "/app/scheduling", label: "Booking page", icon: CalendarClock, group: "work" as const }] : [n]));

export function AppLayout() {
  const me = useMe();
  const config = useConfig();
  useDemoSeedCatchUp(!!me.data?.organization?.isDemo);
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const approvals = useQuery({
    queryKey: ["approvals", "pending"], enabled: !!me.data?.organization, refetchInterval: 30_000,
    queryFn: async () => (await api.get<{ approvals: unknown[] }>("/approvals?status=pending")).approvals,
  });
  const pendingCount = approvals.data?.length ?? 0;
  const unreadNotes = useUnreadNotifications(!!me.data?.organization);
  const chatUnread = useQuery({ queryKey: ["chat", "unread"], enabled: !!me.data?.organization, refetchInterval: 30_000, queryFn: () => api.get<{ total: number; mentions: number }>("/chat/unread") });
  useEffect(() => setDrawer(false), [loc.pathname]);
  // Assigned during render so the first paint already uses the person's zone: their own, their browser's, else the workspace's.
  setDisplayTimeZone(me.data?.user?.timezone, browserTimeZone(), me.data?.organization?.timezone);

  if (me.isPending) return <AppSkeleton />;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div><p className="font-medium">Couldn't load your workspace.</p><p className="mt-1 text-sm text-muted">{me.error.message}</p>
          <button className="mt-4 text-sm text-brand-hover hover:underline" onClick={() => me.refetch()}>Try again</button></div>
      </div>
    );
  }
  const { user, organization } = me.data;
  if (me.data.session?.ssoBlocked) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="max-w-sm">
          <h1 className="text-lg font-semibold">{organization?.name} requires single sign on</h1>
          <p className="mt-2 text-sm text-muted">You signed in with a password. Sign out, then choose your company's SSO on the sign in page.</p>
          <button className="mt-5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-fg hover:bg-brand/90"
            onClick={async () => { try { await authClient.signOut(); } catch { /* already signed out */ } qc.clear(); navigate("/login?sso=required"); }}>
            Sign out and use SSO
          </button>
        </div>
      </div>
    );
  }
  if (me.data.onboarding?.needed) return <Onboarding me={me.data} />;
  const isMail = /^\/app\/mail(\/|$)/.test(loc.pathname);

  const signOut = async () => {
    const providers = qc.getQueryData<AuthProviders>(["auth-providers"]) ?? await api.get<AuthProviders>("/account/providers").catch(() => null);
    qc.clear();
    if (await signOutEverywhere({ idp: !!providers?.idp }) === "done") navigate("/login");
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <Link to="/app" aria-label="Multies overview"><Logo className="h-6" /></Link>
        <button className="grid h-11 w-11 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg lg:hidden" onClick={() => setDrawer(false)} aria-label="Close navigation"><X className="h-5 w-5" /></button>
      </div>
      <div className="shrink-0 px-3">
        <WorkspaceSwitcher current={organization} />
      </div>
      <div className="mt-3 shrink-0 px-3">
        <button onClick={() => { setDrawer(false); setPalette(true); }} className="flex w-full items-center gap-2.5 rounded-lg bg-fill px-2.5 py-[6px] text-[13px] text-subtle transition-colors hover:bg-hover hover:text-muted max-sm:min-h-11">
          <Search className="h-4 w-4" aria-hidden /><span className="flex-1 text-left">Search</span><Kbd>{isMac ? "⌘" : "Ctrl"} K</Kbd>
        </button>
      </div>
      <nav className="mt-3 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3" aria-label="App">
        {([...(config.data?.scheduling ? withScheduling : nav), ...(me.data?.user.platformAdmin ? [{ to: "/app/admin", label: "Operator", icon: Shield, end: false, group: "admin" as const }] : [])] as NavItem[]).map(({ to, label, icon: Icon, end, group }, i, all) => (
          <Fragment key={to}>
          {(i === 0 || all[i - 1].group !== group) && <div data-testid="nav-group" className={cn("px-2.5 pb-1 text-[11.5px] font-semibold text-subtle", i > 0 && "pt-4")}>{GROUP_LABEL[group]}</div>}
          <NavLink to={to} end={end} className={({ isActive }) => cn(
            "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] transition-colors duration-150 max-lg:min-h-11 max-lg:text-[15px]",
            isActive ? "bg-brand-soft font-medium text-brand-hover" : "text-muted hover:bg-hover hover:text-fg",
          )}>
            <Icon className="h-4 w-4" />{label}
            {to === "/app/notifications" && (unreadNotes.data ?? 0) > 0 && <span className="ml-auto rounded-full bg-brand px-1.5 text-[11px] font-semibold tabular-nums text-brand-fg" aria-label={`${unreadNotes.data} unread`}>{unreadNotes.data}</span>}
            {to === "/app/chat" && (chatUnread.data?.total ?? 0) > 0 && <span className="ml-auto rounded-full bg-fill px-1.5 text-[11px] font-semibold tabular-nums text-fg" aria-label={`${chatUnread.data?.total} unread messages`}>{chatUnread.data?.total}</span>}
            {to === "/app/approvals" && pendingCount > 0 && <span className="ml-auto rounded-full bg-brand px-1.5 text-[11px] font-semibold tabular-nums text-brand-fg" aria-label={`${pendingCount} waiting`}>{pendingCount}</span>}
          </NavLink>
          </Fragment>
        ))}
      </nav>
      {organization?.isDemo && (
        <div className="mx-3 mb-3 shrink-0 rounded-lg bg-fill p-3 text-[12.5px]">
          <div className="flex items-center gap-1.5 font-medium text-fg"><FlaskConical className="h-3.5 w-3.5 text-muted" aria-hidden />Demo workspace</div>
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
            <ChevronsUpDown className="h-4 w-4 text-subtle" />
          </button>
        }>
          <MenuLabel>{user.email}</MenuLabel>
          <div className="px-1.5 pb-1.5 pt-0.5"><AppearanceControl className="w-full [&>button]:flex-1 [&>button]:justify-center" /></div>
          <MenuItem icon={<UserCog />} onSelect={() => navigate("/app/settings/account")}>Account & security</MenuItem>
          <MenuItem icon={<Settings />} onSelect={() => navigate("/app/settings")}>Workspace settings</MenuItem>
          <MenuItem icon={<LogOut />} onSelect={signOut} danger>Sign out</MenuItem>
        </Menu>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside aria-label="Sidebar" className="hidden w-60 shrink-0 border-r border-line bg-surface lg:block">{sidebar}</aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 animate-fade-in bg-black/40" onClick={() => setDrawer(false)} />
          <aside aria-label="Sidebar" className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-drawer-in border-r border-line bg-surface pt-[env(safe-area-inset-top)] shadow-pop">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-bg/80 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-xl backdrop-saturate-150 lg:hidden">
          <button className="grid h-11 w-11 place-items-center rounded-full text-brand-hover transition-colors hover:bg-hover" onClick={() => setDrawer(true)} aria-label="Open navigation"><MenuIcon className="h-[22px] w-[22px]" /></button>
          <Link to="/app" aria-label="Multies overview" className="absolute left-1/2 -translate-x-1/2"><Logo className="h-[22px]" /></Link>
        </header>
        <ReadOnlyBanner />
        <main className={cn("min-h-0 flex-1", isMail ? "overflow-hidden" : "overflow-y-auto")}>
          {isMail ? <Outlet /> : <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8"><Outlet /></div>}
        </main>
        <CommandPalette open={palette} onOpenChange={setPalette} onSignOut={signOut} />
        <div className="pointer-events-none fixed bottom-4 right-4 z-30 [&>*]:pointer-events-auto"><TimerChip /></div>
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
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-subtle" />
        </button>
      }>
        <MenuLabel>Workspaces</MenuLabel>
        {(ws.data?.workspaces ?? []).map((w) => (
          <MenuItem key={w.id} icon={w.id === current?.id ? <Check /> : <span className="grid h-4 w-4 place-items-center rounded bg-fill text-[9px] font-bold">{w.name[0]?.toUpperCase()}</span>} onSelect={() => go(w.id)}>
            <span className="truncate">{w.name}</span>
          </MenuItem>
        ))}
        <div className="my-1 border-t border-line" />
        <MenuItem icon={<Plus />} onSelect={() => setCreating(true)}>New workspace</MenuItem>
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
