/**
 * R83: TikTok and Threads on the Social posts tab of Connections, through our own sign in. Connect, see the account,
 * post (a TikTok video with TikTok's own posting rules, or a Threads post), see your recent videos and posts, and
 * disconnect. Server: /api/direct and /api/connections/oauth/{tiktok,threads}/.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { Badge, Card, Skeleton, Switch } from "@/web/components/ui/misc";
import { Button, buttonClass } from "@/web/components/ui/button";
import { Field, Select, Textarea } from "@/web/components/ui/input";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { IconExternalLink, IconImage, IconLock, IconPlug, IconRefresh, IconSend, IconTrash, IconUpload, IconVideo, IconWarning } from "@/web/components/ui/icon";
import {
  DIRECT_NAMES, THREADS_TEXT_MAX, TIKTOK_PRIVACY_LABELS, TIKTOK_TITLE_MAX, TIKTOK_VIDEO_MAX_BYTES, TIKTOK_VIDEO_TYPES,
  type DirectAccountView, type DirectProvider, type DirectStatusResponse, type ThreadsPostView, type TikTokCreatorInfo,
  type TikTokPrivacy, type TikTokPublishView, type TikTokVideoView,
} from "@/shared/direct-social";
import { AppLogo } from "./apps-settings";
import { LoadFailure } from "@/web/components/load-error-t1g";

export const directKeys = {
  status: ["direct", "status"] as const,
  videos: ["direct", "tiktok", "videos"] as const,
  creator: ["direct", "tiktok", "creator"] as const,
  threads: ["direct", "threads", "profile"] as const,
};
const keys = directKeys;

const BLURB: Record<DirectProvider, string> = {
  tiktok: "Post videos to your TikTok and see your latest ones.",
  threads: "Post text or a picture to Threads and see your latest posts.",
};

function shortDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
}

function Avatar({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-fill text-[13px] font-semibold text-muted" aria-hidden>
      {(name || "?").slice(0, 1).toUpperCase()}
      {url && !failed && <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="absolute inset-0 h-full w-full object-cover" />}
    </span>
  );
}

/** Shows the sign in result once (?connected= or ?error= from the return trip), then clears it from the address. */
function useReturnNotice() {
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    const q = new URLSearchParams(loc.search);
    const connected = q.get("connected");
    const error = q.get("error");
    const net = q.get("network");
    if (connected !== "tiktok" && connected !== "threads" && !(error && (net === "tiktok" || net === "threads"))) return;
    if (connected === "tiktok" || connected === "threads") toast.success(`${DIRECT_NAMES[connected]} is connected.`);
    else if (error) toast.error(error);
    void qc.invalidateQueries({ queryKey: ["direct"] });
    navigate(loc.pathname, { replace: true });
  }, [loc.search, loc.pathname, navigate, qc]);
}

export function DirectAccounts() {
  useReturnNotice();
  const status = useQuery({ queryKey: keys.status, queryFn: () => api.get<DirectStatusResponse>("/direct/status"), staleTime: 15_000 });
  if (status.isPending) return <Card className="p-5" aria-busy="true"><Skeleton className="mb-4 h-5 w-48" /><Skeleton className="h-14 rounded-lg" /><Skeleton className="mt-3 h-14 rounded-lg" /></Card>;
  if (status.error || !status.data) {
    return (
      <Card className="p-5" data-testid="direct-accounts">
        <LoadFailure error={status.error} onRetry={() => status.refetch()} />
      </Card>
    );
  }
  const { accounts, canManage } = status.data;
  if (!accounts.some((a) => a.available || a.connected)) return null;
  const tiktok = accounts.find((a) => a.provider === "tiktok")!;
  const threads = accounts.find((a) => a.provider === "threads")!;
  return (
    <div className="space-y-4" data-testid="direct-accounts">
      <Card className="p-5">
        <div className="mb-4">
          <h2 className="text-[15px] font-semibold text-fg">TikTok and Threads</h2>
          <p className="mt-0.5 text-[13px] text-muted">Sign in once, then post straight from here.</p>
        </div>
        <ul className="divide-y divide-line">
          {accounts.map((a) => <AccountRow key={a.provider} a={a} canManage={canManage} />)}
        </ul>
      </Card>
      {tiktok.connected && tiktok.status === "active" && <TikTokVideos />}
      {threads.connected && threads.status === "active" && <ThreadsFeed />}
    </div>
  );
}

