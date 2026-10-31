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
import { IconCheckCircle, IconClock, IconClose, IconExternalLink, IconImage, IconMegaphone, IconPlug, IconRefresh, IconSend, IconWarning, IconXCircle } from "@/web/components/ui/icon";
import {
  SOCIAL_ERROR_COPY, SOCIAL_IMAGE_MAX_BYTES, SOCIAL_MAX_AHEAD_DAYS, SOCIAL_NETWORKS, SOCIAL_TEXT_MAX,
  type ConnectedAccountView, type PostStatus, type SocialPostView,
} from "@/shared/integrations";
import { AppLogo, useAppAccounts } from "./apps-settings";

const postsKey = ["social", "posts"] as const;

const POST_STATUS: Record<PostStatus, { label: string; tone: "ok" | "warn" | "bad" | "neutral" | "brand" }> = {
  scheduled: { label: "Scheduled", tone: "brand" },
  sending: { label: "Posting", tone: "neutral" },
  done: { label: "Posted", tone: "ok" },
  partial: { label: "Partly posted", tone: "warn" },
  failed: { label: "Not posted", tone: "bad" },
  canceled: { label: "Canceled", tone: "neutral" },
};

function whenText(iso: string) {
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
function TargetPicker({ account, value, onChange }: { account: ConnectedAccountView; value: string; onChange: (v: string) => void }) {
  const net = SOCIAL_NETWORKS[account.app]!;
  const listed = net.target?.kind === "page" || net.target?.kind === "board";
  const q = useQuery({
    queryKey: ["apps", "targets", account.id],
    queryFn: () => api.get<{ targets: { id: string; name: string }[] }>(`/apps/accounts/${encodeURIComponent(account.id)}/targets`).then((r) => r.targets),
    enabled: listed, staleTime: 300_000,
  });
  useEffect(() => { if (listed && !value && q.data?.length === 1) onChange(q.data[0]!.id); }, [listed, value, q.data, onChange]);
  if (!net.target) return null;
  const label = `${net.target.label} for ${account.appName}`;
  if (!listed) {
    return <Input aria-label={label} placeholder="Community, for example r/smallbusiness" value={value} onChange={(e) => onChange(e.target.value)} className="h-9 max-w-xs text-sm" />;
  }
  if (q.isPending) return <Skeleton className="h-9 w-56 rounded-lg" />;
  if (q.error) return <p className="text-[13px] text-bad">Couldn't load your {net.target.label.toLowerCase()}s. <button type="button" className="underline" onClick={() => void q.refetch()}>Try again</button></p>;
  if (!q.data?.length) return <p className="text-[13px] text-muted">No {net.target.label.toLowerCase()}s found on this account.</p>;
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 max-w-xs text-sm">
      <option value="">Pick a {net.target.label.toLowerCase()}</option>
      {q.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </Select>
  );
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
            action={<Button onClick={() => navigate("/app/settings/apps")}><IconPlug className="h-4 w-4" aria-hidden />Connect an account</Button>} />
        </Card>
      ) : canManage ? <Composer accounts={postable} /> : null}
      <PostList canManage={canManage} />
    </div>
  );
}

