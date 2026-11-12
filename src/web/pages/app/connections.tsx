import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { IconArrowRight, IconKey, IconLock, IconPlug, IconRefresh, IconTrash } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { qk } from "@/web/lib/queries";
import { showError } from "@/web/lib/show-error";
import { timeAgo, num } from "@/web/lib/format";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input } from "@/web/components/ui/input";
import { ConnectMailboxForm, connectionsKey, useConnections } from "@/web/components/connect-mailbox";
import { isFullConnection, type ConnectionLimited, type ConnectionView } from "@/shared/mail-connect";
import { Section } from "./settings";
import { MailFolderArt } from "@/web/components/illustrations";
import { AvatarTile, PlainStatusPill } from "@/web/components/premium5-r39";
import { connectionStatus } from "@/web/lib/premium5-r39";
import { MailboxSyncProgress } from "@/web/components/mail-sync-progress";
import { MailboxPrivacyPanel } from "@/web/components/mailbox-privacy-priv1a"; // PRIV1a
import { t } from "@/web/i18n";

const STATUS: Record<ConnectionView["status"], { label: string; tone: "ok" | "warn" | "bad" | "neutral" | "brand" }> = {
  active: { label: "Connected", tone: "ok" },
  syncing: { label: "Syncing", tone: "ok" },
  auth_failed: { label: "Needs reconnect", tone: "bad" },
  error: { label: "Can't reach server", tone: "warn" },
  paused: { label: "Paused", tone: "neutral" },
};

/** Settings, Connections, Mail accounts (R82F; was Connected accounts): mailboxes at other providers, their sync, and their stored password. */
export function ConnectionsSettings() {
  const info = useConnections();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(params.get("new") === "1");
  useEffect(() => {
    const done = params.get("connected");
    const error = params.get("error");
    if (done) toast.success(`${done} is connected`);
    if (error) toast.error(error);
    if (done || error) setParams({}, { replace: true });
  }, [params, setParams]);

  if (info.isPending) return <Skeleton className="h-48" />;
  if (!info.data?.enabled) {
    return <Section title="Mail accounts" description="Use a mailbox you already have inside Multies."><p className="text-sm text-muted">Connecting an existing mailbox isn't switched on for this server.</p></Section>;
  }
  const list = info.data.connections;
  return (
    <div className="space-y-6">
      <Section
        title="Mail accounts"
        description={<>Your Gmail, Outlook, Yahoo, iCloud, Zoho, Fastmail, GMX or any other mailbox, inside Multies with your real address. New mail syncs every few minutes and replies go out through your own provider, so they land in its Sent folder too.</>}
      >
        {list.length === 0 && !adding ? (
          <EmptyState icon={<IconPlug className="h-5 w-5" />} art={<MailFolderArt />} title="No connected mailboxes yet" body="Connect one with an app password from your provider. It takes about a minute." action={<Button onClick={() => setAdding(true)} data-testid="connect-start">Connect a mailbox</Button>} />
        ) : (
          <div className="space-y-3" data-testid="connections-list">
            {list.map((c) => (isFullConnection(c) ? <ConnectionRow key={c.id} c={c} /> : <LimitedConnectionRow key={c.id} c={c} />))}
            {!adding && <Button variant="secondary" onClick={() => setAdding(true)} data-testid="connect-start">Connect another mailbox</Button>}
          </div>
        )}
      </Section>
      <Section title={t("priv1a.section_title")} description={t("priv1a.section_desc")}>
        <MailboxPrivacyPanel />
      </Section>
      {adding && (
        <Section title="Connect a mailbox" description="We check the address and app password with your provider before anything is saved. The first sync copies the last 30 days.">
          <ConnectMailboxForm oauth={info.data.oauth} onConnected={() => setAdding(false)} />
        </Section>
      )}
    </div>
  );
}

/**
 * MPLAT-110: a personal mailbox another person connected, which this owner or admin can't open (PRIV1b, P46). The
 * server sends only its address and status, so the row is read only: no counts, no sync, no Reconnect, no Remove.
 */
