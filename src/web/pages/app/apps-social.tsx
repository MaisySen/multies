/**
 * R80C: the Social posts tab of Connections. Write once, pick accounts (a Facebook page, a Pinterest board, a Reddit
 * community where the network needs one), add an image, post now or set a time. Each account then shows its own
 * result. Ctrl or Cmd plus Enter posts. Server: /api/social.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { IconCheckCircle, IconClock, IconClose, IconExternalLink, IconImage, IconMegaphone, IconPlug, IconRefresh, IconSend, IconSpinner, IconTrash, IconWarning, IconXCircle } from "@/web/components/ui/icon";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import {
  SOCIAL_ERROR_COPY, SOCIAL_RECONNECT_ERRORS, socialErrorText, SOCIAL_IMAGE_MAX_BYTES, SOCIAL_MAX_AHEAD_DAYS, SOCIAL_NETWORKS, SOCIAL_TEXT_MAX,
  type ConnectedAccountView, type DeleteOutcome, type PostStatus, type PostTargetView, type SocialAccountHealth, type SocialPostView,
} from "@/shared/integrations";
import { AppLogo, useAppAccounts } from "./apps-settings";
import { useMe } from "@/web/lib/queries";

export const postsKey = ["social", "posts"] as const;

export const POST_STATUS: Record<PostStatus, { label: string; tone: "ok" | "warn" | "bad" | "neutral" | "brand" }> = {
  scheduled: { label: "Scheduled", tone: "brand" },
  sending: { label: "Posting", tone: "neutral" },
  done: { label: "Posted", tone: "ok" },
  partial: { label: "Partly posted", tone: "warn" },
  failed: { label: "Not posted", tone: "bad" },
  canceled: { label: "Canceled", tone: "neutral" },
  draft: { label: "Draft", tone: "neutral" },
  review: { label: "Waiting for approval", tone: "brand" },
  changes: { label: "Changes asked", tone: "warn" },
  rejected: { label: "Rejected", tone: "neutral" },
};

export function whenText(iso: string) {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** A local "YYYY-MM-DDTHH:mm" for datetime-local inputs. */
function localInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function readImage(file: File): Promise<{ contentType: string; dataB64: string; preview: string }> {
  if (!["image/jpeg", "image/png"].includes(file.type)) throw new Error("Use a JPEG or PNG image.");
  if (file.size > SOCIAL_IMAGE_MAX_BYTES) throw new Error("Images can be up to 1 MB.");
  const preview = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error("That image could not be read.")); r.readAsDataURL(file); });
  return { contentType: file.type, dataB64: preview.slice(preview.indexOf(",") + 1), preview };
}

/** Pages or boards for one account, loaded when it is picked. */
function TargetPicker({ account, value, onChange }: { account: ConnectedAccountView; value: string; onChange: (v: string, name?: string) => void }) {
  const net = SOCIAL_NETWORKS[account.app]!;
  const listed = net.target?.kind === "page" || net.target?.kind === "board";
  const q = useQuery({
    queryKey: ["apps", "targets", account.id],
    queryFn: () => api.get<{ targets: { id: string; name: string }[] }>(`/apps/accounts/${encodeURIComponent(account.id)}/targets`).then((r) => r.targets),
    enabled: listed, staleTime: 300_000,
  });
  useEffect(() => { if (listed && !value && q.data?.length === 1) onChange(q.data[0]!.id, q.data[0]!.name); }, [listed, value, q.data, onChange]);
  if (!net.target) return null;
  const label = `${net.target.label} for ${account.appName}`;
  if (!listed) {
    return <Input aria-label={label} placeholder="Community, for example r/smallbusiness" value={value} onChange={(e) => onChange(e.target.value)} className="h-9 max-w-xs text-sm" />;
  }
  if (q.isPending) return <Skeleton className="h-9 w-56 rounded-lg" />;
  if (q.error) return <p className="text-[13px] text-bad">Couldn't load your {net.target.label.toLowerCase()}s. <button type="button" className="underline" onClick={() => void q.refetch()}>Try again</button></p>;
  if (!q.data?.length) return <p className="text-[13px] text-muted">No {net.target.label.toLowerCase()}s found on this account.</p>;
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value, q.data?.find((t) => t.id === e.target.value)?.name)} className="h-9 max-w-xs text-sm">
      <option value="">Pick a {net.target.label.toLowerCase()}</option>
      {q.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </Select>
  );
}

/**
 * P1 layout: why a network cannot take the post as it stands (needs an image, text too long), or null. A broken sign
 * in has its own line from the account check, so it only greys the row here.
 */