function AccountRow({ a, canManage }: { a: DirectAccountView; canManage: boolean }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [posting, setPosting] = useState(false);
  const name = DIRECT_NAMES[a.provider];
  const remove = useMutation({
    mutationFn: () => api.del<{ removed: boolean }>(`/direct/${a.provider}`),
    onSuccess: () => { setConfirm(false); toast.success(`${name} is disconnected.`); void qc.invalidateQueries({ queryKey: ["direct"] }); },
    onError: (e) => toast.error(errorMessage(e, `Couldn't disconnect ${name}. Try again.`)),
  });
  const start = `/api/connections/oauth/${a.provider}/start`;
  return (
    <li className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0" data-testid={`direct-${a.provider}`}>
      <AppLogo slug={a.provider} name={name} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-fg">{name}</span>
          {a.connected && a.status === "active" && <Badge tone="ok" dot>Connected</Badge>}
          {a.connected && a.status === "expired" && <Badge tone="warn" dot>Sign in expired</Badge>}
          {a.testMode && <Badge tone="neutral">Test mode</Badge>}
        </div>
        {a.connected ? (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[13px] text-muted">
            {a.displayName && <span className="truncate">{a.displayName}</span>}
            {a.username && (a.profileUrl
              ? <a href={a.profileUrl} target="_blank" rel="noreferrer" className="truncate text-brand-hover hover:underline">@{a.username}</a>
              : <span className="truncate">@{a.username}</span>)}
          </p>
        ) : (
          <p className="mt-0.5 text-[13px] text-muted">{a.available ? BLURB[a.provider] : "Not switched on here yet."}</p>
        )}
        {/* F13b (MB-308): say what Test mode means and what to do. */}
        {a.testMode && <p className="mt-1 text-[12.5px] text-muted" data-testid={`direct-${a.provider}-test-mode`}>Test mode: {name} has not approved this app for everyone yet, so only accounts added as testers in its developer settings can connect, and posts go up as private. Make a post public in the {name} app.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
        {a.available && canManage && (!a.connected || a.status === "expired") && (
          <a href={start} className={buttonClass(a.connected ? "outline" : "primary", "sm", "max-sm:flex-1")} data-testid={`direct-connect-${a.provider}`}>
            <IconPlug className="h-4 w-4" aria-hidden />{a.connected ? "Sign in again" : `Connect ${name}`}
          </a>
        )}
        {a.connected && a.status === "active" && canManage && (
          <Button size="sm" onClick={() => setPosting(true)} className="max-sm:flex-1" data-testid={`direct-post-${a.provider}`}>
            {a.provider === "tiktok" ? <IconVideo className="h-4 w-4" aria-hidden /> : <IconSend className="h-4 w-4" aria-hidden />}
            {a.provider === "tiktok" ? "Post a video" : "New post"}
          </Button>
        )}
        {a.connected && canManage && (
          <Button variant="ghost" size="sm" onClick={() => setConfirm(true)} aria-label={`Disconnect ${name}`} data-testid={`direct-disconnect-${a.provider}`}>
            <IconTrash className="h-4 w-4" aria-hidden /><span className="max-sm:hidden">Disconnect</span>
          </Button>
        )}
        {!canManage && !a.connected && a.available && <span className="inline-flex items-center gap-1 text-[12.5px] text-subtle"><IconLock className="h-3.5 w-3.5" aria-hidden />Owners and admins connect</span>}
      </div>
      <ConfirmDialog
        open={confirm} onClose={() => setConfirm(false)} onConfirm={() => remove.mutate()} busy={remove.isPending}
        title={`Disconnect ${name}?`} confirmLabel="Disconnect"
        description={a.provider === "tiktok" ? "Multies stops posting to this TikTok and gives back its access. Your videos stay on TikTok. You can connect again any time." : "Multies stops posting to this Threads account and deletes its sign in. Your posts stay on Threads. You can connect again any time."}
      />
      {a.provider === "tiktok" && posting && <TikTokPostDialog open={posting} onClose={() => setPosting(false)} />}
      {a.provider === "threads" && posting && <ThreadsPostDialog open={posting} onClose={() => setPosting(false)} />}
    </li>
  );
}

/* ---------------------------------------------------------------- TikTok */

const PUBLISH_COPY: Record<TikTokPublishView["status"], { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  processing: { label: "Processing", tone: "neutral" },
  published: { label: "Posted", tone: "ok" },
  failed: { label: "Not posted", tone: "bad" },
  removed: { label: "Taken down", tone: "warn" },
};

function TikTokVideos() {
  const q = useQuery({
    queryKey: keys.videos,
    queryFn: () => api.get<{ videos: TikTokVideoView[]; listAvailable?: boolean; publishes: TikTokPublishView[] }>("/direct/tiktok/videos"),
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.publishes.some((p) => p.status === "processing") ? 8_000 : false),
  });
  // Without TikTok's video list (an app without the Display API), every post made from here is listed instead.
  const own = q.data?.listAvailable === false;
  const pending = own ? (q.data?.publishes ?? []) : (q.data?.publishes ?? []).filter((p) => p.status !== "published").slice(0, 3);
  return (
    <Card className="p-5" data-testid="tiktok-videos">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">{own ? "Posted from Multies" : "Your TikTok videos"}</h3>
        <Button variant="ghost" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching} aria-label="Refresh videos"><IconRefresh className={cn("h-4 w-4", q.isFetching && "animate-spin motion-reduce:animate-none")} aria-hidden /></Button>
      </div>
      {pending.length > 0 && (
        <ul className="mb-3 space-y-2" data-testid="tiktok-publishes">
          {pending.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-[13px]">
              <span className="min-w-0 truncate text-fg">{p.title || "Untitled video"}</span>
              <Badge tone={PUBLISH_COPY[p.status].tone} dot>{PUBLISH_COPY[p.status].label}</Badge>
            </li>
          ))}
        </ul>
      )}
      {q.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-[9/16] rounded-lg" />)}</div>
      ) : q.error ? (
        <LoadFailure error={q.error} onRetry={() => q.refetch()} />
      ) : own ? (
        pending.length ? null : <p className="text-[13px] text-muted">No videos yet. Videos you post from here show in this list.</p>
      ) : !q.data?.videos.length ? (
        <p className="text-[13px] text-muted">No videos yet. Post one and it shows here once TikTok has it ready.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="tiktok-video-list">
          {q.data.videos.map((v) => (
            <li key={v.id}>
              <a href={v.shareUrl ?? undefined} target="_blank" rel="noreferrer" className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">
                <span className="relative block aspect-[9/16] overflow-hidden rounded-lg border border-line bg-fill">
                  {v.coverUrl ? <img src={v.coverUrl} alt="" referrerPolicy="no-referrer" loading="lazy" className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02] motion-reduce:transition-none" /> : <span className="grid h-full place-items-center text-subtle"><IconVideo className="h-6 w-6" aria-hidden /></span>}
                </span>
                <span className="mt-1.5 line-clamp-2 text-[13px] text-fg">{v.title || "Untitled video"}</span>
                <span className="text-[12px] text-subtle">{shortDate(v.createdAt)}{v.views != null ? ` · ${v.views.toLocaleString()} views` : ""}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function useVideoDuration(file: File | null) {
  const [sec, setSec] = useState<number | null>(null);
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => { setSec(null); }, [url]);
  return { url, sec, onMeta: (e: React.SyntheticEvent<HTMLVideoElement>) => setSec(Math.round(e.currentTarget.duration)) };
}

/** R117: also opened from the composer (Video or Story or reel with TikTok picked), with the caption carried over. */
export function TikTokPostDialog({ open, onClose, caption }: { open: boolean; onClose: () => void; caption?: string }) {
  const qc = useQueryClient();
  const creator = useQuery({ queryKey: keys.creator, queryFn: () => api.get<{ creator: TikTokCreatorInfo }>("/direct/tiktok/creator").then((r) => r.creator), staleTime: 0, gcTime: 0, enabled: open }); // R100b: the composer keeps this dialog mounted; only ask TikTok when it is open (no 409 when TikTok is not connected)
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [title, setTitle] = useState(caption ?? "");
  useEffect(() => { if (open && caption !== undefined) setTitle(caption); }, [open, caption]);
  const [privacy, setPrivacy] = useState<TikTokPrivacy | "">("");
  const [allowComment, setAllowComment] = useState(false);
  const [allowDuet, setAllowDuet] = useState(false);
  const [allowStitch, setAllowStitch] = useState(false);
  const [disclose, setDisclose] = useState(false);
  const [yourBrand, setYourBrand] = useState(false);
  const [branded, setBranded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const video = useVideoDuration(file);
  const c = creator.data;
  const tooLong = !!(c && video.sec && video.sec > c.maxDurationSec);
  const discloseIncomplete = disclose && !yourBrand && !branded;
  const brandedPrivate = branded && privacy === "SELF_ONLY";

  const post = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.set("video", file!);
      fd.set("title", title);
      fd.set("privacy", privacy);
      fd.set("allowComment", String(allowComment));
      fd.set("allowDuet", String(allowDuet));
      fd.set("allowStitch", String(allowStitch));
      fd.set("yourBrand", String(disclose && yourBrand));
      fd.set("brandedContent", String(disclose && branded));
      fd.set("consent", "true");
      const res = await fetch("/api/direct/tiktok/videos", { method: "POST", body: fd, credentials: "same-origin", headers: { "x-multies-upload": "1" } });
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message || "The video didn't post. Try again.");
      return body;
    },
    onSuccess: () => {
      toast.success("Sent to TikTok. It can take a few minutes to show on your profile.");
      void qc.invalidateQueries({ queryKey: keys.videos });
      onClose();
    },
  });

  const pick = (f: File | undefined) => {
    setFileError(null);
    if (!f) return;
    if (!(TIKTOK_VIDEO_TYPES as readonly string[]).includes(f.type)) { setFileError("Pick an MP4, MOV or WebM video."); return; }
    if (f.size > TIKTOK_VIDEO_MAX_BYTES) { setFileError("That video is over 50 MB. Pick a shorter one."); return; }
    setFile(f);
  };
  const canPost = !!file && !!privacy && !tooLong && !discloseIncomplete && !brandedPrivate && !post.isPending;
  const consent = disclose && branded
    ? <>By posting, you agree to TikTok&apos;s <a className="text-brand-hover underline" href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">Branded Content Policy</a> and <a className="text-brand-hover underline" href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a>.</>
    : <>By posting, you agree to TikTok&apos;s <a className="text-brand-hover underline" href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a>.</>;

  return (
    <Dialog open={open} onClose={onClose} title="Post a video to TikTok" className="sm:max-w-xl"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => post.mutate()} disabled={!canPost} loading={post.isPending} data-testid="tiktok-post-submit"><IconSend className="h-4 w-4" aria-hidden />Post to TikTok</Button>
      </>}>
      {creator.isPending ? (
        <div className="space-y-3" aria-busy="true"><Skeleton className="h-10 rounded-lg" /><Skeleton className="h-28 rounded-lg" /><Skeleton className="h-10 rounded-lg" /></div>
      ) : creator.error || !c ? (
        <div role="alert" className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2.5 text-sm text-bad">
          {errorMessage(creator.error, "Couldn't reach TikTok.")} <button type="button" className="underline" onClick={() => void creator.refetch()}>Try again</button>
        </div>
      ) : (
        <div className="space-y-4" data-testid="tiktok-post-form">
          <div className="flex items-center gap-3 rounded-lg border border-line bg-fill/50 px-3 py-2">
            <Avatar url={c.avatarUrl} name={c.nickname} />
            <div className="min-w-0 text-[13px]">
              <div className="text-subtle">Posting to</div>
              <div className="truncate font-medium text-fg" data-testid="tiktok-creator">{c.nickname}{c.username ? <span className="font-normal text-muted"> @{c.username}</span> : null}</div>
            </div>
          </div>

          <div>
            <input ref={input} type="file" accept={TIKTOK_VIDEO_TYPES.join(",")} className="sr-only" aria-label="Video file" data-testid="tiktok-file" onChange={(e) => pick(e.target.files?.[0])} />
            {file && video.url ? (
              <div className="flex items-start gap-3">
                <video src={video.url} onLoadedMetadata={video.onMeta} className="h-40 w-24 shrink-0 rounded-lg border border-line bg-black object-cover" muted playsInline controls={false} aria-label="Video preview" />
                <div className="min-w-0 text-[13px]">
                  <div className="truncate font-medium text-fg">{file.name}</div>
                  <div className="text-subtle">{(file.size / 1048576).toFixed(1)} MB{video.sec ? ` · ${video.sec} s` : ""}</div>
                  {tooLong && <p className="mt-1 text-bad" role="alert">TikTok allows up to {c.maxDurationSec} seconds for this account.</p>}
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => input.current?.click()}>Pick another</Button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => input.current?.click()} className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-4 py-6 text-[13px] text-muted transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">
                <IconUpload className="h-5 w-5" aria-hidden /><span className="font-medium text-fg">Pick a video</span><span>MP4, MOV or WebM, up to 50 MB</span>
              </button>
            )}
            {fileError && <p className="mt-1.5 text-xs text-bad" role="alert">{fileError}</p>}
          </div>

          <Field label="Caption" hint={`${[...title].length} of ${TIKTOK_TITLE_MAX}`}>
            {(p) => <Textarea {...p} value={title} onChange={(e) => setTitle(e.target.value.slice(0, TIKTOK_TITLE_MAX))} rows={3} placeholder="Say something about the video, add #tags" />}
          </Field>

          <Field label="Who can see this video" error={brandedPrivate ? "Branded content can't be private. Pick another audience." : undefined}>
            {(p) => (
              <Select {...p} value={privacy} onChange={(e) => setPrivacy(e.target.value as TikTokPrivacy)} data-testid="tiktok-privacy">
                <option value="" disabled>Pick one</option>
                {c.privacyOptions.map((o) => <option key={o} value={o} disabled={o === "SELF_ONLY" && disclose && branded}>{TIKTOK_PRIVACY_LABELS[o]}</option>)}
              </Select>
            )}
          </Field>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-[13px] font-medium text-fg/90">Let people</legend>
            <ToggleRow label="Comment" checked={allowComment && !c.commentDisabled} disabled={c.commentDisabled} onChange={setAllowComment} note={c.commentDisabled ? "Turned off in your TikTok settings" : undefined} />
            <ToggleRow label="Duet" checked={allowDuet && !c.duetDisabled} disabled={c.duetDisabled} onChange={setAllowDuet} note={c.duetDisabled ? "Turned off in your TikTok settings" : undefined} />
            <ToggleRow label="Stitch" checked={allowStitch && !c.stitchDisabled} disabled={c.stitchDisabled} onChange={setAllowStitch} note={c.stitchDisabled ? "Turned off in your TikTok settings" : undefined} />
          </fieldset>

          <div className="space-y-2 rounded-lg border border-line p-3">
            <ToggleRow label="Disclose video content" checked={disclose} onChange={(v) => { setDisclose(v); if (!v) { setYourBrand(false); setBranded(false); } }} note="Turn on if this video promotes you, a brand, a product or a service." />
            {disclose && (
              <div className="space-y-2 pl-1 pt-1">
                <label className="flex items-start gap-2 text-[13px] text-fg"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand" checked={yourBrand} onChange={(e) => setYourBrand(e.target.checked)} /><span><span className="font-medium">Your brand</span><span className="block text-subtle">You are promoting yourself or your own business.</span></span></label>
                <label className="flex items-start gap-2 text-[13px] text-fg"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand" checked={branded} onChange={(e) => { setBranded(e.target.checked); if (e.target.checked && privacy === "SELF_ONLY") setPrivacy(""); }} /><span><span className="font-medium">Branded content</span><span className="block text-subtle">You are promoting another brand or a third party.</span></span></label>
                {discloseIncomplete
                  ? <p className="flex items-start gap-1 text-xs text-warn" role="status"><IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />Pick at least one, or turn disclosure off.</p>
                  : <p className="text-xs text-muted" role="status">Your video will be labeled &ldquo;{branded ? "Paid partnership" : "Promotional content"}&rdquo;.</p>}
              </div>
            )}
          </div>

          <p className="text-xs text-muted" data-testid="tiktok-consent">{consent} TikTok can take a few minutes to process the video before it shows on your profile.</p>
          {post.error && <p role="alert" className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2 text-sm text-bad">{post.error.message}</p>}
        </div>
      )}
    </Dialog>
  );
}

