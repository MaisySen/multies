import { useConfig } from "@/web/lib/queries"; // R126
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { IconAgent, IconAssign, IconClock, IconTeam, IconUserCheck, IconCrown, IconEdit, IconKey, IconLink, IconLock, IconMail, IconMore, IconPause, IconPlay, IconPlus, IconRefresh, IconShield, IconTrash, IconUserMinus, IconZap } from "@/web/components/ui/icon";
import { AgentTriggersDialog } from "./agent-triggers"; // R28 (DF-3 slice 3)
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { api, ApiError } from "@/web/lib/api";
import { qk, useMailboxes, useMe, useTeam } from "@/web/lib/queries";
import { teamPickable } from "@/web/lib/mail-level-priv1b"; // PRIV1b (P24, P66)
import type { InviteCreated, Mailbox, PendingInvite, Role, TeamMember } from "@/web/lib/types";
import { Avatar, Badge, Card, CopyButton, EmptyState, Meter, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { ConfirmButton } from "@/web/components/ui/confirm";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { initials, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { HeadlineTile } from "@/web/components/premium5-r39";
import { teamHeadline } from "@/web/lib/premium5-r39";
import { NoContactsArt } from "@/web/components/illustrations";

const ROLE_COPY: Record<Role, string> = {
  owner: "Owns the workspace and billing. Manages everyone.",
  admin: "Manages domains, mailboxes, members and settings. Opens every mailbox.",
  member: "Reads and sends from the mailboxes you choose.",
};

function RoleBadge({ role }: { role: Role }) {
  if (role === "owner") return <Badge tone="brand"><IconCrown className="h-3 w-3" />Owner</Badge>;
  if (role === "admin") return <Badge tone="ok"><IconShield className="h-3 w-3" />Admin</Badge>;
  return <Badge>Member</Badge>;
}

/** Business plan: members must sign in through SSO. The owner keeps password access as break glass. */
function SsoEnforcement({ required }: { required: boolean }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.put("/org/sso", { required: next }),
    onSuccess: (_r, next) => { qc.invalidateQueries({ queryKey: qk.me }); toast.success(next ? "Members now sign in with SSO" : "SSO is optional again"); },
    onError: (e) => showError(e),
  });
  return (
    <Card className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="text-sm font-medium">Require single sign on</h2>
        <p className="mt-0.5 text-xs text-muted">Members and admins must sign in through your SSO provider. You, the owner, keep password sign in for emergencies.</p>
      </div>
      <Button size="sm" variant={required ? "secondary" : "primary"} loading={toggle.isPending} onClick={() => toggle.mutate(!required)}>{required ? "Turn off" : "Require SSO"}</Button>
    </Card>
  );
}

