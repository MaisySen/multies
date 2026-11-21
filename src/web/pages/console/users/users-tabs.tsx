/**
 * OPS1: the tabs on a person's detail page (Profile, Workspaces, Sessions, Sign in). Sign in holds the sign in
 * methods, two-step sign in and the password lockout. Notes come from NotesPanel.
 */
import { Link } from "react-router";
import { Badge, Card, EmptyState } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconBuilding, IconDevices, IconKey } from "@/web/components/ui/icon";
import { DataTable, consoleTable as T } from "../components/data-table";
import { KvList } from "../components/kv-list";
import { EMPTY, EmptyRow, OperatorRoleBadge, RelTime, StatusBadge, TwoStepBadge, compPlanLabel, planLabel, workspaceHref } from "../components/format";
import { deviceLabel, languageName, signInMethodLabel, type ConsoleUserDetail, type ConsoleUserSession } from "./users-api";
import type { UserActions } from "./users-actions";

export function UserProfileTab({ d }: { d: ConsoleUserDetail }) {
  const p = d.profile;
  return (
    <KvList items={[
      { label: "Name", value: p.name },
      { label: "Email", value: p.email, copy: true },
      { label: "Email confirmed", value: p.emailVerified ? <StatusBadge state="verified" label="Confirmed" /> : <StatusBadge state="pending" label="Not confirmed" /> },
      { label: "Account id", value: p.id, mono: true, copy: true },
      { label: "Operator role", value: p.operator ? <OperatorRoleBadge role={p.role} /> : null },
      { label: "Banned", value: p.banned ? <StatusBadge state="banned" label="Banned" /> : "No", hint: p.banned ? <>{p.banReason ?? "No reason given"}. {p.banExpires ? <>Ends <RelTime at={p.banExpires} />.</> : "No end date."}</> : undefined },
      { label: "Active sessions", value: String(d.activeSessions) },
      { label: "Time zone", value: p.timezone },
      { label: "Language", value: p.locale ? <span title={p.locale}>{languageName(p.locale)}</span> : null },
      { label: "Created", value: <RelTime at={p.createdAt} /> },
      { label: "Last updated", value: <RelTime at={p.updatedAt} /> },
    ]} />
  );
}

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function UserWorkspacesTab({ d }: { d: ConsoleUserDetail }) {
  if (!d.memberships.length) {
    return <Card className="p-0"><EmptyState icon={<IconBuilding />} title="No workspaces" body="This account doesn't belong to any workspace." /></Card>;
  }
  return (
    <div className={T.wrap} tabIndex={0} role="region" aria-label="Workspaces">
      <table className={T.table}>
        <thead className={T.head}><tr><th className={T.th}>Workspace</th><th className={T.th}>Role</th><th className={T.th}>Plan</th><th className={`${T.th} ${T.secondary}`}>State</th><th className={`${T.th} ${T.secondary} text-right`}>Joined</th></tr></thead>
        <tbody className={T.body}>
          {d.memberships.map((m) => (
            <tr key={m.memberId} className={T.row}>
              <td className={T.td}><Link to={workspaceHref(m.orgId)} title={m.orgId} className="font-medium hover:underline" data-testid="console-users-workspace-link">{m.orgName || "Deleted workspace"}</Link></td>
              <td className={`${T.td} whitespace-nowrap`}>{ROLE[m.role] ?? m.role}{m.kind === "agent" && <span className="ml-1.5 text-xs text-subtle">(AI agent)</span>}</td>
              <td className={`${T.td} whitespace-nowrap`} title={m.plan}>{m.effectivePlan !== m.plan ? compPlanLabel(m.effectivePlan) : planLabel(m.plan)}</td>
              <td className={`${T.td} ${T.secondary}`}>
                <span className="inline-flex flex-wrap gap-1.5">
                  {m.suspendedAt ? <StatusBadge state="suspended" label="Suspended" /> : <StatusBadge state="active" label="Active" />}
                  {m.isDemo && <Badge className="whitespace-nowrap">Demo</Badge>}
                </span>
              </td>
              <td className={`${T.td} ${T.secondary} text-right text-muted`}><RelTime at={m.joinedAt} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UserSessionsTab({ d, actions }: { d: ConsoleUserDetail; actions: UserActions }) {
  const canRevoke = actions.can.sessions;
  return (
    <div className="space-y-3">
      {canRevoke && d.activeSessions > 0 && (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => actions.signOutAll.open()} data-testid="console-users-sign-out-all">Sign out everywhere</Button>
        </div>
      )}
      <DataTable<ConsoleUserSession>
        label="Sessions" path={`/users/${encodeURIComponent(d.profile.id)}/sessions`} rowKey={(s) => s.id}
        empty={{ icon: <IconDevices />, title: "No sessions", body: "This account isn't signed in anywhere." }}
        columns={[
          { key: "device", header: "Device", cell: (s) => (
            <span className="flex flex-col">
              <span className="whitespace-nowrap font-medium" title={s.userAgent ?? undefined}>{deviceLabel(s.userAgent)}</span>
              <span className="text-xs text-subtle">{s.loginMethod ? signInMethodLabel(s.loginMethod) : "Method not recorded"}{s.impersonatedBy ? ", opened by an operator" : ""}</span>
            </span>
          ) },
          { key: "ip", header: "IP address", secondary: true, cell: (s) => <span className="font-mono text-[13px] text-muted">{s.ipAddress ?? EMPTY}</span> },
          { key: "active", header: "Last active", cell: (s) => <RelTime at={s.updatedAt} /> },
          { key: "state", header: "State", cell: (s) => (s.active ? <StatusBadge state="active" label="Active" /> : <StatusBadge state="expired" label="Expired" />) },
          { key: "started", header: "Started", align: "right", secondary: true, cell: (s) => <RelTime at={s.createdAt} className="text-muted" /> },
          { key: "actions", header: "", align: "right", cell: (s) => (canRevoke && s.active ? (
            <Button size="sm" variant="secondary" onClick={() => actions.revokeOne.open(s)} data-testid="console-users-revoke-session">Sign out</Button>
          ) : null) },
        ]}
      />
    </div>
  );
}

function Lockout({ d, actions }: { d: ConsoleUserDetail; actions: UserActions }) {
  const l = d.lockout;
  const clearable = actions.can.clearLockout && (l.locked || l.failures > 0);
  return (
    <section data-testid="console-users-lockout">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Password lockout</h2>
        {clearable && <Button variant="secondary" size="sm" onClick={() => actions.clearLockout.open()} data-testid="console-users-clear-lockout-tab">Clear lockout</Button>}
      </div>
      <KvList items={[
        { label: "Password sign in", value: l.locked ? <StatusBadge state="locked" tone="bad" label="Locked" /> : <StatusBadge state="ok" label="Not locked" />, hint: l.lockedUntil ? <>The lock ends <RelTime at={l.lockedUntil} /> on its own.</> : undefined },
        { label: "Failed attempts", value: String(l.failures), hint: l.windowStart ? <>Counting since <RelTime at={l.windowStart} /></> : undefined },
      ]} />
    </section>
  );
}

export function UserSignInTab({ d, actions }: { d: ConsoleUserDetail; actions: UserActions }) {
  const tf = d.twoFactor;
  const locked = d.lockout.locked;
  return (
    <div className="space-y-5">
      {/* A lock is what needs attention, so it comes first while it is on. */}
      {locked && <Lockout d={d} actions={actions} />}
      <section>
        <h2 className="mb-2 text-[15px] font-semibold">Sign in methods</h2>
        {!d.accounts.length ? (
          <EmptyRow icon={<IconKey />}>No sign in methods. This account has no password or linked sign in. It may be an AI agent.</EmptyRow>
        ) : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="Sign in methods">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>Method</th><th className={T.th}>Provider account</th><th className={`${T.th} text-right`}>Added</th></tr></thead>
              <tbody className={T.body}>
                {d.accounts.map((a) => (
                  <tr key={a.id} className={T.row}>
                    <td className={T.td}>{signInMethodLabel(a.providerId)}{a.providerId !== "credential" && a.hasPassword && <span className="ml-1.5 text-xs text-subtle">(with password)</span>}</td>
                    <td className={`${T.td} font-mono text-[13px] text-muted`}>{a.providerId === "credential" ? "Not shown" : a.accountId}</td>
                    <td className={`${T.td} text-right text-muted`}><RelTime at={a.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-subtle">Last signed in with: {signInMethodLabel(d.profile.lastLoginMethod)}</p>
      </section>
      <section>
        <h2 className="mb-2 text-[15px] font-semibold">Two-step sign in</h2>
        <KvList items={[
          { label: "Two-step sign in", value: <TwoStepBadge on={tf.enabled} /> },
          { label: "Authenticator app", value: tf.configured ? (tf.verified === false ? "Set up, not confirmed" : "Set up") : "Not set up" },
          { label: "Failed codes", value: String(tf.failedAttempts) },
          { label: "Code entry locked", value: tf.lockedUntil ? <>Until <RelTime at={tf.lockedUntil} /></> : "No" },
        ]} />
      </section>
      {!locked && <Lockout d={d} actions={actions} />}
    </div>
  );
}
