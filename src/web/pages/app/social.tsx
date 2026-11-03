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
import { useSocialP3 } from "./social-p3"; // R132
import { capList, capsOf } from "@/shared/social-p2b";
import { AccountAvatar, AppLogo, appsKeys, useAppAccounts, useAppsStatus, useConnect, useConnectReturn } from "./apps-settings";
import { Composer, POST_STATUS, PostList, ReconnectButton, useAccountHealth, useSocialPosts, type PostFilter } from "./apps-social";
import { DirectAccounts } from "./apps-direct";
import { useConfig, useMe } from "@/web/lib/queries";
import { soc1ChoiceKey } from "@/shared/social-soc1";
import { ComposerV2, composerAccounts, useDirectStatus, useLibrary } from "./social-composer";
import { PlannerV2 } from "./social-planner";
import { SocialLibrary } from "./social-library";
import { LoadFailure } from "@/web/components/load-error-t1g";
import { LoginPages, pagesKey, useSocialPages, useSoc1On } from "./social-soc1"; // SOC1
import { ScrollRow } from "@/web/components/ui/scroll-row"; // F13b
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-social"; // R104B

/** R117: Social P2 (composer v2, planner v2, drafts and approvals, library) sits behind its own flag. */
export const useSocialP2 = () => !!useConfig().data?.socialP2;
/** R118: Social inbox, analytics and account health alerts (on with P2 unless SOCIAL_P2B is off). */
export const useSocialP2b = () => { const c = useConfig().data; return !!c?.socialP2 && c?.socialP2b !== false; };

/** Phones and small tablets have no shell sidebar, so Social's four pages switch here, under the title. */
const SOCIAL_TABS = [
  { to: "/app/social/inbox", get label() { return tr("common.inbox"); }, end: false },
  { to: "/app/social", get label() { return tr("nav.planner"); }, end: true },
  { to: "/app/social/posts", get label() { return tr("nav.posts"); }, end: false },
  { to: "/app/social/new", get label() { return tr("nav.new_post"); }, end: false },
  { to: "/app/social/library", get label() { return tr("nav.library"); }, end: false },
  { to: "/app/social/analytics", get label() { return tr("nav.analytics"); }, end: false },
  { to: "/app/social/accounts", get label() { return tr("nav.accounts"); }, end: false },
] as const;

export function SocialSwitcher() {
  const { pathname } = useLocation();
  const p2 = useSocialP2();
  const p2b = useSocialP2b();
  return (
    <ScrollRow as="nav" aria-label={tr("nav.social")} activeKey={pathname} outerClassName="mb-4 lg:hidden" className="px-0.5" data-testid="social-switcher">
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
    </ScrollRow>
  );
}

/** The networks the one composer connects to here (TikTok and Threads have their own cards; X is not offered). */
const NETWORK_NAMES: Record<string, string> = { facebook: "Facebook Pages", instagram: "Instagram", linkedin: "LinkedIn", pinterest: "Pinterest", reddit: "Reddit" };
const NETWORKS = Object.keys(NETWORK_NAMES);
/** R132: networks connected for their comments only (posting there is held), shown when SOCIAL_P3_R132 is on. */
const P3_NAMES: Record<string, string> = { youtube: "YouTube" };
const postable = (accounts: ConnectedAccountView[] | undefined) => (accounts ?? []).filter((a) => a.status === "active" && a.app in SOCIAL_NETWORKS);

export function NewPostButton() {
  return <ButtonLink to="/app/social/new" size="sm" data-testid="new-post"><IconCompose className="h-4 w-4" aria-hidden />{tr("nav.new_post")}</ButtonLink>;
}

