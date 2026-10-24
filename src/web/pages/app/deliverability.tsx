import { useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, FileUp, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { api, ApiError } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input } from "@/web/components/ui/input";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { LOCALE } from "@/shared/locale";

interface Factor { id: string; label: string; points: number; max: number; status: "good" | "warn" | "bad" | "unknown"; detail: string }
interface Health { domainId: string; domain: string; score: number; grade: "healthy" | "attention" | "at_risk"; factors: Factor[]; stats: { sent: number; bounceRate: number; complaintRate: number; dmarcMessages: number; dmarcPassRate: number | null } }
interface Suppression { id: string; address: string; reason: "hard_bounce" | "complaint" | "manual"; detail: string | null; createdAt: string }
interface Dmarc {
  reports: { id: string; domain: string; reporter: string; beginAt: string; endAt: string; messages: number; passed: number; policy: { p: string } }[];
  sources: { sourceIp: string; domain: string; messages: number; passed: number; dkimPass: number; spfPass: number }[];
}

const gradeLabel = { healthy: "Healthy", attention: "Needs attention", at_risk: "At risk" } as const;
const gradeTone = { healthy: "ok", attention: "warn", at_risk: "bad" } as const;
const reasonLabel = { hard_bounce: "Hard bounce", complaint: "Spam complaint", manual: "Added by hand" } as const;
const day = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, { month: "short", day: "numeric", timeZone: "UTC" });
const pct = (n: number) => `${n < 1 && n > 0 ? n.toFixed(2) : Math.round(n * 10) / 10}%`;

export function DeliverabilityPage() {
  return (
    <>
      <PageHeader title="Deliverability" description="Whether your mail lands in the inbox, and what to fix when it doesn't." />
      <div className="space-y-8">
        <HealthSection />
        <DmarcSection />
        <SuppressionSection />
      </div>
    </>
  );
}