function Composer({ accounts }: { accounts: ConnectedAccountView[] }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Record<string, string | null>>({});
  const [image, setImage] = useState<{ contentType: string; dataB64: string; preview: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [later, setLater] = useState(false);
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + 3600_000)));
  const [problems, setProblems] = useState<Record<string, string>>({});
  const file = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);

  const ids = Object.keys(picked);
  const chosen = accounts.filter((a) => ids.includes(a.id));
  const limit = chosen.length ? Math.min(...chosen.map((a) => SOCIAL_NETWORKS[a.app]!.maxChars), SOCIAL_TEXT_MAX) : SOCIAL_TEXT_MAX;
  const tight = chosen.find((a) => SOCIAL_NETWORKS[a.app]!.maxChars === limit);

  /** What each picked account still needs, in plain words, before anything is sent. */
  const local = useMemo(() => {
    const out: Record<string, string> = {};
    for (const a of chosen) {
      const n = SOCIAL_NETWORKS[a.app]!;
      if (n.image === "required" && !image) out[a.id] = SOCIAL_ERROR_COPY.needs_image!;
      else if (text.trim().length > n.maxChars) out[a.id] = SOCIAL_ERROR_COPY.too_long!;
      else if (n.target && !(picked[a.id] ?? "").trim()) out[a.id] = SOCIAL_ERROR_COPY.needs_target!;
    }
    return out;
  }, [chosen, image, text, picked]);

  const whenIso = later ? new Date(at).toISOString() : null;
  const tooSoon = later && new Date(at).getTime() < Date.now() + 60_000;
  const tooFar = later && new Date(at).getTime() > Date.now() + SOCIAL_MAX_AHEAD_DAYS * 86_400_000;
  const ready = text.trim().length > 0 && chosen.length > 0 && !Object.keys(local).length && !tooSoon && !tooFar;

  const send = useMutation({
    mutationFn: () => api.create<{ post: SocialPostView }>("/social/posts", {
      text: text.trim(),
      image: image ? { contentType: image.contentType, dataB64: image.dataB64 } : null,
      targets: chosen.map((a) => ({ accountId: a.id, target: picked[a.id] || null })),
      runAt: whenIso,
    }),
    onSuccess: (r) => {
      toast.success(r.post.status === "scheduled" && later ? `Scheduled for ${whenText(r.post.runAt)}` : `Posting to ${chosen.length} ${chosen.length === 1 ? "account" : "accounts"}`);
      setText(""); setImage(null); setPicked({}); setLater(false); setProblems({});
      void qc.invalidateQueries({ queryKey: postsKey });
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
        <div>
          <h2 id="composer-title" className="text-[15px] font-semibold">New post</h2>
          <p className="mt-1 text-[13px] text-muted">One post, sent to every account you pick. Each account shows its own result below.</p>
        </div>

        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Post to</legend>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {accounts.map((a) => {
              const on = a.id in picked;
              const err = on ? problems[a.id] ?? local[a.id] : null;
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5" data-testid={`pick-${a.app}`}>
                  <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 sm:min-h-9">
                    <input type="checkbox" checked={on} onChange={() => toggle(a)} className="h-4 w-4 shrink-0 accent-[var(--color-brand)]" />
                    <AppLogo slug={a.app} name={a.appName} size="sm" />
                    <span className="min-w-0 truncate text-sm">{a.appName}{a.label ? <span className="text-muted">, {a.label}</span> : null}</span>
                  </label>
                  {on && <TargetPicker account={a} value={picked[a.id] ?? ""} onChange={(v) => setPicked((p) => ({ ...p, [a.id]: v }))} />}
                  {err && <p className="basis-full pl-7 text-[12.5px] text-warn" data-testid="pick-problem"><IconWarning className="mr-1 inline h-3.5 w-3.5" aria-hidden />{err}</p>}
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
    </Card>
  );
}

function PostList({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const posts = useQuery({
    queryKey: postsKey,
    queryFn: () => api.get<{ posts: SocialPostView[] }>("/social/posts").then((r) => r.posts),
    // While something is going out, look again every few seconds.
    refetchInterval: (q) => ((q.state.data ?? []).some((p) => p.status === "sending" || (p.status === "scheduled" && Date.parse(p.runAt) <= Date.now() + 5_000)) ? 3_000 : false),
  });
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

  return (
    <section aria-labelledby="posts-title">
      <h2 id="posts-title" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">Posts</h2>
      {posts.isPending ? <div className="space-y-3"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-24 rounded-xl" /></div>
        : posts.error ? (
          <Card className="p-5">
            <p className="text-sm text-bad" role="alert">{errorMessage(posts.error, "Couldn't load posts.")}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void posts.refetch()}><IconRefresh className="h-4 w-4" aria-hidden />Try again</Button>
          </Card>
        ) : !posts.data?.length ? (
          <Card><EmptyState icon={<IconMegaphone />} title="No posts yet" body="Posts you send or schedule show here, with how each account did." /></Card>
        ) : (
          <ul className="space-y-3" data-testid="social-posts">
            {posts.data.map((p) => {
              const st = POST_STATUS[p.status];
              return (
                <li key={p.id}>
                  <Card className="p-4 md:p-5" data-testid="social-post" data-status={p.status}>
                    <div className="flex flex-wrap items-start gap-3">
                      {p.imageUrl && <img src={p.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg border border-line object-cover" loading="lazy" />}
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-3 whitespace-pre-line text-sm">{p.text}</p>
                        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                          <Badge tone={st.tone} dot>{st.label}</Badge>
                          <span>{p.status === "scheduled" ? `Goes out ${whenText(p.runAt)}` : whenText(p.runAt)}</span>
                        </p>
                      </div>
                      {canManage && (p.status === "scheduled" || p.status === "failed" || p.status === "partial") && (
                        <div className="flex gap-2 max-sm:w-full">
                          {p.status === "scheduled"
                            ? <Button variant="ghost" size="sm" className="max-sm:flex-1" loading={cancel.isPending && cancel.variables === p.id} onClick={() => cancel.mutate(p.id)}>Cancel post</Button>
                            : <Button variant="outline" size="sm" className="max-sm:flex-1" loading={retry.isPending && retry.variables === p.id} onClick={() => retry.mutate(p.id)}><IconRefresh className="h-4 w-4" aria-hidden />Try again</Button>}
                        </div>
                      )}
                    </div>
                    <ul className="mt-3 divide-y divide-line rounded-lg border border-line" aria-label="Accounts">
                      {p.targets.map((t) => (
                        <li key={t.accountId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]" data-testid="post-target" data-status={t.status}>
                          <AppLogo slug={t.app} name={t.label ?? t.app} size="sm" />
                          <span className="min-w-0 flex-1 truncate">{t.label ?? t.app}{t.target ? <span className="text-muted">, {t.target}</span> : null}</span>
                          {t.status === "sent" ? (
                            <span className="inline-flex items-center gap-1.5 text-ok"><IconCheckCircle className="h-4 w-4" aria-hidden />Posted
                              {t.url && <a href={t.url} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex min-h-8 items-center gap-1 text-brand hover:underline">View<IconExternalLink className="h-3.5 w-3.5" aria-hidden /></a>}
                            </span>
                          ) : t.status === "failed" || t.status === "skipped" ? (
                            <span className="inline-flex basis-full items-center gap-1.5 pl-9 text-bad sm:basis-auto sm:pl-0"><IconXCircle className="h-4 w-4 shrink-0" aria-hidden />{SOCIAL_ERROR_COPY[t.error ?? "rejected"] ?? SOCIAL_ERROR_COPY.rejected}</span>
                          ) : (
                            <span className="text-muted">{p.status === "scheduled" ? "Waiting" : p.status === "canceled" ? "Not sent" : "Posting"}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