export function TeamSettings() {
  const team = useTeam();
  const me = useMe();
  // PRIV1b (P24, P66): access is granted on team mailboxes only; someone's personal mailbox is never offered here.
  const mailboxes = useMailboxes();
  const grantable = teamPickable(mailboxes.data);
  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState<(InviteCreated & { email: string }) | null>(null);
  const myRole = me.data?.organization?.role ?? "member";
  const peopleOn = !!useConfig().data?.peopleR126; // R126
  const canManage = myRole !== "member";
  // R41 (MB-220 follow up): the demo can't send invites (the server answers demo_invites_off); say so before anyone tries.
  const isDemo = !!me.data?.organization?.isDemo;

  if (team.isPending) return <Card className="p-6"><Skeleton className="h-5 w-40" /><Skeleton className="mt-4 h-12" /><Skeleton className="mt-2 h-12" /></Card>;
  if (team.error) return <Card className="p-6 text-sm text-bad">{team.error.message}</Card>;
  const { invites, seats } = team.data;
  const members = team.data.members.filter((m) => m.kind !== "agent");
  const agentMembers = team.data.members.filter((m) => m.kind === "agent");
  const used = seats.members + seats.pendingInvites;
  const head = teamHeadline({ members: seats.members, pendingInvites: seats.pendingInvites, limit: seats.limit });

  return (
    <div className="space-y-6">
      {/* R39 premium pass 5: three headline numbers before the lists. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 max-sm:[&>*:last-child:nth-child(odd)]:col-span-2" data-testid="team-headline">
        <HeadlineTile icon={<IconTeam />} value={head.people} label={head.people === 1 ? "Person" : "People"} />
        <HeadlineTile icon={<IconClock />} value={head.pending} label="Invites pending" tone={head.pending ? "warn" : "neutral"} />
        <HeadlineTile icon={<IconUserCheck />} value={head.seatsLeft} label="Seats left" tone={head.seatsLeft ? "ok" : "warn"} />
      </div>
      {peopleOn && myRole !== "member" && (
        <Card className="flex flex-wrap items-center gap-3 p-5" data-testid="team-onboarding">{/* R126 */}
          <div className="min-w-0 flex-1"><h2 className="text-[15px] font-semibold">Onboarding and offboarding</h2><p className="mt-1 text-sm text-muted">Checklists that turn into tasks when you assign them to someone from their staff profile.</p></div>
          <Link to="/app/settings/team/onboarding" className="inline-flex h-9 items-center rounded-lg border border-line-strong px-3.5 text-sm hover:bg-hover max-sm:min-h-11">Open checklists</Link>
        </Card>
      )}
      <Card>
        <div className="flex flex-col gap-4 border-b border-line p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[15px] font-semibold">Members</h2>
            <p className="mt-1 text-sm text-muted">People who can sign in to this workspace. Members only see the mailboxes you give them.</p>
            {/* R82F (MB-277): at the seat limit, say so in words anyone can see (a hover title never shows on a phone). */}
            {!isDemo && canManage && used >= seats.limit && (
              <p id="seats-full" role="status" className="mt-2 inline-flex flex-wrap items-start gap-x-1.5 gap-y-1 rounded-lg bg-warn-soft px-2.5 py-1.5 text-[12.5px] text-fg" data-testid="seats-full">
                <IconLock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />
                <span>All {seats.limit} seats are in use{seats.pendingInvites ? `, ${seats.pendingInvites} by pending ${seats.pendingInvites === 1 ? "invite" : "invites"}` : ""}. To invite someone, {seats.pendingInvites ? "cancel an invite or remove someone" : "remove someone"}, or <Link to="/app/settings/billing" className="font-medium text-brand-hover underline-offset-2 hover:underline">see plans with more seats</Link>.</span>
              </p>
            )}
            {isDemo && canManage && <p id="demo-invites-off" className="mt-2 inline-flex items-start gap-1.5 rounded-lg bg-fill px-2.5 py-1.5 text-[12.5px] text-muted" data-testid="demo-invites-off"><IconLock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{DEMO_INVITES_OFF_COPY}</p>}
          </div>
          <div className="flex items-center gap-4">
            <div className="w-36">
              <div className="mb-1.5 flex justify-between text-xs text-muted"><span>Seats</span><span className="tabular-nums">{used} / {seats.limit}</span></div>
              <Meter value={used} max={seats.limit} />
              <div className="mt-1.5 text-xs text-subtle tabular-nums" data-testid="agent-seats">{agentMembers.length} agent{agentMembers.length === 1 ? "" : "s"}, no seat needed</div>
            </div>
            {canManage && <Button onClick={() => setInviting(true)} disabled={isDemo || used >= seats.limit} aria-describedby={isDemo ? "demo-invites-off" : used >= seats.limit ? "seats-full" : undefined} title={isDemo ? DEMO_INVITES_OFF_COPY : used >= seats.limit ? "All seats are in use" : undefined} data-testid="team-invite-button"><IconAssign className="h-4 w-4" />Invite</Button>}
          </div>
        </div>
        <ul className="divide-y divide-line" aria-label="Members">
          {members.map((m) => <MemberRow key={m.userId} m={m} myRole={myRole} myId={me.data?.user.id ?? ""} mailboxes={grantable} />)}
        </ul>
      </Card>

      <AgentsCard agents={agentMembers} limit={team.data.agentMembers?.limit ?? 10} canManage={canManage} myId={me.data?.user.id ?? ""} />

      {canManage && (
        <Card>
          <div className="border-b border-line p-5">
            <h2 className="text-[15px] font-semibold">Pending invitations</h2>
            <p className="mt-1 text-sm text-muted">Invitation links work for 7 days and can be used once, only by the invited address.</p>
          </div>
          {invites.length === 0 ? (
            <EmptyState className="py-10" icon={<IconMail />} art={<NoContactsArt />} title="No pending invitations" body="Invite a teammate and they'll show up here until they join." />
          ) : (
            <ul className="divide-y divide-line">
              {invites.map((i) => <InviteRow key={i.id} inv={i} onReissued={(r) => setCreated({ ...r, email: i.email })} />)}
            </ul>
          )}
        </Card>
      )}

      {myRole === "owner" && <SsoEnforcement required={!!me.data?.organization?.requireSso} />}

      <InviteDialog open={inviting} demo={isDemo} onClose={() => setInviting(false)} myRole={myRole} mailboxes={grantable}
        onCreated={(r) => { setInviting(false); setCreated(r); }} />
      <Dialog open={!!created} onClose={() => setCreated(null)} title="Invitation ready"
        description={created?.emailed ? `We emailed ${created.email}. You can also share the link yourself.` : `We couldn't email this invite. Copy the link instead and send it to ${created?.email} yourself.`}
        footer={<Button onClick={() => setCreated(null)}>Done</Button>}>
        {created && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface p-2 pl-3">
            <IconLink className="h-4 w-4 shrink-0 text-subtle" />
            <code className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="invite-link">{created.link}</code>
            <CopyButton value={created.link} label="Copy link" />
          </div>
        )}
        {created && !created.emailed && created.emailDetail && <p className="mt-2 text-xs text-muted" data-testid="invite-not-emailed">{created.emailDetail}</p>}
        <p className="mt-3 text-xs text-subtle">For your security this link is shown once. Resend the invitation to get a fresh one.</p>
      </Dialog>
    </div>
  );
}