function HealthSection() {
  const q = useQuery({ queryKey: ["deliverability", "health"], queryFn: async () => (await api.get<{ domains: Health[] }>("/deliverability/health")).domains });
  if (q.isPending) return <Skeleton className="h-56" />;
  if (!q.data?.length) {
    return <Card><EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No domains yet" body="Add a domain and its health score shows up here." action={<ButtonLink to="/app/domains" size="sm">Add a domain</ButtonLink>} /></Card>;
  }
  return (
    <section aria-labelledby="health-h">
      <h2 id="health-h" className="mb-3 text-[15px] font-semibold">Domain health</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {q.data.map((h) => (
          <Card key={h.domainId} className="p-5">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Link to={`/app/domains/${h.domainId}`} className="block truncate font-medium hover:underline">{h.domain}</Link>
                <Badge tone={gradeTone[h.grade]} dot className="mt-1.5">{gradeLabel[h.grade]}</Badge>
              </div>
              <div className="text-right">
                <div className="font-mono text-3xl font-semibold tabular-nums leading-none">{h.score}</div>
                <div className="mt-1 text-xs text-subtle">out of 100</div>
              </div>
            </div>
            <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-line" role="img" aria-label={`Health score ${h.score} out of 100`}>
              <div className={cn("h-full rounded-full", h.grade === "healthy" ? "bg-ok" : h.grade === "attention" ? "bg-warn" : "bg-bad")} style={{ width: `${h.score}%` }} />
            </div>
            <ul className="space-y-2">
              {h.factors.map((f) => (
                <li key={f.id} className="flex items-start gap-3 text-sm">
                  <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", f.status === "good" ? "bg-ok" : f.status === "warn" ? "bg-warn" : f.status === "bad" ? "bg-bad" : "bg-subtle/50")} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex justify-between gap-2"><span className="font-medium">{f.label}</span><span className="font-mono text-xs tabular-nums text-subtle">{f.points}/{f.max}</span></div>
                    <div className="text-[13px] text-muted">{f.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </section>
  );
}

function DmarcSection() {
  const qc = useQueryClient();
  const me = useMe();
  const isAdmin = me.data?.organization?.role !== "member";
  const q = useQuery({ queryKey: ["deliverability", "dmarc"], queryFn: () => api.get<Dmarc>("/deliverability/dmarc") });
  const file = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return api.post<{ duplicate: boolean; domain: string; reporter: string; messages: number }>("/deliverability/dmarc/reports", { filename: f.name, contentB64: btoa(bin) });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["deliverability"] });
      toast.success(r.duplicate ? "Already had that report." : `Report from ${r.reporter} for ${r.domain}: ${r.messages} messages.`);
    },
    onError: (e) => showError(e),
  });
  return (
    <section aria-labelledby="dmarc-h">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="dmarc-h" className="text-[15px] font-semibold">DMARC reports</h2>
          <p className="text-[13px] text-muted">Mailbox providers send these daily. They show every server sending as your domain, and whether it passed.</p>
        </div>
        {isAdmin && (
          <>
            <input ref={file} type="file" aria-label="DMARC report file" accept=".xml,.gz,.zip,application/xml,application/gzip,application/zip" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }} />
            <Button size="sm" variant="secondary" loading={upload.isPending} onClick={() => file.current?.click()}><FileUp className="h-4 w-4" />Upload a report</Button>
          </>
        )}
      </div>
      {q.isPending ? <Skeleton className="h-40" /> : !q.data?.reports.length ? (
        <Card className="p-5 text-sm text-muted">
          No reports in the last 30 days. Reports arrive by email at the address in your DMARC record's <code className="font-mono text-[12.5px]">rua=</code> tag.
          Point it at a mailbox here, for example <code className="font-mono text-[12.5px]">rua=mailto:dmarc@yourdomain.com</code>, and they are read automatically.
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="overflow-hidden lg:col-span-3">
            <div className="border-b border-line px-4 py-2.5 text-xs font-medium text-muted">Sending sources, last 30 days</div>
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Sending sources">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-subtle"><tr><th className="px-4 py-2 font-medium">Source IP</th><th className="px-4 py-2 font-medium">Domain</th><th className="px-4 py-2 text-right font-medium">Messages</th><th className="px-4 py-2 text-right font-medium">Passed</th></tr></thead>
                <tbody>
                  {q.data.sources.map((s) => {
                    const rate = s.messages ? (s.passed / s.messages) * 100 : 0;
                    return (
                      <tr key={`${s.domain}|${s.sourceIp}`} className="border-t border-line">
                        <td className="px-4 py-2 font-mono text-[12.5px]">{s.sourceIp}</td>
                        <td className="px-4 py-2 text-muted">{s.domain}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">{s.messages.toLocaleString(LOCALE)}</td>
                        <td className={cn("px-4 py-2 text-right font-mono tabular-nums", rate >= 98 ? "text-ok" : rate >= 50 ? "text-warn" : "text-bad")}>{pct(rate)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          <Card className="overflow-hidden lg:col-span-2">
            <div className="border-b border-line px-4 py-2.5 text-xs font-medium text-muted">Recent reports</div>
            <ul className="divide-y divide-line">
              {q.data.reports.slice(0, 8).map((r) => (
                <li key={r.id} className="px-4 py-2.5 text-sm">
                  <div className="flex justify-between gap-2"><span className="font-medium">{r.reporter}</span><span className="font-mono text-xs tabular-nums text-subtle">{r.passed}/{r.messages} passed</span></div>
                  <div className="text-xs text-muted">{r.domain}, {day(r.beginAt)}{day(r.beginAt) !== day(r.endAt) ? ` to ${day(r.endAt)}` : ""}, policy p={r.policy.p}</div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </section>
  );
}

function SuppressionSection() {
  const qc = useQueryClient();
  const me = useMe();
  const isAdmin = me.data?.organization?.role !== "member";
  const q = useQuery({ queryKey: ["deliverability", "suppressions"], queryFn: async () => (await api.get<{ suppressions: Suppression[] }>("/deliverability/suppressions")).suppressions });
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const add = useMutation({
    mutationFn: () => api.post("/deliverability/suppressions", { address }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["deliverability", "suppressions"] }); setOpen(false); setAddress(""); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/deliverability/suppressions/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["deliverability", "suppressions"] }); toast.success("Address unblocked"); },
  });
  return (
    <section aria-labelledby="sup-h">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="sup-h" className="text-[15px] font-semibold">Suppression list</h2>
          <p className="text-[13px] text-muted">We stop sending to addresses that bounce for good or report spam. Sending to them again hurts your reputation.</p>
        </div>
        {isAdmin && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Block an address</Button>}
      </div>
      <Card className="overflow-hidden">
        {q.isPending ? <Skeleton className="m-4 h-10" /> : !q.data?.length ? (
          <EmptyState icon={<Ban className="h-5 w-5" />} title="Nothing suppressed" body="Hard bounces and spam complaints land here on their own." className="py-10" />
        ) : (
          <ul className="divide-y divide-line">
            {q.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[13px]">{s.address}</div>
                  <div className="text-xs text-muted">{reasonLabel[s.reason]}{s.detail ? `: ${s.detail}` : ""}</div>
                </div>
                <div className="flex items-center gap-3 text-xs text-subtle">
                  <span>{timeAgo(s.createdAt)}</span>
                  {isAdmin && <button onClick={() => remove.mutate(s.id)} className="rounded p-1 hover:bg-hover hover:text-bad" aria-label={`Unblock ${s.address}`}><Trash2 className="h-3.5 w-3.5" /></button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} title="Block an address" description="Multies will not send to it from any mailbox in this workspace."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={add.isPending} disabled={!address.trim()} onClick={() => add.mutate()}>Block</Button></>}>
        <form onSubmit={(e) => { e.preventDefault(); if (address.trim()) add.mutate(); }}>
          <Field label="Email address" error={add.error instanceof ApiError ? add.error.message : undefined}>
            {(p) => <Input {...p} autoFocus type="email" value={address} onChange={(e) => setAddress(e.target.value)} />}
          </Field>
        </form>
      </Dialog>
    </section>
  );
}
