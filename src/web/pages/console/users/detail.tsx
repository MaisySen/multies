/**
 * OPS1: one account in the operator console (/console/users/:id?tab=). The header reads like a workspace's: back link,
 * the person's name, one line of facts (email with a copy button, state badges, id) and the actions (Ban or Unban,
 * View as, More). The tabs show the profile, workspaces, sessions, sign in (methods, two-step and the password lockout)
 * and operator notes. The tab is kept in the address (?tab=) because this page's route has no tab segment.
 * Opened from a workspace's Members tab, the address carries ?org=, and View as opens that workspace.
 */
import type { ReactNode } from "react";
import { Navigate, useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { IconMore } from "@/web/components/ui/icon";
import { QueryTabs, TabPanel, useQueryTab } from "../components/detail-tabs";
import { BackLink, LoadError } from "../components/format";
import { NotesPanel } from "../notes-panel";
import { ImpersonateButton } from "../impersonate-button";
import { CopyIdButton, DetailHeader, MetaDot } from "../workspaces/detail-header";
import { useUserActions } from "./users-actions";
import { userKey, usersApi, type ConsoleUserDetail } from "./users-api";
import { UserStateBadges } from "./users-badges";
import { UserProfileTab, UserSessionsTab, UserSignInTab, UserWorkspacesTab } from "./users-tabs";

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "workspaces", label: "Workspaces" },
  { id: "sessions", label: "Sessions" },
  { id: "signin", label: "Sign in" },
  { id: "notes", label: "Notes" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Old links to the Lockout tab open Sign in, which now holds the lockout. */
const MOVED_TABS: Record<string, TabId> = { lockout: "signin" };

const back = { to: "/console/users", label: "All users" };

function Header({ d, refresh }: { d: ConsoleUserDetail; refresh?: ReactNode }) {
  const p = d.profile;
  const a = useUserActions(p);
  const [params] = useSearchParams();
  const tab: TabId = useQueryTab(TABS);
  const moved = MOVED_TABS[params.get("tab") ?? ""];
  // ?org= from a workspace's Members tab: View as opens that workspace (only one they belong to).
  const org = params.get("org");
  const orgId = org && d.memberships.some((m) => m.orgId === org) ? org : undefined;
  const more: ReactNode[] = [];
  if (a.can.clearLockout && (d.lockout.locked || d.lockout.failures > 0)) more.push(<MenuItem key="clearLockout" onSelect={() => a.clearLockout.open()}>Clear lockout</MenuItem>);
  if (a.can.verify && !p.emailVerified) more.push(<MenuItem key="verify" onSelect={() => a.verify.open()}>Mark email verified</MenuItem>);
  if (a.can.sessions && d.activeSessions > 0) more.push(<MenuItem key="signout" onSelect={() => a.signOutAll.open()}>Sign out everywhere</MenuItem>);
  if (a.can.delete) more.push(<MenuItem key="delete" danger onSelect={() => a.remove.open()}>Delete account</MenuItem>);
  if (moved) {
    const next = new URLSearchParams(params);
    next.set("tab", moved);
    return <Navigate replace to={{ search: `?${next.toString()}` }} />;
  }

  return (
    <>
      <DetailHeader
        back={back}
        title={p.name || p.email}
        meta={
          <>
            <span className="inline-flex min-w-0 items-center gap-0.5">
              <span className="truncate" data-testid="console-users-email">{p.email}</span>
              <CopyIdButton value={p.email} label="Copy email" />
            </span>
            <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="console-users-badges">
              <UserStateBadges u={{ ...p, twoFactorEnabled: d.twoFactor.enabled }} showTwoFactor />
            </span>
            {d.lockout.locked && <span className="text-xs text-bad">Password sign in is locked</span>}
            <MetaDot />
            <span className="inline-flex items-center gap-0.5 font-mono text-xs" data-testid="console-users-id">
              {p.id}<CopyIdButton value={p.id} label="Copy account id" />
            </span>
          </>
        }
        note={(p.operator || a.self) ? (
          <p className="text-xs text-subtle">
            {a.self ? "This is your own account. Change it from your account settings." : "This person is a platform operator. Ban, delete and sign out are managed on the Operators page."}
          </p>
        ) : undefined}
        actions={
          <>
            {a.can.ban && (p.banned
              ? <Button variant="secondary" onClick={() => a.unban.open()} data-testid="console-users-unban">Unban</Button>
              : <Button variant="danger" onClick={() => a.ban.open()} data-testid="console-users-ban">Ban</Button>)}
            {!a.self && <ImpersonateButton userId={p.id} orgId={orgId} />}
            {more.length > 0 && (
              <Menu label="More actions" sheet trigger={<Button variant="secondary" data-testid="console-users-more"><IconMore className="h-4 w-4" aria-hidden />More</Button>}>
                {more}
              </Menu>
            )}
          </>
        }
      />
      <QueryTabs tabs={TABS} label="Account sections" testIdPrefix="console-users-tab" keep={["org"]} className="mb-5" />
      {refresh}
      <TabPanel testIdPrefix="console-users-tab" current={tab}>
        {tab === "profile" && <UserProfileTab d={d} />}
        {tab === "workspaces" && <UserWorkspacesTab d={d} />}
        {tab === "sessions" && <UserSessionsTab d={d} actions={a} />}
        {tab === "signin" && <UserSignInTab d={d} actions={a} />}
        {tab === "notes" && <NotesPanel targetType="user" targetId={p.id} />}
      </TabPanel>
      {a.dialogs}
    </>
  );
}

export function ConsoleUserDetailPage() {
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: userKey(id), queryFn: () => usersApi.detail(id), enabled: !!id });
  if (q.isPending) {
    return (
      <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading the account">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (!q.data) {
    return (
      <div className="space-y-4" data-testid="console-user-detail">
        <BackLink to={back.to}>{back.label}</BackLink>
        <LoadError error={q.error} retry={() => void q.refetch()} what="the account" />
      </div>
    );
  }
  return (
    <div data-testid="console-user-detail">
      <Header d={q.data} refresh={q.error ? <LoadError error={q.error} retry={() => void q.refetch()} what="the latest account details" className="mb-4" /> : undefined} />
    </div>
  );
}