/** F12 (MB-299): `what` is kept for the callers; the words are the shared failed load words now. */
export function LoadError({ error, retry }: { error: unknown; retry: () => void; what: string }) {
  return (
    <Card className="p-5">
      <LoadFailure error={error} onRetry={retry} />
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
      <PageHeader title={tr("nav.planner")} description={scheduled ? `${scheduled} ${scheduled === 1 ? "post is" : "posts are"} waiting to go out. Drag one to move it.` : tr("social.your_week_of_posts_with_free_time_slots_to_fill")} actions={<NewPostButton />} />
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
      <PageHeader title={tr("nav.planner")} description={scheduled ? `${scheduled} ${scheduled === 1 ? "post is" : "posts are"} waiting to go out.` : tr("social.scheduled_and_sent_posts_on_a_calendar")} actions={<NewPostButton />} />
      <SocialSwitcher />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-[17px] font-semibold tracking-[-0.01em]" aria-live="polite" data-testid="planner-month">{monthName}</h2>
        <Button variant="outline" size="sm" onClick={() => { const d = new Date(); setCursor({ y: d.getFullYear(), m: d.getMonth() }); }}>{tr("myday.today")}</Button>
        <Button variant="ghost" size="sm" onClick={() => move(-1)} aria-label={tr("social.previous_month")}><IconBack className="h-4 w-4" aria-hidden /></Button>
        <Button variant="ghost" size="sm" onClick={() => move(1)} aria-label={tr("social.next_month")}><IconChevronRight className="h-4 w-4" aria-hidden /></Button>
      </div>
      {posts.isPending ? <Skeleton className="h-[560px] rounded-xl max-sm:h-72" />
        : posts.error ? <LoadError error={posts.error} retry={() => void posts.refetch()} what="the planner" />
        : (<>
          {!posts.data?.length && (
            <Card className="mb-4" data-testid="planner-empty">
              <EmptyState icon={<IconCalendarDays />} title={tr("social.nothing_planned_yet")} body="Write a post and pick a time. It shows here on its day, and in Posts with how each account did." action={<NewPostButton />} />
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
                        <span aria-hidden>{d.getDate()}</span><span className="sr-only">{d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}{k === today ? tr("social.today") : ""}{list.length ? `, ${list.length} ${list.length === 1 ? "post" : "posts"}` : ""}</span>
                      </span>
                    </div>
                    {list.slice(0, 3).map((p) => <PostChip key={p.id} p={p} />)}
                    {list.length > 3 && <Link to="/app/social/posts" className="block px-1.5 text-[12px] font-medium text-muted hover:text-fg">{tr("social.count_more", { count: list.length - 3 })}</Link>}
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
            ) : <p className="rounded-lg bg-fill px-3 py-3 text-[14px] text-muted">{tr("social.no_posts_in_monthname", { monthName })}</p>) : null}
          </div>
        </>)}
    </div>
  );
}

/* ---------------------------------------------------------------- Posts */

