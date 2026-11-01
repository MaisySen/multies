/**
 * P1 layout: Social, a daily tool with its own place in the rail (it lived in Settings, Connections, Social posts).
 * Planner (/app/social): a month of scheduled and sent posts. Posts (/app/social/posts): every post with each account's
 * result, filtered by Scheduled, Sent and Failed. New post (/app/social/new): the one composer. Accounts
 * (/app/social/accounts): connected profiles with their health, TikTok and Threads, and Connect for the rest.
 * No new server calls: the same /api/social, /api/apps and /api/direct the Connections tab used.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { timeAgo } from "@/web/lib/format";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import {
  IconBack, IconCalendarDays, IconChevronRight, IconCompose, IconFlask, IconLock, IconMegaphone, IconPlug, IconPlus, IconRefresh, IconTrash, IconWarning,
} from "@/web/components/ui/icon";
import { LINKEDIN_PAGE_NOTE, SOCIAL_NETWORKS, type ConnectedAccountView, type SocialPostView } from "@/shared/integrations";
import { capList, capsOf } from "@/shared/social-p2b";
import { AccountAvatar, AppLogo, appsKeys, useAppAccounts, useAppsStatus, useConnect, useConnectReturn } from "./apps-settings";
import { Composer, POST_STATUS, PostList, ReconnectButton, useAccountHealth, useSocialPosts, type PostFilter } from "./apps-social";
import { DirectAccounts } from "./apps-direct";
import { useConfig } from "@/web/lib/queries";
import { ComposerV2, composerAccounts, useDirectStatus, useLibrary } from "./social-composer";
import { PlannerV2 } from "./social-planner";
import { SocialLibrary } from "./social-library";

/** R117: Social P2 (composer v2, planner v2, drafts and approvals, library) sits behind its own flag. */
export const useSocialP2 = () => !!useConfig().data?.socialP2;
/** R118: Social inbox, analytics and account health alerts (on with P2 unless SOCIAL_P2B is off). */
export const useSocialP2b = () => { const c = useConfig().data; return !!c?.socialP2 && c?.socialP2b !== false; };

/** Phones and small tablets have no shell sidebar, so Social's four pages switch here, under the title. */
const SOCIAL_TABS = [
  { to: "/app/social/inbox", label: "Inbox", end: false },
  { to: "/app/social", label: "Planner", end: true },
  { to: "/app/social/posts", label: "Posts", end: false },
  { to: "/app/social/new", label: "New post", end: false },
  { to: "/app/social/library", label: "Library", end: false },
  { to: "/app/social/analytics", label: "Analytics", end: false },
  { to: "/app/social/accounts", label: "Accounts", end: false },
] as const;

