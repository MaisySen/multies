/**
 * R80C: Settings, Connections. The workspace's outside apps (social networks first, then everything else in the
 * catalog) and the Social posts panel, as two tabs of one pane: /app/settings/apps and /app/settings/apps/social.
 * R82F (MB-279): the one home for outside apps. Mail accounts (was Settings, Connected accounts) and Webhooks (was
 * Workspace, Integrations) are tabs here too: /app/settings/apps/mail and /app/settings/apps/webhooks; the old
 * addresses redirect.
 * The big app list loads as its own file when the pane opens. Connecting opens the provider's sign in page and comes
 * back here (?connected_account_id=...), where we confirm it with the server. Server: /api/apps and /api/social
 * (contract in src/shared/integrations.ts). Sign in tokens never reach the browser.
 */
import { lazyPage } from "@/web/components/lazy-page";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { timeAgo } from "@/web/lib/format";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Input } from "@/web/components/ui/input";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { IconClock, IconKey, IconLock, IconMegaphone, IconPlug, IconRefresh, IconSearch, IconTrash } from "@/web/components/ui/icon";
import { APP_GROUPS, SOCIAL_FIRST, type AppAvailability, type AppGroup, type ConnectedAccountView } from "@/shared/integrations";
// R82F (MB-280): the Social posts panel loads with its own tab.
const SocialPanel = lazyPage(() => import("./apps-social"), "SocialPanel", { quiet: true });
// R83: TikTok and Threads through our own sign in, at the top of the Social posts tab.
const DirectAccounts = lazyPage(() => import("./apps-direct"), "DirectAccounts", { quiet: true });

// R82F (MB-279, MB-280): the two older panes load only when their tab opens, so the Apps tab stays light.
const MailAccounts = lazyPage(() => import("./connections"), "ConnectionsSettings", { quiet: true });
const Webhooks = lazyPage(() => import("./work/integrations"), "IntegrationsPage", { quiet: true });

export interface CatalogApp { slug: string; name: string; description: string; group: AppGroup; availability: AppAvailability; canPost: boolean }
interface AppsStatus { available: boolean; canManage: boolean }

export const appsKeys = { status: ["apps", "status"] as const, accounts: ["apps", "accounts"] as const, catalog: ["apps", "catalog"] as const };

/**
 * R82F (MB-280): opened straight on Connections, the two calls start as soon as this file runs (it is fetched beside
 * the settings frame), and the first query takes that answer instead of asking again. Used once; a failure asks again.
 */
const early: { status?: Promise<AppsStatus>; accounts?: Promise<{ accounts: ConnectedAccountView[] }> } = {};
if (typeof window !== "undefined" && window.location.pathname.startsWith("/app/settings/apps")) {
  early.status = api.get<AppsStatus>("/apps/status"); early.status.catch(() => {});
  early.accounts = api.get<{ accounts: ConnectedAccountView[] }>("/apps/accounts"); early.accounts.catch(() => {});
}
function takeEarly<K extends keyof typeof early>(k: K): (typeof early)[K] { const p = early[k]; early[k] = undefined; return p; }

export function useAppsStatus() {
  return useQuery({ queryKey: appsKeys.status, queryFn: () => takeEarly("status")?.catch(() => api.get<AppsStatus>("/apps/status")) ?? api.get<AppsStatus>("/apps/status"), staleTime: 60_000 });
}
export function useAppAccounts(enabled = true) {
  const get = () => api.get<{ accounts: ConnectedAccountView[] }>("/apps/accounts");
  return useQuery({ queryKey: appsKeys.accounts, queryFn: () => (takeEarly("accounts")?.catch(get) ?? get()).then((r) => r.accounts), enabled, staleTime: 15_000 });
}
/**
 * R82F (MB-280): the first screen reads a short list (social networks and the most used apps, about 5 KB); the whole
 * catalog (about 90 KB) loads once you search, pick a category, ask for more, or after the page has settled.
 */
