/**
 * R117: composer v2 on New post. Format first (text, image, carousel, video, story or reel); account chips grey out
 * with the reason when a network can't take that format; per network tabs that inherit the main text until edited;
 * counters against each network's limit; a live preview per network (side panel at 1280, sheet on phones); checks
 * before send (ready, will be changed and how, left out and why); crop helpers; library picks; first comment, link
 * card, poll and campaign where a network allows them; Post now, Schedule (or the next free slot), Save draft and
 * Submit for approval. Sending uses the same /api/social posts and the same publisher as before.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { Card, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Dialog } from "@/web/components/ui/dialog";
import {
  IconBookmark, IconCalendarClock, IconCheckCircle, IconClose, IconEye, IconImage, IconLayers, IconSend, IconSmartphone, IconText, IconVideo,
  IconWarning, IconXCircle, IconPlus, IconClock,
} from "@/web/components/ui/icon";
import {
  SOCIAL_ERROR_COPY, SOCIAL_MAX_AHEAD_DAYS, SOCIAL_NETWORKS, type ConnectedAccountView, type SocialPostView,
} from "@/shared/integrations";
import type { DirectStatusResponse } from "@/shared/direct-social";
import {
  CROP_SHAPES, FORMAT_LABELS, NETWORK_RULES, POLL_DAYS, SOCIAL_FORMATS, charCount, composerChecks, cropRect, defaultTarget, firstLink, formatFit, networkLabel, textFor,
  type AccountCheck, type CropAnchor, type CropShape, type LibraryView, type PollInput, type SocialFormat,
} from "@/shared/social-p2";
import { AccountAvatar, AppLogo } from "./apps-settings";
import type { Soc1PageView } from "@/shared/social-soc1"; // SOC1
import { PostedSheet, postsKey, useAccountHealth, whenText } from "./apps-social";
import { TikTokPostDialog, directKeys } from "./apps-direct";
import { LoadErrorInline, LoadFailure } from "@/web/components/load-error-t1g";
import { BestTimeChips, PinDetailsCard, SnapShare, WritingHelp, useSocialP3 } from "./social-p3"; // R132
import type { PinDetails } from "@/shared/social-p3";
import { shrinkPhoto } from "@/web/lib/shrink-image"; // SOCFIX
import { PHOTO_QUALITIES, photoBudget, SOCIAL_PHOTO_ACCEPT } from "@/shared/social-image"; // SOCFIX

/* ---------------------------------------------------------------- helpers */

export interface ComposerAccount { id: string; app: string; name: string; label: string | null; needsTarget: boolean; account?: ConnectedAccountView; /** SOC1: a chosen Page (its own account id). */ page?: boolean }

interface PickedImage { key: string; src: string; w: number; h: number; upload?: { contentType: string; dataB64: string }; mediaId?: string; /** SOCFIX: "Optimised for posting" when it was shrunk. */ note?: string | null }

let seq = 0;
const nextKey = () => `img${++seq}`;

function localInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function measure(src: string): Promise<{ w: number; h: number }> {
  return new Promise((res) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth || 1, h: i.naturalHeight || 1 }); i.onerror = () => res({ w: 1, h: 1 }); i.src = src; });
}

/** SOCFIX: any normal photo works; it is shrunk in the browser to fit every network before upload. */
async function readFile(file: File): Promise<PickedImage> {
  const p = await shrinkPhoto(file);
  return { key: nextKey(), src: p.src, w: p.w, h: p.h, upload: { contentType: p.contentType, dataB64: p.dataB64 }, note: p.note };
}

/** Crops in the browser and keeps the result under the photo budget (JPEG, lower quality until it fits). */
async function cropImage(img: PickedImage, shape: CropShape, anchor: CropAnchor): Promise<PickedImage> {
  const el = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => rej(new Error("That image could not be read.")); i.src = img.src; });
  const r = cropRect(el.naturalWidth, el.naturalHeight, shape, anchor);
  const scale = Math.min(1, 2048 / Math.max(r.w, r.h));
  const c = document.createElement("canvas");
  c.width = Math.round(r.w * scale); c.height = Math.round(r.h * scale);
  c.getContext("2d")!.drawImage(el, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const budget = photoBudget().bytes;
  let url = c.toDataURL("image/jpeg", 0.9);
  for (const q of PHOTO_QUALITIES) { url = c.toDataURL("image/jpeg", q); if (url.length * 0.75 <= budget) break; }
  if (url.length * 0.75 > budget) throw new Error("That crop could not be made small enough. Try a smaller part.");
  return { key: nextKey(), src: url, w: c.width, h: c.height, upload: { contentType: "image/jpeg", dataB64: url.slice(url.indexOf(",") + 1) } };
}

/** SOCFIX: the app's brand focus ring on tabs, for keyboard focus only (a click or tap shows none). An outline, so it
 * never fights the selected tab's shadow, in light, dark and Forest alike. */
const TAB_RING = "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

const FORMAT_ICON: Record<SocialFormat, typeof IconText> = { text: IconText, image: IconImage, carousel: IconLayers, video: IconVideo, story: IconSmartphone };

export function useDirectStatus() {
  return useQuery({ queryKey: directKeys.status, queryFn: () => api.get<DirectStatusResponse>("/direct/status"), staleTime: 15_000, retry: false });
}

/** Composio accounts the composer posts to, plus TikTok and Threads when linked. */
export function composerAccounts(list: ConnectedAccountView[], direct: DirectStatusResponse | undefined, pages?: Soc1PageView[] | null): ComposerAccount[] {
  const live = list.filter((a) => a.status === "active" && a.app in SOCIAL_NETWORKS && a.app !== "threads" && a.app !== "twitter");
  const out: ComposerAccount[] = [];
  for (const a of live) {
    // SOC1: a login with chosen Pages is replaced by one row per Page (its own picture and name); LinkedIn company
    // Pages come after the member's own profile. Without chosen Pages a login works as before (Page picked per post).
    const mine = pages ? pages.filter((p) => p.viaAccountId === a.id && p.app === a.app) : [];
    if (!(a.app === "facebook" && mine.length)) out.push({ id: a.id, app: a.app, name: a.appName, label: a.name ?? a.label ?? null, needsTarget: !!SOCIAL_NETWORKS[a.app]?.target, account: a });
    for (const p of mine) out.push({ id: p.key, app: p.app, name: p.name, label: null, needsTarget: false, account: { ...a, name: p.name, avatarUrl: p.pictureUrl }, page: true });
  }
  for (const d of direct?.accounts ?? []) {
    if (!d.connected || d.status === "expired") continue;
    out.push({ id: `direct:${d.provider}`, app: d.provider, name: networkLabel(d.provider), label: d.username ? `@${d.username}` : null, needsTarget: false });
  }
  // R118: the staging only test network, labelled as such everywhere.
  if (direct?.test) out.push({ id: direct.test.id, app: "testnet", name: "Test network", label: null, needsTarget: false });
  return out;
}