function ToggleRow({ label, checked, onChange, disabled, note }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 text-[13px]">
        <div className={cn("font-medium text-fg", disabled && "text-subtle")}>{label}</div>
        {note && <div className="text-subtle">{note}</div>}
      </div>
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/* ---------------------------------------------------------------- Threads */

function ThreadsFeed() {
  const q = useQuery({
    queryKey: keys.threads,
    queryFn: () => api.get<{ profile: { username: string | null; name: string | null; avatarUrl: string | null; bio: string | null }; posts: ThreadsPostView[] }>("/direct/threads/profile"),
    staleTime: 30_000,
  });
  return (
    <Card className="p-5" data-testid="threads-feed">
      {q.isPending ? (
        <div aria-busy="true" className="space-y-3"><Skeleton className="h-10 w-56 rounded-lg" /><Skeleton className="h-14 rounded-lg" /><Skeleton className="h-14 rounded-lg" /></div>
      ) : q.error || !q.data ? (
        <LoadFailure error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="mb-3 flex items-center gap-3">
            <Avatar url={q.data.profile.avatarUrl} name={q.data.profile.name ?? q.data.profile.username ?? "T"} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-fg" data-testid="threads-profile-name">{q.data.profile.name ?? q.data.profile.username}</div>
              {q.data.profile.username && <a href={`https://www.threads.net/@${encodeURIComponent(q.data.profile.username)}`} target="_blank" rel="noreferrer" className="truncate text-[13px] text-brand-hover hover:underline">@{q.data.profile.username}</a>}
            </div>
          </div>
          {q.data.profile.bio && <p className="mb-3 text-[13px] text-muted">{q.data.profile.bio}</p>}
          <h3 className="mb-2 text-sm font-semibold text-fg">Your latest Threads posts</h3>
          {!q.data.posts.length ? <p className="text-[13px] text-muted">No posts yet. Write one and it shows here.</p> : (
            <ul className="divide-y divide-line" data-testid="threads-post-list">
              {q.data.posts.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-3 py-2.5 text-[13px]">
                  <div className="min-w-0">
                    <p className="line-clamp-2 whitespace-pre-line text-fg">{p.text || (p.mediaType === "IMAGE" ? "Picture" : "Post")}</p>
                    <span className="text-[12px] text-subtle">{shortDate(p.createdAt)}</span>
                  </div>
                  {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer" aria-label="Open on Threads" className={buttonClass("ghost", "icon")}><IconExternalLink className="h-4 w-4" aria-hidden /></a>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

async function readImage(file: File) {
  if (!["image/jpeg", "image/png"].includes(file.type)) throw new Error("Use a JPEG or PNG image.");
  if (file.size > 1_000_000) throw new Error("Images can be up to 1 MB.");
  const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error("That image could not be read.")); r.readAsDataURL(file); });
  return { contentType: file.type, dataB64: data.slice(data.indexOf(",") + 1), preview: data };
}

function ThreadsPostDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ contentType: string; dataB64: string; preview: string } | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const count = [...text].length;
  const post = useMutation({
    mutationFn: () => api.create<{ post: { id: string; permalink: string | null } }>("/direct/threads/posts", { text, image: image ? { contentType: image.contentType, dataB64: image.dataB64 } : null }),
    onSuccess: () => { toast.success("Posted to Threads."); void qc.invalidateQueries({ queryKey: keys.threads }); onClose(); },
  });
  const canPost = (count > 0 || !!image) && count <= THREADS_TEXT_MAX && !post.isPending;
  return (
    <Dialog open={open} onClose={onClose} title="New Threads post"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => post.mutate()} disabled={!canPost} loading={post.isPending} data-testid="threads-post-submit"><IconSend className="h-4 w-4" aria-hidden />Post to Threads</Button>
      </>}>
      <div className="space-y-3" data-testid="threads-post-form">
        <Field label="Post" hint={`${count} of ${THREADS_TEXT_MAX}`} error={count > THREADS_TEXT_MAX ? `Threads allows ${THREADS_TEXT_MAX} characters.` : undefined}>
          {(p) => <Textarea {...p} autoFocus rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="What's new?" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canPost) { e.preventDefault(); post.mutate(); } }} />}
        </Field>
        <input ref={input} type="file" accept="image/jpeg,image/png" className="sr-only" aria-label="Image" onChange={(e) => { const f = e.target.files?.[0]; setImgError(null); if (f) readImage(f).then(setImage, (err: Error) => setImgError(err.message)); e.target.value = ""; }} />
        {image ? (
          <div className="flex items-center gap-3">
            <img src={image.preview} alt="Picked image" className="h-16 w-16 rounded-lg border border-line object-cover" />
            <Button variant="ghost" size="sm" onClick={() => setImage(null)}>Remove image</Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => input.current?.click()}><IconImage className="h-4 w-4" aria-hidden />Add an image</Button>
        )}
        {imgError && <p className="text-xs text-bad" role="alert">{imgError}</p>}
        {post.error && <p role="alert" className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2 text-sm text-bad">{errorMessage(post.error, "That didn't post. Try again.")}</p>}
      </div>
    </Dialog>
  );
}