function accessSummary(m: TeamMember, mailboxes: Mailbox[]) {
  if (m.mailboxIds === null) return "All mailboxes";
  if (m.mailboxIds.length === 0) return "No mailboxes yet";
  const names = m.mailboxIds.map((id) => mailboxes.find((b) => b.id === id)?.address).filter(Boolean);
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

function MemberRow({ m, myRole, myId, mailboxes }: { m: TeamMember; myRole: Role; myId: string; mailboxes: Mailbox[] }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [profiling, setProfiling] = useState(false);
  const self = m.userId === myId;
  const canProfile = self || (myRole === "owner") || (myRole === "admin" && m.role !== "owner");
  const canEdit = !self && m.role !== "owner" && (myRole === "owner" || (myRole === "admin" && m.role === "member"));
  const setRole = useMutation({
    mutationFn: (role: "admin" | "member") => api.patch(`/team/members/${m.userId}`, { role }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.team }); toast.success(`${m.name} updated`); },
    onError: (e) => showError(e),
  });
  return (
    <li className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-hover/40 max-sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar label={initials(m.name)} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium"><span className="truncate">{m.name}</span>{self && <span className="text-xs font-normal text-subtle">(you)</span>}
            {m.agentInbox && <span title="This member's address is an AI agent's inbox, so an AI joined as a person. Remove them, then add the agent in Agents." data-testid="member-agent-inbox"><Badge tone="warn"><IconAgent className="h-3 w-3" />AI</Badge></span>}</div>
          <div className="truncate text-xs text-muted">{m.title ? <><span className="text-fg/80">{m.title}</span> · </> : null}{m.email}</div>
          {m.bio && <div className="mt-0.5 line-clamp-2 text-xs text-subtle">{m.bio}</div>}
          <div className="mt-0.5 text-[11px] text-subtle lg:hidden" data-testid="member-last-active">{m.lastActiveAt ? `Active ${timeAgo(m.lastActiveAt)}` : "Not signed in yet"}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-4">
        <div className="hidden w-48 truncate text-xs text-muted md:block" title={accessSummary(m, mailboxes)}>{accessSummary(m, mailboxes)}</div>
        <div className="hidden w-24 text-xs text-subtle lg:block">{m.lastActiveAt ? `Active ${timeAgo(m.lastActiveAt)}` : "Not signed in"}</div>
        <div className="sm:w-24"><RoleBadge role={m.role} /></div>
        <div className="w-8 max-sm:w-11">
          {(canEdit || canProfile) && (
            <Menu label={`Actions for ${m.name}`} trigger={<button className="grid place-items-center rounded-md p-1.5 text-subtle transition-colors hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11" aria-label={`Actions for ${m.name}`}><IconMore className="h-4 w-4" /></button>}>
              {canProfile && <MenuItem icon={<IconEdit />} onSelect={() => setProfiling(true)}>Edit title and bio</MenuItem>}
              {canEdit && m.role === "member" && <MenuItem icon={<IconMail />} onSelect={() => setEditing(true)}>Mailbox access</MenuItem>}
              {canEdit && myRole === "owner" && m.role === "member" && <MenuItem icon={<IconShield />} onSelect={() => setRole.mutate("admin")}>Make admin</MenuItem>}
              {canEdit && myRole === "owner" && m.role === "admin" && <MenuItem icon={<IconUserMinus />} onSelect={() => setRole.mutate("member")}>Make member</MenuItem>}
              {myRole === "owner" && !self && <MenuItem icon={<IconCrown />} onSelect={() => setTransferring(true)}>Transfer ownership</MenuItem>}
              {(canEdit || (self && m.role !== "owner")) && <MenuItem icon={<IconTrash />} danger onSelect={() => setRemoving(true)}>{self ? "Leave workspace" : "Remove"}</MenuItem>}
            </Menu>
          )}
        </div>
      </div>
      <AccessDialog open={editing} onClose={() => setEditing(false)} member={m} mailboxes={mailboxes} />
      <RemoveDialog open={removing} onClose={() => setRemoving(false)} member={m} self={self} />
      <TransferDialog open={transferring} onClose={() => setTransferring(false)} member={m} />
      {profiling && <ProfileDialog onClose={() => setProfiling(false)} member={m} />}
    </li>
  );
}

