/** OPS1: the tabs on a person's detail page (Profile, Workspaces, Sessions, Sign in, Lockout). Notes come from NotesPanel. */
import { Link } from "react-router";
import { Badge, Card, EmptyState, tableStyles as T } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconBuilding, IconDevices, IconKey } from "@/web/components/ui/icon";
import { operatorRoleLabel } from "@/shared/operator-permissions";
import { DataTable } from "../components/data-table";
import { KvList } from "../components/kv-list";
import { deviceLabel, signInMethodLabel, type ConsoleUserDetail, type ConsoleUserSession } from "./users-api";
import { When } from "./users-badges";
import type { UserActions } from "./users-actions";

const yes = (v: boolean, onLabel = "Yes", offLabel = "No", offTone: "warn" | "neutral" = "neutral") =>
  v ? <Badge tone="ok" dot>{onLabel}</Badge> : <Badge tone={offTone} dot={offTone !== "neutral"}>{offLabel}</Badge>;

export function UserProfileTab({ d }: { d: ConsoleUserDetail }) {
  const p = d.profile;
  return (
    <KvList items={[
      { label: "Name", value: p.name },
      { label: "Email", value: p.email, copy: true },
      { label: "Email confirmed", value: yes(p.emailVerified, "Confirmed", "Not confirmed", "warn") },
      { label: "Account id", value: p.id, mono: true, copy: true },
      { label: "Operator role", value: p.operator ? operatorRoleLabel(p.role) : "None" },
      { label: "Banned", value: p.banned ? <Badge tone="bad" dot>Banned</Badge> : "No", hint: p.banned ? <>{p.banReason ?? "No reason given"}. {p.banExpires ? <>Ends <When at={p.banExpires} />.</> : "No end date."}</> : undefined },
      { label: "Active sessions", value: String(d.activeSessions) },
      { label: "Time zone", value: p.timezone },
      { label: "Language", value: p.locale },
      { label: "Created", value: <When at={p.createdAt} /> },
      { label: "Last updated", value: <When at={p.updatedAt} /> },
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
        <thead className={T.head}><tr><th className={T.th}>Workspace</th><th className={T.th}>Role</th><th className={T.th}>Plan</th><th className={T.th}>State</th><th className={`${T.th} text-right`}>Joined</th></tr></thead>
        <tbody className={T.body}>
          {d.memberships.map((m) => (
            <tr key={m.memberId} className={T.row}>
              <td className={T.td}><Link to={`/console/workspaces/${m.orgId}`} className="font-medium hover:underline" data-testid="console-users-workspace-link">{m.orgName}</Link></td>
              <td className={T.td}>{ROLE[m.role] ?? m.role}{m.kind === "agent" && <span className="ml-1.5 text-xs text-subtle">(AI agent)</span>}</td>
              <td className={T.td}><span className="capitalize">{m.effectivePlan}</span>{m.effectivePlan !== m.plan && <span className="ml-1.5 text-xs text-subtle">(comp)</span>}</td>
              <td className={T.td}>
                <span className="inline-flex flex-wrap gap-1.5">
                  {m.suspendedAt ? <Badge tone="bad" dot>Suspended</Badge> : <Badge tone="ok" dot>Active</Badge>}
                  {m.isDemo && <Badge>Demo</Badge>}
                </span>
              </td>
              <td className={`${T.td} text-right text-muted`}><When at={m.joinedAt} /></td>
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
              <span className="font-medium" title={s.userAgent ?? undefined}>{deviceLabel(s.userAgent)}</span>
              <span className="text-xs text-subtle">{signInMethodLabel(s.loginMethod)}{s.impersonatedBy ? ", opened by an operator" : ""}</span>
            </span>
          ) },
          { key: "ip", header: "IP address", cell: (s) => <span className="font-mono text-[13px] text-muted">{s.ipAddress ?? "Unknown"}</span> },
          { key: "active", header: "Last active", cell: (s) => <When at={s.updatedAt} /> },
          { key: "state", header: "State", cell: (s) => (s.active ? <Badge tone="ok" dot>Active</Badge> : <Badge>Expired</Badge>) },
          { key: "started", header: "Started", align: "right", cell: (s) => <span className="text-muted"><When at={s.createdAt} /></span> },
          { key: "actions", header: "", align: "right", cell: (s) => (canRevoke && s.active ? (
            <Button size="sm" variant="ghost" onClick={() => actions.revokeOne.open(s)} data-testid="console-users-revoke-session">Sign out</Button>
          ) : null) },
        ]}
      />
    </div>
  );
}

export function UserSignInTab({ d }: { d: ConsoleUserDetail }) {
  const tf = d.twoFactor;
  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-2 text-[13px] font-semibold">Sign in methods</h2>
        {!d.accounts.length ? (
          <Card className="p-0"><EmptyState icon={<IconKey />} title="No sign in methods" body="This account has no password or linked sign in. It may be an AI agent." /></Card>
        ) : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="Sign in methods">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>Method</th><th className={T.th}>Provider account</th><th className={`${T.th} text-right`}>Added</th></tr></thead>
              <tbody className={T.body}>
                {d.accounts.map((a) => (
                  <tr key={a.id} className={T.row}>
                    <td className={T.td}>{signInMethodLabel(a.providerId)}{a.providerId !== "credential" && a.hasPassword && <span className="ml-1.5 text-xs text-subtle">(with password)</span>}</td>
                    <td className={`${T.td} font-mono text-[13px] text-muted`}>{a.providerId === "credential" ? "Not shown" : a.accountId}</td>
                    <td className={`${T.td} text-right text-muted`}><When at={a.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-subtle">Last signed in with: {signInMethodLabel(d.profile.lastLoginMethod)}</p>
      </section>
      <section>
        <h2 className="mb-2 text-[13px] font-semibold">Two-step sign in</h2>
        <KvList items={[
          { label: "Two-step sign in", value: yes(tf.enabled, "On", "Off") },
          { label: "Authenticator app", value: tf.configured ? (tf.verified === false ? "Set up, not confirmed" : "Set up") : "Not set up" },
          { label: "Failed codes", value: String(tf.failedAttempts) },
          { label: "Code entry locked", value: tf.lockedUntil ? <>Until <When at={tf.lockedUntil} /></> : "No" },
        ]} />
      </section>
    </div>
  );
}

export function UserLockoutTab({ d, actions }: { d: ConsoleUserDetail; actions: UserActions }) {
  const l = d.lockout;
  return (
    <div className="space-y-3">
      <KvList items={[
        { label: "Password sign in", value: l.locked ? <Badge tone="bad" dot>Locked</Badge> : <Badge tone="ok" dot>Not locked</Badge>, hint: l.lockedUntil ? <>The lock ends <When at={l.lockedUntil} /> on its own.</> : undefined },
        { label: "Failed attempts", value: String(l.failures), hint: l.windowStart ? <>Counting since <When at={l.windowStart} /></> : undefined },
      ]} />
      {actions.can.clearLockout && (l.locked || l.failures > 0) && (
        <Button variant="secondary" onClick={() => actions.clearLockout.open()} data-testid="console-users-clear-lockout-tab">Clear lockout</Button>
      )}
    </div>
  );
}
