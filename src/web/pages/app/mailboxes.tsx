import { useState, type FormEvent, type KeyboardEvent } from "react";
import { appHref } from "@/web/layouts/shell-nav"; // R121: Mail setup lives in Settings when P2 is on
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconArrowRight, IconClose, IconEdit, IconInbox, IconMention, IconMore, IconPause, IconPlay, IconPlus, IconTeam, IconTrash } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { useAliases, useDomains, useMailboxes, useOrg, useTeam, qk } from "@/web/lib/queries";
import { api, ApiError } from "@/web/lib/api";
import type { Alias, Domain, Mailbox } from "@/web/lib/types";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { Badge, Card, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { formatBytes, initials } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { LOCALE } from "@/shared/locale";
import { MailFolderArt } from "@/web/components/illustrations";
import { AvatarTile, MailboxKindPill, StorageRing } from "@/web/components/premium5-r39";
import { mailboxKind } from "@/web/lib/premium5-r39";
import { FreeAddressCard, useFreeAddress } from "@/web/components/free-address";
import { LoadError } from "@/web/components/load-error-t1g";
import { t } from "@/web/i18n"; // PRIV1b (P66)

export function MailboxesPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "aliases" ? "aliases" : "mailboxes";
  const domains = useDomains();
  const org = useOrg();
  const free = useFreeAddress();
  const [creating, setCreatingState] = useState(params.get("add") === "1");
  const setCreating = (v: boolean) => { setCreatingState(v); if (!v && params.has("add")) setParams((p) => { const n = new URLSearchParams(p); n.delete("add"); return n; }, { replace: true }); };
  const noDomains = domains.data?.length === 0;
  const usage = org.data?.usage;
  const limits = org.data?.plan.limits;
  return (
    <>
      <PageHeader title="Mailboxes" description="Inboxes for people, and aliases that forward role addresses wherever they need to go."
        actions={!noDomains && <Button size="sm" onClick={() => setCreating(true)}><IconPlus className="h-4 w-4" />{tab === "aliases" ? "New alias" : "New mailbox"}</Button>} />
      <div role="tablist" aria-label="Address type" className="mb-5 inline-flex rounded-lg bg-fill p-0.5">
        {(["mailboxes", "aliases"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setParams(t === "aliases" ? { tab: t } : {})}
            className={cn("rounded-md px-3 py-1.5 text-[13px] font-medium capitalize transition-colors", tab === t ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>
            {t}{" "}{usage && limits && <span className="ml-1 text-subtle tabular-nums">{usage[t]}/{limits[t].toLocaleString(LOCALE)}</span>}
          </button>
        ))}
      </div>
      {noDomains && free.data?.enabled && tab === "mailboxes" ? (
        <div className="space-y-4">
          <FreeAddressCard />
          {free.data.addresses.length > 0 && <MailboxList domains={[]} freeDomain={free.data.domain} onCreate={() => setCreating(true)} />}
          <p className="text-sm text-muted">Have your own domain? <Link to={appHref("/app/domains")} className="font-medium text-brand hover:underline">Add it</Link> for mailboxes and aliases on it.</p>
        </div>
      ) : noDomains ? (
        <Card><EmptyState icon={<IconMention />} title="Add a domain first" body="Mailboxes and aliases live on your own domain. Add one and we'll walk you through DNS." action={<ButtonLink to={appHref("/app/domains")}>Go to domains <IconArrowRight className="h-4 w-4" /></ButtonLink>} /></Card>
      ) : tab === "mailboxes" ? (
        <MailboxList domains={domains.data ?? []} freeDomain={free.data?.enabled ? free.data.domain : undefined} onCreate={() => setCreating(true)} />
      ) : (
        <AliasList domains={domains.data ?? []} onCreate={() => setCreating(true)} />
      )}
      {tab === "mailboxes"
        ? <CreateMailboxDialog open={creating} onClose={() => setCreating(false)} domains={domains.data ?? []} />
        : <CreateAliasDialog open={creating} onClose={() => setCreating(false)} domains={domains.data ?? []} />}
    </>
  );
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    for (const k of [qk.mailboxes, qk.aliases, qk.org, qk.dashboard, qk.domains, qk.overview]) qc.invalidateQueries({ queryKey: k });
  };
}

