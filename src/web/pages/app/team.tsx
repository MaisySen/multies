import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Crown, KeyRound, Link2, Mail, MoreHorizontal, Pause, Pencil, Play, Plus, RefreshCw, Shield, Trash2, UserMinus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { api, ApiError } from "@/web/lib/api";
import { qk, useMailboxes, useMe, useTeam } from "@/web/lib/queries";
import type { InviteCreated, Mailbox, PendingInvite, Role, TeamMember } from "@/web/lib/types";
import { Avatar, Badge, Card, CopyButton, EmptyState, Meter, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { initials, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";

const ROLE_COPY: Record<Role, string> = {
  owner: "Owns the workspace and billing. Manages everyone.",
  admin: "Manages domains, mailboxes, members and settings. Opens every mailbox.",
  member: "Reads and sends from the mailboxes you choose.",
};

function RoleBadge({ role }: { role: Role }) {
  if (role === "owner") return <Badge tone="brand"><Crown className="h-3 w-3" />Owner</Badge>;
  if (role === "admin") return <Badge tone="ok"><Shield className="h-3 w-3" />Admin</Badge>;
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
  const mailboxes = useMailboxes();
  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState<(InviteCreated & { email: string }) | null>(null);
  const myRole = me.data?.organization?.role ?? "member";
  const canManage = myRole !== "member";

  if (team.isPending) return <Card className="p-6"><Skeleton className="h-5 w-40" /><Skeleton className="mt-4 h-12" /><Skeleton className="mt-2 h-12" /></Card>;
  if (team.error) return <Card className="p-6 text-sm text-bad">{team.error.message}</Card>;
  const { invites, seats } = team.data;
  const members = team.data.members.filter((m) => m.kind !== "agent");
  const agentMembers = team.data.members.filter((m) => m.kind === "agent");
  const used = seats.members + seats.pendingInvites;

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-col gap-4 border-b border-line p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[15px] font-semibold">Members</h2>
            <p className="mt-1 text-sm text-muted">People who can sign in to this workspace. Members only see the mailboxes you give them.</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-36">
              <div className="mb-1.5 flex justify-between text-xs text-muted"><span>Seats</span><span className="tabular-nums">{used} / {seats.limit}</span></div>
              <Meter value={used} max={seats.limit} />
              <div className="mt-1.5 text-xs text-subtle tabular-nums" data-testid="agent-seats">{agentMembers.length} agent{agentMembers.length === 1 ? "" : "s"}, no seat needed</div>
            </div>
            {canManage && <Button onClick={() => setInviting(true)} disabled={used >= seats.limit} title={used >= seats.limit ? "All seats are in use" : undefined}><UserPlus className="h-4 w-4" />Invite</Button>}
          </div>
        </div>
        <ul className="divide-y divide-line" aria-label="Members">
          {members.map((m) => <MemberRow key={m.userId} m={m} myRole={myRole} myId={me.data?.user.id ?? ""} mailboxes={mailboxes.data ?? []} />)}
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
            <EmptyState className="py-10" icon={<Mail />} title="No pending invitations" body="Invite a teammate and they'll show up here until they join." />
          ) : (
            <ul className="divide-y divide-line">
              {invites.map((i) => <InviteRow key={i.id} inv={i} onReissued={(r) => setCreated({ ...r, email: i.email })} />)}
            </ul>
          )}
        </Card>
      )}

      {myRole === "owner" && <SsoEnforcement required={!!me.data?.organization?.requireSso} />}

      <InviteDialog open={inviting} onClose={() => setInviting(false)} myRole={myRole} mailboxes={mailboxes.data ?? []}
        onCreated={(r) => { setInviting(false); setCreated(r); }} />
      <Dialog open={!!created} onClose={() => setCreated(null)} title="Invitation ready"
        description={created?.emailed ? `We emailed ${created.email}. You can also share the link yourself.` : `Email delivery isn't connected yet, so share this link with ${created?.email} yourself.`}
        footer={<Button onClick={() => setCreated(null)}>Done</Button>}>
        {created && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface p-2 pl-3">
            <Link2 className="h-4 w-4 shrink-0 text-subtle" />
            <code className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="invite-link">{created.link}</code>
            <CopyButton value={created.link} label="Copy link" />
          </div>
        )}
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
    <li className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar label={initials(m.name)} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium"><span className="truncate">{m.name}</span>{self && <span className="text-xs font-normal text-subtle">(you)</span>}</div>
          <div className="truncate text-xs text-muted">{m.title ? <><span className="text-fg/80">{m.title}</span> · </> : null}{m.email}</div>
          {m.bio && <div className="mt-0.5 line-clamp-2 text-xs text-subtle">{m.bio}</div>}
        </div>
      </div>
      <div className="flex items-center gap-4 pl-11 sm:pl-0">
        <div className="hidden w-48 truncate text-xs text-muted md:block" title={accessSummary(m, mailboxes)}>{accessSummary(m, mailboxes)}</div>
        <div className="hidden w-24 text-xs text-subtle lg:block">{m.lastActiveAt ? `Active ${timeAgo(m.lastActiveAt)}` : "Not signed in"}</div>
        <div className="w-24"><RoleBadge role={m.role} /></div>
        <div className="w-8">
          {(canEdit || canProfile) && (
            <Menu label={`Actions for ${m.name}`} trigger={<button className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg" aria-label={`Actions for ${m.name}`}><MoreHorizontal className="h-4 w-4" /></button>}>
              {canProfile && <MenuItem icon={<Pencil />} onSelect={() => setProfiling(true)}>Edit title and bio</MenuItem>}
              {canEdit && m.role === "member" && <MenuItem icon={<Mail />} onSelect={() => setEditing(true)}>Mailbox access</MenuItem>}
              {canEdit && myRole === "owner" && m.role === "member" && <MenuItem icon={<Shield />} onSelect={() => setRole.mutate("admin")}>Make admin</MenuItem>}
              {canEdit && myRole === "owner" && m.role === "admin" && <MenuItem icon={<UserMinus />} onSelect={() => setRole.mutate("member")}>Make member</MenuItem>}
              {myRole === "owner" && !self && <MenuItem icon={<Crown />} onSelect={() => setTransferring(true)}>Transfer ownership</MenuItem>}
              {(canEdit || (self && m.role !== "owner")) && <MenuItem icon={<Trash2 />} danger onSelect={() => setRemoving(true)}>{self ? "Leave workspace" : "Remove"}</MenuItem>}
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

function InviteDialog({ open, onClose, myRole, mailboxes, onCreated }: { open: boolean; onClose: () => void; myRole: Role; mailboxes: Mailbox[]; onCreated: (r: InviteCreated & { email: string }) => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [ids, setIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [bio, setBio] = useState("");
  const invite = useMutation({
    mutationFn: () => api.post<InviteCreated>("/team/invites", { email, role, mailboxIds: role === "member" ? ids : [], ...(title.trim() ? { title } : {}), ...(bio.trim() ? { bio } : {}) }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: qk.team }); onCreated({ ...r, email: email.toLowerCase() }); setEmail(""); setIds([]); setRole("member"); setTitle(""); setBio(""); },
  });
  const err = invite.error instanceof ApiError ? invite.error : null;
  return (
    <Dialog open={open} onClose={onClose} title="Invite a teammate" description="They'll get a link to join this workspace."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={invite.isPending} disabled={!email} onClick={() => invite.mutate()}>Create invitation</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
        {err && !err.fields?.email && <p className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2 text-sm text-bad">{err.message}</p>}
        <Field label="Email" error={err?.fields?.email}>{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" autoFocus />}</Field>
        <Field label="Role" hint={ROLE_COPY[role]}>
          {(p) => (
            <Select {...p} value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")}>
              <option value="member">Member</option>
              {myRole === "owner" && <option value="admin">Admin</option>}
            </Select>
          )}
        </Field>
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
    mutationFn: () => api.patch(`/team/members/${member.userId}`, { mailboxIds: ids }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.team }); toast.success("Access updated"); onClose(); },
    onError: (e) => showError(e),
  });
  return (
    <Dialog open={open} onClose={onClose} title={`Mailbox access for ${member.name}`} description="They can read, search and send from these mailboxes only."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Save access</Button></>}>
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
  return (
    <li className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-dashed border-line-strong text-subtle"><Mail className="h-3.5 w-3.5" /></div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{inv.email}{inv.title && <span className="font-normal text-muted"> · {inv.title}</span>}</div>
          <div className="text-xs text-muted">{inv.expired ? "Expired" : `Expires ${timeAgo(inv.expiresAt)}`}{inv.invitedByName ? ` · invited by ${inv.invitedByName}` : ""}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 pl-11 sm:pl-0">
        <RoleBadge role={inv.role} />
        <Button size="sm" variant="secondary" loading={resend.isPending} onClick={() => resend.mutate()}><RefreshCw className="h-3.5 w-3.5" />{inv.expired ? "Renew" : "New link"}</Button>
        <Button size="sm" variant="ghost" loading={revoke.isPending} onClick={() => revoke.mutate()} aria-label={`Revoke invitation for ${inv.email}`}><Trash2 className="h-3.5 w-3.5" /></Button>
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
            <Button onClick={() => setAdding(true)} disabled={agents.length >= limit} title={agents.length >= limit ? "Your plan's agent limit is reached" : undefined}><Plus className="h-4 w-4" />Add agent</Button>
          </div>
        )}
      </div>
      {agents.length === 0 ? (
        <EmptyState className="py-10" icon={<Bot />} title="No agents yet" body="Add an agent with a title and a short bio, then give its key to the tool that runs it." />
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
            <KeyRound className="h-4 w-4 shrink-0 text-subtle" />
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
          <Badge tone="brand"><Bot className="h-3 w-3" />AI agent</Badge>
          {paused && <span data-testid="agent-paused"><Badge>Paused</Badge></span>}
          {extra?.inbox && <span className="inline-flex items-center gap-1 text-xs font-normal text-muted"><Mail className="h-3 w-3" aria-hidden />{extra.inbox.address}</span>}
        </div>
        {a.title && <div className="truncate text-xs text-fg/80">{a.title}</div>}
        {a.bio && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{a.bio}</div>}
        <div className="mt-0.5 text-xs text-subtle">{a.lastActiveAt ? `Active ${timeAgo(a.lastActiveAt)}` : `Added ${timeAgo(a.joinedAt)}`}</div>
      </div>
      {(canManage || self) && (
        <Menu label={`Actions for ${a.name}`} trigger={<button className="rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg" aria-label={`Actions for ${a.name}`}><MoreHorizontal className="h-4 w-4" /></button>}>
          <MenuItem icon={<Pencil />} onSelect={() => setProfiling(true)}>Edit profile</MenuItem>
          {canManage && <MenuItem icon={<KeyRound />} onSelect={() => newKey.mutate()}>New API key</MenuItem>}
          {canManage && <MenuItem icon={paused ? <Play /> : <Pause />} onSelect={() => pause.mutate()}>{paused ? "Resume" : "Pause"}</MenuItem>}
          {canManage && <MenuItem icon={<Trash2 />} danger onSelect={() => setRemoving(true)}>Remove</MenuItem>}
        </Menu>
      )}
      {profiling && <ProfileDialog onClose={() => setProfiling(false)} member={a} />}
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