export function cannotTake(a: ConnectedAccountView, post: { image: boolean; length: number; broken: boolean }): string | null {
  const n = SOCIAL_NETWORKS[a.app];
  if (!n || post.broken) return null;
  if (n.image === "required" && !post.image) return `${a.appName} needs an image. Add one below to post here.`;
  if (post.length > n.maxChars) return `Too long for ${a.appName}: ${n.maxChars.toLocaleString()} characters at most.`;
  return null;
}

export function SocialPanel({ canManage }: { canManage: boolean }) {
  const accounts = useAppAccounts();
  const navigate = useNavigate();
  const postable = (accounts.data ?? []).filter((a) => a.status === "active" && a.app in SOCIAL_NETWORKS);
  if (accounts.isPending) return <div className="space-y-4"><Skeleton className="h-64 rounded-xl" /><Skeleton className="h-28 rounded-xl" /></div>;
  if (accounts.error) {
    return (
      <Card className="p-6">
        <p className="text-sm text-bad" role="alert">{errorMessage(accounts.error, "Couldn't load your accounts.")}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void accounts.refetch()}><IconRefresh className="h-4 w-4" aria-hidden />Try again</Button>
      </Card>
    );
  }
  return (
    <div className="space-y-6" data-testid="social-panel">
      {postable.length === 0 ? (
        <Card data-testid="social-empty">
          <EmptyState icon={<IconMegaphone />} title="Connect a social account first"
            body="Connect Facebook Pages, Instagram, LinkedIn, Pinterest or Reddit, then write one post and send it to all of them."
            action={<Button onClick={() => navigate("/app/social/accounts")}><IconPlug className="h-4 w-4" aria-hidden />Connect an account</Button>} />
        </Card>
      ) : canManage ? <Composer accounts={postable} /> : null}
      <PostList canManage={canManage} />
    </div>
  );
}