// Started once, when this file loads, so the short list arrives with the page rather than after the status call.
let topLoad: Promise<{ total: number; apps: CatalogApp[] }> | null = null;
const loadTop = () => (topLoad ??= import("@/shared/connections-catalog-top.json").then((m) => m.default as { total: number; apps: CatalogApp[] }).catch((e) => { topLoad = null; throw e; }));
if (typeof window !== "undefined") void loadTop().catch(() => {});

export function useCatalog(wantAll: boolean) {
  const top = useQuery({
    queryKey: [...appsKeys.catalog, "top"],
    queryFn: loadTop,
    staleTime: Infinity,
  });
  const [idle, setIdle] = useState(false);
  useEffect(() => { const t = setTimeout(() => setIdle(true), 4000); return () => clearTimeout(t); }, []);
  const full = useQuery({
    queryKey: appsKeys.catalog,
    queryFn: async () => ((await import("@/shared/connections-catalog.json")).default as { apps: CatalogApp[] }).apps,
    staleTime: Infinity,
    enabled: wantAll || idle || top.isError,
  });
  const data = full.data ?? top.data?.apps;
  return {
    data,
    total: full.data?.length ?? top.data?.total ?? 0,
    complete: !!full.data,
    loadingMore: !full.data && full.isFetching,
    isPending: !data && (top.isPending || full.isPending),
    error: data ? null : full.error ?? (top.isError && !full.isFetching ? top.error : null),
    refetch: () => { void top.refetch(); void full.refetch(); },
  };
}

/** App logo through our own origin, with the first letter as a stand in while it loads or when there is none. */
export function AppLogo({ slug, name, size = "md" }: { slug: string; name: string; size?: "sm" | "md" | "lg" }) {
  const [failed, setFailed] = useState(false);
  // R82F (MB-280): a logo is fetched only when its card is about to show (the browser's own lazy loading starts
  // thousands of pixels early on a slow connection, which fetched every logo on the page at once).
  const box = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  const dims = size === "sm" ? "h-7 w-7 rounded-md text-[12px]" : size === "lg" ? "h-12 w-12 rounded-xl text-lg" : "h-10 w-10 rounded-lg text-[15px]";
  return (
    <span ref={box} className={cn("relative grid shrink-0 place-items-center overflow-hidden border border-line bg-surface font-semibold text-muted", dims)} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
      {!failed && near && <img src={`/api/apps/logo/${slug}`} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="absolute inset-0 h-full w-full bg-surface object-contain p-1.5" />}
    </span>
  );
}

const STATUS_COPY: Record<ConnectedAccountView["status"], { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  active: { label: "Connected", tone: "ok" },
  pending: { label: "Sign in not finished", tone: "warn" }, // R82F (MB-284): an abandoned sign in must not read as connected
  expired: { label: "Sign in expired", tone: "warn" },
  failed: { label: "Needs attention", tone: "bad" },
  disabled: { label: "Turned off", tone: "neutral" },
};

export type ConnectionsTab = "apps" | "social" | "mail" | "webhooks";
/** `short` is the phone label, so all four tabs fit at 390 px without a cut off last tab. */
export const CONNECTION_TABS: { id: ConnectionsTab; label: string; short: string; to: string }[] = [
  { id: "apps", label: "Apps", short: "Apps", to: "/app/settings/apps" },
  { id: "social", label: "Social posts", short: "Social", to: "/app/settings/apps/social" },
  { id: "mail", label: "Mail accounts", short: "Mail", to: "/app/settings/apps/mail" },
  { id: "webhooks", label: "Webhooks", short: "Webhooks", to: "/app/settings/apps/webhooks" },
];
export function connectionsTabFor(pathname: string): ConnectionsTab {
  const last = pathname.replace(/\/+$/, "").split("/").pop();
  return last === "social" || last === "mail" || last === "webhooks" ? last : "apps";
}