function MailboxPicker({ mailboxes, value, onChange }: { mailboxes: Mailbox[]; value: string[]; onChange: (v: string[]) => void }) {
  if (!mailboxes.length) return <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">No mailboxes yet. You can grant access after you create some.</p>;
  return (
    <fieldset className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line p-1.5">
      <legend className="sr-only">Mailboxes</legend>
      {mailboxes.map((b) => {
        const on = value.includes(b.id);
        return (
          <label key={b.id} className={cn("flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-hover", on && "bg-fill/60")}>
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={on} onChange={() => onChange(on ? value.filter((v) => v !== b.id) : [...value, b.id])} />
            <span className="truncate">{b.address}</span>
            <span className="ml-auto truncate text-xs text-subtle">{b.displayName}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** R41: shown on the disabled Invite button and inside the invite dialog in a demo workspace. */
export const DEMO_INVITES_OFF_COPY = "Invites are off in the demo. Create your own workspace to invite your team.";

/** R41: the invite dialog's body in a demo workspace: the reason and the way out, instead of a form that would fail. */
function DemoInvitesOff({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="invite-demo-off">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-soft text-brand-hover" aria-hidden><IconLock className="h-5 w-5" /></span>
      <p className="max-w-xs text-[15px] font-medium leading-snug">{DEMO_INVITES_OFF_COPY}</p>
      <p className="max-w-xs text-sm text-muted">Everything else in the demo works, so look around first. Your own workspace keeps your team, mail and tasks.</p>
      <div className="mt-1 flex gap-2">
        <Button variant="secondary" onClick={onClose}>Keep exploring</Button>
        <a href="/signup" className="inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-brand-press max-sm:h-11">Create your workspace</a>
      </div>
    </div>
  );
}

function InviteDialog({ open, onClose, myRole, mailboxes, onCreated, demo }: { open: boolean; onClose: () => void; demo?: boolean; myRole: Role; mailboxes: Mailbox[]; onCreated: (r: InviteCreated & { email: string }) => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [ids, setIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [bio, setBio] = useState("");
  const invite = useMutation({
    mutationFn: () => api.create<InviteCreated>("/team/invites", { email, role, mailboxIds: role === "member" ? ids : [], ...(title.trim() ? { title } : {}), ...(bio.trim() ? { bio } : {}) }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: qk.team }); onCreated({ ...r, email: email.toLowerCase() }); setEmail(""); setIds([]); setRole("member"); setTitle(""); setBio(""); },
  });
  const err = invite.error instanceof ApiError ? invite.error : null;
  if (demo || err?.code === "demo_invites_off") return <Dialog open={open} onClose={onClose} title="Invite a teammate"><DemoInvitesOff onClose={onClose} /></Dialog>;
  return (
    <Dialog open={open} onClose={onClose} title="Invite a teammate" description="They'll get a link to join this workspace."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={invite.isPending} disabled={!email} onClick={() => invite.mutate()}>Create invitation</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
        {err && !err.fields?.email && <p className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2 text-sm text-bad">{err.message}</p>}
        <Field label="Email" error={err?.fields?.email}>{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" autoFocus />}</Field>
        {/* R39 premium pass 5: the role as two tappable cards, each with one line on what it can do. */}
        <fieldset className="space-y-1.5" data-testid="invite-role">
          <legend className="mb-1.5 text-[13px] font-medium text-fg/90">Role</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["member", "admin"] as const).filter((r) => r === "member" || myRole === "owner").map((r) => (
              <label key={r} className={cn("flex min-h-11 cursor-pointer items-start gap-2.5 rounded-[12px] border p-3 transition-colors duration-150 motion-reduce:transition-none focus-within:ring-2 focus-within:ring-brand",
                role === r ? "border-brand bg-brand-soft" : "border-line hover:bg-hover")}>
                <input type="radio" name="invite-role" value={r} checked={role === r} onChange={() => setRole(r)} className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">{r === "admin" ? <IconShield className="h-3.5 w-3.5" aria-hidden /> : <IconMail className="h-3.5 w-3.5" aria-hidden />}{r === "admin" ? "Admin" : "Member"}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted">{ROLE_COPY[r]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Title" hint="Optional. Shown in People once they join.">{(p) => <Input {...p} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Head of Product" />}</Field>
        <Field label="Bio" hint="Optional. They can change both later.">{(p) => <Textarea {...p} rows={2} value={bio} maxLength={500} onChange={(e) => setBio(e.target.value)} />}</Field>
        {role === "member" && (
          <div className="space-y-1.5">
            <div className="text-[13px] font-medium text-fg/90">Mailbox access</div>
            <MailboxPicker mailboxes={mailboxes} value={ids} onChange={setIds} />
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function AccessDialog({ open, onClose, member, mailboxes }: { open: boolean; onClose: () => void; member: TeamMember; mailboxes: Mailbox[] }) {
  const qc = useQueryClient();
  const [ids, setIds] = useState<string[]>(member.mailboxIds ?? []);
  const save = useMutation({
    // PRIV1b (P24): an old grant on a mailbox not offered here (now personal) is left out, so Save is not refused for it (what the
    // picker shows is what is saved).
    mutationFn: () => api.patch(`/team/members/${member.userId}`, { mailboxIds: ids.filter((id) => mailboxes.some((b) => b.id === id)) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.team }); toast.success("Access updated"); onClose(); },
    onError: (e) => showError(e),
  });
  return (
    <Dialog open={open} onClose={onClose} title={`Mailbox access for ${member.name}`} description="They can read, search and send from these mailboxes only."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!mailboxes.length} onClick={() => save.mutate()}>Save access</Button></>}>
      <MailboxPicker mailboxes={mailboxes} value={ids} onChange={setIds} />
    </Dialog>
  );
}

function RemoveDialog({ open, onClose, member, self }: { open: boolean; onClose: () => void; member: TeamMember; self: boolean }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.del(`/team/members/${member.userId}`),
    onSuccess: () => {
      if (self) { qc.clear(); window.location.assign("/app"); return; }
      qc.invalidateQueries({ queryKey: qk.team }); toast.success(`${member.name} removed`); onClose();
    },
    onError: (e) => showError(e),
  });
  return (
    <Dialog open={open} onClose={onClose} title={self ? "Leave this workspace?" : `Remove ${member.name}?`}
      description={self ? "You'll lose access to its mailboxes until someone invites you again." : "They're signed out of this workspace right away. Their mail stays in the mailboxes."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>{self ? "Leave" : "Remove"}</Button></>} />
  );
}

function TransferDialog({ open, onClose, member }: { open: boolean; onClose: () => void; member: TeamMember }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const transfer = useMutation({
    mutationFn: () => api.post("/team/transfer", { userId: member.userId, password }),
    onSuccess: () => { qc.invalidateQueries(); toast.success(`${member.name} now owns this workspace`); onClose(); },
  });
  return (
    <Dialog open={open} onClose={onClose} title={`Make ${member.name} the owner?`} description="You'll become an admin. Only the new owner can change billing or transfer ownership again."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={transfer.isPending} disabled={!password} onClick={() => transfer.mutate()}>Transfer ownership</Button></>}>
      <Field label="Confirm with your password" error={transfer.error?.message}>{(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
    </Dialog>
  );
}

function InviteRow({ inv, onReissued }: { inv: PendingInvite; onReissued: (r: InviteCreated) => void }) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.del(`/team/invites/${inv.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.team }); toast.success("Invitation revoked"); },
  });
  const resend = useMutation({
    mutationFn: () => api.post<InviteCreated>(`/team/invites/${inv.id}/resend`),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: qk.team }); onReissued(r); },
    onError: (e) => showError(e),
  });
  // AIS1: an invite an API key or a connected app made sends nothing until a person here confirms it.
  const confirm = useMutation({
    mutationFn: () => api.post<InviteCreated>(`/team/invites/${inv.id}/confirm`),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: qk.team }); onReissued(r); },
    onError: (e) => showError(e),
  });
  const held = !!inv.awaitingApproval;
  return (
    <li className="flex flex-col gap-3 px-5 py-3.5 transition-colors hover:bg-hover/40 sm:flex-row sm:items-center max-sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-dashed border-line-strong text-subtle"><IconMail className="h-3.5 w-3.5" /></div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{inv.email}{inv.title && <span className="font-normal text-muted"> · {inv.title}</span>}</div>
          <div className="text-xs text-muted">{held ? "Made by an API key or app. Not sent until you confirm it." : inv.expired ? "Expired" : `Expires ${timeAgo(inv.expiresAt)}`}{inv.invitedByName ? ` · invited by ${inv.invitedByName}` : ""}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 pl-11 sm:pl-0">
        {held && <Badge tone="warn">Needs you</Badge>}
        <RoleBadge role={inv.role} />
        {held
          ? <Button size="sm" loading={confirm.isPending} onClick={() => confirm.mutate()} aria-label={`Confirm and send the invitation for ${inv.email}`} data-testid="invite-confirm"><IconUserCheck className="h-3.5 w-3.5" />Confirm and send</Button>
          : <Button size="sm" variant="secondary" loading={resend.isPending} onClick={() => resend.mutate()}><IconRefresh className="h-3.5 w-3.5" />{inv.expired ? "Renew" : "New link"}</Button>}
        <ConfirmButton armedLabel="Revoke?" loading={revoke.isPending} onConfirm={() => revoke.mutate()} aria-label={`Revoke invitation for ${inv.email}`}><IconTrash className="h-3.5 w-3.5" /></ConfirmButton>
      </div>
    </li>
  );
}

/** Title and bio for anyone; an agent member's name too. */
function ProfileDialog({ onClose, member }: { onClose: () => void; member: TeamMember }) {
  const qc = useQueryClient();
  const agent = member.kind === "agent";
  const [name, setName] = useState(member.name);
  const [title, setTitle] = useState(member.title ?? "");
  const [bio, setBio] = useState(member.bio ?? "");
  const save = useMutation({
    mutationFn: () => api.patch(`/team/people/${member.userId}`, { title, bio, ...(agent ? { name } : {}) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.team }); toast.success("Profile saved"); onClose(); },
    onError: (e) => showError(e),
  });
  return (
    <Dialog open onClose={onClose} title={`Profile for ${member.name}`} description="Shown in People and on the member card."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={agent && !name.trim()} onClick={() => save.mutate()}>Save</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {agent && <Field label="Name">{(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}</Field>}
        <Field label="Title" hint="For example Head of Product.">{(p) => <Input {...p} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Bio">{(p) => <Textarea {...p} rows={3} value={bio} maxLength={500} onChange={(e) => setBio(e.target.value)} />}</Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

type AgentCreated = { member: { userId: string; name: string }; secret: string };
type AgentExtra = { userId: string; avatar: { color: string; initials: string }; disabled: boolean; inbox: { agentId: string; address: string } | null; keys: number };

/** AI agent members: no seat, no mailbox, their own API keys. */
function AgentsCard({ agents, limit, canManage, myId }: { agents: TeamMember[]; limit: number; canManage: boolean; myId: string }) {
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  // R26 (DF-3): avatar colour, paused state and linked inbox per agent member.
  const extras = useQuery({ queryKey: [...qk.team, "agents"], queryFn: async () => (await api.get<{ agents: AgentExtra[] }>("/team/agents")).agents, enabled: agents.length > 0 });
  const extraOf = (id: string) => extras.data?.find((x) => x.userId === id);
  if (!canManage && !agents.length) return null;
  return (
    <Card>
      <div className="flex flex-col gap-4 border-b border-line p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold">AI agents</h2>
          <p className="mt-1 text-sm text-muted">Agents post, comment and take tasks with their own API key. They take no seat and need no mailbox.</p>
        </div>
        {canManage && (
          <div className="flex items-center gap-4">
            <div className="w-36">
              <div className="mb-1.5 flex justify-between text-xs text-muted"><span>Agents</span><span className="tabular-nums">{agents.length} / {limit}</span></div>
              <Meter value={agents.length} max={limit} />
            </div>
            <Button onClick={() => setAdding(true)} disabled={agents.length >= limit} title={agents.length >= limit ? "Your plan's agent limit is reached" : undefined}><IconPlus className="h-4 w-4" />Add agent</Button>
          </div>
        )}
      </div>
      {agents.length === 0 ? (
        <EmptyState className="py-10" icon={<IconAgent />} title="No agents yet" body="Add an agent with a title and a short bio, then give its key to the tool that runs it." />
      ) : (
        <ul className="divide-y divide-line" aria-label="AI agents">
          {agents.map((a) => <AgentRow key={a.userId} a={a} extra={extraOf(a.userId)} canManage={canManage} self={a.userId === myId} onKey={(s) => setSecret({ name: a.name, secret: s })} />)}
        </ul>
      )}
      {adding && <AddAgentDialog onClose={() => setAdding(false)} onCreated={(r) => { setAdding(false); setSecret({ name: r.member.name, secret: r.secret }); }} />}
      <Dialog open={!!secret} onClose={() => setSecret(null)} title={`API key for ${secret?.name ?? ""}`} description="Copy it now. For your security it is shown once."
        footer={<Button onClick={() => setSecret(null)}>Done</Button>}>
        {secret && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface p-2 pl-3">
            <IconKey className="h-4 w-4 shrink-0 text-subtle" />
            <code className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="agent-key">{secret.secret}</code>
            <CopyButton value={secret.secret} label="Copy key" />
          </div>
        )}
        <p className="mt-3 text-xs text-subtle">Send it as Authorization: Bearer on the REST API or the MCP server. It acts as this agent with the member role.</p>
      </Dialog>
    </Card>
  );
}

function AgentRow({ a, extra, canManage, self, onKey }: { a: TeamMember; extra?: AgentExtra; canManage: boolean; self: boolean; onKey: (secret: string) => void }) {
  const qc = useQueryClient();
  const paused = !!extra?.disabled;
  const pause = useMutation({
    mutationFn: () => api.patch(`/team/agents/${a.userId}`, { disabled: !paused }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.team }); toast.success(paused ? `${a.name} resumed` : `${a.name} paused. Its keys stop working until you resume it.`); },
    onError: (e) => showError(e),
  });
  const [profiling, setProfiling] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [triggers, setTriggers] = useState(false);
  const newKey = useMutation({
    mutationFn: () => api.post<{ secret: string }>(`/team/agents/${a.userId}/keys`, {}),
    onSuccess: (r) => onKey(r.secret),
    onError: (e) => showError(e),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/team/members/${a.userId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.team }); toast.success(`${a.name} removed`); setRemoving(false); },
    onError: (e) => showError(e),
  });
  return (
    <li className="flex items-start gap-3 px-5 py-3.5" data-testid="agent-member">
      {extra
        ? <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white", paused && "opacity-50")} style={{ background: extra.avatar.color }} aria-hidden>{extra.avatar.initials}</span>
        : <Avatar label={initials(a.name)} />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="truncate">{a.name}</span>
          <Badge tone="brand"><IconAgent className="h-3 w-3" />AI agent</Badge>
          {paused && <span data-testid="agent-paused"><Badge>Paused</Badge></span>}
          {extra?.inbox && <span className="inline-flex items-center gap-1 text-xs font-normal text-muted"><IconMail className="h-3 w-3" aria-hidden />{extra.inbox.address}</span>}
        </div>
        {a.title && <div className="truncate text-xs text-fg/80">{a.title}</div>}
        {a.bio && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{a.bio}</div>}
        <div className="mt-0.5 text-xs text-subtle">{a.lastActiveAt ? `Active ${timeAgo(a.lastActiveAt)}` : `Added ${timeAgo(a.joinedAt)}`}</div>
      </div>
      {(canManage || self) && (
        <Menu label={`Actions for ${a.name}`} trigger={<button className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg" aria-label={`Actions for ${a.name}`}><IconMore className="h-4 w-4" /></button>}>
          <MenuItem icon={<IconEdit />} onSelect={() => setProfiling(true)}>Edit profile</MenuItem>
          {canManage && <MenuItem icon={<IconKey />} onSelect={() => newKey.mutate()}>New API key</MenuItem>}
          {canManage && <MenuItem icon={<IconZap />} onSelect={() => setTriggers(true)}>Triggers</MenuItem>}
          {canManage && <MenuItem icon={paused ? <IconPlay /> : <IconPause />} onSelect={() => pause.mutate()}>{paused ? "Resume" : "Pause"}</MenuItem>}
          {canManage && <MenuItem icon={<IconTrash />} danger onSelect={() => setRemoving(true)}>Remove</MenuItem>}
        </Menu>
      )}
      {profiling && <ProfileDialog onClose={() => setProfiling(false)} member={a} />}
      {triggers && <AgentTriggersDialog agentUserId={a.userId} agentName={a.name} onClose={() => setTriggers(false)} />}
      <Dialog open={removing} onClose={() => setRemoving(false)} title={`Remove ${a.name}?`} description="Its API keys stop working at once. What it posted stays, under its name."
        footer={<><Button variant="secondary" onClick={() => setRemoving(false)}>Cancel</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button></>} />
    </li>
  );
}

function AddAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (r: AgentCreated) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [bio, setBio] = useState("");
  const [scope, setScope] = useState<"full" | "read">("full");
  const add = useMutation({
    mutationFn: () => api.post<AgentCreated>("/team/agents", { name, title, bio, scope }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: qk.team }); onCreated(r); },
  });
  return (
    <Dialog open onClose={onClose} title="Add an AI agent" description="It joins People with its own API key. No seat and no mailbox needed."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={add.isPending} disabled={!name.trim()} onClick={() => add.mutate()}>Add agent</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(); }}>
        {add.error && <p className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2 text-sm text-bad">{add.error.message}</p>}
        <Field label="Name">{(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Builder" autoFocus />}</Field>
        <Field label="Title">{(p) => <Input {...p} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Engineering lead" />}</Field>
        <Field label="Bio">{(p) => <Textarea {...p} rows={3} value={bio} maxLength={500} onChange={(e) => setBio(e.target.value)} placeholder="What it does and who it reports to." />}</Field>
        <Field label="Key access" hint={scope === "full" ? "Reads and writes tasks, projects, docs, chat, meetings and goals." : "Reads only."}>
          {(p) => (
            <Select {...p} value={scope} onChange={(e) => setScope(e.target.value as "full" | "read")}>
              <option value="full">Read and write</option>
              <option value="read">Read only</option>
            </Select>
          )}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
