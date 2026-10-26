import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconChevronRight, IconGlobe, IconPlus } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { useDomains, qk } from "@/web/lib/queries";
import { api, ApiError } from "@/web/lib/api";
import type { Domain } from "@/web/lib/types";
import { Button } from "@/web/components/ui/button";
import { Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input } from "@/web/components/ui/input";
import { DomainStatusBadge } from "@/web/components/app-bits";
import { timeAgo } from "@/web/lib/format";

export function DomainsPage() {
  const { data, isPending, error } = useDomains();
  const [params, setParams] = useSearchParams();
  const [open, setOpenState] = useState(params.get("add") === "1");
  const setOpen = (v: boolean) => { setOpenState(v); if (!v && params.has("add")) setParams({}, { replace: true }); };
  return (
    <>
      <PageHeader title="Domains" description="Domains you send and receive mail on. Each one is verified live against DNS." actions={<Button size="sm" onClick={() => setOpen(true)}><IconPlus className="h-4 w-4" />Add domain</Button>} />
      {error && <Card className="p-6 text-sm text-bad">{error.message}</Card>}
      {isPending ? (
        <Card className="divide-y divide-line">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="flex items-center gap-4 p-5"><Skeleton className="h-9 w-9 rounded-lg" /><Skeleton className="h-4 w-48" /><Skeleton className="ml-auto h-5 w-20 rounded-full" /></div>)}</Card>
      ) : data?.length === 0 ? (
        <Card><EmptyState icon={<IconGlobe />} title="Add your first domain" body="Bring a domain you own. We'll generate its DKIM key and walk you through every DNS record." action={<Button onClick={() => setOpen(true)}><IconPlus className="h-4 w-4" />Add domain</Button>} /></Card>
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {data?.map((d) => <DomainRow key={d.id} d={d} />)}
        </Card>
      )}
      <AddDomainDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function DomainRow({ d }: { d: Domain }) {
  const passed = d.lastCheck?.records.filter((r) => r.status === "pass").length ?? 0;
  return (
    <Link to={`/app/domains/${d.id}`} className="group flex items-center gap-4 p-4 transition-colors hover:bg-hover sm:p-5">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-elevated text-muted"><IconGlobe className="h-4 w-4" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><span className="truncate font-medium">{d.name}</span><DomainStatusBadge status={d.status} /></div>
        <div className="mt-0.5 text-xs text-subtle">
          {d.counts ? `${d.counts.mailboxes} mailbox${d.counts.mailboxes === 1 ? "" : "es"} · ${d.counts.aliases} alias${d.counts.aliases === 1 ? "" : "es"} · ` : ""}
          {passed}/5 records passing · checked {timeAgo(d.lastCheckedAt)}
        </div>
      </div>
      <IconChevronRight className="h-4 w-4 text-subtle transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

export function AddDomainDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (n: string) => api.post<{ domain: Domain }>("/domains", { name: n }),
    onSuccess: ({ domain }) => {
      qc.invalidateQueries({ queryKey: qk.domains });
      qc.invalidateQueries({ queryKey: qk.dashboard });
      toast.success(`${domain.name} added`, { description: "Next: publish its DNS records." });
      onClose();
      setName("");
      navigate(`/app/domains/${domain.id}`);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Couldn't add the domain."),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setErr(null); m.mutate(name); };
  return (
    <Dialog open={open} onClose={onClose} title="Add a domain" description="Use a domain you control. You'll add a few DNS records next."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="add-domain" loading={m.isPending} disabled={!name.trim()}>Add domain</Button></>}>
      <form id="add-domain" onSubmit={submit}>
        <Field label="Domain" error={err ?? undefined} hint="Like yourcompany.com, without https:// or www.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="yourcompany.com" autoFocus autoComplete="off" spellCheck={false} />}
        </Field>
      </form>
    </Dialog>
  );
}
