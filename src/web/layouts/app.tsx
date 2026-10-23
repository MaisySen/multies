import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, Check, Search, ShieldCheck, ChevronsUpDown, Plus, UserCog, Globe, Inbox, LayoutDashboard, LogOut, Menu as MenuIcon, Settings, Shield, Sparkles, Users, X } from "lucide-react";
import { Logo } from "@/web/components/logo";
import { Avatar, Kbd } from "@/web/components/ui/misc";
import { CommandPalette } from "@/web/components/command-palette";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { useMe, useWorkspaces } from "@/web/lib/queries";
import type { Me } from "@/web/lib/types";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import { authClient } from "@/web/lib/auth-client";
import { api, ApiError } from "@/web/lib/api";
import { initials, setDisplayTimeZone } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { AppSkeleton } from "./app-skeleton";
import { PLANS } from "@/shared/plans";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const nav = [
  { to: "/app", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/app/mail", label: "Mail", icon: Inbox },
  { to: "/app/domains", label: "Domains", icon: Globe },
  { to: "/app/mailboxes", label: "Mailboxes", icon: Users },
  { to: "/app/deliverability", label: "Deliverability", icon: ShieldCheck },
  { to: "/app/activity", label: "Activity", icon: Activity },
  { to: "/app/settings", label: "Settings", icon: Settings },
];

export function AppLayout() {
  const me = useMe();
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  useEffect(() => setDrawer(false), [loc.pathname]);
  // Assigned during render so the first paint already uses the workspace's zone.
  setDisplayTimeZone(me.data?.organization?.timezone);

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
  const isMail = /^\/app\/mail(\/|$)/.test(loc.pathname);

  const signOut = async () => {
    try { await authClient.signOut(); } catch { /* already signed out */ }
    qc.clear();
    navigate("/login");
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-between px-4">
        <Link to="/app" aria-label="MyMail overview"><Logo /></Link>
        <button className="rounded-md p-1.5 text-muted hover:text-fg lg:hidden" onClick={() => setDrawer(false)} aria-label="Close navigation"><X className="h-5 w-5" /></button>
      </div>
      <div className="px-3">
        <WorkspaceSwitcher current={organization} />
      </div>
      <div className="mt-3 px-3">
        <button onClick={() => { setDrawer(false); setPalette(true); }} className="flex w-full items-center gap-2.5 rounded-lg border border-line px-2.5 py-[6px] text-[13px] text-subtle transition-colors hover:border-line-strong hover:text-muted">
          <Search className="h-4 w-4" aria-hidden /><span className="flex-1 text-left">Search</span><Kbd>{isMac ? "⌘" : "Ctrl"} K</Kbd>
        </button>
      </div>
      <nav className="mt-3 flex-1 space-y-0.5 px-3" aria-label="App">
        {[...nav, ...(me.data?.user.platformAdmin ? [{ to: "/app/admin", label: "Operator", icon: Shield, end: false }] : [])].map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => cn(
            "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] transition-colors",
            isActive ? "bg-white/[0.07] font-medium text-fg" : "text-muted hover:bg-white/[0.04] hover:text-fg",
          )}>
            <Icon className="h-4 w-4" />{label}
          </NavLink>
        ))}
      </nav>
      {organization?.isDemo && (
        <div className="mx-3 mb-3 rounded-lg border border-brand/25 bg-brand-soft p-3 text-[12.5px]">
          <div className="flex items-center gap-1.5 font-medium text-brand-hover"><Sparkles className="h-3.5 w-3.5" />Demo workspace</div>
          <p className="mt-1 text-muted">Sample data, private to you, deleted after 24 hours.</p>
          <Link to="/signup" onClick={signOut} className="mt-2 inline-block font-medium text-fg hover:underline">Create a real account →</Link>
        </div>
      )}
      <div className="border-t border-line p-3">
        <Menu label="Account menu" align="start" trigger={
          <button className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-white/[0.04]">
            <Avatar label={initials(user.name)} className="h-7 w-7" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{user.name}</div>
              <div className="truncate text-[11.5px] text-subtle">{user.email}</div>
            </div>
            <ChevronsUpDown className="h-4 w-4 text-subtle" />
          </button>
        }>
          <MenuLabel>{user.email}</MenuLabel>
          <MenuItem icon={<UserCog />} onSelect={() => navigate("/app/settings/account")}>Account & security</MenuItem>
          <MenuItem icon={<Settings />} onSelect={() => navigate("/app/settings")}>Workspace settings</MenuItem>
          <MenuItem icon={<LogOut />} onSelect={signOut} danger>Sign out</MenuItem>
        </Menu>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-60 shrink-0 border-r border-line bg-surface lg:block">{sidebar}</aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 animate-fade-in bg-black/60" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 animate-pop-in border-r border-line bg-surface">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4 lg:hidden">
          <button className="rounded-md p-1.5 text-muted hover:text-fg" onClick={() => setDrawer(true)} aria-label="Open navigation"><MenuIcon className="h-5 w-5" /></button>
          <Logo />
        </header>
        <main className={cn("min-h-0 flex-1", isMail ? "overflow-hidden" : "overflow-y-auto")}>
          {isMail ? <Outlet /> : <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8"><Outlet /></div>}
        </main>
        <CommandPalette open={palette} onOpenChange={setPalette} onSignOut={signOut} />
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
      <Menu label="Switch workspace" align="start" trigger={
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
          <MenuItem key={w.id} icon={w.id === current?.id ? <Check /> : <span className="grid h-4 w-4 place-items-center rounded bg-white/10 text-[9px] font-bold">{w.name[0]?.toUpperCase()}</span>} onSelect={() => go(w.id)}>
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
