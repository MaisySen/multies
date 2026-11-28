import { useMe } from "@/web/lib/queries";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCheck, IconDevices, IconKey, IconPlus, IconTrash } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { api, ApiError } from "@/web/lib/api";
import { useOpenableMailboxes } from "@/web/lib/queries";
import { CopyButton, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { timeAgo } from "@/web/lib/format";
import { Section } from "./settings";
import { LoadError } from "@/web/components/load-error-t1g";

interface Endpoint { host: string; port: number; security: "ssl" | "starttls" }
interface MailAccess { enabled: boolean; missing: string[]; imap: Endpoint; smtp: Endpoint }
interface AppPassword { id: string; mailboxId: string; name: string; hint: string; createdAt: string }
interface Created { appPassword: AppPassword; secret: string; username: string; settings: MailAccess }

const securityLabel = (s: Endpoint["security"]) => (s === "ssl" ? "SSL/TLS" : "STARTTLS");

export function MailAppsSettings() {
  const access = useQuery({ queryKey: ["mail-access"], queryFn: () => api.get<MailAccess>("/mail-access") });
  if (access.isPending) return <Skeleton className="h-48" />;
  if (access.isError && !access.data) {
    return <Section title="Mail apps" description="Outlook, Apple Mail, Thunderbird and phone apps."><LoadError compact onRetry={() => access.refetch()} /></Section>;
  }
  if (!access.data?.enabled) return <NotConnected missing={access.data?.missing ?? []} />;
  return <Connected access={access.data} />;
}

function NotConnected({ missing }: { missing: string[] }) {
  const me = useMe();
  return (
    <Section title="Mail apps" description="Outlook, Apple Mail, Thunderbird and phone apps.">
      <div className="text-sm">
        <p className="font-medium">Coming soon</p>
        <p className="mt-1 text-muted">Reading and sending from mail apps isn't available yet. Use Multies in your browser on any device for now; it works on phones too.</p>
        {me.data?.user.platformAdmin && (
          <p className="mt-2 text-[12px] text-subtle">Operator: this needs the Stalwart mail server{missing.length ? ` (${missing.join(", ")})` : ""}.</p>
        )}
      </div>
    </Section>
  );
}

function Connected({ access }: { access: MailAccess }) {
  const mailboxes = useOpenableMailboxes(); // PRIV1b (WC5): only mailboxes this person can open
  const [mailboxId, setMailboxId] = useState("");
  useEffect(() => { if (!mailboxId && mailboxes.data?.[0]) setMailboxId(mailboxes.data[0].id); }, [mailboxes.data, mailboxId]);
  const mailbox = mailboxes.data?.find((m) => m.id === mailboxId);

  if (mailboxes.isPending) return <Skeleton className="h-48" />;
  if (mailboxes.isError && mailboxes.data === undefined) return <LoadError onRetry={() => mailboxes.refetch()} />; // F12 (MB-295)
  if (!mailboxes.data?.length) {
    return (
      <EmptyState icon={<IconDevices className="h-5 w-5" />} title="No mailboxes yet"
        body="Create a mailbox first. Then you can make an app password for it and add it to any mail app."
        action={<ButtonLink to="/app/mailboxes" size="sm">Go to mailboxes</ButtonLink>} />
    );
  }
  return (
    <div className="space-y-6">
      <Section title="Mailbox" description="App passwords belong to one mailbox. Pick the one you want on your device.">
        <Field label="Mailbox" className="max-w-sm">
          {(p) => <Select {...p} value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>{mailboxes.data.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}</Select>}
        </Field>
      </Section>
      {mailbox && <ServerSettings access={access} username={mailbox.address} />}
      {mailbox && <AppPasswords mailboxId={mailbox.id} address={mailbox.address} />}
    </div>
  );
}

function ServerSettings({ access, username }: { access: MailAccess; username: string }) {
  const rows = [
    { kind: "Incoming (IMAP)", ...access.imap },
    { kind: "Outgoing (SMTP)", ...access.smtp },
  ];
  return (
    <Section title="Server settings" description="Most apps fill these in from your address. If yours asks, use these.">
      <div className="grid gap-x-8 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.kind} className="border-t border-line py-3">
            <div className="mb-2 text-xs font-medium text-muted">{r.kind}</div>
            <div className="flex items-center justify-between gap-2"><code className="min-w-0 truncate font-mono text-[13px]">{r.host}</code><CopyButton value={r.host} /></div>
            <div className="mt-2 flex gap-4 text-[13px] text-muted"><span>Port <span className="font-mono tabular-nums text-fg">{r.port}</span></span><span>{securityLabel(r.security)}</span></div>
          </div>
        ))}
      </div>
      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-[140px_1fr]">
        <dt className="text-muted">User name</dt><dd className="inline-flex items-center gap-1.5"><code className="font-mono text-[12.5px]">{username}</code><CopyButton value={username} /></dd>
        <dt className="text-muted">Password</dt><dd>An app password from below. Your Multies password does not work in mail apps.</dd>
      </dl>
    </Section>
  );
}