export function SocialSwitcher() {
  const { pathname } = useLocation();
  const p2 = useSocialP2();
  const p2b = useSocialP2b();
  return (
    <nav aria-label="Social" className="-mx-1 mb-4 overflow-x-auto px-1 lg:hidden" data-testid="social-switcher">
      <ul className="flex w-max gap-1 rounded-lg border border-line bg-fill/50 p-1">
        {/* R117: with Library the phone switcher keeps four tabs that fit; New post stays one tap away in each page header. */}
        {SOCIAL_TABS.filter((t) => (p2 ? t.to !== "/app/social/new" || pathname.startsWith("/app/social/new") : t.to !== "/app/social/library"))
          .filter((t) => p2b || (t.to !== "/app/social/inbox" && t.to !== "/app/social/analytics")).map((t) => {
          const on = t.end ? pathname === t.to || pathname === `${t.to}/` : pathname.startsWith(t.to);
          return (
            <li key={t.to}>
              <Link to={t.to} aria-current={on ? "page" : undefined}
                className={cn("flex min-h-11 items-center rounded-md px-3.5 text-[13.5px] font-medium transition-colors duration-150",
                  on ? "bg-surface text-fg elev-1" : "text-muted hover:bg-hover hover:text-fg")}>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The networks the one composer connects to here (TikTok and Threads have their own cards; X is not offered). */
const NETWORK_NAMES: Record<string, string> = { facebook: "Facebook Pages", instagram: "Instagram", linkedin: "LinkedIn", pinterest: "Pinterest", reddit: "Reddit" };
const NETWORKS = Object.keys(NETWORK_NAMES);
const postable = (accounts: ConnectedAccountView[] | undefined) => (accounts ?? []).filter((a) => a.status === "active" && a.app in SOCIAL_NETWORKS);

export function NewPostButton() {
  return <ButtonLink to="/app/social/new" size="sm" data-testid="new-post"><IconCompose className="h-4 w-4" aria-hidden />New post</ButtonLink>;
}

export function LoadError({ error, retry, what }: { error: unknown; retry: () => void; what: string }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-bad" role="alert">{errorMessage(error, `Couldn't load ${what}.`)}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={retry}><IconRefresh className="h-4 w-4" aria-hidden />Try again</Button>
    </Card>
  );
}

/* ---------------------------------------------------------------- Planner */

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const timeText = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const TONE_DOT: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", brand: "bg-brand", neutral: "bg-subtle" };

/** The weeks shown for a month, Monday first, as whole weeks. */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead);
  const last = new Date(year, month + 1, 0);
  const cells = Math.ceil((lead + last.getDate()) / 7) * 7;
  return Array.from({ length: cells }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/** Posts by local day. */
export function postsByDay(posts: SocialPostView[]): Map<string, SocialPostView[]> {
  const m = new Map<string, SocialPostView[]>();
  for (const p of [...posts].sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))) {
    if (p.status === "canceled") continue;
    const k = dayKey(new Date(p.runAt));
    m.set(k, [...(m.get(k) ?? []), p]);
  }
  return m;
}

function PostChip({ p }: { p: SocialPostView }) {
  const st = POST_STATUS[p.status];
  return (
    <Link to={`/app/social/posts#post-${p.id}`} data-testid="planner-post" data-status={p.status} title={`${st.label}: ${p.text}`}
      className="flex min-w-0 items-center gap-1.5 rounded-md bg-fill px-1.5 py-1 text-[12px] leading-tight transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 motion-reduce:transition-none">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[st.tone])} aria-hidden />
      <span className="shrink-0 tabular-nums text-muted">{timeText(p.runAt)}</span>
      <span className="min-w-0 truncate">{p.text}</span>
      <span className="sr-only">, {st.label}</span>
    </Link>
  );
}

export function SocialPlannerPage() {
  const p2 = useSocialP2();
  if (p2) return <SocialPlannerV2Page />;
  return <SocialPlannerV1 />;
}

function SocialPlannerV2Page() {
  const status = useAppsStatus();
  const accounts = useAppAccounts();
  const direct = useDirectStatus();
  const posts = useSocialPosts();
  const list = composerAccounts(accounts.data ?? [], direct.data).map((a) => ({ id: a.id, name: a.label ? `${a.name}, ${a.label}` : a.name }));
  const scheduled = (posts.data ?? []).filter((p) => p.status === "scheduled").length;
  return (
    <div data-testid="social-planner">
      <PageHeader title="Planner" description={scheduled ? `${scheduled} ${scheduled === 1 ? "post is" : "posts are"} waiting to go out. Drag one to move it.` : "Your week of posts, with free time slots to fill."} actions={<NewPostButton />} />
      <SocialSwitcher />
      <PlannerV2 canManage={!!status.data?.canManage} accounts={list} />
    </div>
  );
}

function SocialPlannerV1() {
  const posts = useSocialPosts();
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const cells = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor]);
  const byDay = useMemo(() => postsByDay(posts.data ?? []), [posts.data]);
  const today = dayKey(new Date());
  const monthName = new Date(cursor.y, cursor.m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const move = (n: number) => setCursor((c) => { const d = new Date(c.y, c.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const weekdays = cells.slice(0, 7).map((d) => ({ short: d.toLocaleDateString(undefined, { weekday: "short" }), long: d.toLocaleDateString(undefined, { weekday: "long" }) }));
  const inMonth = cells.filter((d) => d.getMonth() === cursor.m);
  const agenda = inMonth.filter((d) => byDay.has(dayKey(d)));
  const scheduled = (posts.data ?? []).filter((p) => p.status === "scheduled").length;

  return (
    <div data-testid="social-planner">
      <PageHeader title="Planner" description={scheduled ? `${scheduled} ${scheduled === 1 ? "post is" : "posts are"} waiting to go out.` : "Scheduled and sent posts on a calendar."} actions={<NewPostButton />} />
      <SocialSwitcher />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-[17px] font-semibold tracking-[-0.01em]" aria-live="polite" data-testid="planner-month">{monthName}</h2>
        <Button variant="outline" size="sm" onClick={() => { const d = new Date(); setCursor({ y: d.getFullYear(), m: d.getMonth() }); }}>Today</Button>
        <Button variant="ghost" size="sm" onClick={() => move(-1)} aria-label="Previous month"><IconBack className="h-4 w-4" aria-hidden /></Button>
        <Button variant="ghost" size="sm" onClick={() => move(1)} aria-label="Next month"><IconChevronRight className="h-4 w-4" aria-hidden /></Button>
      </div>
      {posts.isPending ? <Skeleton className="h-[560px] rounded-xl max-sm:h-72" />
        : posts.error ? <LoadError error={posts.error} retry={() => void posts.refetch()} what="the planner" />
        : (<>
          {!posts.data?.length && (
            <Card className="mb-4" data-testid="planner-empty">
              <EmptyState icon={<IconCalendarDays />} title="Nothing planned yet" body="Write a post and pick a time. It shows here on its day, and in Posts with how each account did." action={<NewPostButton />} />
            </Card>
          )}
          {/* Desktop and tablet: the month grid. */}
          <Card className="overflow-hidden max-sm:hidden" data-testid="planner-grid">
            <div className="grid grid-cols-7 border-b border-line bg-fill/50" aria-hidden>
              {weekdays.map((w) => <div key={w.long} className="px-2 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-subtle">{w.short}</div>)}
            </div>
            <ol className="grid grid-cols-7" aria-label={monthName}>
              {cells.map((d, i) => {
                const k = dayKey(d);
                const list = byDay.get(k) ?? [];
                const out = d.getMonth() !== cursor.m;
                return (
                  <li key={k} className={cn("min-h-[104px] min-w-0 space-y-1 p-1.5", i % 7 !== 6 && "border-r border-line", i < cells.length - 7 && "border-b border-line", out && "bg-fill/40")} data-day={k}>
                    <div className="flex items-center justify-between px-0.5">
                      <span className={cn("grid h-6 min-w-6 place-items-center rounded-full px-1 text-[12px] tabular-nums", k === today ? "bg-brand font-semibold text-brand-fg" : out ? "text-subtle" : "text-muted")}>
                        <span aria-hidden>{d.getDate()}</span><span className="sr-only">{d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}{k === today ? ", today" : ""}{list.length ? `, ${list.length} ${list.length === 1 ? "post" : "posts"}` : ""}</span>
                      </span>
                    </div>
                    {list.slice(0, 3).map((p) => <PostChip key={p.id} p={p} />)}
                    {list.length > 3 && <Link to="/app/social/posts" className="block px-1.5 text-[12px] font-medium text-muted hover:text-fg">{list.length - 3} more</Link>}
                  </li>
                );
              })}
            </ol>
          </Card>
          {/* Phone: the month as a list of the days that have posts. */}
          <div className="sm:hidden" data-testid="planner-agenda">
            {posts.data?.length ? (agenda.length ? (
              <ul className="space-y-4">
                {agenda.map((d) => (
                  <li key={dayKey(d)}>
                    <h3 className={cn("mb-1.5 px-1 text-[13px] font-semibold", dayKey(d) === today ? "text-brand-hover" : "text-muted")}>{d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}</h3>
                    <Card className="space-y-1.5 p-2">{(byDay.get(dayKey(d)) ?? []).map((p) => <PostChip key={p.id} p={p} />)}</Card>
                  </li>
                ))}
              </ul>
            ) : <p className="rounded-lg bg-fill px-3 py-3 text-[14px] text-muted">No posts in {monthName}.</p>) : null}
          </div>
        </>)}
    </div>
  );
}

/* ---------------------------------------------------------------- Posts */

const FILTERS: { id: PostFilter; label: string; p2?: true }[] = [
  { id: "all", label: "All" }, { id: "scheduled", label: "Scheduled" }, { id: "sent", label: "Sent" }, { id: "failed", label: "Failed" },
  { id: "drafts", label: "Drafts", p2: true }, { id: "waiting", label: "Waiting for approval", p2: true },
];

export function SocialPostsPage() {
  const status = useAppsStatus();
  const posts = useSocialPosts();
  const [params, setParams] = useSearchParams();
  const loc = useLocation();
  const p2 = useSocialP2();
  const filters = FILTERS.filter((f) => p2 || !f.p2);
  const raw = params.get("status");
  const filter: PostFilter = filters.some((f) => f.id === raw) ? (raw as PostFilter) : "all";
  const waiting = (posts.data ?? []).filter((p) => p.status === "review").length;
  const failed = (posts.data ?? []).filter((p) => p.status === "failed" || p.status === "partial").length;
  // A post opened from the planner: scroll to it once the list is here.
  useEffect(() => {
    if (!loc.hash || !posts.data) return;
    const el = document.getElementById(loc.hash.slice(1));
    el?.scrollIntoView({ block: "center" });
    el?.querySelector<HTMLElement>("[data-testid=social-post]")?.focus({ preventScroll: true });
  }, [loc.hash, posts.data]);
  const tab = "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-sm:min-h-11 max-sm:px-2.5 motion-reduce:transition-none";
  return (
    <div data-testid="social-posts-page">
      <PageHeader title="Posts" description="Every post, with how each account did. Fix a failed one right here." actions={<NewPostButton />} />
      <SocialSwitcher />
      <div className="mb-4 -mx-1 max-w-full overflow-x-auto px-1 [scrollbar-width:none]">
        <div className="inline-flex gap-1 rounded-lg bg-fill p-1" role="group" aria-label="Show posts" data-testid="posts-filter">
          {filters.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setParams((p) => { const n = new URLSearchParams(p); if (f.id === "all") n.delete("status"); else n.set("status", f.id); return n; }, { replace: true })}
              className={cn(tab, filter === f.id ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>
              {f.label}
              {f.id === "waiting" && waiting > 0 && <span className="min-w-[18px] rounded-full bg-warn-soft px-1.5 text-center text-[11px] font-semibold tabular-nums leading-[18px] text-warn" aria-label={`${waiting} waiting`}>{waiting}</span>}
              {f.id === "failed" && failed > 0 && <span className="min-w-[18px] rounded-full bg-bad-soft px-1.5 text-center text-[11px] font-semibold tabular-nums leading-[18px] text-bad" aria-label={`${failed} need attention`}>{failed}</span>}
            </button>
          ))}
        </div>
      </div>
      <PostList canManage={!!status.data?.canManage} filter={filter} heading={false} />
    </div>
  );
}

/* ---------------------------------------------------------------- New post */

export function SocialNewPostPage() {
  const p2 = useSocialP2();
  if (p2) return <SocialNewPostV2 />;
  return <SocialNewPostV1 />;
}

function SocialNewPostV2() {
  const status = useAppsStatus();
  const accounts = useAppAccounts();
  const direct = useDirectStatus();
  const posts = useSocialPosts();
  const [params] = useSearchParams();
  const draftId = params.get("draft");
  const libId = params.get("lib");
  const lib = useLibrary(!!libId);
  const list = composerAccounts(accounts.data ?? [], direct.data);
  const draft = draftId ? (posts.data ?? []).find((p) => p.id === draftId) ?? null : null;
  const libItem = libId ? lib.data?.items.find((i) => i.id === libId) ?? null : null;
  const campaigns = [...new Set((posts.data ?? []).map((p) => p.campaign).filter((c): c is string => !!c))].sort();
  const waitingOn = status.isPending || accounts.isPending || direct.isPending || (!!draftId && posts.isPending) || (!!libId && lib.isPending);
  const canPublish = !!status.data?.canManage;
  return (
    <div data-testid="social-new">
      <PageHeader title={draft ? "Edit post" : "New post"} description={canPublish ? "Pick a format, write once and adjust the text per network. Accounts that can't take the format are greyed out with the reason." : "Write a post and send it for approval. An owner or admin approves it before it goes out."} />
      <SocialSwitcher />
      {waitingOn ? <div className="space-y-4" aria-busy="true"><Skeleton className="h-72 rounded-xl" /></div>
        : status.error ? <LoadError error={status.error} retry={() => void status.refetch()} what="Social" />
        : accounts.error ? <LoadError error={accounts.error} retry={() => void accounts.refetch()} what="your accounts" />
        : draftId && !draft ? <Card><EmptyState icon={<IconMegaphone />} title="That draft is gone" body="It may have been sent, discarded or approved already." action={<ButtonLink to="/app/social/posts?status=drafts" variant="outline" size="sm">See drafts</ButtonLink>} /></Card>
        : !list.length ? (
          <Card data-testid="social-empty"><EmptyState icon={<IconMegaphone />} title="Connect a social account first" body="Connect Facebook Pages, Instagram, LinkedIn, Pinterest, Reddit, Threads or TikTok, then write one post and send it to all of them." action={<ButtonLink to="/app/social/accounts" size="sm"><IconPlug className="h-4 w-4" aria-hidden />Connect an account</ButtonLink>} /></Card>
        ) : (
          <ComposerV2 key={draft?.id ?? libItem?.id ?? "new"} accounts={list} canPublish={canPublish} draft={draft} presetAt={params.get("at")} presetAccount={params.get("account")} campaigns={campaigns}
            presetLibraryText={libItem && libItem.kind !== "image" ? libItem.body : null}
            presetImage={libItem?.kind === "image" && libItem.imageUrl && libItem.mediaId ? { url: libItem.imageUrl, mediaId: libItem.mediaId } : null} />
        )}
    </div>
  );
}

/* ---------------------------------------------------------------- Library */

export function SocialLibraryPage() {
  const p2 = useSocialP2();
  return (
    <div data-testid="social-library-page">
      <PageHeader title="Library" description="Images, captions and hashtag sets your team reuses, tagged by campaign." actions={<NewPostButton />} />
      <SocialSwitcher />
      {p2 ? <SocialLibrary /> : <Card><EmptyState icon={<IconMegaphone />} title="Library isn't on yet" body="It arrives with the next Social update." /></Card>}
    </div>
  );
}

function SocialNewPostV1() {
  const status = useAppsStatus();
  const accounts = useAppAccounts();
  const navigate = useNavigate();
  const list = postable(accounts.data);
  return (
    <div data-testid="social-new">
      <PageHeader title="New post" description="Write once and send it to every account you pick. Networks that can't take the post are greyed out with the reason." />
      <SocialSwitcher />
      {status.isPending || accounts.isPending ? <div className="space-y-4" aria-busy="true"><Skeleton className="h-72 rounded-xl" /></div>
        : status.error ? <LoadError error={status.error} retry={() => void status.refetch()} what="Social" />
        : accounts.error ? <LoadError error={accounts.error} retry={() => void accounts.refetch()} what="your accounts" />
        : !status.data?.canManage ? (
          <Card data-testid="social-locked"><EmptyState icon={<IconLock />} title="Only owners and admins can post" body="You can see every post and how it did in Posts. Ask an owner or admin to post for the team." action={<ButtonLink to="/app/social/posts" variant="outline" size="sm">See posts</ButtonLink>} /></Card>
        ) : !list.length ? (
          <Card data-testid="social-empty"><EmptyState icon={<IconMegaphone />} title="Connect a social account first" body="Connect Facebook Pages, Instagram, LinkedIn, Pinterest or Reddit, then write one post and send it to all of them." action={<ButtonLink to="/app/social/accounts" size="sm"><IconPlug className="h-4 w-4" aria-hidden />Connect an account</ButtonLink>} /></Card>
        ) : (
          <div className="space-y-3">
            <Composer accounts={list} heading={false} onPosted={() => navigate("/app/social/posts")} />
            <p className="px-1 text-[13px] text-muted">TikTok videos and Threads posts are written from their cards in <Link to="/app/social/accounts" className="font-medium text-fg underline underline-offset-2 hover:text-muted">Accounts</Link>.</p>
          </div>
        )}
    </div>
  );
}

/* ---------------------------------------------------------------- Accounts */

/** R118: what each account can do, so nobody wonders why its messages or results are missing. */
function AccountCaps({ app }: { app: string }) {
  const list = capList(app);
  const c = capsOf(app);
  const only = list.length === 1;
  return (
    <p className="mt-1 text-[12.5px] text-muted" data-testid={`account-caps-${app}`}>
      {only ? <span className="font-medium text-fg">Posting only.</span> : <span>Can do: {list.join(", ")}.</span>}
      {c.note && !only ? <span> {c.note}</span> : c.note ? <span> {c.note.replace(/^Posting only\.\s*/, "")}</span> : null}
    </p>
  );
}

/** R118: the staging only test network (only asked for where the config allows it). */
function useTestNetwork() {
  const allowed = !!useConfig().data?.socialTestNetwork;
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["social-test-network"], queryFn: () => api.get<{ available: boolean; account: { id: string; name: string; broken: boolean } | null }>("/social/test-network"), enabled: allowed });
  const act = useMutation({
    mutationFn: (what: "add" | "out" | "in" | "remove") => what === "add" ? api.post("/social/test-network", {}) : what === "remove" ? api.del("/social/test-network") : api.post("/social/test-network/signed-out", { broken: what === "out" }),
    onSuccess: (_r, what) => { toast.success(what === "add" ? "Test network added" : what === "remove" ? "Test network removed" : what === "out" ? "Test network now acts signed out" : "Signed in again"); void qc.invalidateQueries(); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't change the test network.")),
  });
  return { allowed, st, act };
}

/** R118: the staging only test network: add it, act signed out to try the warnings, remove it. */
function TestNetworkCard({ canManage }: { canManage: boolean }) {
  const { st, act } = useTestNetwork();
  if (!st.data?.available) return null;
  const a = st.data.account;
  return (
    <section aria-labelledby="acc-test">
      <h2 id="acc-test" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">Test network</h2>
      <Card className="flex flex-wrap items-center gap-3 p-4 md:px-5" data-testid="test-network-card" data-health={a ? (a.broken ? "bad" : "ok") : "none"}>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-fill" aria-hidden><IconFlask className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">Test network <Badge tone="brand">Staging only</Badge></p>
          <p className="text-[13px] text-muted">{!a ? "A pretend network for trying posts, approvals, the inbox and analytics. It never reaches a real network." : a.broken ? "Acting signed out, so you can see the warnings." : "Connected. Posts to it show as sent; replies and results are made up."}</p>
          {a && <AccountCaps app="testnet" />}
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {!a ? <Button size="sm" variant="outline" onClick={() => act.mutate("add")} loading={act.isPending} data-testid="test-network-add"><IconPlus className="h-4 w-4" aria-hidden />Add</Button> : <>
              {a.broken
                ? <Button size="sm" variant="outline" onClick={() => act.mutate("in")} loading={act.isPending} data-testid="test-network-signin">Sign in again</Button>
                : <Button size="sm" variant="ghost" onClick={() => act.mutate("out")} loading={act.isPending} data-testid="test-network-signout">Act signed out</Button>}
              <Button size="sm" variant="ghost" className="text-bad hover:text-bad" onClick={() => act.mutate("remove")} loading={act.isPending} aria-label="Remove the test network"><IconTrash className="h-4 w-4" aria-hidden />Remove</Button>
            </>}
          </div>
        )}
      </Card>
    </section>
  );
}