/* ---------------------------------------------------------------- preview */

function PreviewCard({ app, name, label, text, images, linkCard, poll, firstComment, format }: {
  app: string; name: string; label: string | null; text: string; images: PickedImage[]; linkCard: boolean; poll: PollInput | null; firstComment: string; format: SocialFormat;
}) {
  const [more, setMore] = useState(false);
  const r = NETWORK_RULES[app];
  const fold = r?.fold ?? 300;
  const long = charCount(text) > fold;
  const shown = long && !more ? `${[...text].slice(0, fold).join("").trimEnd()}...` : text;
  const fit = formatFit(app, format);
  const showImages = (format === "image" || format === "carousel") && fit.fit !== "no" && !(fit.fit === "changed" && fit.how.startsWith("Text only")) ? images.slice(0, Math.max(1, r?.maxImages ?? 1)) : [];
  const aspect = app === "instagram" ? "aspect-[4/5]" : format === "story" ? "aspect-[9/16]" : "aspect-[4/3]";
  const link = linkCard && r?.linkCard ? firstLink(text) : null;
  return (
    <article className="overflow-hidden rounded-xl border border-line bg-surface" data-testid={`preview-${app}`} aria-label={`${networkLabel(app)} preview`}>
      <header className="flex items-center gap-2.5 px-3.5 pt-3.5">
        <AppLogo slug={app} name={name} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold leading-tight">{label ?? name}</p>
          <p className="text-[12px] text-subtle">Just now</p>
        </div>
      </header>
      {fit.fit === "no" ? <p className="px-3.5 py-4 text-[13px] text-muted">{fit.why}</p> : (<>
        <p className="whitespace-pre-line break-words px-3.5 py-2.5 text-[13.5px] leading-relaxed">
          {shown || <span className="text-subtle">Your text shows here.</span>}
          {long && <button type="button" className="ml-1 font-medium text-muted underline underline-offset-2" onClick={() => setMore((m) => !m)}>{more ? "See less" : "See more"}</button>}
        </p>
        {showImages.length > 0 && (
          <div className={cn("grid gap-0.5 bg-fill", showImages.length > 1 && "grid-cols-2")}>
            {showImages.slice(0, 4).map((im, i) => (
              <div key={im.key} className={cn("relative overflow-hidden", showImages.length === 1 ? aspect : "aspect-square")}>
                <img src={im.src} alt="" className="h-full w-full object-cover" />
                {i === 3 && showImages.length > 4 && <span className="absolute inset-0 grid place-items-center bg-black/55 text-lg font-semibold text-white">+{showImages.length - 4}</span>}
              </div>
            ))}
          </div>
        )}
        {link && (
          <div className="mx-3.5 mb-3 rounded-lg border border-line bg-fill px-3 py-2" data-testid="preview-link">
            <p className="text-[11.5px] uppercase tracking-wide text-subtle">{(() => { try { return new URL(link).hostname.replace(/^www\./, ""); } catch { return link; } })()}</p>
            <p className="truncate text-[13px] font-medium">{link.replace(/^https?:\/\//, "")}</p>
          </div>
        )}
        {poll && app === "linkedin" && (
          <div className="mx-3.5 mb-3 space-y-1.5" data-testid="preview-poll">
            <p className="text-[13px] font-medium">{poll.question || "Your poll question"}</p>
            {poll.options.filter((o) => o.trim()).map((o, i) => <p key={i} className="rounded-full border border-line px-3 py-1.5 text-center text-[13px] text-brand-hover">{o}</p>)}
          </div>
        )}
        {firstComment.trim() && r?.firstComment && <p className="border-t border-line px-3.5 py-2 text-[12.5px] text-muted"><span className="font-medium text-fg">First comment:</span> {firstComment}</p>}
      </>)}
    </article>
  );
}

function Preview(props: { accounts: ComposerAccount[]; text: (app: string) => string; images: PickedImage[]; linkCard: boolean; poll: PollInput | null; firstComment: string; format: SocialFormat }) {
  const apps = [...new Map(props.accounts.map((a) => [a.app, a])).values()];
  const [sel, setSel] = useState<string | null>(null);
  const cur = apps.find((a) => a.app === sel) ?? apps[0];
  if (!cur) return <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] text-muted" data-testid="preview-empty">Pick an account to see how the post looks there.</p>;
  return (
    <div className="space-y-3" data-testid="composer-preview">
      {apps.length > 1 && (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Preview for">
          {apps.map((a) => (
            <button key={a.app} type="button" role="tab" aria-selected={cur.app === a.app} onClick={() => setSel(a.app)}
              className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none sm:min-h-9", TAB_RING,
                cur.app === a.app ? "bg-surface text-fg elev-1" : "text-muted hover:bg-hover hover:text-fg")}>
              {networkLabel(a.app)}
            </button>
          ))}
        </div>
      )}
      <PreviewCard app={cur.app} name={cur.name} label={cur.label} text={props.text(cur.app)} images={props.images} linkCard={props.linkCard} poll={props.poll} firstComment={props.firstComment} format={props.format} />
    </div>
  );
}

/* ---------------------------------------------------------------- checks */

const CHECK_LOOK: Record<AccountCheck["state"], { label: string; icon: typeof IconCheckCircle; cls: string }> = {
  ready: { label: "Ready", icon: IconCheckCircle, cls: "text-ok" },
  changed: { label: "Will be changed", icon: IconWarning, cls: "text-warn" },
  out: { label: "Left out", icon: IconXCircle, cls: "text-bad" },
};