export function LimitedConnectionRow({ c }: { c: ConnectionLimited }) {
  const s = STATUS[c.status] ?? STATUS.paused;
  return (
    <Card className="p-4" data-testid="connection-row-limited">
      <div className="flex items-start gap-3">
        <AvatarTile label={(c.email || "?").slice(0, 1).toUpperCase()} name={c.email || "Mailbox"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-[15px] font-semibold" data-testid="connection-email">{c.email}</span>
            <Badge tone={s.tone} dot>{s.label}</Badge>
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted" data-testid="connection-limited-note">
            <IconLock className="h-3.5 w-3.5 shrink-0" aria-hidden />Personal mailbox, owner only
          </p>
        </div>
      </div>
    </Card>
  );
}

function ConnectionRow({ c }: { c: ConnectionView }) {
  const qc = useQueryClient();
  const [reconnecting, setReconnecting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = () => { for (const k of [connectionsKey, qk.mailboxes, qk.overview]) qc.invalidateQueries({ queryKey: k }); };
  const sync = useMutation({
    mutationFn: () => api.post<{ result: { stored: number; error: string | null } }>(`/connections/${c.id}/sync`, {}),
    onSuccess: (r) => { refresh(); if (r.result.error) toast.error(r.result.error); else toast.success(r.result.stored ? `${r.result.stored} new message${r.result.stored === 1 ? "" : "s"}` : "Up to date"); },
    onError: showError,
  });
  // R41: the demo's sample mailbox has nothing to sign in to; Reconnect resets it to the healthy sample in one tap.
  const resetSample = useMutation({
    mutationFn: () => api.put(`/connections/${c.id}`, { password: "sample" }),
    onSuccess: () => { refresh(); toast.success("The sample mailbox is connected again"); },
    onError: showError,
  });
  const reconnect = useMutation({
    mutationFn: () => api.put(`/connections/${c.id}`, { password }),
    onSuccess: () => { refresh(); setReconnecting(false); setPassword(""); toast.success(`${c.email} is reconnected`); },
    onError: (e) => setError(e instanceof ApiError ? e.message : "That didn't work. Try again."),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/connections/${c.id}`),
    onSuccess: () => { refresh(); setRemoving(false); toast.success(`${c.email} is removed from Multies`); },
    onError: showError,
  });
  const s = c.status === "active" && !c.initialDone ? { label: "Copying recent mail", tone: "brand" as const } : STATUS[c.status];
  const plain = connectionStatus(c.status);
  return (
    <Card className="p-4 transition-shadow duration-200 hover:shadow-[var(--shadow-e2)] motion-reduce:transition-none" data-testid="connection-row">
      <div className="flex items-start gap-3">
        <AvatarTile label={c.email.slice(0, 1).toUpperCase()} name={c.email} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-[15px] font-semibold" data-testid="connection-email">{c.email}</span>
            <PlainStatusPill status={plain.status} />
            <Badge tone={s.tone} dot>{s.label}</Badge>
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            {c.providerLabel} · {c.authKind === "oauth" ? "signed in with the provider" : "app password"} · {c.lastSyncAt ? `last sync ${timeAgo(c.lastSyncAt)}` : "first sync starting"} · {num(c.messagesSynced)} messages{c.initialDone ? "" : ", still copying recent mail"}
          </p>
          <MailboxSyncProgress c={c} />
          {c.lastError && c.status !== "active" && <p className="mt-1.5 text-[13px] text-bad" data-testid="connection-error">{c.lastError}</p>}
          {plain.next && <p className="mt-2 flex items-start gap-1.5 rounded-[10px] bg-warn-soft px-3 py-2 text-[13px] text-fg" data-testid="connection-next"><IconArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden /><span><span className="font-semibold">Next step: </span>{plain.next}</span></p>}
          <div className="mt-3 flex flex-wrap gap-2">
          <ButtonLink size="sm" variant="secondary" to={`/app/mail?mailbox=${c.mailboxId}`}>Open inbox <IconArrowRight className="h-4 w-4" /></ButtonLink>
          <Button size="sm" variant="secondary" loading={sync.isPending} onClick={() => sync.mutate()} aria-label={`Sync now ${c.email}`}><IconRefresh className="h-4 w-4" />Sync now</Button>
          {c.sample
            ? <Button size="sm" variant={c.status === "active" ? "secondary" : "primary"} loading={resetSample.isPending} onClick={() => resetSample.mutate()} data-testid="sample-reconnect"><IconRefresh className="h-4 w-4" />Reconnect</Button>
            : <Button size="sm" variant={c.status === "auth_failed" ? "primary" : "secondary"} onClick={() => { setError(null); setReconnecting(true); }}><IconKey className="h-4 w-4" />Reconnect</Button>}
          <Button size="sm" variant="ghost" onClick={() => setRemoving(true)} aria-label={`Remove ${c.email}`}><IconTrash className="h-4 w-4" />Remove</Button>
          </div>
        </div>
      </div>
      <Dialog open={reconnecting} onClose={() => setReconnecting(false)} title={`Reconnect ${c.email}`} description="Paste a new app password. We check it with your provider before saving."
        footer={<><Button variant="secondary" onClick={() => setReconnecting(false)}>Cancel</Button><Button loading={reconnect.isPending} disabled={!password} onClick={() => reconnect.mutate()} data-testid="reconnect-save">Reconnect</Button></>}>
        <Field label="App password" error={error ?? undefined}>{(fp) => <Input {...fp} type="password" autoComplete="off" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} data-testid="reconnect-password" />}</Field>
      </Dialog>
      <Dialog open={removing} onClose={() => setRemoving(false)} title={`Remove ${c.email}?`} description="The stored app password is deleted, and so is the copy of this mailbox in Multies. Nothing changes at your provider: your mail stays there."
        footer={<><Button variant="secondary" onClick={() => setRemoving(false)}>Cancel</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()} data-testid="remove-confirm">Remove</Button></>}>
        <span />
      </Dialog>
    </Card>
  );
}
