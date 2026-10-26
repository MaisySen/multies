import { useSearchParams } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Download, FileClock, Mail } from "lucide-react";
import { api } from "@/web/lib/api";
import type { AuditEntry, Delivery } from "@/web/lib/types";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { useMe } from "@/web/lib/queries";
import { describeAudit } from "@/web/components/app-bits";
import { fullDate, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";

const statusTone: Record<Delivery["status"], "ok" | "warn" | "bad" | "brand" | "neutral"> = {
  delivered: "ok", received: "ok", sent: "ok", forwarded: "brand", queued: "warn", failed: "bad", rejected: "bad",
  bounced: "bad", complained: "bad", delayed: "warn", suppressed: "neutral",
};

export function ActivityPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "audit" ? "audit" : "deliveries";
  const direction = params.get("direction") ?? "";
  const role = useMe().data?.organization?.role;
  const canExport = role === "owner" || role === "admin";
  return (
    <>
      <PageHeader title="Activity" description="Every message that moved through your domains, and every change anyone made." />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Activity type" className="inline-flex rounded-lg bg-fill p-0.5">
          {([["deliveries", "Delivery log"], ["audit", "Audit log"]] as const).map(([t, l]) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setParams(t === "audit" ? { tab: t } : {})}
              className={cn("rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors", tab === t ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>{l}</button>
          ))}
        </div>
        {tab === "deliveries" && (
          <div className="inline-flex rounded-lg border border-line p-0.5 text-[12.5px]">
            {[["", "All"], ["inbound", "Inbound"], ["outbound", "Outbound"]].map(([d, l]) => (
              <button key={d} onClick={() => setParams(d ? { direction: d } : {})} className={cn("rounded-md px-2.5 py-1", direction === d ? "bg-fill text-fg" : "text-muted hover:text-fg")}>{l}</button>
            ))}
          </div>
        )}
        {tab === "audit" && canExport && (
          <div className="ml-auto flex gap-2 text-[12.5px]">
            <a href="/api/org/audit/export?format=csv" download className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 font-medium text-muted hover:bg-hover hover:text-fg">
              <Download className="h-3.5 w-3.5" aria-hidden />Export CSV
            </a>
            <a href="/api/org/audit/export?format=json" download className="inline-flex items-center rounded-md border border-line px-2.5 py-1 font-medium text-muted hover:bg-hover hover:text-fg">JSON</a>
          </div>
        )}
      </div>
      {tab === "deliveries" ? <Deliveries direction={direction} /> : <Audit />}
    </>
  );
}

function useCursorList<T extends { createdAt: string }>(key: unknown[], path: string, pick: (r: unknown) => T[]) {
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: "",
    queryFn: async ({ pageParam }) => pick(await api.get(`${path}${path.includes("?") ? "&" : "?"}limit=50${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`)),
    getNextPageParam: (last) => (last.length === 50 ? last[last.length - 1].createdAt : undefined),
  });
}

function TableSkeleton() {
  return <Card className="divide-y divide-line">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="flex gap-4 p-4"><Skeleton className="h-4 w-24" /><Skeleton className="h-4 flex-1" /><Skeleton className="h-4 w-16" /></div>)}</Card>;
}

function Deliveries({ direction }: { direction: string }) {
  const q = useCursorList<Delivery>(["deliveries", direction], `/deliveries${direction ? `?direction=${direction}` : ""}`, (r) => (r as { deliveries: Delivery[] }).deliveries);
  const rows = q.data?.pages.flat() ?? [];
  if (q.isPending) return <TableSkeleton />;
  if (!rows.length) return <Card><EmptyState icon={<Mail />} title="No deliveries yet" body="Inbound, outbound and forwarded mail will be logged here with its status and the reason behind it." /></Card>;
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Log entries">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead><tr className="border-b border-line text-left text-xs text-subtle">
            <th scope="col" className="px-4 py-2.5 font-medium">When</th><th scope="col" className="px-4 py-2.5 font-medium">Route</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Subject</th><th scope="col" className="px-4 py-2.5 font-medium">Status</th><th scope="col" className="px-4 py-2.5 font-medium">Detail</th>
          </tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((d) => (
              <tr key={d.id} className="hover:bg-hover">
                <td className="whitespace-nowrap px-4 py-3 text-muted" title={fullDate(d.createdAt)}>{timeAgo(d.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {d.direction === "inbound" ? <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-brand-hover" aria-label="Inbound" /> : <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-ok" aria-label="Outbound" />}
                    <span className="max-w-44 truncate text-muted">{d.fromAddress}</span><ArrowRight className="h-3.5 w-3.5 shrink-0 text-subtle" aria-label="to" /><span className="max-w-44 truncate">{d.toAddress}</span>
                  </div>
                </td>
                <td className="max-w-56 truncate px-4 py-3">{d.subject || <span className="text-subtle">(no subject)</span>}</td>
                <td className="px-4 py-3"><Badge tone={statusTone[d.status]}>{d.status}</Badge></td>
                <td className="max-w-72 truncate px-4 py-3 text-xs text-subtle" title={d.detail ?? ""}>{d.provider} · {d.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && <div className="border-t border-line p-2"><Button variant="ghost" className="w-full" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button></div>}
    </Card>
  );
}

function Audit() {
  const q = useCursorList<AuditEntry>(["audit"], "/org/audit", (r) => (r as { entries: AuditEntry[] }).entries);
  const rows = q.data?.pages.flat() ?? [];
  if (q.isPending) return <TableSkeleton />;
  if (!rows.length) return <Card><EmptyState icon={<FileClock />} title="No activity yet" body="Changes to domains, mailboxes, aliases, keys and plans are recorded here." /></Card>;
  return (
    <Card className="divide-y divide-line">
      {rows.map((e) => {
        const { verb, object, subject } = describeAudit(e);
        return (
          <div key={e.id} className="flex flex-col gap-1 px-4 py-3 text-[13px] sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0"><span className="font-medium">{subject ?? e.actorEmail ?? "System"}</span> <span className="text-muted">{verb}</span>{object && <span className="font-medium"> {object}</span>}</span>
            <span className="flex shrink-0 items-center gap-3 text-xs text-subtle">{e.ip && e.ip !== "unknown" && <span className="font-mono">{e.ip}</span>}<time dateTime={e.createdAt} title={fullDate(e.createdAt)}>{timeAgo(e.createdAt)}</time></span>
          </div>
        );
      })}
      {q.hasNextPage && <div className="p-2"><Button variant="ghost" className="w-full" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button></div>}
    </Card>
  );
}
