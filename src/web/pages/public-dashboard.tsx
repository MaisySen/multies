/**
 * R91: the public read only dashboard (/dash/:token). No account needed. Shows the dashboard's own numbers as
 * the person who shared it sees them, with names but no ids or emails, "Updated" time and Refresh. A link
 * with a password asks for it first. Works at 390 and 1280, light and dark.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { Button } from "@/web/components/ui/button";
import { Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Field, Input } from "@/web/components/ui/input";
import { IconDashboard } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { WidgetBody, type Widget } from "./app/work/dashboards";

interface PublicDashboard {
  name: string; brand: string | null; updatedAt: string; timeZone: string;
  widgets: { id: string; type: string; title: string; chart: string; size: number; groupBy: string | null; settings: Record<string, unknown> }[];
  data: { id: string; type: string; data: unknown; error: string | null }[];
}
type State = { kind: "loading" } | { kind: "ok"; d: PublicDashboard } | { kind: "password"; wrong: boolean } | { kind: "gone" } | { kind: "error"; message: string };

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? "just now" : m === 1 ? "1 minute ago" : m < 60 ? `${m} minutes ago` : new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export function PublicDashboardPage() {
  const { token = "" } = useParams();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const pwRef = useRef<string>("");
  const load = async (opts: { refresh?: boolean; pw?: string } = {}) => {
    setBusy(true);
    try {
      let stored = "";
      try { stored = sessionStorage.getItem(`dash-pw:${token}`) ?? ""; } catch { /* storage blocked */ }
      const pw = opts.pw ?? (pwRef.current || stored);
      const r = await fetch(`/api/dash-public/${encodeURIComponent(token)}${opts.refresh ? "?refresh=1" : ""}`, { headers: pw ? { "x-share-password": pw } : {} });
      const body = await r.json().catch(() => ({})) as { dashboard?: PublicDashboard; error?: { code: string; message: string } };
      if (r.ok && body.dashboard) { if (pw) { pwRef.current = pw; try { sessionStorage.setItem(`dash-pw:${token}`, pw); } catch { /* storage blocked */ } } setState({ kind: "ok", d: body.dashboard }); }
      else if (r.status === 401) { pwRef.current = ""; try { sessionStorage.removeItem(`dash-pw:${token}`); } catch { /* storage blocked */ } setState({ kind: "password", wrong: body.error?.code === "password_wrong" }); }
      else if (r.status === 404) setState({ kind: "gone" });
      else setState({ kind: "error", message: body.error?.message ?? "Something went wrong. Try again in a minute." });
    } catch { setState({ kind: "error", message: "We couldn't reach the dashboard. Check your connection and try again." }); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = state.kind === "ok" ? state.d.name : "Shared dashboard"; }, [state]);
  const submit = (e: FormEvent) => { e.preventDefault(); if (password) void load({ pw: password }); };
  return (
    <div className="min-h-dvh bg-canvas text-fg">
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10" data-testid="public-dashboard">
        {state.kind === "loading" && <div className="space-y-4"><Skeleton className="h-8 w-60" /><div className="grid gap-4 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-60" />)}</div></div>}
        {state.kind === "gone" && <EmptyState className="mt-16" icon={<IconDashboard className="h-6 w-6" />} title="This link isn't available" body="It was turned off or it expired. Ask the person who sent it for a new one." />}
        {state.kind === "error" && <EmptyState className="mt-16" icon={<IconDashboard className="h-6 w-6" />} title="Couldn't open the dashboard" body={state.message} action={<Button onClick={() => void load()}>Try again</Button>} />}
        {state.kind === "password" && (
          <Card className="mx-auto mt-16 max-w-sm p-6">
            <form onSubmit={submit} className="space-y-4" data-testid="public-password">
              <div><h1 className="text-lg font-semibold">This dashboard has a password</h1><p className="mt-1 text-[13px] text-muted">Enter the password you were given to see it.</p></div>
              <Field label="Password" error={state.wrong ? "That password isn't right." : undefined}>{(fp) => (<><Input {...fp} type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></>)}</Field>
              <Button type="submit" className="w-full" disabled={!password || busy}>{busy ? "Opening" : "Open dashboard"}</Button>
            </form>
          </Card>
        )}
        {state.kind === "ok" && (
          <>
            <header className="mb-6 flex flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1">
                {state.d.brand && <p className="mb-1 truncate text-[12px] font-semibold uppercase tracking-wide text-subtle">{state.d.brand}</p>}
                <h1 className="truncate text-2xl font-semibold" title={state.d.name}>{state.d.name}</h1>
                <p className="mt-1 text-[13px] text-muted">Read only · updated {ago(state.d.updatedAt)}</p>
              </div>
              <Button variant="secondary" onClick={() => void load({ refresh: true })} disabled={busy}>{busy ? "Refreshing" : "Refresh"}</Button>
            </header>
            {!state.d.widgets.length ? <EmptyState icon={<IconDashboard className="h-6 w-6" />} title="Nothing here yet" body="This dashboard has no cards yet." /> : (
              <div className="grid gap-4 md:grid-cols-2">
                {state.d.widgets.map((w, i) => {
                  const res = state.d.data.find((x) => x.id === w.id);
                  const widget = { ...w.settings, id: w.id, type: w.type, title: w.title, chart: w.chart, size: w.size, groupBy: w.groupBy, source: {}, position: i } as unknown as Widget;
                  return (
                    <Card key={w.id} className={cn("flex flex-col p-4", w.size === 2 && "md:col-span-2")} data-testid="public-widget">
                      <h2 className="mb-3 truncate text-[13px] font-semibold" title={w.title}>{w.title}</h2>
                      <div className="min-h-0 flex-1">{!res ? <Skeleton className="h-40" /> : res.error ? <p className="py-10 text-center text-[13px] text-muted">{res.error}</p> : (res.data as { publicList?: boolean } | null)?.publicList ? <PublicCounts data={res.data as Record<string, unknown>} /> : <WidgetBody w={widget} data={res.data} />}</div>
                    </Card>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

const COUNT_LABEL: Record<string, string> = { overdue: "Overdue", dueThisWeek: "Due this week", tasksCount: "Tasks", itemsCount: "Items", total: "Total", count: "Count", open: "Open", done: "Done" };
/** Numbers only: a list widget on a public link shows its counts, never the titles behind them. */
function PublicCounts({ data }: { data: Record<string, unknown> }) {
  const nums = Object.entries(data).filter(([k, v]) => typeof v === "number" && k !== "publicV").slice(0, 4) as [string, number][];
  return (
    <div className="grid grid-cols-2 gap-3 py-2" data-testid="public-counts">
      {nums.map(([k, v]) => (
        <div key={k} className="rounded-lg bg-fill px-3 py-3">
          <p className="text-2xl font-semibold tabular-nums">{v.toLocaleString()}</p>
          <p className="text-[12.5px] text-muted">{COUNT_LABEL[k] ?? k.replace(/Count$/, "").replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}</p>
        </div>
      ))}
    </div>
  );
}