function Tabs({ current }: { current: ConnectionsTab }) {
  const tab = "relative inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted transition-colors duration-150 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-sm:min-h-11 max-sm:px-2.5";
  return (
    <nav aria-label="Connections" className="-mx-1 max-w-full overflow-x-auto px-1 [scrollbar-width:none]">
      <div className="inline-flex gap-1 rounded-lg bg-fill p-1" data-testid="apps-tabs">
        {CONNECTION_TABS.map((t) => (
          <NavLink key={t.id} to={t.to} end aria-current={current === t.id ? "page" : undefined} className={() => cn(tab, current === t.id && "bg-surface text-fg shadow-card")}><span className="sm:hidden">{t.short}</span><span className="max-sm:hidden">{t.label}</span></NavLink>
        ))}
      </div>
    </nav>
  );
}

function TabFallback() { return <div className="space-y-3" aria-busy="true"><Skeleton className="h-11 rounded-lg" /><Skeleton className="h-40 rounded-xl" /></div>; }

export function AppsSettings() {
  const loc = useLocation();
  const current = connectionsTabFor(loc.pathname);
  return (
    <div className="space-y-5" data-testid="connections-hub" data-tab={current}>
      <Tabs current={current} />
      {current === "mail" ? <Suspense fallback={<TabFallback />}><MailAccounts /></Suspense>
        : current === "webhooks" ? <Suspense fallback={<TabFallback />}><Webhooks embedded /></Suspense>
        : current === "social" ? <><Suspense fallback={null}><DirectAccounts /></Suspense><OutsideApps social /></>
        : <OutsideApps social={false} />}
    </div>
  );
}

function OutsideApps({ social }: { social: boolean }) {
  const status = useAppsStatus();
  useAppAccounts(); // R82F (MB-280): asked at the same time as the status, not after it
  if (status.isPending) return <div className="space-y-4" data-testid="apps-settings"><Skeleton className="h-11 rounded-lg" /><GridSkeleton /></div>;
  if (status.error || !status.data) {
    return (
      <Card className="p-6" data-testid="apps-settings">
        <p className="text-sm text-bad" role="alert">{errorMessage(status.error, "Couldn't load Connections.")}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void status.refetch()}><IconRefresh className="h-4 w-4" aria-hidden />Try again</Button>
      </Card>
    );
  }
  if (!status.data.available) {
    return (
      <Card data-testid="apps-settings">
        <EmptyState icon={<IconPlug />} title="Connections are almost ready" body="Social networks and other apps will connect here. We are finishing setup for this workspace." />
      </Card>
    );
  }
  return (
    <div className="space-y-5" data-testid="apps-settings">
      {!status.data.canManage && <p className="inline-flex items-center gap-1.5 text-[13px] text-subtle"><IconLock className="h-3.5 w-3.5" aria-hidden />Only owners and admins can connect apps or post.</p>}
      {social ? <Suspense fallback={<TabFallback />}><SocialPanel canManage={status.data.canManage} /></Suspense> : <AppsGallery canManage={status.data.canManage} />}
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" aria-busy="true" aria-label="Loading apps">
      {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)}
    </div>
  );
}

/** Coming back from the provider's sign in page: confirm the account, say so, and tidy the address bar. */
function useConnectReturn() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const done = useRef(false);
  useEffect(() => {
    const id = params.get("connected_account_id");
    const st = params.get("status");
    if (done.current || (!id && !st)) return;
    done.current = true;
    const clean = () => setParams((p) => { p.delete("connected_account_id"); p.delete("status"); p.delete("app"); return p; }, { replace: true });
    if (st && st !== "success") { toast.error("The connection was not finished. Try again when you are ready."); clean(); return; }
    if (!id) { clean(); return; }
    api.post<{ account: ConnectedAccountView }>(`/apps/accounts/${encodeURIComponent(id)}/confirm`)
      .then((r) => {
        if (r.account.status === "active") toast.success(`${r.account.appName} connected`);
        else toast.message(`${r.account.appName} is still finishing sign in. It shows here when it is ready.`);
      })
      .catch((e) => toast.error(errorMessage(e, "Couldn't confirm the connection. Refresh to check.")))
      .finally(() => { void qc.invalidateQueries({ queryKey: appsKeys.accounts }); clean(); });
  }, [params, qc, setParams]);
}

