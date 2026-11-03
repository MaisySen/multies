/**
 * VID2: the small pieces of the meeting recording upgrade on screen: a two way choice (speaker or gallery view,
 * 720p or 1080p), the in call Pause, Resume and layout controls, and "Recover last recording" after a crash.
 * Pieces of a recording live only on this device (IndexedDB); nothing here talks to the server.
 */
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { IconWarning } from "@/web/components/ui/icon";
import { sizeText } from "@/web/lib/video-rec-vid1";
import type { LayoutMode, QualityId, StoredMeta } from "@/web/lib/video-rec-vid2";
import { download } from "./video-record-vid1";

export const LAYOUT_LABEL: Record<LayoutMode, string> = { speaker: "Speaker view", gallery: "Gallery view" };
export const PAUSED_NOTE = "Recording paused. Nothing is recorded until it resumes.";

/** A row of two or three pill shaped radio buttons (native radios, so keyboard and screen readers just work). */
export function ChoiceGroup<T extends string>({ label, value, options, onChange, testid, compact, onDark }: {
  label: string; value: T; options: { value: T; label: string; disabled?: boolean; hint?: string }[]; onChange: (v: T) => void; testid: string; compact?: boolean; onDark?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className={cn("min-w-0", compact ? "" : "space-y-1.5")} data-testid={testid} aria-label={compact ? label : undefined}>
      {!compact && <legend className="text-[12.5px] font-medium text-fg">{label}</legend>}
      <div className={cn("inline-flex max-w-full rounded-lg p-0.5", onDark ? "bg-black/60" : "bg-fill")}>
        {options.map((o) => (
          <label key={o.value} title={o.hint} className={cn("relative cursor-pointer whitespace-nowrap rounded-md px-3 text-[12.5px] font-medium leading-none transition-colors duration-150 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-brand",
            compact ? "py-2" : "py-2.5",
            o.value === value ? (onDark ? "bg-white text-[#1c1c1e]" : "bg-surface text-fg shadow-sm") : (onDark ? "text-white" : "text-muted hover:text-fg"),
            o.disabled && "cursor-not-allowed opacity-60")}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} disabled={o.disabled} onChange={() => onChange(o.value)} className="sr-only" data-testid={`${testid}-${o.value}`} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The recording's settings in the Record dialog. */
export function RecordSettings({ layout, setLayout, quality, setQuality, hd }: { layout: LayoutMode; setLayout: (l: LayoutMode) => void; quality: QualityId; setQuality: (q: QualityId) => void; hd: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-3" data-testid="video-rec-settings">
      <ChoiceGroup label="Layout" value={layout} onChange={setLayout} testid="video-rec-layout"
        options={[{ value: "speaker", label: "Speaker" }, { value: "gallery", label: "Gallery" }]} />
      <ChoiceGroup label="Quality" value={quality} onChange={setQuality} testid="video-rec-quality"
        options={[{ value: "hd720", label: "720p" }, { value: "hd1080", label: "1080p", disabled: !hd, hint: hd ? undefined : "This device may not keep up with 1080p" }]} />
    </div>
  );
}

/** "A recording didn't finish saving": rebuild and save it, or discard it. Shows only when pieces are on this device. */
export function RecoverRecording({ meetingId, className, onDark }: { meetingId?: string | null; className?: string; onDark?: boolean }) {
  const [list, setList] = useState<StoredMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [{ recoverable, sweep }, { idbBackend }] = await Promise.all([import("@/web/lib/video-rec-vid2"), import("@/web/lib/video-store-vid2")]);
        await sweep(idbBackend, Date.now());
        const found = recoverable(await idbBackend.metas(), Date.now());
        if (live) setList(found.filter((m) => !meetingId || !m.meetingId || m.meetingId === meetingId));
      } catch { /* no store in this browser: nothing to recover */ }
    })();
    return () => { live = false; };
  }, [meetingId]);
  const m = list[0];
  if (!m) return null;
  const recover = async () => {
    setBusy("recover");
    try {
      const [{ rebuild }, { idbBackend }] = await Promise.all([import("@/web/lib/video-rec-vid2"), import("@/web/lib/video-store-vid2")]);
      const blob = await rebuild(idbBackend, m);
      if (!blob) throw new Error("nothing was kept");
      const url = URL.createObjectURL(blob);
      download(url, m.fileName);
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
      await idbBackend.remove(m.id);
      setList((l) => l.filter((x) => x.id !== m.id));
      toast.success(`Recovered video saved, ${sizeText(blob.size)}`, { description: m.fileName });
    } catch (e) {
      toast.error(`Couldn't rebuild the video: ${(e as Error).message || "the browser refused"}.`);
    } finally { setBusy(null); }
  };
  const discard = async () => {
    setBusy("discard");
    try {
      const { idbBackend } = await import("@/web/lib/video-store-vid2");
      await idbBackend.remove(m.id);
      setList((l) => l.filter((x) => x.id !== m.id));
    } finally { setBusy(null); }
  };
  const when = new Date(m.startedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return (
    <div role="region" aria-label="Recover a recording" className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-[13px]", onDark ? "border-white/20 bg-[#1c1c1e] text-white" : "border-line bg-surface text-fg", className)} data-testid="video-recover">
      <IconWarning className={cn("h-4 w-4 shrink-0", onDark ? "text-white/80" : "text-muted")} aria-hidden />
      <p className="min-w-0 flex-1 basis-56">
        <span className="font-medium">A video recording didn't finish saving.</span>{" "}
        <span className={onDark ? "text-white/80" : "text-muted"}>{m.title || "Meeting"}, {when}, {sizeText(m.bytes)}. It is kept on this device only.</span>
      </p>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="ghost" className={onDark ? "text-white hover:bg-white/10" : undefined} onClick={() => void discard()} loading={busy === "discard"} disabled={!!busy} data-testid="video-recover-discard">Discard</Button>
        <Button size="sm" onClick={() => void recover()} loading={busy === "recover"} disabled={!!busy} data-testid="video-recover-save">Recover last recording</Button>
      </div>
    </div>
  );
}