function Checks({ checks, accounts, fix }: { checks: AccountCheck[]; accounts: ComposerAccount[]; /** SOCFIX: the board or community picker, right in a row that needs one. */ fix?: (accountId: string) => ReactNode }) {
  if (!checks.length) return null;
  return (
    <section aria-labelledby="checks-title" data-testid="composer-checks">
      <h3 id="checks-title" className="mb-2 text-[13px] font-medium">Checks before sending</h3>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {checks.map((c) => {
          const a = accounts.find((x) => x.id === c.accountId)!;
          const look = CHECK_LOOK[c.state];
          const Icon = look.icon;
          return (
            <li key={c.accountId} className="flex items-start gap-2.5 px-3 py-2.5 text-[13px]" data-testid="check-row" data-state={c.state} data-app={c.app}>
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", look.cls)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p><span className="font-medium">{a?.name ?? networkLabel(c.app)}{a?.label ? `, ${a.label}` : ""}</span><span className="text-muted">: {look.label}</span></p>
                {c.notes.length > 0 && <ul className="mt-0.5 text-[12.5px] text-muted">{c.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
                {fix && c.state === "out" && <div className="mt-1.5 min-w-0">{fix(c.accountId)}</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ---------------------------------------------------------------- crop and library */

function CropDialog({ img, open, onClose, onDone }: { img: PickedImage | null; open: boolean; onClose: () => void; onDone: (img: PickedImage) => void }) {
  const [shape, setShape] = useState<CropShape>("portrait");
  const [anchor, setAnchor] = useState<CropAnchor>("center");
  const [busy, setBusy] = useState(false);
  const ratio = CROP_SHAPES.find((s) => s.id === shape)?.ratio ?? null;
  const box = img && ratio ? cropRect(img.w, img.h, shape, anchor) : null;
  return (
    <Dialog open={open} onClose={onClose} title="Crop image" description="Pick the shape each network shows best. Instagram takes 4:5 to 1.91:1; stories are 9:16."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!img} data-testid="crop-apply" onClick={async () => {
        if (!img) return; setBusy(true);
        try { onDone(await cropImage(img, shape, anchor)); onClose(); } catch (e) { toast.error(errorMessage(e, "Couldn't crop that image.")); } finally { setBusy(false); }
      }}>Crop</Button></>}>
      {img && (
        <div className="space-y-4">
          <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-lg bg-fill">
            <img src={img.src} alt="" className="block max-h-64 max-w-full" />
            {box && (
              <div aria-hidden className="pointer-events-none absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
                style={{ left: `${(box.x / img.w) * 100}%`, top: `${(box.y / img.h) * 100}%`, width: `${(box.w / img.w) * 100}%`, height: `${(box.h / img.h) * 100}%` }} />
            )}
          </div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Shape">
            {CROP_SHAPES.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={shape === s.id} onClick={() => setShape(s.id)}
                className={cn("min-h-9 rounded-md border px-2.5 text-[13px] transition-colors duration-150", shape === s.id ? "border-brand bg-brand-soft text-fg" : "border-line text-muted hover:bg-hover")}>{s.label}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[13px]">Keep
            <Select value={anchor} onChange={(e) => setAnchor(e.target.value as CropAnchor)} className="h-9 w-auto text-sm" aria-label="Part to keep">
              <option value="start">Top or left</option><option value="center">Middle</option><option value="end">Bottom or right</option>
            </Select>
          </label>
        </div>
      )}
    </Dialog>
  );
}

export const libraryKey = ["social", "library"] as const;
export function useLibrary(enabled = true) {
  return useQuery({ queryKey: libraryKey, queryFn: () => api.get<LibraryView>("/social/library"), enabled, staleTime: 30_000 });
}

function LibraryPicker({ open, onClose, onImage, onText }: { open: boolean; onClose: () => void; onImage: (img: PickedImage) => void; onText: (t: string, kind: "caption" | "hashtags") => void }) {
  const lib = useLibrary(open);
  const [tab, setTab] = useState<"image" | "caption" | "hashtags">("image");
  const items = (lib.data?.items ?? []).filter((i) => i.kind === tab);
  return (
    <Dialog open={open} onClose={onClose} title="Pick from the library" description="Images, saved captions and hashtag sets your team keeps in Social, Library.">
      <div className="mb-3 flex gap-1 rounded-lg bg-fill p-1" role="tablist" aria-label="Library">
        {(["image", "caption", "hashtags"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={cn("min-h-11 flex-1 rounded-md px-2.5 text-[13px] font-medium sm:min-h-9", TAB_RING, tab === t ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>
            {t === "image" ? "Images" : t === "caption" ? "Captions" : "Hashtags"}
          </button>
        ))}
      </div>
      {lib.isPending ? <Skeleton className="h-32 rounded-lg" /> : lib.error ? <LoadFailure error={lib.error} onRetry={() => lib.refetch()} />
        : !items.length ? <p className="rounded-lg bg-fill px-3 py-6 text-center text-[13px] text-muted">Nothing here yet. Add some in <Link to="/app/social/library" className="font-medium text-fg underline underline-offset-2">Library</Link>.</p>
        : tab === "image" ? (
          <ul className="grid grid-cols-3 gap-2" data-testid="library-pick-images">
            {items.map((i) => (
              <li key={i.id}>
                <button type="button" className="group block w-full overflow-hidden rounded-lg border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50" aria-label={`Use ${i.name}`}
                  onClick={async () => { const mediaId = i.mediaId; if (!i.imageUrl || !mediaId) return; const d = await measure(i.imageUrl); onImage({ key: nextKey(), src: i.imageUrl, w: d.w, h: d.h, mediaId }); onClose(); }}>
                  <img src={i.imageUrl ?? ""} alt="" className="aspect-square w-full object-cover transition-transform duration-150 group-hover:scale-[1.03] motion-reduce:transition-none" />
                  <span className="block truncate px-1.5 py-1 text-left text-[12px]">{i.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="max-h-72 space-y-2 overflow-y-auto" data-testid="library-pick-text">
            {items.map((i) => (
              <li key={i.id}>
                <button type="button" className="w-full rounded-lg border border-line px-3 py-2 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50" onClick={() => { onText(i.body ?? "", tab as "caption" | "hashtags"); onClose(); }}>
                  <span className="block text-[13px] font-medium">{i.name}</span>
                  <span className="line-clamp-2 text-[12.5px] text-muted">{i.body}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </Dialog>
  );
}

/* ---------------------------------------------------------------- the composer */

export interface ComposerProps {
  accounts: ComposerAccount[];
  canPublish: boolean;
  draft?: SocialPostView | null;
  presetAt?: string | null;
  presetAccount?: string | null;
  presetLibraryText?: string | null;
  /** SOC1: accounts grouped per network with Select all, and each person's last choice remembered in this browser. */
  multi?: boolean;
  rememberKey?: string | null;
  presetImage?: { url: string; mediaId: string } | null;
  campaigns?: string[];
}

/** R100b: the toast after Post now (the sheet then follows each network). */
export const POST_NOW_TOAST = "Posting now. Follow it in Posts.";

export function ComposerV2({ accounts, canPublish, draft, presetAt, presetAccount, presetLibraryText, presetImage, campaigns = [], multi = false, rememberKey = null }: ComposerProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const health = useAccountHealth();
  const [format, setFormat] = useState<SocialFormat>(() => (draft?.format as SocialFormat) ?? (draft?.images?.length ? (draft.images.length > 1 ? "carousel" : "image") : presetImage ? "image" : "text"));
  const [text, setText] = useState(draft?.text ?? presetLibraryText ?? "");
  const [texts, setTexts] = useState<Record<string, string>>(draft?.texts ?? {});
  const [tab, setTab] = useState<string>("all");
  const [images, setImages] = useState<PickedImage[]>([]);
  const [picked, setPicked] = useState<Record<string, string | null>>(() => {
    if (draft) return Object.fromEntries(draft.targets.map((t) => [t.accountId, t.target]));
    if (presetAccount && accounts.some((a) => a.id === presetAccount)) return { [presetAccount]: null };
    // SOC1: start from this person's last choice (only accounts still here; anything unreadable is ignored).
    if (multi && rememberKey) {
      try {
        const ids = JSON.parse(localStorage.getItem(rememberKey) ?? "[]") as unknown;
        if (Array.isArray(ids)) return Object.fromEntries(ids.filter((id): id is string => typeof id === "string" && accounts.some((a) => a.id === id && !a.needsTarget)).map((id) => [id, null]));
      } catch { /* no saved choice */ }
    }
    return {};
  });
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries((draft?.targets ?? []).filter((t) => t.targetName).map((t) => [t.accountId, t.targetName!])));
  const [firstComment, setFirstComment] = useState(draft?.extras?.firstComment ?? "");
  const [linkCard, setLinkCard] = useState(draft?.extras?.linkCard ?? true);
  const [poll, setPoll] = useState<PollInput | null>(draft?.extras?.poll ?? null);
  const [campaign, setCampaign] = useState(draft?.campaign ?? "");
  const [evergreen, setEvergreen] = useState(!!draft?.evergreen);
  // R132: pin details (Pinterest) and the text before the last writing help, for Undo.
  const p3on = useSocialP3();
  const [pin, setPin] = useState<PinDetails>(() => (draft?.extras as { pin?: PinDetails | null } | null | undefined)?.pin ?? {});
  const beforeHelp = useRef<{ text: string; texts: Record<string, string> } | null>(null);
  const initialLater = !!presetAt || (!!draft && Date.parse(draft.runAt) > Date.now() + 60_000);
  const [later, setLater] = useState(initialLater);
  const [at, setAt] = useState(() => localInput(presetAt ? new Date(presetAt) : draft && Date.parse(draft.runAt) > Date.now() ? new Date(draft.runAt) : new Date(Date.now() + 3600_000)));
  const [imageError, setImageError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [serverProblems, setServerProblems] = useState<Record<string, string>>({});
  const [cropFor, setCropFor] = useState<PickedImage | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [tiktokOpen, setTiktokOpen] = useState(false);
  const [postedId, setPostedId] = useState<string | null>(null);
  const [tiktokAfter, setTiktokAfter] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(!!(draft?.extras || draft?.campaign || draft?.evergreen));
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!presetImage) return;
    void measure(presetImage.url).then((d) => setImages([{ key: nextKey(), src: presetImage.url, w: d.w, h: d.h, mediaId: presetImage.mediaId }]));
  }, [presetImage]);
  // A draft's images come back as library style picks (the post already holds them).
  useEffect(() => {
    if (!draft?.images?.length) return;
    let live = true;
    void Promise.all(draft.images.map(async (im) => { const d = await measure(im.url); return { key: nextKey(), src: im.url, w: d.w, h: d.h, mediaId: im.mediaId } as PickedImage; })).then((list) => { if (live) setImages(list); });
    return () => { live = false; };
  }, [draft]);

  const targetField = (a: ComposerAccount, where: "pick" | "check") => (a.needsTarget && a.account
    ? <TargetField account={a.account} where={where} value={picked[a.id] ?? ""} onChange={(v, name) => { setPicked((p) => ({ ...p, [a.id]: v })); setNames((n) => ({ ...n, [a.id]: name ?? v })); }} />
    : null);
  const brokenText = (id: string) => { const h = health.data?.get(id); return h && !h.ok && h.code !== "check_failed" ? (h.text ?? SOCIAL_ERROR_COPY.reconnect!) : null; };
  const chosen = accounts.filter((a) => a.id in picked);
  const apps = [...new Set(chosen.map((a) => a.app))];
  const usesImages = format === "image" || format === "carousel";
  const textOf = (app: string) => textFor(text, texts, app);
  const checks = useMemo(() => composerChecks({
    format, main: text, texts, images: usesImages ? images.map((i) => ({ w: i.w, h: i.h })) : [],
    extras: { firstComment, poll: apps.includes("linkedin") ? poll : null, linkCard, ...(p3on && apps.includes("pinterest") ? { pin } : {}) },
    accounts: chosen.map((a) => ({ id: a.id, app: a.app, target: picked[a.id], needsTarget: a.needsTarget, broken: brokenText(a.id) ?? serverProblems[a.id] ?? null })),
    scheduled: later,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [format, text, texts, images, firstComment, poll, linkCard, picked, health.data, serverProblems, later, accounts, pin, p3on]);
  const sendable = checks.filter((c) => c.state !== "out" && c.app !== "tiktok");
  const tiktokPicked = chosen.some((a) => a.app === "tiktok") && (format === "video" || format === "story");
  const leftOut = checks.filter((c) => c.state === "out").length;
  const whenMs = new Date(at).getTime();
  const tooSoon = later && whenMs < Date.now() + 60_000;
  const tooFar = later && whenMs > Date.now() + SOCIAL_MAX_AHEAD_DAYS * 86_400_000;
  const hasContent = text.trim().length > 0 || images.length > 0;

  const slots = useQuery({
    queryKey: ["social", "slots", "next", chosen.map((a) => a.id).sort().join(",")],
    queryFn: () => api.get<{ slots: string[]; hasSlots: boolean }>(`/social/slots/next?limit=3&accounts=${encodeURIComponent(chosen.map((a) => a.id).join(","))}`),
    enabled: later, staleTime: 30_000,
  });

  const body = (mode: "send" | "draft" | "submit", targets = mode === "draft" ? chosen.filter((a) => a.app !== "tiktok") : chosen.filter((a) => sendable.some((c) => c.accountId === a.id))) => ({
    text: text.trim(),
    format,
    texts: Object.fromEntries(Object.entries(texts).filter(([app, v]) => v.trim() && v.trim() !== text.trim() && apps.includes(app))),
    images: usesImages ? images.map((i) => (i.mediaId ? { mediaId: i.mediaId } : i.upload!)) : [],
    targets: targets.map((a) => ({ accountId: a.id, target: picked[a.id] || null, targetName: names[a.id] || null })),
    runAt: later ? new Date(at).toISOString() : null,
    extras: { firstComment: firstComment.trim() || null, poll: apps.includes("linkedin") && poll ? poll : null, linkCard, ...(p3on && apps.includes("pinterest") && (pin.title || pin.link || pin.alt) ? { pin } : {}) },
    campaign: campaign.trim() || null,
    evergreen,
    mode,
  });

  const save = useMutation({
    mutationFn: (mode: "send" | "draft" | "submit") => (draft
      ? api.patch<{ post: SocialPostView }>(`/social/posts/${draft.id}`, body(mode))
      : api.create<{ post: SocialPostView }>("/social/posts", body(mode))),
    onSuccess: (r, mode) => {
      void qc.invalidateQueries({ queryKey: postsKey });
      setServerProblems({});
      if (multi && rememberKey && mode !== "draft") { try { localStorage.setItem(rememberKey, JSON.stringify(r.post.targets.map((t) => t.accountId).slice(0, 50))); } catch { /* storage full or off */ } }
      if (mode === "draft") { toast.success("Draft saved"); navigate("/app/social/posts?status=drafts"); return; }
      if (mode === "submit") { toast.success("Sent for approval. Owners and admins see it in Approvals."); navigate("/app/social/posts?status=waiting"); return; }
      if (later) { toast.success(`Scheduled for ${whenText(r.post.runAt)}`); navigate("/app/social/posts"); return; }
      // The composer clears behind the sheet; TikTok (when picked) opens after it.
      setTiktokAfter(tiktokPicked ? textOf("tiktok") : null);
      toast.success(POST_NOW_TOAST); // R100b: a plain confirmation besides the sheet
      resetAfterPost();
      setPostedId(r.post.id);
    },
    onError: (e) => {
      const d = e instanceof ApiError ? (e.details as { problems?: { accountId: string; code: string; text?: string }[] } | undefined) : undefined;
      if (d?.problems) setServerProblems(Object.fromEntries(d.problems.map((p) => [p.accountId, p.text ?? SOCIAL_ERROR_COPY[p.code] ?? SOCIAL_ERROR_COPY.rejected!])));
      toast.error(errorMessage(e, "Couldn't save the post. Try again."));
    },
  });

  const resetAfterPost = () => { setText(""); setTexts({}); setImages([]); setPicked({}); setFirstComment(""); setPoll(null); setLater(false); setTab("all"); setPin({}); };

  const addFiles = async (files: FileList | null) => {
    setImageError(null);
    if (!files?.length) return;
    setPreparing(true);
    try {
      // One after another: a few 12 MB photos decoded at once can run a phone out of memory.
      const list: PickedImage[] = [];
      for (const f of [...files].slice(0, 10)) list.push(await readFile(f));
      setImages((cur) => (format === "carousel" ? [...cur, ...list].slice(0, 10) : list.slice(0, 1)));
      if (list.length > 1 && format !== "carousel") setFormat("carousel");
      else if (format === "text") setFormat(list.length > 1 ? "carousel" : "image");
    } catch (err) { setImageError(err instanceof Error ? err.message : "That photo could not be read."); } finally { setPreparing(false); }
  };
  const shrunk = images.filter((i) => i.note);
  const optimised = preparing ? "Preparing your photo for posting" : shrunk.length === 1 ? shrunk[0]!.note! : shrunk.length > 1 ? `${shrunk.length} photos optimised for posting` : null;

  const primaryMode: "send" | "submit" = canPublish ? "send" : "submit";
  const blocked = !hasContent || (!sendable.length && !tiktokPicked) || tooSoon || tooFar;
  const submit = () => {
    if (save.isPending) return;
    if (!sendable.length && tiktokPicked) { setTiktokOpen(true); return; }
    if (!blocked) save.mutate(primaryMode);
  };
  const primaryLabel = !canPublish ? "Submit for approval"
    : !sendable.length && tiktokPicked ? "Continue on TikTok"
    : later ? (sendable.length > 1 ? `Schedule for ${sendable.length} accounts` : "Schedule")
    : sendable.length > 1 ? `Post to ${sendable.length} accounts` : "Post now";

  const toggle = (a: ComposerAccount) => setPicked((p) => { const n = { ...p }; if (a.id in n) delete n[a.id]; else n[a.id] = null; return n; });
  const tabApp = tab === "all" || !apps.includes(tab) ? null : tab;
  const curText = tabApp ? (texts[tabApp] ?? text) : text;
  const edited = (app: string) => texts[app] !== undefined && texts[app].trim() !== text.trim();
  const showFirstComment = apps.some((a) => NETWORK_RULES[a]?.firstComment);
  const showPoll = apps.includes("linkedin") && format === "text";
  const showLinkCard = apps.some((a) => NETWORK_RULES[a]?.linkCard) && !!firstLink(textFor(text, texts, "facebook"));
  const previewProps = { accounts: chosen, text: textOf, images, linkCard, poll: showPoll ? poll : null, firstComment, format };
  const row = (a: ComposerAccount) => {
                const on = a.id in picked;
                const fit = formatFit(a.app, format);
                const broken = brokenText(a.id);
                const max = NETWORK_RULES[a.app]?.maxChars;
                const tooLong = !on && max !== undefined && charCount(textOf(a.app)) > max ? `Too long for ${a.name}: ${max.toLocaleString()} characters at most.` : null;
                const block = fit.fit === "no" ? fit.why : tooLong;
                const greyed = !on && !!block;
                const why = block ?? broken;
                return (
                  <li key={a.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2", greyed && "bg-fill/40")} data-testid={`pick-${a.app}`} data-blocked={greyed ? "true" : undefined}>
                    <label className={cn("flex min-h-8 min-w-0 flex-1 items-center gap-2.5 text-[13.5px]", greyed ? "cursor-not-allowed" : "cursor-pointer")}>
                      <input type="checkbox" className="h-4 w-4 shrink-0 accent-[var(--color-brand)]" checked={on} disabled={greyed} onChange={() => toggle(a)} aria-describedby={why ? `why-${a.id}` : undefined} />
                      {multi && a.account?.avatarUrl ? <AccountAvatar account={a.account} size="sm" /> : <AppLogo slug={a.app} name={a.name} size="sm" />}
                      <span className={cn("min-w-0 truncate font-medium", greyed && "text-muted")} title={multi ? (a.label ? `${a.name}, ${a.label}` : a.name) : undefined}>{a.name}{a.label ? <span className="font-normal text-muted">, {a.label}</span> : null}</span>
                    </label>
                    {on && targetField(a, "pick")}
                    {why && <p id={`why-${a.id}`} className="basis-full pl-[26px] text-[12.5px] text-muted" data-testid="pick-why">{why}</p>}
                  </li>
                );
  };
  // SOC1: one group per network; Select all picks every account of it that can take this post.
  const groups = multi ? [...accounts.reduce((m, a) => m.set(a.app, [...(m.get(a.app) ?? []), a]), new Map<string, ComposerAccount[]>())] : [];
  const selectable = (a: ComposerAccount) => formatFit(a.app, format).fit !== "no" && !(NETWORK_RULES[a.app]?.maxChars !== undefined && charCount(textOf(a.app)) > NETWORK_RULES[a.app]!.maxChars);
  const selectAll = (list: ComposerAccount[]) => setPicked((p) => {
    const n = { ...p };
    const can = list.filter(selectable);
    if (can.every((a) => a.id in n)) for (const a of list) delete n[a.id];
    else for (const a of can) if (!(a.id in n)) n[a.id] = null;
    return n;
  });

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]" data-testid="composer-v2">
      <Card>
        <form className="space-y-5 p-5 md:p-6" aria-label="New post" data-testid="social-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}>
          {draft && (draft.status === "changes" || draft.status === "rejected") && draft.reviewNote && (
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn" data-testid="composer-review-note"><IconWarning className="mr-1.5 inline h-4 w-4" aria-hidden />{draft.status === "changes" ? "Changes asked" : "Rejected"}: {draft.reviewNote}</p>
          )}

          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Format</legend>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Format" data-testid="format-picker">
              {SOCIAL_FORMATS.map((f) => {
                const Icon = FORMAT_ICON[f];
                return (
                  <button key={f} type="button" role="radio" aria-checked={format === f} data-format={f} onClick={() => { setFormat(f); if (f === "image") setImages((c) => c.slice(0, 1)); }}
                    className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-[13.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 sm:min-h-9 motion-reduce:transition-none",
                      format === f ? "border-brand bg-brand-soft text-fg" : "border-line text-muted hover:bg-hover hover:text-fg")}>
                    <Icon className="h-4 w-4" aria-hidden />{FORMAT_LABELS[f]}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Post to</legend>
            {multi ? (
              <div className="space-y-3" data-testid="account-groups">
                {groups.map(([app, list]) => (
                  <div key={app} data-testid={`group-${app}`}>
                    {list.length > 1 && (
                      <div className="mb-1 flex items-center justify-between gap-2 px-1">
                        <span className="text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">{list[0]!.account?.appName ?? list[0]!.name}</span>
                        <Button type="button" variant="ghost" size="sm" onClick={() => selectAll(list)} data-testid={`select-all-${app}`}>
                          {list.filter(selectable).every((a) => a.id in picked) ? "Clear" : "Select all"}
                        </Button>
                      </div>
                    )}
                    <ul className="divide-y divide-line rounded-lg border border-line" data-testid="account-chips">{list.map(row)}</ul>
                  </div>
                ))}
              </div>
            ) : (
            <ul className="divide-y divide-line rounded-lg border border-line" data-testid="account-chips">
              {accounts.map(row)}
            </ul>
            )}
          </fieldset>

          <div>
            <div className="mb-2 flex flex-wrap items-center gap-1" role="tablist" aria-label="Text for" data-testid="network-tabs">
              {["all", ...apps.filter((a) => a !== "tiktok" || tiktokPicked)].map((t) => (
                <button key={t} type="button" role="tab" id={`tab-${t}`} aria-selected={(tabApp ?? "all") === t} aria-controls="post-text-panel" onClick={() => setTab(t)}
                  className={cn("relative inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none sm:min-h-9", TAB_RING,
                    (tabApp ?? "all") === t ? "bg-fill text-fg" : "text-muted hover:bg-hover hover:text-fg")} data-testid={`tab-${t}`}>
                  {t === "all" ? "All networks" : networkLabel(t)}
                  {t !== "all" && edited(t) && <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-label="has its own text" />}
                </button>
              ))}
            </div>
            <div id="post-text-panel" role="tabpanel" aria-labelledby={`tab-${tabApp ?? "all"}`}>
              <label htmlFor="social-text" className="sr-only">{tabApp ? `Text for ${networkLabel(tabApp)}` : "Text"}</label>
              <Textarea id="social-text" rows={6} value={curText} data-testid="social-text" placeholder={tabApp ? `Text for ${networkLabel(tabApp)}` : "What do you want to share?"}
                onChange={(e) => { const v = e.target.value; if (tabApp) setTexts((m) => ({ ...m, [tabApp]: v })); else setText(v); }} />
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" data-testid="counters">
                {(tabApp ? [tabApp] : apps).filter((a) => NETWORK_RULES[a]).map((a) => {
                  const n = charCount(textOf(a)); const max = NETWORK_RULES[a]!.maxChars; const over = n > max;
                  return <span key={a} className={cn("tabular-nums", over ? "font-medium text-bad" : n > max * 0.9 ? "text-warn" : "text-subtle")} data-testid={`counter-${a}`}>{networkLabel(a)} {n.toLocaleString()} / {max.toLocaleString()}</span>;
                })}
                {!apps.length && <span className="text-subtle tabular-nums">{charCount(text).toLocaleString()} characters</span>}
                {tabApp && edited(tabApp) && <button type="button" className="ml-auto font-medium text-muted underline underline-offset-2 hover:text-fg" onClick={() => setTexts((m) => { const n = { ...m }; delete n[tabApp]; return n; })} data-testid="use-main-text">Use the main text</button>}
                {tabApp && !edited(tabApp) && <span className="ml-auto text-subtle">Same as the main text until you edit it</span>}
              </div>
            </div>
          </div>

          {(usesImages || format === "video" || format === "story") && (
            <div>
              <p className="mb-2 text-[13px] font-medium">{format === "carousel" ? "Images (up to 10)" : format === "image" ? "Image" : "Video"}</p>
              {format === "video" || format === "story" ? (
                <p className="rounded-lg bg-fill px-3 py-2.5 text-[13px] text-muted">Videos go to TikTok through its own form, with TikTok's required choices. Pick TikTok above, then continue.</p>
              ) : (<>
                <ul className="flex flex-wrap gap-2" data-testid="composer-images">
                  {images.map((im, i) => (
                    <li key={im.key} className="relative">
                      <img src={im.src} alt={`Image ${i + 1}`} className="h-24 w-24 rounded-lg border border-line object-cover" />
                      <div className="absolute inset-x-1 bottom-1 flex justify-between gap-1">
                        <button type="button" className="rounded bg-black/60 px-1.5 py-0.5 text-[11.5px] font-medium text-white" onClick={() => setCropFor(im)} aria-label={`Crop image ${i + 1}`}>Crop</button>
                        <button type="button" className="rounded bg-black/60 p-0.5 text-white" onClick={() => setImages((c) => c.filter((x) => x.key !== im.key))} aria-label={`Remove image ${i + 1}`}><IconClose className="h-3.5 w-3.5" aria-hidden /></button>
                      </div>
                    </li>
                  ))}
                  {(format === "carousel" ? images.length < 10 : images.length === 0) && (
                    <li>
                      <button type="button" disabled={preparing} aria-busy={preparing} onClick={() => file.current?.click()} className="grid h-24 w-24 disabled:opacity-60 place-items-center rounded-lg border border-dashed border-line text-[12.5px] text-muted hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50" data-testid="add-image">
                        <span className="flex flex-col items-center gap-1"><IconPlus className="h-4 w-4" aria-hidden />Add</span>
                      </button>
                    </li>
                  )}
                </ul>
                <input ref={file} type="file" accept={SOCIAL_PHOTO_ACCEPT} multiple={format === "carousel"} className="sr-only" tabIndex={-1} aria-hidden data-testid="social-image" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
                {imageError && <p className="mt-1.5 text-[12.5px] text-bad" role="alert" data-testid="image-error">{imageError}</p>}
                {optimised && !imageError && <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-muted" role="status" data-testid="image-optimised"><IconCheckCircle className="h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />{optimised}</p>}
                <p className="mt-1.5 text-[12px] text-subtle">Any photo works: JPEG, PNG, WebP or HEIC. Large photos are resized to fit each network.</p>
              </>)}
            </div>
          )}

          {p3on && apps.includes("pinterest") && <PinDetailsCard value={pin} onChange={setPin} />}

          <div className="flex flex-wrap gap-2">
            {p3on && (
              <WritingHelp text={curText} apps={apps.filter((a) => NETWORK_RULES[a])}
                onText={(t) => { beforeHelp.current = { text, texts }; if (tabApp) setTexts((m) => ({ ...m, [tabApp]: t })); else setText(t); }}
                onTexts={(m) => { beforeHelp.current = { text, texts }; setTexts((cur) => ({ ...cur, ...m })); }}
                restore={() => { const b = beforeHelp.current; if (b) { setText(b.text); setTexts(b.texts); beforeHelp.current = null; } }} />
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => setLibOpen(true)} data-testid="open-library"><IconBookmark className="h-4 w-4" aria-hidden />Library</Button>
            <Button type="button" variant="outline" size="sm" className="xl:hidden" onClick={() => setPreviewOpen(true)} data-testid="open-preview"><IconEye className="h-4 w-4" aria-hidden />Preview</Button>
            <Button type="button" variant="ghost" size="sm" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} data-testid="more-options">{moreOpen ? "Fewer options" : "More options"}</Button>
          </div>

          {moreOpen && (
            <div className="grid gap-4 rounded-lg border border-line p-4 sm:grid-cols-2" data-testid="extras">
              <div className="sm:col-span-2">
                <label htmlFor="campaign" className="mb-1.5 block text-[13px] font-medium">Campaign</label>
                <Input id="campaign" list="campaign-list" value={campaign} maxLength={40} onChange={(e) => setCampaign(e.target.value)} placeholder="For example Spring launch" className="h-9 text-sm" data-testid="campaign" />
                <datalist id="campaign-list">{campaigns.map((c) => <option key={c} value={c} />)}</datalist>
              </div>
              {showFirstComment && (
                <div className="sm:col-span-2">
                  <label htmlFor="first-comment" className="mb-1.5 block text-[13px] font-medium">First comment <span className="font-normal text-muted">(Facebook)</span></label>
                  <Textarea id="first-comment" rows={2} maxLength={2000} value={firstComment} onChange={(e) => setFirstComment(e.target.value)} placeholder="Posted under the post right after it goes out" data-testid="first-comment" />
                </div>
              )}
              {showLinkCard && (
                <label className="flex min-h-11 items-center gap-2 text-[13px] sm:col-span-2">
                  <input type="checkbox" checked={linkCard} onChange={(e) => setLinkCard(e.target.checked)} className="h-4 w-4 accent-[var(--color-brand)]" data-testid="link-card" />
                  Show a link card for the first link (Facebook)
                </label>
              )}
              {showPoll && (
                <div className="space-y-2 sm:col-span-2" data-testid="poll">
                  <label className="flex min-h-11 items-center gap-2 text-[13px] font-medium">
                    <input type="checkbox" checked={!!poll} onChange={(e) => setPoll(e.target.checked ? { question: "", options: ["", ""], days: 3 } : null)} className="h-4 w-4 accent-[var(--color-brand)]" data-testid="poll-toggle" />
                    Add a poll (LinkedIn)
                  </label>
                  {poll && (<>
                    <Input aria-label="Poll question" value={poll.question} maxLength={140} onChange={(e) => setPoll({ ...poll, question: e.target.value })} placeholder="Question" className="h-9 text-sm" data-testid="poll-question" />
                    {poll.options.map((o, i) => (
                      <div key={i} className="flex gap-2">
                        <Input aria-label={`Option ${i + 1}`} value={o} maxLength={30} onChange={(e) => setPoll({ ...poll, options: poll.options.map((x, j) => (j === i ? e.target.value : x)) })} placeholder={`Option ${i + 1}`} className="h-9 text-sm" data-testid={`poll-option-${i}`} />
                        {poll.options.length > 2 && <Button type="button" variant="ghost" size="sm" aria-label={`Remove option ${i + 1}`} onClick={() => setPoll({ ...poll, options: poll.options.filter((_, j) => j !== i) })}><IconClose className="h-4 w-4" aria-hidden /></Button>}
                      </div>
                    ))}
                    <div className="flex flex-wrap items-center gap-2">
                      {poll.options.length < 4 && <Button type="button" variant="ghost" size="sm" onClick={() => setPoll({ ...poll, options: [...poll.options, ""] })}><IconPlus className="h-4 w-4" aria-hidden />Add option</Button>}
                      <Select aria-label="Poll runs for" value={String(poll.days)} onChange={(e) => setPoll({ ...poll, days: Number(e.target.value) })} className="h-9 w-auto text-sm">
                        {POLL_DAYS.map((d) => <option key={d} value={d}>{d === 1 ? "1 day" : `${d} days`}</option>)}
                      </Select>
                    </div>
                  </>)}
                </div>
              )}
              <label className="flex min-h-11 items-start gap-2 text-[13px] sm:col-span-2">
                <input type="checkbox" checked={evergreen} onChange={(e) => setEvergreen(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" data-testid="evergreen" />
                <span><span className="font-medium">Evergreen</span><span className="block text-muted">After it goes out, it comes back into free time slots every few weeks (never twice in a row, 3 a week at most).</span></span>
              </label>
            </div>
          )}

          <Checks checks={checks} accounts={accounts} fix={(id) => { const a = chosen.find((x) => x.id === id); return a && a.needsTarget && a.account && !(picked[id] ?? "").trim() ? targetField(a, "check") : null; }} />

          <div className="space-y-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="When">
              {([["now", "Now"], ["later", "Later"]] as const).map(([k, l]) => (
                <button key={k} type="button" role="radio" aria-checked={(k === "later") === later} onClick={() => setLater(k === "later")} data-testid={`when-${k}`}
                  className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium sm:min-h-9", (k === "later") === later ? "bg-fill text-fg" : "text-muted hover:bg-hover")}>
                  {k === "now" ? <IconSend className="h-4 w-4" aria-hidden /> : <IconClock className="h-4 w-4" aria-hidden />}{l}
                </button>
              ))}
              {later && <Input type="datetime-local" aria-label="Post at" value={at} min={localInput(new Date())} onChange={(e) => setAt(e.target.value)} className="h-9 w-auto text-sm" data-testid="social-at" />}
              {later && (slots.data?.slots.length ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setAt(localInput(new Date(slots.data!.slots[0]!)))} data-testid="next-slot">
                  <IconCalendarClock className="h-4 w-4" aria-hidden />Next free slot, {whenText(slots.data.slots[0]!)}
                </Button>
              ) : slots.data && !slots.data.hasSlots ? <Link to="/app/social?slots=1" className="text-[12.5px] font-medium text-muted max-sm:inline-flex max-sm:min-h-11 max-sm:items-center underline underline-offset-2 hover:text-fg">Set weekly time slots</Link> : null)}
            </div>
            {later && p3on && <BestTimeChips apps={apps.filter((a) => a !== "tiktok")} onPick={(iso) => setAt(localInput(new Date(iso)))} />}
            {tooSoon && <p className="text-[12.5px] text-warn">Pick a time at least a minute from now.</p>}
            {tooFar && <p className="text-[12.5px] text-warn">Posts can be set up to {SOCIAL_MAX_AHEAD_DAYS} days ahead.</p>}
            {leftOut > 0 && sendable.length > 0 && <p className="text-[12.5px] text-muted" data-testid="left-out-note">{leftOut === 1 ? "1 account is left out" : `${leftOut} accounts are left out`}; the rest get the post.</p>}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {!canPublish && <p className="mr-auto text-[12.5px] text-muted">An owner or admin approves it before it goes out.</p>}
              <Button type="button" variant="ghost" disabled={!hasContent || save.isPending} onClick={() => save.mutate("draft")} data-testid="save-draft" className="max-sm:flex-1">Save draft</Button>
              <Button type="submit" disabled={blocked || save.isPending} loading={save.isPending && save.variables !== "draft"} data-testid="social-submit" className="max-sm:flex-1">
                <IconSend className="h-4 w-4" aria-hidden />{primaryLabel}
              </Button>
            </div>
            {tiktokPicked && sendable.length > 0 && <p className="text-right text-[12.5px] text-muted">TikTok goes through its own form after this.</p>}
            {p3on && <div className="border-t border-line pt-3" data-testid="snap-share-row"><SnapShare text={textFor(text, texts, "snapchat")} /></div>}
          </div>
        </form>
      </Card>

      <aside className="hidden xl:block" aria-label="Preview">
        <div className="sticky top-4 space-y-2">
          <h2 className="px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">Preview</h2>
          <Preview {...previewProps} />
        </div>
      </aside>

      <Dialog open={previewOpen} onClose={() => setPreviewOpen(false)} title="Preview" description="How the post looks on each network.">
        <Preview {...previewProps} />
      </Dialog>
      <CropDialog img={cropFor} open={!!cropFor} onClose={() => setCropFor(null)} onDone={(n) => setImages((c) => c.map((x) => (x.key === cropFor?.key ? n : x)))} />
      <LibraryPicker open={libOpen} onClose={() => setLibOpen(false)}
        onImage={(img) => { setImages((c) => (format === "carousel" ? [...c, img].slice(0, 10) : [img])); if (format === "text") setFormat("image"); }}
        onText={(t, kind) => { const join = (cur: string) => (cur.trim() ? `${cur.trimEnd()}${kind === "hashtags" ? " " : "\n\n"}${t}` : t); if (tabApp) setTexts((m) => ({ ...m, [tabApp]: join(m[tabApp] ?? text) })); else setText(join); }} />
      <TikTokPostDialog open={tiktokOpen} onClose={() => { setTiktokOpen(false); setTiktokAfter(null); }} caption={tiktokAfter ?? textOf("tiktok")} />
      {postedId && <PostedSheet postId={postedId}
        // R100b: closing the sheet goes back to the posts list; Write another (or TikTok still to post) stays here.
        onClose={() => { setPostedId(null); if (tiktokAfter !== null) setTiktokOpen(true); else navigate("/app/social/posts"); }}
        onWriteAnother={() => { setPostedId(null); if (tiktokAfter !== null) setTiktokOpen(true); requestAnimationFrame(() => document.getElementById("social-text")?.focus()); }} />}
    </div>
  );
}

/** Page, board or community for one account (the network needs one), loaded when the account is picked. SOCFIX: a
 * single board is picked by itself, and the one this workspace used last for the account is offered first. */
function TargetField({ account, value, onChange, where = "pick" }: { account: ConnectedAccountView; value: string; onChange: (v: string, name?: string) => void; where?: "pick" | "check" }) {
  const net = SOCIAL_NETWORKS[account.app]!;
  const listed = net.target?.kind === "page" || net.target?.kind === "board";
  const q = useQuery({
    queryKey: ["apps", "targets", account.id],
    queryFn: () => api.get<{ targets: { id: string; name: string }[]; last?: { id: string; name: string } | null }>(`/apps/accounts/${encodeURIComponent(account.id)}/targets`),
    enabled: !!net.target, staleTime: 300_000,
  });
  const list = q.data?.targets;
  const def = q.data ? defaultTarget(listed, list ?? [], q.data.last ?? null) : null;
  // Once per field: a person who clears it to type another community is not refilled.
  const filled = useRef(false);
  useEffect(() => { if (!filled.current && !value && def) { filled.current = true; onChange(def.id, def.name); } }, [value, def?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!net.target) return null;
  const label = `${net.target.label} for ${account.appName}`;
  const tid = where === "check" ? `check-target-${account.app}` : `target-${account.app}`;
  const size = "h-11 w-full min-w-0 max-w-xs text-sm sm:h-9";
  if (!listed) return (
    <span className="flex min-w-0 flex-col gap-1">
      <Input aria-label={label} placeholder="Community, for example r/smallbusiness" value={value} onChange={(e) => onChange(e.target.value)} className={size} data-testid={tid} />
      {q.data?.last && value.replace(/^\/?r\//i, "") !== q.data.last.id.replace(/^\/?r\//i, "") && (
        <button type="button" className="inline-flex min-h-11 w-fit items-center rounded-md px-1 text-[12.5px] font-medium text-brand hover:underline sm:min-h-0" onClick={() => onChange(q.data!.last!.id, q.data!.last!.name)} data-testid={`${tid}-last`}>
          Use r/{q.data.last.id.replace(/^\/?r\//i, "")} again
        </button>
      )}
    </span>
  );
  if (q.isPending) return <Skeleton className="h-9 w-56 rounded-lg" />;
  if (q.error) return <LoadErrorInline onRetry={() => q.refetch()} />;
  if (!list?.length) return <span className="text-[12.5px] text-muted" data-testid={`${tid}-none`}>No {net.target.label.toLowerCase()}s on this account yet. Make one on {account.appName}, then come back.</span>;
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value, list.find((t) => t.id === e.target.value)?.name)} className={size} data-testid={tid}>
      <option value="">Pick a {net.target.label.toLowerCase()}</option>
      {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </Select>
  );
}