export function SocialAccountsPage() {
  useConnectReturn();
  const qc = useQueryClient();
  const status = useAppsStatus();
  const accounts = useAppAccounts();
  const health = useAccountHealth();
  const connect = useConnect();
  const [removing, setRemoving] = useState<ConnectedAccountView | null>(null);
  const canManage = !!status.data?.canManage;
  const p2b = useSocialP2b();
  const isBad = (a: ConnectedAccountView) => { const h = health.data?.get(a.id); return a.status !== "active" || (!!h && !h.ok && h.code !== "check_failed"); };
  // R118: a broken account goes to the top, so a lost sign in is the first thing seen here.
  const social = (accounts.data ?? []).filter((a) => a.app in SOCIAL_NETWORKS && a.app !== "testnet").sort((x, y) => (p2b ? Number(isBad(y)) - Number(isBad(x)) : 0));
  const broken = p2b ? social.filter((a) => isBad(a) && a.status !== "pending") : [];
  const test = useTestNetwork();
  const testBroken = p2b && !!test.st.data?.account?.broken;
  const connectedApps = new Set(social.filter((a) => a.status === "active").map((a) => a.app));
  const disconnect = useMutation({
    mutationFn: (a: ConnectedAccountView) => api.del<{ ok: true }>(`/apps/accounts/${encodeURIComponent(a.id)}`),
    onSuccess: (_r, a) => { toast.success(`${a.appName} disconnected`); setRemoving(null); void qc.invalidateQueries({ queryKey: appsKeys.accounts }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't disconnect. Try again.")),
  });

  const healthLine = (a: ConnectedAccountView) => {
    if (a.status === "pending") return <Badge tone="warn" dot>Sign in not finished</Badge>;
    if (a.status !== "active") return <Badge tone="warn" dot>Needs attention</Badge>;
    if (health.isPending) return <span className="text-subtle">Checking</span>;
    const h = health.data?.get(a.id);
    if (!h || h.ok) return <Badge tone="ok" dot>Ready to post</Badge>;
    if (h.code === "check_failed") return <Badge tone="neutral" dot>Not checked</Badge>;
    return <Badge tone="warn" dot>Needs attention</Badge>;
  };

  return (
    <div data-testid="social-accounts">
      <PageHeader title="Accounts" description="The profiles Multies posts to, checked before you write. Connect, reconnect or remove them here." actions={<NewPostButton />} />
      <SocialSwitcher />
      {!status.isPending && !canManage && <p className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-subtle"><IconLock className="h-3.5 w-3.5" aria-hidden />Only owners and admins can connect accounts or post.</p>}
      {(broken.length > 0 || testBroken) && (
        <Card className="mb-5 border-warn/40 p-4 md:px-5" data-testid="accounts-broken" role="region" aria-label="Sign in again">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><IconWarning className="h-4 w-4 text-warn" aria-hidden />Sign in again</h2>
          <ul className="mt-2 space-y-2">
            {broken.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 text-[13.5px]">
                <span className="min-w-0 flex-1">{a.appName}{(a.name ?? a.label) ? `, ${a.name ?? a.label}` : ""} lost its sign in. Planned posts to it won't go out until you reconnect.</span>
                {canManage ? <ReconnectButton accountId={a.id} appName={a.appName} /> : <span className="text-[12.5px] text-muted">Ask an owner or admin to reconnect it.</span>}
              </li>
            ))}
            {testBroken && (
              <li className="flex flex-wrap items-center gap-3 text-[13.5px]">
                <span className="min-w-0 flex-1">Test network lost its sign in. Planned posts to it won't go out until you reconnect.</span>
                {canManage ? <Button size="sm" variant="outline" onClick={() => test.act.mutate("in")} loading={test.act.isPending} data-testid="broken-reconnect-testnet"><IconRefresh className="h-4 w-4" aria-hidden />Reconnect</Button>
                  : <span className="text-[12.5px] text-muted">Ask an owner or admin to reconnect it.</span>}
              </li>
            )}
          </ul>
        </Card>
      )}
      <div className="space-y-7">
        <section aria-labelledby="acc-connected">
          <h2 id="acc-connected" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">Connected</h2>
          {accounts.isPending ? <Card className="space-y-3 p-4" aria-busy="true"><Skeleton className="h-10 rounded-lg" /><Skeleton className="h-10 rounded-lg" /></Card>
            : accounts.error ? <LoadError error={accounts.error} retry={() => void accounts.refetch()} what="your accounts" />
            : !social.length ? (
              <Card className="flex items-center gap-3 p-4 text-sm text-muted" data-testid="accounts-none">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-fill" aria-hidden><IconPlug className="h-4 w-4" /></span>
                <p>No social accounts yet. Connect one below to start posting.</p>
              </Card>
            ) : (
              <Card className="divide-y divide-line" data-testid="accounts-list">
                {social.map((a) => {
                  const h = health.data?.get(a.id);
                  const bad = h && !h.ok && h.code !== "check_failed";
                  return (
                    <div key={a.id} className="flex flex-wrap items-center gap-3 p-4 md:px-5" data-testid={`social-account-${a.app}`} data-health={bad ? "bad" : h?.ok ? "ok" : "unknown"}>
                      <AccountAvatar account={a} />
                      <div className="min-w-0 flex-1">
                        {/* SA1: the account's own name first, so two accounts on one network are told apart. */}
                        <p className="truncate text-[15px] font-medium" data-testid="account-name">{a.name ?? a.label ?? a.appName}</p>
                        <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">{(a.name ?? a.label) ? <span className="text-subtle">{a.appName}</span> : null}{healthLine(a)}<span>Connected {timeAgo(a.createdAt)}</span></p>
                        {bad && h?.text && <p className="mt-1 text-[12.5px] text-warn" data-testid="account-health-text">{h.text}</p>}
                        {a.app === "linkedin" && <p className="mt-1 text-[12.5px] text-muted" data-testid="linkedin-page-note">{LINKEDIN_PAGE_NOTE}</p>}
                        {p2b && <AccountCaps app={a.app} />}
                      </div>
                      {canManage && (
                        <div className="flex gap-2 max-sm:w-full max-sm:pl-[52px]">
                          {(bad || a.status !== "active") && <ReconnectButton accountId={a.id} appName={a.appName} />}
                          <Button variant="ghost" size="sm" className="text-bad hover:text-bad" onClick={() => setRemoving(a)} aria-label={`Disconnect ${a.appName}${a.name ? `, ${a.name}` : ""}`}><IconTrash className="h-4 w-4" aria-hidden />Disconnect</Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </Card>
            )}
        </section>

        {/* R118: staging only. */}
        {test.allowed && <TestNetworkCard canManage={canManage} />}

        {/* TikTok and Threads carry their own heading (and hide while neither is offered). */}
        <section aria-label="TikTok and Threads"><DirectAccounts /></section>

        <section aria-labelledby="acc-add">
          <h2 id="acc-add" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">Connect a network</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="accounts-add">
            {NETWORKS.map((app) => (
              <Card key={app} className="flex items-center gap-3 p-4" data-testid={`connect-${app}`}>
                <AppLogo slug={app} name={NETWORK_NAMES[app] ?? app} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">{NETWORK_NAMES[app] ?? app}</p>
                  <p className="text-[12.5px] text-muted">{connectedApps.has(app) ? "Connected. Add another account." : SOCIAL_NETWORKS[app]!.image === "required" ? "Posts need an image." : "Text and image posts."}</p>
                  {app === "linkedin" && <p className="mt-1 text-[12px] leading-snug text-subtle" data-testid="connect-linkedin-note">{LINKEDIN_PAGE_NOTE}</p>}
                </div>
                {canManage && (
                  <Button variant="outline" size="sm" loading={connect.isPending && connect.variables === app} onClick={() => connect.mutate(app)} aria-label={`Connect ${NETWORK_NAMES[app] ?? app}`}>
                    <IconPlus className="h-4 w-4" aria-hidden />Connect
                  </Button>
                )}
              </Card>
            ))}
          </div>
          <p className="mt-3 px-1 text-[13px] text-muted">Other apps, mail accounts and webhooks are in <Link to="/app/settings/apps" className="font-medium text-fg underline underline-offset-2 hover:text-muted">Settings, Connections</Link>.</p>
        </section>
      </div>
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && disconnect.mutate(removing)} busy={disconnect.isPending}
        title={removing ? `Disconnect ${removing.appName}${removing.name ? `, ${removing.name}` : ""}?` : "Disconnect"} confirmLabel="Disconnect"
        description="Scheduled posts to this account will not go out. You can connect it again any time." />
    </div>
  );
}