const FILTERS: { id: PostFilter; label: string; p2?: true }[] = [
  { id: "all", get label() { return tr("notifications.all"); } }, { id: "scheduled", get label() { return tr("mailfolder.scheduled"); } }, { id: "sent", get label() { return tr("mailfolder.sent"); } }, { id: "failed", get label() { return tr("social.failed"); } },
  { id: "drafts", get label() { return tr("mailfolder.drafts"); }, p2: true }, { id: "waiting", get label() { return tr("social.waiting_for_approval"); }, p2: true },
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
      <PageHeader title={tr("nav.posts")} description={tr("social.every_post_with_how_each_account_did_fix_a_faile")} actions={<NewPostButton />} />
      <SocialSwitcher />
      <div className="mb-4 -mx-1 max-w-full overflow-x-auto px-1 [scrollbar-width:none]">
        <div className="inline-flex gap-1 rounded-lg bg-fill p-1" role="group" aria-label={tr("social.show_posts")} data-testid="posts-filter">
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
  const soc1 = useSoc1On();
  const pages = useSocialPages(soc1);
  const me = useMe();
  const list = composerAccounts(accounts.data ?? [], direct.data, soc1 ? pages.data ?? [] : null);
  const rememberKey = soc1 && me.data?.organization && me.data.user ? soc1ChoiceKey(me.data.organization.id, me.data.user.id) : null;
  const draft = draftId ? (posts.data ?? []).find((p) => p.id === draftId) ?? null : null;
  const libItem = libId ? lib.data?.items.find((i) => i.id === libId) ?? null : null;
  const campaigns = [...new Set((posts.data ?? []).map((p) => p.campaign).filter((c): c is string => !!c))].sort();
  const waitingOn = status.isPending || accounts.isPending || direct.isPending || (soc1 && pages.isPending) || (!!draftId && posts.isPending) || (!!libId && lib.isPending);
  const canPublish = !!status.data?.canManage;
  return (
    <div data-testid="social-new">
      <PageHeader title={draft ? tr("social.edit_post") : tr("nav.new_post")} description={canPublish ? tr("social.pick_a_format_write_once_and_adjust_the_text_per") : tr("social.write_a_post_and_send_it_for_approval_an_owner_o")} />
      <SocialSwitcher />
      {waitingOn ? <div className="space-y-4" aria-busy="true"><Skeleton className="h-72 rounded-xl" /></div>
        : status.error ? <LoadError error={status.error} retry={() => void status.refetch()} what="Social" />
        : accounts.error ? <LoadError error={accounts.error} retry={() => void accounts.refetch()} what="your accounts" />
        : draftId && !draft ? <Card><EmptyState icon={<IconMegaphone />} title={tr("social.that_draft_is_gone")} body="It may have been sent, discarded or approved already." action={<ButtonLink to="/app/social/posts?status=drafts" variant="outline" size="sm">{tr("social.see_drafts")}</ButtonLink>} /></Card>
        : !list.length ? (
          <Card data-testid="social-empty"><EmptyState icon={<IconMegaphone />} title={tr("social.connect_a_social_account_first")} body="Connect Facebook Pages, Instagram, LinkedIn, Pinterest, Reddit, Threads or TikTok, then write one post and send it to all of them." action={<ButtonLink to="/app/social/accounts" size="sm"><IconPlug className="h-4 w-4" aria-hidden />{tr("social.connect_an_account")}</ButtonLink>} /></Card>
        ) : (
          <ComposerV2 key={draft?.id ?? libItem?.id ?? "new"} accounts={list} canPublish={canPublish} draft={draft} presetAt={params.get("at")} presetAccount={params.get("account")} campaigns={campaigns} multi={soc1} rememberKey={rememberKey}
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
      <PageHeader title={tr("nav.library")} description={tr("social.images_captions_and_hashtag_sets_your_team_reuse")} actions={<NewPostButton />} />
      <SocialSwitcher />
      {p2 ? <SocialLibrary /> : <Card><EmptyState icon={<IconMegaphone />} title={tr("social.library_isn_t_on_yet")} body="It arrives with the next Social update." /></Card>}
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
      <PageHeader title={tr("nav.new_post")} description={tr("social.write_once_and_send_it_to_every_account_you_pick")} />
      <SocialSwitcher />
      {status.isPending || accounts.isPending ? <div className="space-y-4" aria-busy="true"><Skeleton className="h-72 rounded-xl" /></div>
        : status.error ? <LoadError error={status.error} retry={() => void status.refetch()} what="Social" />
        : accounts.error ? <LoadError error={accounts.error} retry={() => void accounts.refetch()} what="your accounts" />
        : !status.data?.canManage ? (
          <Card data-testid="social-locked"><EmptyState icon={<IconLock />} title={tr("social.only_owners_and_admins_can_post")} body="You can see every post and how it did in Posts. Ask an owner or admin to post for the team." action={<ButtonLink to="/app/social/posts" variant="outline" size="sm">{tr("social.see_posts")}</ButtonLink>} /></Card>
        ) : !list.length ? (
          <Card data-testid="social-empty"><EmptyState icon={<IconMegaphone />} title={tr("social.connect_a_social_account_first")} body="Connect Facebook Pages, Instagram, LinkedIn, Pinterest or Reddit, then write one post and send it to all of them." action={<ButtonLink to="/app/social/accounts" size="sm"><IconPlug className="h-4 w-4" aria-hidden />{tr("social.connect_an_account")}</ButtonLink>} /></Card>
        ) : (
          <div className="space-y-3">
            <Composer accounts={list} heading={false} onPosted={() => navigate("/app/social/posts")} />
            <p className="px-1 text-[13px] text-muted">{tr("social.tiktok_videos_and_threads_posts_are_written_from")} <Link to="/app/social/accounts" className="font-medium text-fg underline underline-offset-2 hover:text-muted">{tr("nav.accounts")}</Link>.</p>
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
      {only ? <span className="font-medium text-fg">{tr("social.posting_only")}</span> : <span>{tr("social.can_do")} {list.join(", ")}.</span>}
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
    onSuccess: (_r, what) => { toast.success(what === "add" ? tr("social.test_network_added") : what === "remove" ? tr("social.test_network_removed") : what === "out" ? tr("social.test_network_now_acts_signed_out") : tr("social.signed_in_again")); void qc.invalidateQueries(); },
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
      <h2 id="acc-test" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">{tr("social.test_network")}</h2>
      <Card className="flex flex-wrap items-center gap-3 p-4 md:px-5" data-testid="test-network-card" data-health={a ? (a.broken ? "bad" : "ok") : "none"}>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-fill" aria-hidden><IconFlask className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">{tr("social.test_network")} <Badge tone="brand">{tr("social.staging_only")}</Badge></p>
          <p className="text-[13px] text-muted">{!a ? tr("social.a_pretend_network_for_trying_posts_approvals_the") : a.broken ? tr("social.acting_signed_out_so_you_can_see_the_warnings") : tr("social.connected_posts_to_it_show_as_sent_replies_and_r")}</p>
          {a && <AccountCaps app="testnet" />}
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {!a ? <Button size="sm" variant="outline" onClick={() => act.mutate("add")} loading={act.isPending} data-testid="test-network-add"><IconPlus className="h-4 w-4" aria-hidden />{tr("common.add")}</Button> : <>
              {a.broken
                ? <Button size="sm" variant="outline" onClick={() => act.mutate("in")} loading={act.isPending} data-testid="test-network-signin">{tr("settings.sign_in_again")}</Button>
                : <Button size="sm" variant="ghost" onClick={() => act.mutate("out")} loading={act.isPending} data-testid="test-network-signout">{tr("social.act_signed_out")}</Button>}
              <Button size="sm" variant="ghost" className="text-bad hover:text-bad" onClick={() => act.mutate("remove")} loading={act.isPending} aria-label={tr("social.remove_the_test_network")}><IconTrash className="h-4 w-4" aria-hidden />{tr("common.remove")}</Button>
            </>}
          </div>
        )}
      </Card>
    </section>
  );
}

export function SocialAccountsPage() {
  // SOC1: several Pages per login (flag SOCIAL_MULTI_SOC1); a new Facebook login opens its Page picker.
  const soc1 = useSoc1On();
  const pages = useSocialPages(soc1);
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  useConnectReturn((a) => { if (soc1 && a.app === "facebook") setOpenPicker(a.id); });
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
  const p3on = useSocialP3();
  const social = (accounts.data ?? []).filter((a) => (a.app in SOCIAL_NETWORKS || (p3on && a.app in P3_NAMES)) && a.app !== "testnet").sort((x, y) => (p2b ? Number(isBad(y)) - Number(isBad(x)) : 0));
  const broken = p2b ? social.filter((a) => isBad(a) && a.status !== "pending") : [];
  const test = useTestNetwork();
  const testBroken = p2b && !!test.st.data?.account?.broken;
  const connectedApps = new Set(social.filter((a) => a.status === "active").map((a) => a.app));
  const disconnect = useMutation({
    mutationFn: (a: ConnectedAccountView) => api.del<{ ok: true }>(`/apps/accounts/${encodeURIComponent(a.id)}`),
    onSuccess: (_r, a) => { toast.success(tr("social.appname_disconnected", { appName: a.appName })); setRemoving(null); void qc.invalidateQueries({ queryKey: appsKeys.accounts }); if (soc1) void qc.invalidateQueries({ queryKey: pagesKey }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't disconnect. Try again.")),
  });

  const healthLine = (a: ConnectedAccountView) => {
    if (a.status === "pending") return <Badge tone="warn" dot>{tr("social.sign_in_not_finished")}</Badge>;
    if (a.status !== "active") return <Badge tone="warn" dot>{tr("common.needs_attention")}</Badge>;
    if (health.isPending) return <span className="text-subtle">{tr("social.checking")}</span>;
    const h = health.data?.get(a.id);
    if (!h || h.ok) return <Badge tone="ok" dot>{a.app in P3_NAMES ? tr("social.ready_for_comments") : tr("social.ready_to_post")}</Badge>;
    if (h.code === "check_failed") return <Badge tone="neutral" dot>{tr("social.not_checked")}</Badge>;
    return <Badge tone="warn" dot>{tr("common.needs_attention")}</Badge>;
  };

  return (
    <div data-testid="social-accounts">
      <PageHeader title={tr("nav.accounts")} description={tr("social.the_profiles_multies_posts_to_checked_before_you")} actions={<NewPostButton />} />
      <SocialSwitcher />
      {!status.isPending && !canManage && <p className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-subtle"><IconLock className="h-3.5 w-3.5" aria-hidden />{tr("social.only_owners_and_admins_can_connect_accounts_or_p")}</p>}
      {(broken.length > 0 || testBroken) && (
        <Card className="mb-5 border-warn/40 p-4 md:px-5" data-testid="accounts-broken" role="region" aria-label={tr("settings.sign_in_again")}>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><IconWarning className="h-4 w-4 text-warn" aria-hidden />{tr("settings.sign_in_again")}</h2>
          <ul className="mt-2 space-y-2">
            {broken.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 text-[13.5px]">
                <span className="min-w-0 flex-1">{a.appName}{(a.name ?? a.label) ? `, ${a.name ?? a.label}` : ""} {tr("social.lost_its_sign_in_planned_posts_to_it_won_t_go_ou")}</span>
                {canManage ? <ReconnectButton accountId={a.id} appName={a.appName} /> : <span className="text-[12.5px] text-muted">{tr("social.ask_an_owner_or_admin_to_reconnect_it")}</span>}
              </li>
            ))}
            {testBroken && (
              <li className="flex flex-wrap items-center gap-3 text-[13.5px]">
                <span className="min-w-0 flex-1">{tr("social.test_network_lost_its_sign_in_planned_posts_to_i")}</span>
                {canManage ? <Button size="sm" variant="outline" onClick={() => test.act.mutate("in")} loading={test.act.isPending} data-testid="broken-reconnect-testnet"><IconRefresh className="h-4 w-4" aria-hidden />{tr("social.reconnect")}</Button>
                  : <span className="text-[12.5px] text-muted">{tr("social.ask_an_owner_or_admin_to_reconnect_it")}</span>}
              </li>
            )}
          </ul>
        </Card>
      )}
      <div className="space-y-7">
        <section aria-labelledby="acc-connected">
          <h2 id="acc-connected" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">{tr("social.connected")}</h2>
          {accounts.isPending ? <Card className="space-y-3 p-4" aria-busy="true"><Skeleton className="h-10 rounded-lg" /><Skeleton className="h-10 rounded-lg" /></Card>
            : accounts.error ? <LoadError error={accounts.error} retry={() => void accounts.refetch()} what="your accounts" />
            : !social.length ? (
              <Card className="flex items-center gap-3 p-4 text-sm text-muted" data-testid="accounts-none">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-fill" aria-hidden><IconPlug className="h-4 w-4" /></span>
                <p>{tr("social.no_social_accounts_yet_connect_one_below_to_star")}</p>
              </Card>
            ) : (
              <Card className="divide-y divide-line" data-testid="accounts-list">
                {social.map((a) => {
                  const h = health.data?.get(a.id);
                  const bad = h && !h.ok && h.code !== "check_failed";
                  return (
                    <div key={a.id} className={cn("flex flex-wrap gap-3 p-4 md:px-5", soc1 && (a.app === "facebook" || a.app === "linkedin") ? "items-start" : "items-center")} data-testid={`social-account-${a.app}`} data-health={bad ? "bad" : h?.ok ? "ok" : "unknown"}>
                      <AccountAvatar account={a} />
                      <div className="min-w-0 flex-1">
                        {/* SA1: the account's own name first, so two accounts on one network are told apart. */}
                        <p className="truncate text-[15px] font-medium" data-testid="account-name">{a.name ?? a.label ?? a.appName}</p>
                        <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">{(a.name ?? a.label) ? <span className="text-subtle">{a.appName}</span> : null}{healthLine(a)}<span>{tr("social.connected_createdat", { createdAt: timeAgo(a.createdAt) })}</span></p>
                        {bad && h?.text && <p className="mt-1 text-[12.5px] text-warn" data-testid="account-health-text">{h.text}</p>}
                        {a.app === "linkedin" && !(soc1 && a.companyPages) && <p className="mt-1 text-[12.5px] text-muted" data-testid="linkedin-page-note">{LINKEDIN_PAGE_NOTE}</p>}
                        {p2b && <AccountCaps app={a.app} />}
                        {soc1 && (a.app === "facebook" || a.app === "linkedin") && <LoginPages account={a} pages={pages.data} health={health.data} canManage={canManage} autoOpen={openPicker === a.id} />}
                      </div>
                      {canManage && (
                        <div className="flex gap-2 max-sm:w-full max-sm:pl-[52px]">
                          {(bad || a.status !== "active") && <ReconnectButton accountId={a.id} appName={a.appName} />}
                          <Button variant="ghost" size="sm" className="text-bad hover:text-bad" onClick={() => setRemoving(a)} aria-label={`Disconnect ${a.appName}${a.name ? `, ${a.name}` : ""}`}><IconTrash className="h-4 w-4" aria-hidden />{tr("social.disconnect")}</Button>
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
        <section aria-label={tr("social.tiktok_and_threads")}><DirectAccounts /></section>

        <section aria-labelledby="acc-add">
          <h2 id="acc-add" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">{tr("social.connect_a_network")}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="accounts-add">
            {[...NETWORKS, ...(p3on ? Object.keys(P3_NAMES) : [])].map((app) => (
              <Card key={app} className="flex items-center gap-3 p-4" data-testid={`connect-${app}`}>
                <AppLogo slug={app} name={NETWORK_NAMES[app] ?? P3_NAMES[app] ?? app} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">{NETWORK_NAMES[app] ?? P3_NAMES[app] ?? app}</p>
                  <p className="text-[12.5px] text-muted">{connectedApps.has(app) ? tr("social.connected_add_another_account") : app in P3_NAMES ? tr("social.comments_and_replies_in_your_inbox") : SOCIAL_NETWORKS[app]?.image === "required" ? tr("social.posts_need_an_image") : tr("social.text_and_image_posts")}</p>
                  {app === "linkedin" && <p className="mt-1 text-[12px] leading-snug text-subtle" data-testid="connect-linkedin-note">{LINKEDIN_PAGE_NOTE}</p>}
                </div>
                {canManage && (
                  <Button variant="outline" size="sm" loading={connect.isPending && connect.variables === app} onClick={() => connect.mutate(app)} aria-label={`Connect ${NETWORK_NAMES[app] ?? P3_NAMES[app] ?? app}`}>
                    <IconPlus className="h-4 w-4" aria-hidden />{tr("social.connect")}
                  </Button>
                )}
              </Card>
            ))}
          </div>
          <p className="mt-3 px-1 text-[13px] text-muted">{tr("social.other_apps_mail_accounts_and_webhooks_are_in")} <Link to="/app/settings/apps" className="font-medium text-fg underline underline-offset-2 hover:text-muted">{tr("social.settings_connections")}</Link>.</p>
        </section>
      </div>
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && disconnect.mutate(removing)} busy={disconnect.isPending}
        title={removing ? `Disconnect ${removing.appName}${removing.name ? `, ${removing.name}` : ""}?` : tr("social.disconnect")} confirmLabel={tr("social.disconnect")}
        description={soc1 && removing?.app === "facebook" ? tr("social.scheduled_posts_to_this_account_and_its_pages_wi") : tr("social.scheduled_posts_to_this_account_will_not_go_out")} />
    </div>
  );
}
