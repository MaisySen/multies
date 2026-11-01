/** R87: the link domain. Short links and bio pages use the workspace's own verified domain when one is set up. */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { IconGlobe, IconRefresh } from "@/web/components/ui/icon";
import type { LinkHostInfo } from "@/shared/links";
import { plainUrl, useLinkHost } from "./data";
import { LoadErrorInline } from "@/web/components/load-error-t1g";

const STATE: Record<LinkHostInfo["status"], { label: string; tone: "ok" | "warn" | "neutral" | "bad"; body: string }> = {
  none: { label: "Not set", tone: "neutral", body: "" },
  pending: { label: "Waiting for DNS", tone: "warn", body: "Add the record below at your DNS provider, then check again. Changes can take up to an hour to show." },
  dns_ok: { label: "DNS found", tone: "warn", body: "Your record points at us. Multies support finishes the secure certificate for this name, usually within one working day, and switches it on. Until then your links keep using the address below." },
  live: { label: "Live", tone: "ok", body: "New and existing short links and bio pages use this domain." },
  failed: { label: "Record not found", tone: "bad", body: "We couldn't find the record. Check the name and the value, then try again." },
};

export function DomainTab() {
  const q = useLinkHost();
  const qc = useQueryClient();
  const [domainId, setDomainId] = useState("");
  const [sub, setSub] = useState("go");
  const h = q.data;
  useEffect(() => { if (h?.verifiedDomains[0] && !domainId) setDomainId(h.verifiedDomains[0].id); }, [h, domainId]);
  const done = (r: LinkHostInfo) => { qc.setQueryData(["links-host"], r); void qc.invalidateQueries({ queryKey: ["links"] }); };
  const set = useMutation({ mutationFn: () => api.put<LinkHostInfo>("/links/host", { domainId, sub }), onSuccess: (r) => { done(r); toast.success("Saved. Add the DNS record next."); }, onError: (e) => toast.error(errorMessage(e), { id: "links-domain-error" }) });
  const check = useMutation({ mutationFn: () => api.post<LinkHostInfo>("/links/host/check", {}), onSuccess: (r) => { done(r); toast[r.status === "failed" || r.status === "pending" ? "error" : "success"](STATE[r.status].label); }, onError: (e) => toast.error(errorMessage(e), { id: "links-domain-error" }) });
  const remove = useMutation({ mutationFn: () => api.del<LinkHostInfo>("/links/host"), onSuccess: (r) => { done(r); toast.success("Back to the standard address"); }, onError: (e) => toast.error(errorMessage(e), { id: "links-domain-error" }) });

  if (q.isError) return <Card className="mt-4 p-6 text-center"><LoadErrorInline onRetry={() => q.refetch()} /></Card>;
  if (!h) return <div className="space-y-3 pt-4" aria-busy="true"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-40 rounded-xl" /></div>;
  const st = STATE[h.status];
  const name = h.host?.split(".")[0] ?? sub;
  return (
    <div className="max-w-2xl space-y-4 pt-4" data-testid="links-domain">
      <Card className="p-4 sm:p-5">
        <p className="text-[12.5px] text-muted">Your links look like</p>
        <p className="mt-0.5 break-all text-[17px] font-semibold">{plainUrl(h.base)}/spring-sale</p>
        {h.host && h.status !== "live" && <p className="mt-1 text-[12.5px] text-muted">Switches to {h.host}/l when the domain is live.</p>}
      </Card>
      {h.host ? (
        <Card className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[15px] font-semibold">{h.host}</h2><Badge tone={st.tone} dot>{st.label}</Badge></div>
          <p className="text-sm text-muted">{st.body}</p>
          {h.status !== "live" && (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-sm"><thead className="bg-fill/60 text-left text-[12px] text-muted"><tr><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Value</th></tr></thead>
                <tbody><tr><td className="px-3 py-2.5 font-medium">CNAME</td><td className="px-3 py-2.5"><span className="mr-2">{name}</span><CopyButton value={name} toastText="Name copied" /></td><td className="px-3 py-2.5"><span className="mr-2 break-all">{h.target}</span><CopyButton value={h.target} toastText="Value copied" /></td></tr></tbody></table>
            </div>
          )}
          {h.canEdit && <div className="flex flex-wrap gap-2">
            {h.status !== "live" && <Button onClick={() => check.mutate()} loading={check.isPending} data-testid="domain-check"><IconRefresh className="h-4 w-4" />Check DNS</Button>}
            <Button variant="ghost" onClick={() => remove.mutate()} loading={remove.isPending}>Stop using this domain</Button>
          </div>}
        </Card>
      ) : !h.verifiedDomains.length ? (
        <Card><EmptyState icon={<IconGlobe />} title="Use your own domain" body={<>Verify a domain for your workspace first, then come back to put your short links on it, like go.yourcompany.com/sale.</>} action={h.canEdit ? <Link to="/app/domains" className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg hover:bg-brand/90 max-sm:min-h-11">Set up a domain</Link> : undefined} /></Card>
      ) : h.canEdit ? (
        <Card className="space-y-4 p-4 sm:p-5">
          <div><h2 className="text-[15px] font-semibold">Use your own domain</h2><p className="mt-0.5 text-sm text-muted">Pick a name on one of your verified domains. Short links become {sub || "go"}.{h.verifiedDomains.find((d) => d.id === domainId)?.name ?? "yourcompany.com"}/l/name.</p></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">{(fp) => (<><Input {...fp} value={sub} onChange={(e) => setSub(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} maxLength={30} placeholder="go" data-testid="domain-sub" /></>)}</Field>
            <Field label="Domain">{(fp) => (<><Select {...fp} value={domainId} onChange={(e) => setDomainId(e.target.value)}>{h.verifiedDomains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></>)}</Field>
          </div>
          <Button onClick={() => set.mutate()} loading={set.isPending} disabled={!sub || !domainId} data-testid="domain-save">Continue</Button>
        </Card>
      ) : <p className="text-sm text-muted">An admin can put your links on the workspace's own domain.</p>}
    </div>
  );
}