export function useConnect() {
  return useMutation({
    mutationFn: (app: string) => api.post<{ redirectUrl: string }>("/apps/connect", { app }),
    onSuccess: (r) => { window.location.assign(r.redirectUrl); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't start the connection. Try again.")),
  });
}

const PAGE = 24; // R82F (MB-280): a lighter first screen; "Show more apps" adds more

function AppsGallery({ canManage }: { canManage: boolean }) {
  useConnectReturn();
  const qc = useQueryClient();
  const accounts = useAppAccounts();
  const connect = useConnect();
  // R82F (MB-284): the search and the category live in the address, so Back from a sign in page (or a link to
  // ?group=social) lands on the same list.
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [group, setGroup] = useState<AppGroup | "all">(() => { const g = params.get("group"); return APP_GROUPS.some((x) => x.id === g) ? (g as AppGroup) : "all"; });
  useEffect(() => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (q.trim()) next.set("q", q); else next.delete("q");
      if (group !== "all") next.set("group", group); else next.delete("group");
      return next.toString() === p.toString() ? p : next;
    }, { replace: true });
  }, [q, group, setParams]);
  const [limit, setLimit] = useState(PAGE);
  const [removing, setRemoving] = useState<ConnectedAccountView | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const catalog = useCatalog(!!q.trim() || group !== "all" || limit > PAGE);
  const navigate = useNavigate();

  // "/" jumps to search, the way it does in lists across the app.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !(t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName)))) { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const reconnect = useMutation({
    mutationFn: (id: string) => api.post<{ redirectUrl: string }>(`/apps/accounts/${encodeURIComponent(id)}/reconnect`),
    onSuccess: (r) => { window.location.assign(r.redirectUrl); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't reconnect. Try again.")),
  });
  const disconnect = useMutation({
    mutationFn: (a: ConnectedAccountView) => api.del<{ ok: true }>(`/apps/accounts/${encodeURIComponent(a.id)}`),
    onSuccess: (_r, a) => { toast.success(`${a.appName} disconnected`); setRemoving(null); void qc.invalidateQueries({ queryKey: appsKeys.accounts }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't disconnect. Try again.")),
  });

  const byApp = useMemo(() => {
    const m = new Map<string, ConnectedAccountView[]>();
    for (const a of accounts.data ?? []) m.set(a.app, [...(m.get(a.app) ?? []), a]);
    return m;
  }, [accounts.data]);

  const apps = useMemo(() => catalog.data ?? [], [catalog.data]);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = useMemo(() => {
    const order = new Map<string, number>(SOCIAL_FIRST.map((s, i) => [s, i]));
    return apps
      .filter((a) => group === "all" || a.group === group)
      .filter((a) => !words.length || words.every((w) => `${a.name} ${a.slug} ${a.description}`.toLowerCase().includes(w)))
      .sort((x, y) => (order.get(x.slug) ?? 999) - (order.get(y.slug) ?? 999) || (x.availability === "ready" ? 0 : 1) - (y.availability === "ready" ? 0 : 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps, group, q]);
  const counts = useMemo(() => { const c = new Map<string, number>(); for (const a of apps) c.set(a.group, (c.get(a.group) ?? 0) + 1); return c; }, [apps]);
  useEffect(() => { setLimit(PAGE); }, [q, group]);
  // Until the whole catalog is here, the first screen still says how many apps there are in all.
  const shownCount = !catalog.complete && !q.trim() && group === "all" ? catalog.total : matches.length;
  const more = matches.length > limit || (!catalog.complete && !q.trim() && group === "all" && catalog.total > limit);

  const connected = accounts.data ?? [];
  return (
    <div className="space-y-6">
      <section aria-labelledby="apps-connected">
        <h2 id="apps-connected" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">Connected</h2>
        <Card className="divide-y divide-line" data-testid="apps-connected-list">
          {accounts.isPending ? (
            <div className="space-y-3 p-4"><Skeleton className="h-10 rounded-lg" /><Skeleton className="h-10 rounded-lg" /></div>
          ) : accounts.error ? (
            <div className="flex flex-wrap items-center gap-3 p-4">
              <p className="flex-1 text-sm text-bad" role="alert">{errorMessage(accounts.error, "Couldn't load your connected apps.")}</p>
              <Button variant="outline" size="sm" onClick={() => void accounts.refetch()}><IconRefresh className="h-4 w-4" aria-hidden />Try again</Button>
            </div>
          ) : connected.length === 0 ? (
            <div className="flex items-center gap-3 p-4 text-sm text-muted" data-testid="apps-none">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-fill text-muted" aria-hidden><IconPlug className="h-4 w-4" /></span>
              <p>Nothing connected yet. Pick an app below to connect your first account.</p>
            </div>
          ) : connected.map((a) => {
            const s = STATUS_COPY[a.status];
            const same = byApp.get(a.app) ?? [];
            const n = same.length > 1 ? same.indexOf(a) + 1 : 0;
            return (
              <div key={a.id} className="flex flex-wrap items-center gap-3 p-4 md:px-5" data-testid={`account-${a.app}`}>
                <AppLogo slug={a.app} name={a.appName} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">{a.appName}{a.label ? <span className="text-muted">, {a.label}</span> : n ? <span className="text-muted">, account {n}</span> : null}</p>
                  <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted"><Badge tone={s.tone} dot>{s.label}</Badge><span>{a.status === "pending" ? "Started" : "Connected"} {timeAgo(a.createdAt)}</span></p>
                </div>
                {canManage && (
                  <div className="flex gap-2 max-sm:w-full">
                    <Button variant={a.status === "active" ? "ghost" : "outline"} size="sm" className="max-sm:flex-1" loading={reconnect.isPending && reconnect.variables === a.id} onClick={() => reconnect.mutate(a.id)} aria-label={a.status === "pending" ? `Finish sign in to ${a.appName}` : `Reconnect ${a.appName}`}>
                      <IconRefresh className="h-4 w-4" aria-hidden />{a.status === "pending" ? "Finish sign in" : "Reconnect"}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-bad hover:text-bad max-sm:flex-1" onClick={() => setRemoving(a)} aria-label={`Disconnect ${a.appName}`}>
                      <IconTrash className="h-4 w-4" aria-hidden />Disconnect
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
        {connected.some((a) => a.status === "active" && a.app in { facebook: 1, instagram: 1, linkedin: 1, pinterest: 1, reddit: 1 }) && (
          <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate("/app/settings/apps/social")}>
            <IconMegaphone className="h-4 w-4" aria-hidden />Write a social post
          </Button>
        )}
      </section>

      <section aria-labelledby="apps-all" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="apps-all" className="px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">Add an app</h2>
          {catalog.data && <p className="px-1 text-[12.5px] text-subtle" aria-live="polite">{catalog.loadingMore && (q.trim() || group !== "all") ? "Looking through every app" : `${shownCount} ${shownCount === 1 ? "app" : "apps"}`}</p>}
        </div>
        <label className="relative block">
          <span className="sr-only">Search apps</span>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps, for example Instagram or Slack" className="pl-9" data-testid="apps-search" type="search" />
        </label>
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]" role="group" aria-label="Categories" data-testid="apps-groups">
          {[{ id: "all" as const, label: "All" }, ...APP_GROUPS].map((g) => {
            const n = g.id === "all" ? catalog.total : counts.get(g.id) ?? 0;
            if (g.id !== "all" && catalog.complete && !n) return null;
            const on = group === g.id;
            return (
              <button key={g.id} type="button" aria-pressed={on} onClick={() => setGroup(g.id)}
                className={cn("inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 max-sm:min-h-11",
                  on ? "border-brand bg-brand-soft text-brand-hover" : "border-line text-muted hover:bg-hover hover:text-fg")}>
                {g.label}
              </button>
            );
          })}
        </div>

        {catalog.isPending || (!matches.length && !catalog.complete && !catalog.error) ? <GridSkeleton /> : catalog.error ? (
          <Card className="p-6">
            <p className="text-sm text-bad" role="alert">Couldn't load the list of apps.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void catalog.refetch()}><IconRefresh className="h-4 w-4" aria-hidden />Try again</Button>
          </Card>
        ) : matches.length === 0 ? (
          <Card><EmptyState icon={<IconSearch />} title="No apps match" body={`Nothing matches "${q.trim()}". Try a shorter word or another category.`} action={<Button variant="outline" size="sm" onClick={() => { setQ(""); setGroup("all"); }}>Clear search</Button>} /></Card>
        ) : (
          <>
            <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" data-testid="apps-grid">
              {matches.slice(0, limit).map((a) => (
                <AppCard key={a.slug} app={a} count={byApp.get(a.slug)?.filter((x) => x.status === "active").length ?? 0} canManage={canManage} busy={connect.isPending && connect.variables === a.slug} onConnect={() => connect.mutate(a.slug)} />
              ))}
            </ul>
            {more && (
              <div className="flex justify-center"><Button variant="outline" onClick={() => setLimit((l) => l + PAGE * 2)}>Show more apps</Button></div>
            )}
          </>
        )}
      </section>

      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && disconnect.mutate(removing)} busy={disconnect.isPending}
        title={removing ? `Disconnect ${removing.appName}?` : "Disconnect"}
        description="Multies stops using this account right away. Scheduled posts to it will not go out. You can connect it again any time."
        confirmLabel="Disconnect" />
    </div>
  );
}

function AppCard({ app, count, canManage, busy, onConnect }: { app: CatalogApp; count: number; canManage: boolean; busy: boolean; onConnect: () => void }) {
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-card transition-colors duration-150 hover:border-line-strong" data-testid={`app-${app.slug}`}>
      <div className="flex min-w-0 items-start gap-3">
        <AppLogo slug={app.slug} name={app.name} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-medium leading-5">
            <span className="truncate">{app.name}</span>
            {count > 0 && <Badge tone="ok" dot>{count === 1 ? "Connected" : `${count} connected`}</Badge>}
          </p>
          <p className="mt-1 line-clamp-2 text-[13px] leading-[18px] text-muted">{app.description}</p>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="min-w-0 truncate whitespace-nowrap text-[12px] text-subtle">
          {app.availability === "key" ? <span className="inline-flex items-center gap-1"><IconKey className="h-3.5 w-3.5" aria-hidden />Uses your own key</span>
            : app.availability === "soon" ? <span className="inline-flex items-center gap-1"><IconClock className="h-3.5 w-3.5" aria-hidden />Coming soon</span>
            : app.canPost ? <span className="inline-flex items-center gap-1"><IconMegaphone className="h-3.5 w-3.5" aria-hidden />Post from Multies</span> : null}
        </span>
        {app.availability !== "soon" && canManage && (
          <Button size="sm" variant={count ? "outline" : "primary"} loading={busy} onClick={onConnect} aria-label={count ? `Add account for ${app.name}` : `Connect ${app.name}`}>
            <IconPlug className="h-4 w-4" aria-hidden />{count ? "Add account" : "Connect"}
          </Button>
        )}
      </div>
    </li>
  );
}