function AppPasswords({ mailboxId, address }: { mailboxId: string; address: string }) {
  const qc = useQueryClient();
  const key = ["app-passwords", mailboxId];
  const list = useQuery({ queryKey: key, queryFn: async () => (await api.get<{ appPasswords: AppPassword[] }>(`/mail-access/mailboxes/${mailboxId}/app-passwords`)).appPasswords });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<Created>(`/mail-access/mailboxes/${mailboxId}/app-passwords`, { name }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: key }); setOpen(false); setName(""); setCreated(r); },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/mail-access/app-passwords/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); toast.success("App password revoked. Devices using it are signed out."); },
    onError: (e) => showError(e),
  });
  return (
    <Section title="App passwords" description={<>One per device, so you can sign out a lost phone without touching the others. For <span className="text-fg">{address}</span>.</>}>
      <div className="space-y-2">
        {list.isPending ? <Skeleton className="h-12" /> : list.data?.length ? list.data.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0">
            <div className="flex min-w-0 items-center gap-2.5">
              <IconKey className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
              <span className="truncate text-sm font-medium">{p.name}</span>
              <code className="font-mono text-[12px] text-subtle">ends in {p.hint}</code>
            </div>
            <div className="flex shrink-0 items-center gap-3 text-xs text-subtle">
              <span>created {timeAgo(p.createdAt)}</span>
              <button onClick={() => revoke.mutate(p.id)} className="rounded p-1 hover:bg-hover hover:text-bad" aria-label={`Revoke ${p.name}`}><IconTrash className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        )) : <p className="text-sm text-muted">No app passwords yet.</p>}
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><IconPlus className="h-4 w-4" />Create app password</Button>
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} title="New app password" description="Name it after the device or app, so you know which one to revoke later."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Create</Button></>}>
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
          <Field label="Name" hint="For example: Work laptop, iPhone, Outlook" error={create.error instanceof ApiError ? create.error.message : undefined}>
            {(p) => <Input {...p} autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />}
          </Field>
        </form>
      </Dialog>

      <Dialog open={!!created} onClose={() => setCreated(null)} title="Copy your app password" description="It is shown once. Paste it into your mail app as the password."
        footer={<Button onClick={() => setCreated(null)}><IconCheck className="h-4 w-4" />Done</Button>}>
        {created && (
          <div className="space-y-3 text-sm">
            <Row label="User name" value={created.username} />
            <Row label="Password" value={created.secret} />
            <Row label="Incoming (IMAP)" value={`${created.settings.imap.host}, port ${created.settings.imap.port}, ${securityLabel(created.settings.imap.security)}`} />
            <Row label="Outgoing (SMTP)" value={`${created.settings.smtp.host}, port ${created.settings.smtp.port}, ${securityLabel(created.settings.smtp.security)}`} />
          </div>
        )}
      </Dialog>
    </Section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-bg/60 px-3 py-2"><code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{value}</code><CopyButton value={value} /></div>
    </div>
  );
}
