import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconArrowLeft, IconCheck, IconChevronDown, IconClose, IconInfo, IconRefresh, IconSpinner, IconWarning } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { useDomain, useMailboxes, qk } from "@/web/lib/queries";
import { api, ApiError } from "@/web/lib/api";
import type { Domain } from "@/web/lib/types";
import type { RecordCheck } from "@/shared/dns";
import { Button } from "@/web/components/ui/button";
import { Badge, Card, CopyButton, Skeleton } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { DomainStatusBadge } from "@/web/components/app-bits";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { fetchMailCheck, ProviderSummary, SwitchPlan } from "@/web/components/mail-check";
import { RecordStatusPill, Stepper } from "@/web/components/premium4-r39"; // R39 premium pass 4
import { domainSteps, recordPill } from "@/web/lib/premium4-r39";

export function DomainDetailPage() {
  const { id = "" } = useParams();
  const { data: d, isPending, error } = useDomain(id);
  const { data: mailboxes } = useMailboxes(); // R39: the stepper's last step
  const qc = useQueryClient();
  const verify = useMutation({
    mutationFn: () => api.post<{ domain: Domain }>(`/domains/${id}/verify`),
    onSuccess: ({ domain }) => {
      const was = qc.getQueryData<Domain>(qk.domain(id))?.status;
      qc.setQueryData(qk.domain(id), domain);
      qc.invalidateQueries({ queryKey: qk.domains });
      if (domain.status === "verified" && was !== "verified") toast.success(`${domain.name} is verified`, { description: "Mail can flow. Create a mailbox next." });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Check failed"),
  });

  // While pending, re-check automatically every 30 seconds.
  useEffect(() => {
    if (!d || d.status === "verified") return;
    const t = setInterval(() => { if (!document.hidden && !verify.isPending) verify.mutate(); }, 30_000);
    return () => clearInterval(t);
  }, [d, verify]);

  if (error) return <Card className="p-6 text-sm text-bad">{error instanceof ApiError && error.status === 404 ? "This domain doesn't exist in your workspace." : error.message}</Card>;
  if (isPending || !d) return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 rounded-xl" /><Skeleton className="h-40 rounded-xl" /></div>;

  const checks = new Map((d.lastCheck?.records ?? []).map((r) => [r.id, r]));
  const required = d.records.filter((r) => r.required);
  const passing = required.filter((r) => ["pass", "warn"].includes(checks.get(r.id)?.status ?? "")).length;

  return (
    <>
      <Link to="/app/domains" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><IconArrowLeft className="h-4 w-4" />Domains</Link>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3"><h1 className="truncate text-2xl font-semibold tracking-tight">{d.name}</h1><DomainStatusBadge status={d.status} /></div>
          <p className="mt-1.5 text-sm text-muted">
            {d.status === "verified" ? `Verified ${timeAgo(d.verifiedAt)}. We re-check DNS regularly and warn you if anything drifts.` : `${passing} of ${required.length} required records passing. We re-check every 30 seconds while this page is open.`}
          </p>
        </div>
        <Button variant="secondary" onClick={() => verify.mutate()} loading={verify.isPending} className="shrink-0">
          {!verify.isPending && <IconRefresh className="h-4 w-4" />}Check DNS now
        </Button>
      </div>

      <SetupProgress domain={d} passing={passing} required={required.length} mailboxes={(mailboxes ?? []).filter((m) => m.domainId === d.id).length} />

      {d.status !== "verified" && (
        <Card className="mb-6 flex gap-3 border-brand/25 bg-brand-soft/40 p-4 text-sm">
          <IconInfo className="mt-0.5 h-4 w-4 shrink-0 text-brand-hover" />
          <div className="text-fg/85">
            Add these records at your DNS provider, then come back. We pick them up within minutes.
            {d.records.some((r) => r.id === "mx" && /cloudflare/i.test(r.value))
              ? <span className="text-muted"> On Cloudflare? Turn on <b className="font-medium text-fg">Email Routing</b> for the zone and it adds the MX and SPF records for you.</span>
              : <span className="text-muted"> Your nameservers stay where they are: these records work at any DNS provider (GoDaddy, Namecheap, Cloudflare and others).</span>}
          </div>
        </Card>
      )}

      {d.status !== "verified" && <SwitchPlanCard name={d.name} />}

      {d.sending && (
        <Card className="mb-6 flex items-start gap-3 p-4 text-sm" data-testid="domain-sending">
          <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", d.sending.status === "verified" ? "bg-ok" : d.sending.status === "error" ? "bg-bad" : "bg-warn")} aria-hidden />
          <div>
            <div className="font-medium">{d.sending.status === "verified" ? "Sending and receiving are ready" : d.sending.status === "error" ? "Sending isn't set up for this domain yet" : d.sending.status === "queued" ? "In the queue for a sending slot" : "Sending and receiving start once the records below are in"}</div>
            <p className="mt-0.5 text-xs text-muted">{d.sending.status === "error" ? `The email service said: ${d.sending.detail ?? "no reason given"}. Check DNS now tries again.` : d.sending.status === "queued" ? d.sending.detail : "Mail to any mailbox on this domain lands in this workspace, and mail you send from it is signed with the key below."}</p>
          </div>
        </Card>
      )}

      <div className="space-y-3" id="dns-records">
        {d.records.map((r) => <RecordCard key={`${r.id}:${r.host}`} record={r} check={checks.get(r.id)} checking={verify.isPending} />)}
      </div>
      <p className="mt-3 text-xs text-subtle">Last checked {timeAgo(d.lastCheckedAt)}. Some DNS providers want the host without your domain (e.g. <code className="font-mono">_dmarc</code>), others the full name (<code className="font-mono">_dmarc.{d.name}</code>).</p>

      <CatchAll domain={d} />
      <DangerZone domain={d} />
    </>
  );
}

/** R39 premium pass 4: the 4 setup steps with the next one named and one button for it. */
function SetupProgress({ domain: d, passing, required, mailboxes }: { domain: Domain; passing: number; required: number; mailboxes: number }) {
  const { steps, current } = domainSteps({ status: d.status, passing, required, mailboxes });
  const next = steps[current]?.id;
  const line = next === "records" ? `Add the ${required - passing} missing record${required - passing === 1 ? "" : "s"} below at your DNS provider. ${passing} of ${required} are in.`
    : next === "verified" ? "The records are in. Verification usually lands within a few minutes."
    : next === "mailbox" ? `${d.name} is ready. Create the first address on it.`
    : `Setup is complete. ${mailboxes} mailbox${mailboxes === 1 ? "" : "es"} on ${d.name}.`;
  return (
    <Card className="mb-6 p-4 sm:p-5" data-testid="domain-setup">
      <Stepper steps={steps} current={current} label={`Setup of ${d.name}`} />
      <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm"><span className="font-semibold">{current === -1 ? "All set. " : "Next step. "}</span><span className="text-muted">{line}</span></p>
        {next === "mailbox" && <Link to="/app/mailboxes" className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 text-[13px] font-medium text-white transition-colors duration-150 hover:bg-brand-hover max-sm:min-h-11">Create a mailbox</Link>}
        {next === "records" && <a href="#dns-records" className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg bg-fill px-3.5 text-[13px] font-medium transition-colors duration-150 hover:bg-hover max-sm:min-h-11">Show the records</a>}
      </div>
    </Card>
  );
}

/** While a domain is not verified, says where its mail goes today and the order of steps to switch. */
function SwitchPlanCard({ name }: { name: string }) {
  const q = useQuery({ queryKey: ["mail-check", name], queryFn: () => fetchMailCheck(name), retry: false, staleTime: 10 * 60_000 });
  const c = q.data;
  if (!c || c.provider.kind === "multies" || c.provider.kind === "none") return null;
  return (
    <Card className="mb-6 p-5" data-testid="switch-plan">
      <ProviderSummary check={c} />
      <p className="mt-3 text-sm text-muted">Mail keeps arriving at {c.provider.name} until you change the MX records. Follow these steps in order and nobody misses a message.</p>
      <details className="group mt-3">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-brand-hover">
          <IconChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />Show the switch plan
        </summary>
        <SwitchPlan check={c} className="mt-4" />
      </details>
    </Card>
  );
}

const statusUi: Record<string, { icon: React.ReactNode; label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  pass: { icon: <IconCheck className="h-3.5 w-3.5" />, label: "Passing", tone: "ok" },
  warn: { icon: <IconWarning className="h-3.5 w-3.5" />, label: "Warning", tone: "warn" },
  fail: { icon: <IconClose className="h-3.5 w-3.5" />, label: "Not found", tone: "bad" },
  error: { icon: <IconWarning className="h-3.5 w-3.5" />, label: "Lookup failed", tone: "warn" },
};

function RecordCard({ record: r, check, checking }: { record: Domain["records"][number]; check?: RecordCheck; checking: boolean }) {
  const [open, setOpen] = useState(false);
  const ui = check ? statusUi[check.status] ?? statusUi.fail : null;
  return (
    <Card className={cn("overflow-hidden transition-colors duration-200 motion-reduce:transition-none", check?.status === "pass" && "border-ok/20", check?.status === "fail" && check.found.length > 0 && "border-bad/25")} data-testid="dns-record">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex items-center gap-3">
          <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg border",
            check?.status === "pass" ? "border-ok/25 bg-ok-soft text-ok" : check?.status === "warn" || check?.status === "error" ? "border-warn/25 bg-warn-soft text-warn" : "border-line-strong bg-elevated text-subtle")}>
            {checking ? <IconSpinner className="h-4 w-4 animate-spin" /> : ui?.icon ?? <span className="h-1.5 w-1.5 rounded-full bg-current" />}
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold">{r.title}</h3>
              {!r.required && <Badge>Recommended</Badge>}
              <RecordStatusPill pill={recordPill(check)} />
            </div>
            <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-subtle">{r.why}</p>
          </div>
        </div>
      </div>
      <div className="border-t border-line bg-bg/40">
        <dl className="grid gap-px sm:grid-cols-[90px_minmax(0,1fr)_minmax(0,2.4fr)]">
          <RecordCell label="Type"><span className="font-mono text-[13px]">{r.type}</span></RecordCell>
          <RecordCell label="Host" copy={r.host}><span className="break-all font-mono text-[13px]">{r.host}</span></RecordCell>
          {r.values ? (
            <RecordCell label="Value · priority">
              <div className="space-y-1.5">
                {r.values.map((v) => (
                  <div key={v.value} className="flex items-center justify-between gap-3">
                    <span className="break-all font-mono text-[13px]">{v.value} <span className="text-subtle">· {v.priority}</span></span>
                    <CopyButton value={v.value} toastText="Value copied" />
                  </div>
                ))}
              </div>
            </RecordCell>
          ) : (
            <RecordCell label="Value" copy={r.value}><span className="break-all font-mono text-[13px] leading-relaxed">{r.value}</span></RecordCell>
          )}
        </dl>
      </div>
      {check && check.status !== "pass" && (
        <div className="border-t border-line px-4 py-3 text-sm sm:px-5">
          <p className={cn(check.status === "fail" ? "text-bad" : "text-warn")}>{check.message}</p>
          {check.suggestion && (
            <div className="mt-3 rounded-lg border border-line bg-bg/60 p-3">
              <div className="mb-1.5 flex items-center justify-between gap-2"><span className="text-xs font-medium text-muted">Replace it with this single record</span><CopyButton value={check.suggestion} toastText="Record copied" /></div>
              <code className="block break-all font-mono text-[12.5px] text-fg/90">{check.suggestion}</code>
            </div>
          )}
          {check.found.length > 0 && (
            <div className="mt-2">
              <button className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                <IconChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />What we found in DNS ({check.found.length})
              </button>
              {open && <ul className="mt-2 space-y-1">{check.found.map((f) => <li key={f} className="break-all rounded bg-fill/60 px-2 py-1 font-mono text-[12px] text-muted">{f}</li>)}</ul>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function RecordCell({ label, children, copy }: { label: string; children: React.ReactNode; copy?: string }) {
  return (
    <div className="bg-surface/40 px-4 py-3 sm:px-5">
      <dt className="mb-1 text-[11px] font-medium uppercase tracking-wide text-subtle">{label}</dt>
      <dd className="flex items-start justify-between gap-3">{children}{copy && <CopyButton value={copy} toastText={`${label} copied`} />}</dd>
    </div>
  );
}

function CatchAll({ domain }: { domain: Domain }) {
  const { data: mailboxes } = useMailboxes();
  const qc = useQueryClient();
  const own = (mailboxes ?? []).filter((m) => m.domainId === domain.id);
  const m = useMutation({
    mutationFn: (catchAllMailboxId: string | null) => api.patch<{ domain: Domain }>(`/domains/${domain.id}`, { catchAllMailboxId }),
    onSuccess: ({ domain: d }) => { qc.setQueryData(qk.domain(domain.id), d); toast.success("Catch-all updated"); },
    onError: (e) => showError(e),
  });
  return (
    <Card className="mt-8 p-5">
      <h2 className="text-sm font-semibold">Catch-all</h2>
      <p className="mt-1 text-sm text-muted">Deliver mail sent to any unknown address at {domain.name} to one mailbox, instead of bouncing it.</p>
      <div className="mt-4 max-w-sm">
        <Select aria-label="Catch-all mailbox" value={domain.catchAllMailboxId ?? ""} disabled={m.isPending || own.length === 0} onChange={(e) => m.mutate(e.target.value || null)}>
          <option value="">{own.length ? "Off: bounce unknown addresses" : "Create a mailbox on this domain first"}</option>
          {own.map((mb) => <option key={mb.id} value={mb.id}>{mb.address}</option>)}
        </Select>
      </div>
    </Card>
  );
}

function DangerZone({ domain }: { domain: Domain }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const m = useMutation({
    mutationFn: () => api.del(`/domains/${domain.id}`),
    onSuccess: () => { qc.invalidateQueries(); toast.success(`${domain.name} removed`); navigate("/app/domains"); },
    onError: (e) => showError(e),
  });
  return (
    <Card className="mt-4 border-bad/20 p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="text-sm font-semibold">Remove domain</h2><p className="mt-1 text-sm text-muted">Deletes its mailboxes, aliases and stored mail. This can't be undone.</p></div>
        <Button variant="danger" size="sm" onClick={() => setOpen(true)}>Remove domain</Button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Remove ${domain.name}?`} description="All mailboxes, aliases and messages on this domain will be permanently deleted."
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" disabled={confirm !== domain.name} loading={m.isPending} onClick={() => m.mutate()}>Remove permanently</Button></>}>
        <Field label={`Type ${domain.name} to confirm`}>{(p) => <Input {...p} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />}</Field>
      </Dialog>
    </Card>
  );
}
