/**
 * R118: Social, Analytics. Reach, engagement and clicks per post and per account for the networks that share them
 * (Facebook, Instagram, Pinterest, Threads), and the best times to post from this workspace's own results.
 */
import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { timeAgo } from "@/web/lib/format";
import { Card, EmptyState, PageHeader, Skeleton, StatTile } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconChart, IconClock, IconExternalLink, IconRefresh, IconSend, IconTrendingUp, IconUser } from "@/web/components/ui/icon";
import { networkLabel } from "@/shared/social-p2";
import {
  ANALYTICS_RANGES, DAY_LABELS, bestTimes, byAccount, capsOf, engagementRate, fmtCount, fmtHour, fmtRate, totalsOf, type AnalyticsResponse,
} from "@/shared/social-p2b";
import { LoadError, NewPostButton, SocialSwitcher, useSocialP2b } from "./social";

const appName = (app: string) => (app === "testnet" ? "Test network" : networkLabel(app));
const key = (range: number) => ["social-analytics", range] as const;

function Heatmap({ grid }: { grid: (number | null)[][] }) {
  const max = Math.max(0.0001, ...grid.flat().filter((v): v is number => v != null));
  return (
    <div className="overflow-x-auto" data-testid="best-time-grid">
      <table className="w-full min-w-[320px] border-separate border-spacing-[2px] text-[11px]" aria-label="Engagement rate by day and hour">
        <thead><tr><th className="w-9" /><th colSpan={24} className="text-left font-normal text-subtle"><span className="flex justify-between"><span>12 am</span><span>6 am</span><span>12 pm</span><span>6 pm</span><span>11 pm</span></span></th></tr></thead>
        <tbody>
          {grid.map((row, d) => (
            <tr key={d}>
              <th scope="row" className="pr-1 text-left font-medium text-muted">{DAY_LABELS[d]}</th>
              {row.map((v, h) => (
                <td key={h} className="h-4 rounded-[3px] bg-fill p-0" title={v == null ? `${DAY_LABELS[d]} ${fmtHour(h)}: no posts` : `${DAY_LABELS[d]} ${fmtHour(h)}: ${fmtRate(v)}`}>
                  {v != null && <span className="block h-4 rounded-[3px] bg-brand" style={{ opacity: 0.25 + 0.75 * (v / max) }} aria-hidden />}
                  <span className="sr-only">{v == null ? "No posts" : fmtRate(v)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SocialAnalyticsPage() {
  const on = useSocialP2b();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const range = ANALYTICS_RANGES.find((r) => String(r) === params.get("range")) ?? 30;
  const q = useQuery({ queryKey: key(range), queryFn: () => api.get<AnalyticsResponse>(`/social/analytics?range=${range}`), enabled: on, placeholderData: (p) => p });
  const sync = useMutation({
    mutationFn: (_manual: boolean) => api.post<{ fetched: number; skipped: boolean }>("/social/analytics/sync", {}),
    onSuccess: (r, manual) => { if (manual && !r.skipped) toast.success(r.fetched ? "Results updated" : "Up to date"); void qc.invalidateQueries({ queryKey: ["social-analytics"] }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't ask the networks. Try again.")),
  });
  const asked = useRef(false);
  useEffect(() => { if (q.data?.stale && !asked.current) { asked.current = true; sync.mutate(false); } }, [q.data?.stale, sync]);
  const data = q.data;
  const supportedRows = useMemo(() => (data?.rows ?? []).filter((r) => capsOf(r.app).analytics), [data]);
  const totals = useMemo(() => totalsOf(supportedRows), [supportedRows]);
  const accounts = useMemo(() => byAccount(supportedRows), [supportedRows]);
  const best = useMemo(() => bestTimes(supportedRows, new Date().getTimezoneOffset()), [supportedRows]);
  const top = useMemo(() => [...supportedRows].filter((r) => r.engagement != null).sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0)).slice(0, 8), [supportedRows]);
  const unsupported = (data?.accounts ?? []).filter((a) => !a.supported);

  if (!on) return <div><PageHeader title="Analytics" /><Card className="p-5 text-sm text-muted">Social analytics isn't switched on for this workspace yet.</Card></div>;
  return (
    <div data-testid="social-analytics">
      <PageHeader title="Analytics" description="Reach, engagement and clicks per post and per account, and the best times to post."
        actions={<div className="flex flex-wrap gap-2">
          <div role="tablist" aria-label="Period" className="flex gap-1 rounded-lg border border-line bg-fill/50 p-1">
            {ANALYTICS_RANGES.map((r) => (
              <button key={r} type="button" role="tab" aria-selected={range === r} onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.set("range", String(r)); return n; }, { replace: true })}
                className={cn("inline-flex min-h-9 items-center rounded-md px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  range === r ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")} data-testid={`range-${r}`}>{r} days</button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => sync.mutate(true)} loading={sync.isPending} data-testid="analytics-refresh"><IconRefresh className="h-4 w-4" aria-hidden />Refresh</Button>
        </div>} />
      <SocialSwitcher />

      {q.isPending ? (
        <div className="space-y-4" aria-busy="true"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div><Skeleton className="h-64 rounded-xl" /></div>
      ) : q.error && !data ? <LoadError error={q.error} retry={() => void q.refetch()} what="analytics" />
        : !data?.rows.length ? (
          <Card data-testid="analytics-empty"><EmptyState icon={<IconChart />} title="No results yet"
            body={`Results show here once posts go out to Facebook, Instagram, Pinterest or Threads. Nothing was sent in the last ${range} days.`} action={<NewPostButton />} /></Card>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="analytics-totals">
              <StatTile label="Posts sent" value={data.sent} icon={<IconSend />} />
              <StatTile label="Reach" value={fmtCount(totals.reach)} icon={<IconUser />} hint="People who saw them" />
              <StatTile label="Engagement" value={fmtCount(totals.engagement)} icon={<IconTrendingUp />} hint="Likes, comments, shares" />
              <StatTile label="Clicks" value={fmtCount(totals.clicks)} icon={<IconExternalLink />} />
              <StatTile label="Engagement rate" value={fmtRate(totals.rate)} icon={<IconChart />} hint="Engagement for each person reached" />
            </div>
            <p className="-mt-3 px-1 text-[12px] text-subtle">{data.syncedAt ? `Numbers from the networks, checked ${timeAgo(data.syncedAt)}.` : "Asking the networks for numbers."}</p>

            <section aria-labelledby="an-accounts">
              <h2 id="an-accounts" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">By account</h2>
              <Card className="divide-y divide-line" data-testid="analytics-accounts">
                {accounts.map((a) => (
                  <div key={a.accountId} className="grid grid-cols-2 gap-x-4 gap-y-1 p-4 text-[13px] sm:grid-cols-[minmax(0,1.6fr)_repeat(5,minmax(0,1fr))] sm:items-center md:px-5">
                    <p className="col-span-2 min-w-0 truncate text-[14px] font-medium sm:col-span-1">{appName(a.app)}<span className="text-muted">{a.label && a.label !== appName(a.app) ? `, ${a.label}` : ""}</span></p>
                    <p><span className="text-muted sm:sr-only">Posts </span>{a.posts}</p>
                    <p><span className="text-muted sm:sr-only">Reach </span>{fmtCount(a.reach)}</p>
                    <p><span className="text-muted sm:sr-only">Engagement </span>{fmtCount(a.engagement)}</p>
                    <p><span className="text-muted sm:sr-only">Clicks </span>{fmtCount(a.clicks)}</p>
                    <p><span className="text-muted sm:sr-only">Rate </span>{fmtRate(a.rate)}</p>
                  </div>
                ))}
                {unsupported.map((a) => (
                  <div key={a.accountId} className="p-4 text-[13px] md:px-5" data-testid={`analytics-unsupported-${a.app}`}>
                    <p className="text-[14px] font-medium">{appName(a.app)}<span className="text-muted">{a.label && a.label !== appName(a.app) ? `, ${a.label}` : ""}</span></p>
                    <p className="text-muted">{capsOf(a.app).note ?? "This network doesn't share results with Multies yet."}</p>
                  </div>
                ))}
              </Card>
              <p className="mt-2 hidden px-1 text-[12px] text-subtle sm:block">Columns: posts, reach, engagement, clicks and engagement rate.</p>
            </section>

            <section aria-labelledby="an-best">
              <h2 id="an-best" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">Best time to post</h2>
              <Card className="p-4 md:p-5" data-testid="analytics-best">
                {!best.ready ? (
                  <p className="flex items-center gap-2 text-[13.5px] text-muted"><IconClock className="h-4 w-4" aria-hidden />Post {best.need} more {best.need === 1 ? "time" : "times"} with results to see your best times.</p>
                ) : (
                  <>
                    <ol className="mb-4 flex flex-wrap gap-2" aria-label="Top times">
                      {best.top.map((t, i) => <li key={i} className="rounded-lg border border-line px-3 py-2 text-[13px]"><span className="font-semibold">{DAY_LABELS[t.day]} {fmtHour(t.hour)}</span><span className="text-muted"> · {fmtRate(t.rate)} engagement</span></li>)}
                    </ol>
                    <Heatmap grid={best.grid} />
                    <p className="mt-2 text-[12px] text-subtle">In your time zone, from {best.posts} posts. Darker means more engagement for each person reached.</p>
                  </>
                )}
              </Card>
            </section>

            <section aria-labelledby="an-top">
              <h2 id="an-top" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">Top posts</h2>
              <Card className="divide-y divide-line" data-testid="analytics-top">
                {!top.length ? <p className="p-4 text-[13.5px] text-muted">Numbers arrive a few minutes after a post goes out.</p> : top.map((r) => (
                  <div key={`${r.postId}-${r.accountId}`} className="flex flex-wrap items-start gap-3 p-4 md:px-5">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 break-words text-[14px]">{r.text || "(image only)"}</p>
                      <p className="mt-1 text-[12px] text-muted">{appName(r.app)} · {new Date(r.sentAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</p>
                    </div>
                    <dl className="grid grid-cols-4 gap-3 text-[12.5px]">
                      <div><dt className="text-muted">Reach</dt><dd className="font-medium tabular-nums">{fmtCount(r.reach)}</dd></div>
                      <div><dt className="text-muted">Engaged</dt><dd className="font-medium tabular-nums">{fmtCount(r.engagement)}</dd></div>
                      <div><dt className="text-muted">Clicks</dt><dd className="font-medium tabular-nums">{fmtCount(r.clicks)}</dd></div>
                      <div><dt className="text-muted">Rate</dt><dd className="font-medium tabular-nums">{fmtRate(engagementRate(r.reach, r.engagement))}</dd></div>
                    </dl>
                    {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-muted hover:bg-hover hover:text-fg" aria-label="Open the post"><IconExternalLink className="h-4 w-4" aria-hidden />Open</a>}
                  </div>
                ))}
              </Card>
              <p className="mt-2 px-1 text-[12px] text-subtle">LinkedIn, TikTok and Reddit don't share results with Multies yet. <Link to="/app/social/accounts" className="font-medium underline underline-offset-2">See what each account can do</Link>.</p>
            </section>
          </div>
        )}
    </div>
  );
}