function ListSkeleton() {
  // R39 premium pass 5: skeleton rows shaped like the cards they stand in for.
  return <div role="status" className="space-y-2" aria-busy="true" aria-label="Loading">{Array.from({ length: 3 }).map((_, i) => <Card key={i} className="flex items-center gap-3 p-3.5 sm:gap-4"><Skeleton className="h-10 w-10 rounded-[12px]" /><div className="flex-1 space-y-1.5"><Skeleton className="h-4 w-48 max-w-full" /><Skeleton className="h-3 w-28" /></div><Skeleton className="h-8 w-8 rounded-full" /></Card>)}</div>;
}

function MailboxList({ domains, onCreate, freeDomain }: { domains: Domain[]; onCreate: () => void; freeDomain?: string }) {
  const { data, isPending, isError, refetch } = useMailboxes();
  const team = useTeam();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [deleting, setDeleting] = useState<Mailbox | null>(null);
  const invalidate = useInvalidate();
  const update = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; status?: Mailbox["status"] }) => api.patch(`/mailboxes/${id}`, patch),
    onSuccess: () => { invalidate(); toast.success("Mailbox updated"); },
    onError: (e) => showError(e),
  });
  if (isPending) return <ListSkeleton />;
  if (isError && data === undefined) return <Card><LoadError onRetry={() => refetch()} /></Card>; // F12 (MB-295)
  if (!data?.length) return <Card><EmptyState icon={<IconTeam />} art={<MailFolderArt />} title="No mailboxes yet" body="Create an inbox for yourself or a teammate. It can receive, send and store mail." action={<Button onClick={onCreate}><IconPlus className="h-4 w-4" />New mailbox</Button>} /></Card>;
  const domainStatus = new Map(domains.map((d) => [d.id, d.status]));
  return (
    <>
      {/* R39 premium pass 5: each mailbox a card with a tinted avatar tile, a kind pill and a storage ring. */}
      <ul className="space-y-2" aria-label="Mailboxes" data-testid="mailbox-cards">
        {data.map((m) => { const locked = m.openable === false; return (
          <li key={m.id}>
            <Card className="flex items-center gap-3 p-3.5 transition-shadow duration-200 hover:shadow-[var(--shadow-e2)] motion-reduce:transition-none sm:gap-4" data-testid="mailbox-card">
              <AvatarTile label={initials(m.displayName)} name={m.address} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 truncate text-[15px] font-semibold">{m.address}</span>
                  {/* PRIV1b (P23, P66): someone's personal mailbox comes as a reduced row: no Open, no storage, no Edit. */}
                  <MailboxKindPill kind={locked ? "personal" : mailboxKind(m, team.data?.members ?? [])} />
                  {locked && <Badge tone="neutral">{t("priv1a.private")}</Badge>}
                  {m.status === "suspended" && <Badge tone="warn">Suspended</Badge>}
                  {freeDomain && m.address.endsWith(`@${freeDomain}`) ? <Badge tone="neutral">Free address</Badge>
                    : !locked && domainStatus.has(m.domainId) && domainStatus.get(m.domainId) !== "verified" && <Badge tone="neutral">Domain pending</Badge>}
                </div>
                <div className="mt-0.5 truncate text-[13px] text-muted">{m.displayName}{m.replyTo ? ` · replies to ${m.replyTo}` : ""}</div>
              </div>
              {/* R40: the ring shows on phones too, compact (the figures are in its label and on the mailbox page). */}
              {!locked && <div className="shrink-0 max-sm:[&_[data-ring-text]]:hidden"><StorageRing used={m.usedBytes} max={m.quotaMb * 1024 * 1024} label={`Storage for ${m.address}`} show={formatBytes} /></div>}
              {!locked && <Link to={`/app/mail?mailbox=${m.id}`} className="hidden rounded-full p-2 text-muted transition-colors hover:bg-hover hover:text-fg sm:block" aria-label={`Open ${m.address} in mail`}><IconInbox className="h-4 w-4" /></Link>}
              <Menu label={`Actions for ${m.address}`} trigger={<button className="grid h-11 w-11 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg sm:h-9 sm:w-9" aria-label={`Actions for ${m.address}`}><IconMore className="h-4 w-4" /></button>}>
                {!locked && <MenuItem icon={<IconInbox />} onSelect={() => navigate(`/app/mail?mailbox=${m.id}`)}>Open in mail</MenuItem>}
                {!locked && <MenuItem icon={<IconEdit />} onSelect={() => setEditing(m)}>Edit</MenuItem>}
                {m.status === "active"
                  ? <MenuItem icon={<IconPause />} onSelect={() => update.mutate({ id: m.id, status: "suspended" })}>Suspend</MenuItem>
                  : <MenuItem icon={<IconPlay />} onSelect={() => update.mutate({ id: m.id, status: "active" })}>Reactivate</MenuItem>}
                <MenuItem icon={<IconTrash />} danger onSelect={() => setDeleting(m)}>Delete</MenuItem>
              </Menu>
            </Card>
          </li>
        ); })}
      </ul>
      {editing && <EditMailboxDialog mailbox={editing} onClose={() => setEditing(null)} />}
      <ConfirmDelete open={!!deleting} onClose={() => setDeleting(null)} what={deleting?.address ?? ""} path={`/mailboxes/${deleting?.id}`} body="Its stored mail is deleted too. Mail sent to this address will bounce." />
    </>
  );
}