export function Composer({ accounts, onPosted, heading = true }: { accounts: ConnectedAccountView[]; onPosted?: (post: SocialPostView) => void; heading?: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Record<string, string | null>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [image, setImage] = useState<{ contentType: string; dataB64: string; preview: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [later, setLater] = useState(false);
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + 3600_000)));
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [postedId, setPostedId] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const health = useAccountHealth();
  /** An account whose check says it can't post right now (a check that could not run does not block). */
  const broken = (id: string) => { const h = health.data?.get(id); return h && !h.ok && h.code !== "check_failed" ? h : null; };

  const ids = Object.keys(picked);
  const chosen = accounts.filter((a) => ids.includes(a.id));
  const limit = chosen.length ? Math.min(...chosen.map((a) => SOCIAL_NETWORKS[a.app]!.maxChars), SOCIAL_TEXT_MAX) : SOCIAL_TEXT_MAX;
  const tight = chosen.find((a) => SOCIAL_NETWORKS[a.app]!.maxChars === limit);

  /** What each picked account still needs, in plain words, before anything is sent. */
  const local = useMemo(() => {
    const out: Record<string, string> = {};
    for (const a of chosen) {
      const n = SOCIAL_NETWORKS[a.app]!;
      const h = broken(a.id);
      if (h) out[a.id] = h.text ?? SOCIAL_ERROR_COPY.reconnect!;
      else if (n.image === "required" && !image) out[a.id] = SOCIAL_ERROR_COPY.needs_image!;
      else if (text.trim().length > n.maxChars) out[a.id] = SOCIAL_ERROR_COPY.too_long!;
      else if (n.target && !(picked[a.id] ?? "").trim()) out[a.id] = SOCIAL_ERROR_COPY.needs_target!;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, image, text, picked, health.data]);

  const whenIso = later ? new Date(at).toISOString() : null;
  const tooSoon = later && new Date(at).getTime() < Date.now() + 60_000;
  const tooFar = later && new Date(at).getTime() > Date.now() + SOCIAL_MAX_AHEAD_DAYS * 86_400_000;
  const ready = text.trim().length > 0 && chosen.length > 0 && !Object.keys(local).length && !tooSoon && !tooFar;

  const send = useMutation({
    mutationFn: () => api.create<{ post: SocialPostView }>("/social/posts", {
      text: text.trim(),
      image: image ? { contentType: image.contentType, dataB64: image.dataB64 } : null,
      targets: chosen.map((a) => ({ accountId: a.id, target: picked[a.id] || null, targetName: names[a.id] || null })),
      runAt: whenIso,
    }),
    onSuccess: (r) => {
      setText(""); setImage(null); setPicked({}); setLater(false); setProblems({});
      void qc.invalidateQueries({ queryKey: postsKey });
      // Oct 31: a post set for now opens a sheet that follows it until every network has answered.
      if (r.post.status === "scheduled" && later) { toast.success(`Scheduled for ${whenText(r.post.runAt)}`); onPosted?.(r.post); }
      else setPostedId(r.post.id);
    },
    onError: (e) => {
      const d = e instanceof ApiError ? (e.details as { problems?: { accountId: string; code: string }[] } | undefined) : undefined;
      if (d?.problems) setProblems(Object.fromEntries(d.problems.map((p) => [p.accountId, SOCIAL_ERROR_COPY[p.code] ?? SOCIAL_ERROR_COPY.rejected!])));
      toast.error(errorMessage(e, "Couldn't save the post. Try again."));
    },
  });

  const submit = (e?: React.FormEvent) => { e?.preventDefault(); if (ready && !send.isPending) send.mutate(); };
  const toggle = (a: ConnectedAccountView) => setPicked((p) => { const n = { ...p }; if (a.id in n) delete n[a.id]; else n[a.id] = null; return n; });

  return (
    <Card>
      <form ref={form} onSubmit={submit} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }} className="space-y-5 p-5 md:p-6" data-testid="social-composer" aria-labelledby="composer-title">
        <div className={cn(!heading && "sr-only")}>
          <h2 id="composer-title" className="text-[15px] font-semibold">New post</h2>
          <p className="mt-1 text-[13px] text-muted">One post, sent to every account you pick. Each account shows its own result below.</p>
        </div>

        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Post to</legend>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {accounts.map((a) => {
              const on = a.id in picked;
              const h = broken(a.id);
              const err = on ? problems[a.id] ?? local[a.id] : null;
              const textOnly = on && !err && image && SOCIAL_NETWORKS[a.app]!.image === "none";
              // P1 layout: a network that cannot take this post is greyed out, with the reason, until it can.
              const cannot = on ? null : cannotTake(a, { image: !!image, length: text.trim().length, broken: !!h });
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5" data-testid={`pick-${a.app}`} data-blocked={cannot ? "true" : undefined}>
                  <label className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-3 sm:min-h-9", cannot ? "cursor-not-allowed" : "cursor-pointer")}>
                    <input type="checkbox" checked={on} disabled={!!cannot || !!(h && !on)} onChange={() => toggle(a)} aria-describedby={cannot ? `why-${a.id}` : undefined} className="h-4 w-4 shrink-0 accent-[var(--color-brand)] disabled:cursor-not-allowed" />
                    <span className={cn("flex min-w-0 items-center gap-3", (cannot || (h && !on)) && "opacity-55")}>
                      <AppLogo slug={a.app} name={a.appName} size="sm" />
                      <span className="min-w-0 truncate text-sm">{a.appName}{a.label ? <span className="text-muted">, {a.label}</span> : null}</span>
                    </span>
                  </label>
                  {cannot && <p id={`why-${a.id}`} className="basis-full pl-7 text-[12.5px] text-muted" data-testid="pick-why">{cannot}</p>}
                  {on && <TargetPicker account={a} value={picked[a.id] ?? ""} onChange={(v, name) => { setPicked((p) => ({ ...p, [a.id]: v })); setNames((n) => ({ ...n, [a.id]: name ?? v })); }} />}
                  {h && !on && <span className="text-[12.5px] text-warn max-sm:hidden" data-testid="pick-health">Needs attention</span>}
                  {h && <ReconnectButton accountId={a.id} appName={a.appName} />}
                  {(err ?? (h ? h.text : null)) && <p className="basis-full pl-7 text-[12.5px] text-warn" data-testid="pick-problem" data-code={h?.code ?? undefined}><IconWarning className="mr-1 inline h-3.5 w-3.5" aria-hidden />{err ?? h?.text}</p>}
                  {textOnly && <p className="basis-full pl-7 text-[12.5px] text-muted" data-testid="pick-note">{a.appName} gets the text only; the image is left off.</p>}
                </li>
              );
            })}
          </ul>
        </fieldset>

        <div>
          <label htmlFor="social-text" className="mb-2 block text-[13px] font-medium">Text</label>
          <Textarea id="social-text" value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={SOCIAL_TEXT_MAX} placeholder="What do you want to share?" data-testid="social-text" />
          <p className={cn("mt-1 text-right text-[12px] tabular-nums", text.length > limit ? "text-bad" : "text-subtle")} aria-live="polite">
            {text.length} of {limit}{tight && limit < SOCIAL_TEXT_MAX ? ` (${tight.appName} limit)` : ""}
          </p>
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium">Image <span className="font-normal text-subtle">(JPEG or PNG, up to 1 MB)</span></p>
          {image ? (
            <div className="relative inline-block">
              <img src={image.preview} alt="Image for the post" className="h-28 w-28 rounded-lg border border-line object-cover" />
              <Button type="button" size="icon" variant="secondary" className="absolute -right-2 -top-2 rounded-full shadow-card" onClick={() => setImage(null)} aria-label="Remove image"><IconClose className="h-4 w-4" aria-hidden /></Button>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()}><IconImage className="h-4 w-4" aria-hidden />Add image</Button>
          )}
          <input ref={file} type="file" accept="image/jpeg,image/png" className="sr-only" tabIndex={-1} aria-hidden data-testid="social-image"
            onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; setImageError(null); try { setImage(await readImage(f)); } catch (err) { setImageError((err as Error).message); } }} />
          {imageError && <p role="alert" className="mt-2 text-[13px] text-bad">{imageError}</p>}
        </div>

        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">When</legend>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg bg-fill p-1" role="radiogroup" aria-label="When">
              {[{ v: false, l: "Now" }, { v: true, l: "Later" }].map((o) => (
                <button key={o.l} type="button" role="radio" aria-checked={later === o.v} onClick={() => setLater(o.v)}
                  className={cn("h-8 rounded-md px-3 text-sm font-medium transition-colors duration-150 max-sm:min-h-11", later === o.v ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>{o.l}</button>
              ))}
            </div>
            {later && <Input type="datetime-local" aria-label="Post at" value={at} min={localInput(new Date())} onChange={(e) => setAt(e.target.value)} className="h-9 w-auto text-sm" data-testid="social-at" />}
          </div>
          {tooSoon && <p className="mt-2 text-[13px] text-warn">Pick a time at least a minute from now, or post now.</p>}
          {tooFar && <p className="mt-2 text-[13px] text-warn">Posts can be set up to {SOCIAL_MAX_AHEAD_DAYS} days ahead.</p>}
        </fieldset>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
          <span className="text-[12px] text-subtle max-sm:hidden">Ctrl Enter to {later ? "schedule" : "post"}</span>
          <Button type="submit" disabled={!ready} loading={send.isPending} className="max-sm:w-full" data-testid="social-submit">
            {later ? <IconClock className="h-4 w-4" aria-hidden /> : <IconSend className="h-4 w-4" aria-hidden />}
            {later ? "Schedule post" : chosen.length > 1 ? `Post to ${chosen.length} accounts` : "Post now"}
          </Button>
        </div>
      </form>
      {postedId && <PostedSheet postId={postedId} onClose={() => { setPostedId(null); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="social-text"]')?.focus()); }} onViewPosts={onPosted ? (p) => { setPostedId(null); onPosted(p); } : undefined} />}
    </Card>
  );
}

/** Starts a fresh sign in for one account and goes to the network's page. */
export function ReconnectButton({ accountId, appName }: { accountId: string; appName: string }) {
  const reconnect = useMutation({
    mutationFn: () => api.post<{ redirectUrl: string }>(`/apps/accounts/${encodeURIComponent(accountId)}/reconnect`),
    onSuccess: (r) => { window.location.assign(r.redirectUrl); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't reconnect. Try again.")),
  });
  return (
    <Button type="button" variant="outline" size="sm" loading={reconnect.isPending} onClick={() => reconnect.mutate()} aria-label={`Reconnect ${appName}`}>
      <IconPlug className="h-4 w-4" aria-hidden />Reconnect
    </Button>
  );
}

/** Why one account did not post, in plain words, with Reconnect when signing in again is the fix. */
function TargetError({ error, accountId, appName, canManage }: { error: string | null; accountId: string; appName: string; canManage: boolean }) {
  const { code, text } = socialErrorText(error);
  return (
    <span className="flex basis-full flex-wrap items-center gap-x-2 gap-y-1 pl-9" data-testid="post-target-error" data-code={code}>
      <span className="inline-flex min-w-0 items-start gap-1.5 text-bad"><IconXCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span className="min-w-0 break-words">{text}</span></span>
      {canManage && SOCIAL_RECONNECT_ERRORS.has(code) && <ReconnectButton accountId={accountId} appName={appName} />}
    </span>
  );
}

const healthKey = ["social", "health"] as const;

/** Each account checked without posting, so a broken sign in shows before anyone writes. */
export function useAccountHealth() {
  return useQuery({
    queryKey: healthKey,
    queryFn: () => api.get<{ accounts: SocialAccountHealth[] }>("/social/health").then((r) => new Map(r.accounts.map((a) => [a.accountId, a]))),
    staleTime: 60_000,
    retry: false,
  });
}

/** P1 layout: the Posts page filters the one list. */
export type PostFilter = "all" | "scheduled" | "sent" | "failed" | "drafts" | "waiting";
/** R117: drafts and posts waiting for approval have their own filters and stay out of All. */
export const isDraftLike = (p: SocialPostView) => p.status === "draft" || p.status === "changes" || p.status === "rejected";
export function postMatches(p: SocialPostView, f: PostFilter): boolean {
  if (f === "scheduled") return p.status === "scheduled" || p.status === "sending";
  if (f === "sent") return p.status === "done" || p.status === "partial";
  if (f === "failed") return p.status === "failed" || p.status === "partial";
  if (f === "drafts") return isDraftLike(p);
  if (f === "waiting") return p.status === "review";
  return !isDraftLike(p) && p.status !== "review";
}
const FILTER_EMPTY: Record<PostFilter, { title: string; body: string }> = {
  all: { title: "No posts yet", body: "Posts you send or schedule show here, with how each account did." },
  scheduled: { title: "Nothing scheduled", body: "Posts set for later wait here until they go out." },
  sent: { title: "Nothing sent yet", body: "Posts that went out show here, with a link to each one." },
  failed: { title: "Nothing failed", body: "When a network turns a post down, it shows here with the reason and a fix." },
  drafts: { title: "No drafts", body: "Save a post as a draft from New post and finish it later." },
  waiting: { title: "Nothing waiting for approval", body: "Posts sent for approval wait here until an owner or admin approves them." },
};

/** The social posts list, shared by the Social Posts page; one query for every filter. */
export function useSocialPosts() {
  return useQuery({
    queryKey: postsKey,
    // R117: the web asks for drafts and posts waiting for approval too (the phone app's list stays as it was).
    queryFn: () => api.get<{ posts: SocialPostView[] }>("/social/posts?all=1").then((r) => r.posts),
    // While something is going out, look again every few seconds.
    refetchInterval: (q) => ((q.state.data ?? []).some((p) => p.status === "sending" || (p.status === "scheduled" && Date.parse(p.runAt) <= Date.now() + 5_000)) ? 3_000 : false),
  });
}

/** Oct 31: the network's name as people say it ("Facebook"), from the account label or the app id. */
const NETWORK_NAME: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", pinterest: "Pinterest", reddit: "Reddit", twitter: "X", threads: "Threads" };
export const networkName = (app: string) => NETWORK_NAME[app] ?? app.charAt(0).toUpperCase() + app.slice(1);

/** "Facebook and LinkedIn", "Facebook, Instagram and LinkedIn". */
export function andList(items: string[]): string {
  const u = [...new Set(items)];
  return u.length <= 1 ? (u[0] ?? "") : `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
}

/**
 * Where a delete reaches: networks it is deleted on, and networks where the post stays. A post on an account that is
 * no longer connected stays there (Multies can't reach it), so only networks Multies will really delete from are
 * named, Facebook first.
 */
export function deleteReach(p: SocialPostView, connected?: Set<string> | null): { on: string[]; stays: string[] } {
  const sent = p.targets.filter((t) => t.status === "sent" && t.networkState !== "removed");
  const reachable = (t: PostTargetView) => !!t.canDelete && (!connected || connected.has(t.accountId));
  const order = (a: string, b: string) => (a === "Facebook" ? -1 : b === "Facebook" ? 1 : 0);
  const on = [...new Set(sent.filter(reachable).map((t) => networkName(t.app)))].sort(order);
  const stays = [...new Set(sent.filter((t) => !reachable(t)).map((t) => networkName(t.app)))].filter((n) => !on.includes(n));
  return { on, stays };
}

/** Every network that had the post has since removed it. */
export const removedEverywhere = (p: SocialPostView) => p.targets.some((t) => t.status === "sent") && p.targets.filter((t) => t.status === "sent").every((t) => t.networkState === "removed");

/** One account's row on a post: logo, account, status chip, time, then Open post or the reason and a fix. */
function TargetRow({ t, p, canManage }: { t: PostTargetView; p: SocialPostView; canManage: boolean }) {
  const name = t.label ?? networkName(t.app);
  const removed = t.status === "sent" && t.networkState === "removed";
  return (
    <li className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2.5 text-[13px]", removed && "text-muted")} data-testid="post-target" data-status={t.status} data-network={removed ? "removed" : t.networkState ?? ""}>
      <AppLogo slug={t.app} name={name} size="sm" />
      <span className="min-w-0 flex-1 truncate">{name}{t.target ? <span className="text-muted">, {t.targetName ?? t.target}</span> : null}</span>
      {removed ? (
        <Badge tone="neutral">Removed on {networkName(t.app)}</Badge>
      ) : t.status === "sent" ? (
        <span className="inline-flex items-center gap-2">
          <Badge tone="ok"><IconCheckCircle className="h-3.5 w-3.5" aria-hidden />Posted</Badge>
          {t.sentAt && <span className="text-[12px] text-subtle">{whenText(t.sentAt)}</span>}
          {t.url && <a href={t.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1 font-medium text-fg underline underline-offset-2 hover:text-muted max-sm:min-h-11" data-testid="open-post">Open post<IconExternalLink className="h-3.5 w-3.5" aria-hidden /></a>}
        </span>
      ) : t.status === "failed" || t.status === "skipped" ? (
        <>
          <Badge tone="bad">Not posted</Badge>
          <TargetError error={t.error} accountId={t.accountId} appName={name} canManage={canManage} />
        </>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-muted">
          {p.status === "sending" || (p.status === "scheduled" && Date.parse(p.runAt) <= Date.now()) ? <><IconSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />Posting</> : p.status === "canceled" ? "Not sent" : <><IconClock className="h-3.5 w-3.5" aria-hidden />Waiting</>}
        </span>
      )}
      {removed && <p className="basis-full pl-9 text-[12px] text-subtle">This post was deleted on {networkName(t.app)}. There is nothing left to open.</p>}
      {t.status === "sent" && !removed && t.canCheck === false && t.canDelete && (
        <p className="basis-full pl-9 text-[12px] text-subtle" data-testid="no-removal-check">{networkName(t.app)} doesn't tell Multies when a post is deleted there. Deleted it on {networkName(t.app)}? Delete it here too.</p>
      )}
    </li>
  );
}

/**
 * Oct 31: after Post now, a sheet follows the post until every network has answered: a tick and Open post for each
 * one that took it, the reason and a fix for one that did not. The composer is already clear behind it.
 */
export function PostedSheet({ postId, onClose, onViewPosts }: { postId: string; onClose: () => void; onViewPosts?: (p: SocialPostView) => void }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: [...postsKey, "one", postId],
    queryFn: () => api.get<{ post: SocialPostView }>(`/social/posts/${postId}`).then((r) => r.post),
    refetchInterval: (x) => (!x.state.data || x.state.data.status === "sending" || x.state.data.status === "scheduled" ? 1500 : false),
  });
  const p = q.data;
  const busy = !p || p.status === "sending" || p.status === "scheduled";
  const okCount = p ? p.targets.filter((t) => t.status === "sent").length : 0;
  const title = busy ? "Posting now" : p.status === "done" ? (okCount === 1 ? `Posted to ${networkName(p.targets[0]!.app)}` : `Posted to all ${okCount} accounts`) : p.status === "partial" ? `Posted to ${okCount} of ${p.targets.length} accounts` : "Not posted";
  const description = busy ? "Each network answers in a few seconds." : p.status === "done" ? "It's live. Open it on each network below." : p.status === "partial" ? "One network turned it down. The reason and the fix are below." : "No network took it. The reason and the fix are below.";
  const view = () => { if (p && onViewPosts) onViewPosts(p); else { onClose(); navigate("/app/social/posts"); } };
  return (
    <Dialog open onClose={onClose} title={title} description={description} className="sm:max-w-lg"
      footer={(
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" className="max-sm:w-full" onClick={onClose}>Write another</Button>
          <Button className="max-sm:w-full" onClick={view} data-testid="view-in-posts">View in Posts</Button>
        </div>
      )}>
      <div data-testid="posted-sheet" data-status={p?.status ?? "loading"} aria-live="polite">
        {!p ? (q.error ? <p className="text-sm text-bad" role="alert">{errorMessage(q.error, "Couldn't load the post. It is in Posts.")}</p> : <div className="space-y-2"><Skeleton className="h-10 rounded-lg" /><Skeleton className="h-10 rounded-lg" /></div>) : (
          <ul className="divide-y divide-line rounded-lg border border-line text-left" aria-label="Where it went">
            {p.targets.map((t) => <TargetRow key={t.accountId} t={t} p={p} canManage />)}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Oct 31: the posts on screen are checked against their network when Posts opens, when the window comes back into
 * view and on Refresh (the server holds each post to one check per 5 minutes). Facebook only: LinkedIn doesn't say.
 */
function useNetworkSync(posts: SocialPostView[] | undefined) {
  const qc = useQueryClient();
  const ids = useMemo(() => (posts ?? []).filter((p) => p.targets.some((t) => t.canCheck && t.status === "sent" && t.networkState !== "removed" && t.sentAt && Date.now() - Date.parse(t.sentAt) < 30 * 86_400_000)).slice(0, 20).map((p) => p.id), [posts]);
  const key = ids.join(",");
  const run = useMutation({
    mutationFn: (list: string[]) => api.post<{ posts: SocialPostView[] }>("/social/posts/sync", { ids: list }),
    onSuccess: async (r) => {
      // A list read that started before the check would bring back the old state: drop it, then apply the check.
      await qc.cancelQueries({ queryKey: postsKey });
      const byId = new Map(r.posts.map((p) => [p.id, p]));
      qc.setQueryData<SocialPostView[]>(postsKey, (old) => old?.map((p) => byId.get(p.id) ?? p));
    },
  });
  const runRef = useRef(run.mutate);
  runRef.current = run.mutate;
  useEffect(() => {
    if (!key) return;
    runRef.current(key.split(","));
    const onFocus = () => { if (document.visibilityState === "visible") runRef.current(key.split(",")); };
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [key]);
  // Refresh checks first, then reloads the list, so the reload always carries what the check found.
  const refresh = () => {
    if (key) run.mutate(key.split(","), { onSettled: () => void qc.invalidateQueries({ queryKey: postsKey }) });
    else void qc.invalidateQueries({ queryKey: postsKey });
  };
  return { syncing: run.isPending, refresh };
}


export function PostList({ canManage, filter = "all", heading = true }: { canManage: boolean; filter?: PostFilter; heading?: boolean }) {
  const qc = useQueryClient();
  const posts = useSocialPosts();
  const navigate = useNavigate();
  const me = useMe();
  const myId = me.data?.user.id;
  const linked = useAppAccounts();
  const connected = useMemo(() => (linked.data ? new Set(linked.data.filter((a) => a.status === "active").map((a) => a.id)) : null), [linked.data]);
  const [toDiscard, setToDiscard] = useState<SocialPostView | null>(null);
  const discard = useMutation({
    mutationFn: (id: string) => api.post<{ discarded: boolean }>(`/social/posts/${id}/discard`),
    onSuccess: () => { toast.success("Draft discarded"); setToDiscard(null); void qc.invalidateQueries({ queryKey: postsKey }); requestAnimationFrame(() => document.getElementById("posts-title")?.focus()); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't discard it. Try again.")),
  });
  const shown = (posts.data ?? []).filter((p) => postMatches(p, filter));
  const net = useNetworkSync(posts.data);
  const [toDelete, setToDelete] = useState<SocialPostView | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => api.post<{ post: SocialPostView }>(`/social/posts/${id}/cancel`),
    onSuccess: () => { toast.success("Post canceled"); void qc.invalidateQueries({ queryKey: postsKey }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't cancel the post. Try again.")),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post<{ post: SocialPostView }>(`/social/posts/${id}/retry`),
    onSuccess: () => { toast.success("Sending again"); void qc.invalidateQueries({ queryKey: postsKey }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't send again. Try again in a minute.")),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del<{ deleted: boolean; results: { app: string; outcome: DeleteOutcome }[] }>(`/social/posts/${id}`),
    onSuccess: (r) => {
      const done = r.results.filter((x) => x.outcome === "deleted").map((x) => networkName(x.app));
      const failed = r.results.filter((x) => x.outcome === "failed").map((x) => networkName(x.app));
      if (r.deleted) toast.success(done.length ? `Post deleted from ${andList(done)}` : "Post deleted");
      else toast.error(`${done.length ? `Deleted from ${andList(done)}. ` : ""}${andList(failed)} didn't delete it. Try again in a minute.`);
      setToDelete(null);
      void qc.invalidateQueries({ queryKey: postsKey });
      // The row that held focus may be gone: land on the list heading, not the page body.
      if (r.deleted) requestAnimationFrame(() => document.getElementById("posts-title")?.focus());
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't delete the post. Try again.")),
  });
  const reach = toDelete ? deleteReach(toDelete, connected) : { on: [], stays: [] };
  const deleteText = !toDelete ? "" : [
    reach.on.length ? `It will also be deleted from ${andList(reach.on)}.` : toDelete.status === "scheduled" ? "It won't go out." : "",
    reach.stays.length ? `It stays on ${andList(reach.stays)}, because Multies can't delete it there.` : "",
    reach.on.length ? "You can't undo this." : "",
  ].filter(Boolean).join(" ");

  return (
    <section aria-labelledby="posts-title">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h2 id="posts-title" tabIndex={-1} className={cn("outline-none text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle", !heading && "sr-only")}>Posts</h2>
        {!!posts.data?.length && (
          <Button variant="ghost" size="sm" className="ml-auto" loading={net.syncing || posts.isRefetching} onClick={net.refresh} data-testid="posts-refresh">
            <IconRefresh className="h-4 w-4" aria-hidden />Refresh
          </Button>
        )}
      </div>
      {posts.isPending ? <div className="space-y-3"><Skeleton className="h-28 rounded-xl" /><Skeleton className="h-28 rounded-xl" /></div>
        : posts.error ? (
          <Card className="p-5">
            <p className="text-sm text-bad" role="alert">{errorMessage(posts.error, "Couldn't load posts.")}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void posts.refetch()}><IconRefresh className="h-4 w-4" aria-hidden />Try again</Button>
          </Card>
        ) : !shown.length ? (
          <Card data-testid="posts-empty"><EmptyState icon={<IconMegaphone />} title={FILTER_EMPTY[filter].title} body={FILTER_EMPTY[filter].body} /></Card>
        ) : (
          <ul className="space-y-3" data-testid="social-posts">
            {shown.map((p) => {
              const gone = removedEverywhere(p);
              const st = gone ? { label: "Removed", tone: "neutral" as const } : POST_STATUS[p.status];
              return (
                <li key={p.id}>
                  <Card className="p-4 md:p-5" data-testid="social-post" data-status={p.status}>
                    <div className="flex items-start gap-3.5">
                      {p.imageUrl && (
                        <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-fill">
                          <img src={p.imageUrl} alt="" className="max-h-full max-w-full object-contain" loading="lazy" />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                          <Badge tone={st.tone} dot>{st.label}</Badge>
                          <span>{p.status === "scheduled" ? `Goes out ${whenText(p.runAt)}` : whenText(p.runAt)}</span>
                        </p>
                        <p className={cn("mt-2 line-clamp-4 whitespace-pre-line break-words text-sm leading-relaxed", gone && "text-muted")}>{p.text}</p>
                      </div>
                    </div>
                    <ul className="mt-3.5 divide-y divide-line rounded-lg border border-line" aria-label="Accounts">
                      {p.targets.map((t) => <TargetRow key={t.accountId} t={t} p={p} canManage={canManage} />)}
                    </ul>
                    {(p.campaign || p.evergreen || p.reviewNote) && (
                      <p className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-muted" data-testid="post-meta">
                        {p.campaign && <Badge tone="neutral">{p.campaign}</Badge>}
                        {p.evergreen && <span>Evergreen</span>}
                        {p.reviewNote && (p.status === "changes" || p.status === "rejected") && <span className="basis-full text-warn" data-testid="post-review-note">{p.status === "changes" ? "Changes asked" : "Rejected"}: {p.reviewNote}</span>}
                      </p>
                    )}
                    {(isDraftLike(p) || p.status === "review") && (canManage || p.createdBy === myId) && (
                      <div className="mt-3 flex flex-wrap justify-end gap-2" data-testid="draft-actions">
                        <Button variant="ghost" size="sm" className="text-bad hover:text-bad max-sm:flex-1" onClick={() => setToDiscard(p)} data-testid="post-discard"><IconTrash className="h-4 w-4" aria-hidden />Discard</Button>
                        {(p.status !== "review" || canManage) && <Button variant="outline" size="sm" className="max-sm:flex-1" onClick={() => navigate(`/app/social/new?draft=${encodeURIComponent(p.id)}`)} data-testid="post-edit">Edit</Button>}
                      </div>
                    )}
                    {canManage && p.status !== "sending" && !isDraftLike(p) && p.status !== "review" && (
                      <div className="mt-3 flex flex-wrap justify-end gap-2">
                        {p.status === "scheduled" && <Button variant="ghost" size="sm" className="max-sm:flex-1" loading={cancel.isPending && cancel.variables === p.id} onClick={() => cancel.mutate(p.id)}>Cancel post</Button>}
                        {(p.status === "failed" || p.status === "partial") && <Button variant="outline" size="sm" className="max-sm:flex-1" loading={retry.isPending && retry.variables === p.id} onClick={() => retry.mutate(p.id)}><IconRefresh className="h-4 w-4" aria-hidden />Try again</Button>}
                        <Button variant="ghost" size="sm" className="text-bad hover:text-bad max-sm:flex-1" onClick={() => setToDelete(p)} data-testid="post-delete"><IconTrash className="h-4 w-4" aria-hidden />Delete</Button>
                      </div>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={() => toDelete && del.mutate(toDelete.id)} busy={del.isPending}
        title="Delete this post?" description={deleteText || "It leaves your list in Multies."}
        confirmLabel={reach.on.length ? `Delete from ${andList(reach.on)}` : "Delete post"} />
      <ConfirmDialog open={!!toDiscard} onClose={() => setToDiscard(null)} onConfirm={() => toDiscard && discard.mutate(toDiscard.id)} busy={discard.isPending}
        title="Discard this draft?" description="It leaves Multies. Nothing was posted, so no network is touched." confirmLabel="Discard draft" />
    </section>
  );
}
