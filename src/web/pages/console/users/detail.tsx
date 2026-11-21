/**
 * OPS1: one account in the operator console (/console/users/:id?tab=). The header names the person, their state and
 * the actions (Ban or Unban, View as, More); the tabs show the profile, workspaces, sessions, sign in methods and
 * two-step sign in, the password lockout, and operator notes. The tab is kept in the address (?tab=) so a link opens it.
 */
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ApiError, errorMessage } from "@/web/lib/api";
import { Card, CopyButton, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button, buttonClass } from "@/web/components/ui/button";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { IconArrowLeft, IconMore, IconUserX, IconWarning } from "@/web/components/ui/icon";
import { QueryTabs, TabPanel, useQueryTab } from "../components/detail-tabs";
import { NotesPanel } from "../notes-panel";
import { ImpersonateButton } from "../impersonate-button";
import { useUserActions } from "./users-actions";
import { userKey, usersApi, type ConsoleUserDetail } from "./users-api";
import { UserStateBadges } from "./users-badges";
import { UserLockoutTab, UserProfileTab, UserSessionsTab, UserSignInTab, UserWorkspacesTab } from "./users-tabs";

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "workspaces", label: "Workspaces" },
  { id: "sessions", label: "Sessions" },
  { id: "signin", label: "Sign in" },
  { id: "lockout", label: "Lockout" },
  { id: "notes", label: "Notes" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const backLink = <Link to="/console/users" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg"><IconArrowLeft className="h-4 w-4" aria-hidden />All users</Link>;

function Header({ d }: { d: ConsoleUserDetail }) {
  const p = d.profile;
  const a = useUserActions(p);
  const tab: TabId = useQueryTab(TABS);
  const counts: Partial<Record<TabId, number>> = { workspaces: d.memberships.length, sessions: d.activeSessions };
  const more: ReactNode[] = [];
  if (a.can.clearLockout && (d.lockout.locked || d.lockout.failures > 0)) more.push(<MenuItem key="clearLockout" onSelect={() => a.clearLockout.open()}>Clear lockout</MenuItem>);
  if (a.can.verify && !p.emailVerified) more.push(<MenuItem key="verify" onSelect={() => a.verify.open()}>Mark email verified</MenuItem>);
  if (a.can.sessions && d.activeSessions > 0) more.push(<MenuItem key="signout" onSelect={() => a.signOutAll.open()}>Sign out everywhere</MenuItem>);
  if (a.can.delete) more.push(<MenuItem key="delete" danger onSelect={() => a.remove.open()}>Delete account</MenuItem>);

  return (
    <>
      <div className="mb-2">{backLink}</div>
      <PageHeader
        eyebrow="User" title={p.name || p.email}
        description={<span className="inline-flex flex-wrap items-center gap-1.5"><span className="[overflow-wrap:anywhere]" data-testid="console-users-email">{p.email}</span><CopyButton value={p.email} label="email" /></span>}
        actions={
          <>
            {a.can.ban && (p.banned
              ? <Button variant="secondary" onClick={() => a.unban.open()} data-testid="console-users-unban">Unban</Button>
              : <Button variant="danger" onClick={() => a.ban.open()} data-testid="console-users-ban">Ban</Button>)}
            {!a.self && <ImpersonateButton userId={p.id} />}
            {more.length > 0 && (
              <Menu label="More actions" sheet trigger={<Button variant="secondary" data-testid="console-users-more"><IconMore className="h-4 w-4" aria-hidden />More</Button>}>
                {more}
              </Menu>
            )}
          </>
        }
      />
      <div className="-mt-3 mb-5 flex flex-wrap items-center gap-1.5" data-testid="console-users-badges">
        <UserStateBadges u={{ ...p, twoFactorEnabled: d.twoFactor.enabled }} showTwoFactor />
        {d.lockout.locked && <span className="text-xs text-bad">Password sign in is locked</span>}
      </div>
      {(p.operator || a.self) && (
        <p className="mb-4 text-xs text-subtle">
          {a.self ? "This is your own account. Change it from your account settings." : "This person is a platform operator. Ban, delete and sign out are managed on the Operators page."}
        </p>
      )}
      <QueryTabs tabs={TABS.map((t) => counts[t.id] === undefined ? t : { ...t, badge: <span className="rounded-full bg-fill px-1.5 text-[11px] tabular-nums text-muted">{counts[t.id]}</span> })}
        label="Account sections" testIdPrefix="console-users-tab" className="mb-5" />
      <TabPanel testIdPrefix="console-users-tab" current={tab}>
      {tab === "profile" && <UserProfileTab d={d} />}
      {tab === "workspaces" && <UserWorkspacesTab d={d} />}
      {tab === "sessions" && <UserSessionsTab d={d} actions={a} />}
      {tab === "signin" && <UserSignInTab d={d} />}
      {tab === "lockout" && <UserLockoutTab d={d} actions={a} />}
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
  if (q.error) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-4">
        {backLink}
        <Card className="p-0">
          {missing
            ? <EmptyState icon={<IconUserX />} title="No account with this id" body="It may have been deleted. Search for the person on the Users page." action={<Link to="/console/users" className={buttonClass("secondary", "md")}>All users</Link>} />
            : <EmptyState icon={<IconWarning />} title="Couldn't load this account" body={errorMessage(q.error)} action={<Button variant="secondary" onClick={() => void q.refetch()}>Try again</Button>} />}
        </Card>
      </div>
    );
  }
  return <div data-testid="console-user-detail"><Header d={q.data} /></div>;
}