function ConfirmDelete({ open, onClose, what, path, body }: { open: boolean; onClose: () => void; what: string; path: string; body: string }) {
  const invalidate = useInvalidate();
  const m = useMutation({
    mutationFn: () => api.del(path),
    onSuccess: () => { invalidate(); toast.success(`${what} deleted`); onClose(); },
    onError: (e) => showError(e),
  });
  return (
    <Dialog open={open} onClose={onClose} title={`Delete ${what}?`} description={body}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={m.isPending} onClick={() => m.mutate()}>Delete</Button></>} />
  );
}

function AddressInput({ domains, domainId, setDomainId, localPart, setLocalPart, error }: {
  domains: Domain[]; domainId: string; setDomainId: (v: string) => void; localPart: string; setLocalPart: (v: string) => void; error?: string;
}) {
  return (
    <Field label="Address" error={error}>
      {(p) => (
        <div className="flex items-stretch overflow-hidden rounded-lg border border-line focus-within:border-brand/70 focus-within:ring-4 focus-within:ring-brand/15">
          <input {...p} value={localPart} onChange={(e) => setLocalPart(e.target.value)} placeholder="hello" autoFocus autoComplete="off" spellCheck={false}
            className="h-10 min-w-0 flex-1 bg-surface px-3 text-sm outline-none placeholder:text-subtle" />
          <span className="grid place-items-center border-l border-line bg-elevated px-2 text-sm text-subtle">@</span>
          <Select bare aria-label="Domain" value={domainId} onChange={(e) => setDomainId(e.target.value)} className="h-10 max-w-[55%] border-l border-line bg-elevated px-2 text-sm outline-none"
            phoneClassName="flex h-11 min-w-0 max-w-[55%] items-center truncate border-l border-line bg-elevated px-3 text-left text-base text-fg">
            {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </div>
      )}
    </Field>
  );
}

function CreateMailboxDialog({ open, onClose, domains }: { open: boolean; onClose: () => void; domains: Domain[] }) {
  const [domainId, setDomainId] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invalidate = useInvalidate();
  const effectiveDomain = domainId || domains[0]?.id || "";
  const m = useMutation({
    mutationFn: () => api.post<{ mailbox: Mailbox }>("/mailboxes", { domainId: effectiveDomain, localPart, displayName }),
    onSuccess: ({ mailbox }) => { invalidate(); toast.success(`${mailbox.address} created`); onClose(); setLocalPart(""); setDisplayName(""); setErrors({}); },
    onError: (e) => setErrors(e instanceof ApiError ? e.fields ?? { _: e.message } : { _: "Something went wrong." }),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setErrors({}); m.mutate(); };
  return (
    <Dialog open={open} onClose={onClose} title="New mailbox" description="A full inbox that can receive, send and store mail."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="new-mailbox" loading={m.isPending} disabled={!localPart || !displayName}>Create mailbox</Button></>}>
      <form id="new-mailbox" onSubmit={submit} className="space-y-4">
        {errors._ && <p role="alert" className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2 text-sm text-bad">{errors._}</p>}
        <AddressInput domains={domains} domainId={effectiveDomain} setDomainId={setDomainId} localPart={localPart} setLocalPart={setLocalPart} error={errors.localPart} />
        <Field label="Display name" hint="Shown to recipients, e.g. “Ada at Acme”." error={errors.displayName}>{(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ada Lovelace" />}</Field>
      </form>
    </Dialog>
  );
}

function EditMailboxDialog({ mailbox, onClose }: { mailbox: Mailbox; onClose: () => void }) {
  const [displayName, setDisplayName] = useState(mailbox.displayName);
  const [quota, setQuota] = useState(String(mailbox.quotaMb / 1024));
  const [replyTo, setReplyTo] = useState(mailbox.replyTo ?? "");
  const org = useOrg();
  const maxGb = (org.data?.plan.limits.storagePerMailboxMb ?? 1024) / 1024;
  const invalidate = useInvalidate();
  const m = useMutation({
    mutationFn: () => api.patch(`/mailboxes/${mailbox.id}`, { displayName, quotaMb: Math.round(Number(quota) * 1024), replyTo: replyTo.trim() || null }),
    onSuccess: () => { invalidate(); toast.success("Mailbox updated"); onClose(); },
    onError: (e) => showError(e),
  });
  return (
    <Dialog open onClose={onClose} title={`Edit ${mailbox.address}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Display name">{(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}</Field>
        <Field label="Storage quota (GB)" hint={`Up to ${maxGb} GB on your plan.`}>{(p) => <Input {...p} type="number" min={0.1} max={maxGb} step={0.5} value={quota} onChange={(e) => setQuota(e.target.value)} />}</Field>
        <Field label="Replies go to" hint="Optional. Mail sent from this address asks for replies here, unless a send names its own. Leave empty for replies to come back to this address.">
          {(p) => <Input {...p} type="email" placeholder="support@example.com" autoComplete="off" spellCheck={false} value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function AliasList({ domains, onCreate }: { domains: Domain[]; onCreate: () => void }) {
  const { data, isPending, isError, refetch } = useAliases();
  const [editing, setEditing] = useState<Alias | null>(null);
  const [deleting, setDeleting] = useState<Alias | null>(null);
  const invalidate = useInvalidate();
  const toggle = useMutation({
    mutationFn: (a: Alias) => api.patch(`/aliases/${a.id}`, { enabled: !a.enabled }),
    onSuccess: invalidate,
    onError: (e) => showError(e),
  });
  if (isPending) return <ListSkeleton />;
  if (isError && data === undefined) return <Card><LoadError onRetry={() => refetch()} /></Card>; // F12 (MB-295)
  if (!data?.length) return <Card><EmptyState icon={<IconMention />} title="No aliases yet" body="Aliases forward a role address like sales@ to one or more people, inside or outside your domain." action={<Button onClick={onCreate}><IconPlus className="h-4 w-4" />New alias</Button>} /></Card>;
  void domains;
  return (
    <>
      <Card className="divide-y divide-line">
        {data.map((a) => (
          <div key={a.id} className={cn("flex items-center gap-3 p-4 sm:gap-4", !a.enabled && "opacity-60")}>
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-elevated text-muted"><IconMention className="h-4 w-4" /></div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{a.address}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <IconArrowRight className="h-3 w-3 text-subtle" />
                {a.destinations.map((d) => <span key={d} className="rounded-md border border-line bg-fill/60 px-1.5 py-0.5 text-[11.5px] text-muted">{d}</span>)}
              </div>
            </div>
            <Switch checked={a.enabled} onChange={() => toggle.mutate(a)} label={`${a.enabled ? "Disable" : "Enable"} ${a.address}`} />
            <Menu label={`Actions for ${a.address}`} trigger={<button className="rounded-md p-2 text-muted hover:bg-hover hover:text-fg" aria-label={`Actions for ${a.address}`}><IconMore className="h-4 w-4" /></button>}>
              <MenuItem icon={<IconEdit />} onSelect={() => setEditing(a)}>Edit destinations</MenuItem>
              <MenuItem icon={<IconTrash />} danger onSelect={() => setDeleting(a)}>Delete</MenuItem>
            </Menu>
          </div>
        ))}
      </Card>
      {editing && <EditAliasDialog alias={editing} onClose={() => setEditing(null)} />}
      <ConfirmDelete open={!!deleting} onClose={() => setDeleting(null)} what={deleting?.address ?? ""} path={`/aliases/${deleting?.id}`} body="Mail sent to this address will bounce unless a catch-all is set." />
    </>
  );
}

function DestinationsInput({ value, onChange, error }: { value: string[]; onChange: (v: string[]) => void; error?: string }) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const parts = draft.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (["Enter", ",", " ", "Tab"].includes(e.key) && draft.trim()) { e.preventDefault(); commit(); }
    if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <Field label="Forward to" hint="Press Enter after each address. Can be inside or outside your domain." error={error}>
      {(p) => (
        <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 focus-within:border-brand/70 focus-within:ring-4 focus-within:ring-brand/15">
          {value.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-md bg-elevated py-0.5 pl-2 pr-1 text-[12.5px]">
              {v}<button type="button" onClick={() => onChange(value.filter((x) => x !== v))} className="rounded p-0.5 text-subtle hover:text-fg" aria-label={`Remove ${v}`}><IconClose className="h-3 w-3" /></button>
            </span>
          ))}
          <input {...p} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={commit} placeholder={value.length ? "" : "founder@gmail.com"} className="h-7 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-subtle" />
        </div>
      )}
    </Field>
  );
}

function CreateAliasDialog({ open, onClose, domains }: { open: boolean; onClose: () => void; domains: Domain[] }) {
  const [domainId, setDomainId] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [destinations, setDestinations] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invalidate = useInvalidate();
  const effectiveDomain = domainId || domains[0]?.id || "";
  const m = useMutation({
    mutationFn: () => api.post<{ alias: Alias }>("/aliases", { domainId: effectiveDomain, localPart, destinations }),
    onSuccess: ({ alias }) => { invalidate(); toast.success(`${alias.address} created`); onClose(); setLocalPart(""); setDestinations([]); setErrors({}); },
    onError: (e) => setErrors(e instanceof ApiError ? e.fields ?? { _: e.message } : { _: "Something went wrong." }),
  });
  return (
    <Dialog open={open} onClose={onClose} title="New alias" description="Forward a role address to the people who should get it."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="new-alias" loading={m.isPending} disabled={!localPart || !destinations.length}>Create alias</Button></>}>
      <form id="new-alias" onSubmit={(e) => { e.preventDefault(); setErrors({}); m.mutate(); }} className="space-y-4">
        {errors._ && <p role="alert" className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2 text-sm text-bad">{errors._}</p>}
        <AddressInput domains={domains} domainId={effectiveDomain} setDomainId={setDomainId} localPart={localPart} setLocalPart={setLocalPart} error={errors.localPart} />
        <DestinationsInput value={destinations} onChange={setDestinations} error={errors.destinations ?? Object.entries(errors).find(([k]) => k.startsWith("destinations."))?.[1]} />
      </form>
    </Dialog>
  );
}

function EditAliasDialog({ alias, onClose }: { alias: Alias; onClose: () => void }) {
  const [destinations, setDestinations] = useState(alias.destinations);
  const invalidate = useInvalidate();
  const m = useMutation({
    mutationFn: () => api.patch(`/aliases/${alias.id}`, { destinations }),
    onSuccess: () => { invalidate(); toast.success("Alias updated"); onClose(); },
    onError: (e) => showError(e),
  });
  return (
    <Dialog open onClose={onClose} title={`Edit ${alias.address}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!destinations.length} onClick={() => m.mutate()}>Save</Button></>}>
      <DestinationsInput value={destinations} onChange={setDestinations} />
    </Dialog>
  );
}

export { Select };
