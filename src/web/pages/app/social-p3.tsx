/**
 * R132: Social P3 pieces of the composer (flag SOCIAL_P3_R132): pin details for Pinterest, best time chips under
 * Post at, the writing help menu and the Snapchat share button. Rules live in src/shared/social-p3.ts.
 */
import { LoadErrorInline } from "@/web/components/load-error-t1g";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { useConfig } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Input } from "@/web/components/ui/input";
import { Skeleton } from "@/web/components/ui/misc";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { IconCalendarClock, IconShare, IconSparkle } from "@/web/components/ui/icon";
import { firstLink } from "@/shared/social-p2";
import {
  PIN_ALT_MAX, PIN_TITLE_MAX, WRITE_ACTIONS, WRITE_LABEL, isHttpsLink, snapShareHref, type BestTimesResponse, type PinDetails, type WriteAction,
} from "@/shared/social-p3";

export const useSocialP3 = () => !!useConfig().data?.socialP3R132;

function Counter({ n, max }: { n: number; max: number }) {
  return <span className={cn("text-[12px] tabular-nums", n > max ? "text-bad" : "text-subtle")} aria-hidden>{n}/{max}</span>;
}

/** Pin title, destination link and alt text (Pinterest). Empty fields fall back to the post's first line and nothing. */
export function PinDetailsCard({ value, onChange }: { value: PinDetails; onChange: (v: PinDetails) => void }) {
  const link = value.link ?? "";
  const badLink = !!link && !isHttpsLink(link);
  return (
    <section className="grid gap-3 rounded-lg border border-line p-4 sm:grid-cols-2" aria-labelledby="pin-details-h" data-testid="pin-details">
      <h3 id="pin-details-h" className="text-[13px] font-semibold sm:col-span-2">Pin details <span className="font-normal text-muted">(Pinterest)</span></h3>
      <div className="sm:col-span-2">
        <div className="mb-1.5 flex items-center justify-between"><label htmlFor="pin-title" className="text-[13px] font-medium">Pin title</label><Counter n={(value.title ?? "").length} max={PIN_TITLE_MAX} /></div>
        <Input id="pin-title" value={value.title ?? ""} maxLength={PIN_TITLE_MAX + 20} onChange={(e) => onChange({ ...value, title: e.target.value })} placeholder="First line of your post" className="h-9 text-sm" data-testid="pin-title" />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="pin-link" className="mb-1.5 block text-[13px] font-medium">Link when someone taps the pin</label>
        <Input id="pin-link" type="url" inputMode="url" value={link} onChange={(e) => onChange({ ...value, link: e.target.value })} placeholder="https://" aria-invalid={badLink || undefined} aria-describedby={badLink ? "pin-link-err" : undefined} className="h-9 text-sm" data-testid="pin-link" />
        {badLink && <p id="pin-link-err" className="mt-1 text-[12.5px] text-bad">Use a full link that starts with https://</p>}
      </div>
      <div className="sm:col-span-2">
        <div className="mb-1.5 flex items-center justify-between"><label htmlFor="pin-alt" className="text-[13px] font-medium">Alt text</label><Counter n={(value.alt ?? "").length} max={PIN_ALT_MAX} /></div>
        <Input id="pin-alt" value={value.alt ?? ""} maxLength={PIN_ALT_MAX + 20} onChange={(e) => onChange({ ...value, alt: e.target.value })} placeholder="Describe the image" className="h-9 text-sm" data-testid="pin-alt" />
      </div>
    </section>
  );
}

function browserTz(): string { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } }

/** The top 3 times to post, from the workspace's own results (or plain defaults, said as defaults). A chip fills Post at. */
export function BestTimeChips({ apps, onPick }: { apps: string[]; onPick: (iso: string) => void }) {
  const key = [...apps].sort().join(",");
  const q = useQuery({
    queryKey: ["social", "best-times", key],
    queryFn: () => api.get<BestTimesResponse>(`/social/best-times?apps=${encodeURIComponent(key)}&tz=${encodeURIComponent(browserTz())}`),
    staleTime: 5 * 60_000,
  });
  if (q.isLoading) return <div className="flex gap-2" aria-busy="true" aria-label="Loading best times"><Skeleton className="h-9 w-24 rounded-full" /><Skeleton className="h-9 w-24 rounded-full" /><Skeleton className="h-9 w-24 rounded-full" /></div>;
  if (q.isError || !q.data) return <LoadErrorInline onRetry={() => q.refetch()} className="text-[12.5px]" />;
  const d = q.data;
  return (
    <div className="space-y-1.5" data-testid="best-times">
      <p className="text-[12.5px] font-medium text-muted" id="best-times-h">{d.defaults ? "Suggested times" : "Your best times"}</p>
      <ul className="flex flex-wrap gap-2" aria-labelledby="best-times-h">
        {d.slots.map((s) => (
          <li key={`${s.day}:${s.hour}`}>
            <button type="button" onClick={() => onPick(s.at)} title={s.why} aria-label={`${s.label}. ${s.why}`}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px] font-medium transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 sm:min-h-9"
              data-testid="best-time-chip">
              <IconCalendarClock className="h-4 w-4 text-muted" aria-hidden />{s.label}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-subtle" data-testid="best-times-why">{d.defaults ? `Common good times. Yours show after ${d.posts + d.need} posts with results (${d.posts} so far).` : d.slots[0]?.why}</p>
    </div>
  );
}

interface WriteOut { text: string; texts?: Record<string, string>; left: number }

/** Writing help: shorter, friendlier, more formal, hashtags, or fit each picked network's limit. Undo puts it back. */
export function WritingHelp({ text, apps, onText, onTexts, restore }: { text: string; apps: string[]; onText: (t: string) => void; onTexts: (m: Record<string, string>) => void; restore: () => void }) {
  const m = useMutation({
    mutationFn: (action: WriteAction) => api.post<WriteOut>("/social/write-help", { action, text, apps }),
    onSuccess: (r, action) => {
      if (action === "fit") {
        const n = Object.keys(r.texts ?? {}).length;
        if (!n) { toast.success("Already fits every network you picked."); return; }
        onTexts(r.texts!);
        toast.success(`Fitted for ${n === 1 ? "1 network" : `${n} networks`}. Each has its own text now.`, { action: { label: "Undo", onClick: restore } });
        return;
      }
      onText(r.text);
      toast.success(`Rewritten. ${r.left} left today.`, { action: { label: "Undo", onClick: restore } });
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't rewrite this. Try again.")),
  });
  const empty = !text.trim();
  return (
    <Menu sheet label="Writing help" trigger={
      <Button type="button" variant="outline" size="sm" disabled={empty || m.isPending} loading={m.isPending} data-testid="write-help" title={empty ? "Write something first" : undefined}>
        <IconSparkle className="h-4 w-4" aria-hidden />{m.isPending ? "Writing" : "Writing help"}
      </Button>
    }>
      {WRITE_ACTIONS.filter((a) => a !== "fit" || apps.length > 0).map((a) => <MenuItem key={a} onSelect={() => m.mutate(a)}>{WRITE_LABEL[a]}</MenuItem>)}
    </Menu>
  );
}

/** Share to Snapchat: copies the caption, then opens our share page with the post's link attached. No account needed. */
export function SnapShare({ text }: { text: string }) {
  const link = firstLink(text);
  const href = link ? snapShareHref(link) : null;
  const go = async () => {
    if (!href) return;
    try { await navigator.clipboard.writeText(text.trim()); toast.success("Caption copied. Paste it in Snapchat."); } catch { /* copying is a help, not a must */ }
    window.open(href, "_blank", "noopener");
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={!href} onClick={() => void go()} data-testid="snap-share" aria-describedby={!href ? "snap-share-hint" : undefined}>
        <IconShare className="h-4 w-4" aria-hidden />Share to Snapchat
      </Button>
      {!href && <span id="snap-share-hint" className="text-[12px] text-subtle">Add a link to share to Snapchat</span>}
    </div>
  );
}
