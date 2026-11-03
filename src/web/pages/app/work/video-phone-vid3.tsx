/**
 * VID3: the videos a phone recorded, each with a Save video button. A phone browser opens its share sheet (Save to
 * Files, Save video to Photos, the gallery, Drive) only from a tap, so Stop never saves on its own there: the video
 * waits here, in this tab only, until the person saves it and taps Done. Where the share sheet can't take the file, a
 * download link does the same job. Nothing here talks to the server: the video only goes to the person's device.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { IconCheck, IconDownload, IconVideo } from "@/web/components/ui/icon";
import { sizeText } from "@/web/lib/video-rec-vid1";
import { readyVideos, saveMode, shareGroups, type ReadyVideo, type ShareNav } from "@/web/lib/video-phone-vid3";
import { useT } from "@/web/i18n";

const nav = (): ShareNav | undefined => (typeof navigator !== "undefined" ? (navigator as unknown as ShareNav) : undefined);
const asFile = (blob: Blob, name: string) => new File([blob], name, { type: blob.type || (/\.mp4$/i.test(name) ? "video/mp4" : "video/webm") });
const textFile = (s: { name: string; text: string }) => new File([s.text], s.name, { type: "text/plain" });

/** The list of videos waiting for a Save tap (shows again whenever it changes). */
export function useReadyVideos(): ReadyVideo[] {
  return useSyncExternalStore((cb) => readyVideos.subscribe(cb), () => readyVideos.list(), () => readyVideos.list());
}

/** A link the person taps to download a file (the fallback when the share sheet can't take it). */
function DownloadLink({ blob, name, label, onDark, primary, onSaved, testid }: { blob: Blob; name: string; label: string; onDark?: boolean; primary?: boolean; onSaved: () => void; testid: string }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => { setTimeout(() => URL.revokeObjectURL(url), 60_000); }, [url]);
  return (
    <a href={url} download={name} onClick={onSaved} data-testid={testid}
      className={cn("inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        primary ? "bg-brand text-brand-fg hover:bg-brand-press" : onDark ? "bg-white/15 text-white hover:bg-white/25" : "bg-fill text-fg hover:bg-hover")}>
      <IconDownload className="h-4 w-4" aria-hidden />{label}
    </a>
  );
}

function ReadyRow({ v, onDark }: { v: ReadyVideo; onDark?: boolean }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [forceDownload, setForceDownload] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const file = useMemo(() => asFile(v.blob, v.name), [v.blob, v.name]);
  const sideFiles = useMemo(() => v.sides.map(textFile), [v.sides]);
  const groups = shareGroups(nav(), file, v.sidesSaved ? [] : sideFiles);
  const mode = forceDownload ? "download" : saveMode(nav(), [file]);
  const onlyTranscript = v.sides.length === 1 && /transcript\.txt$/i.test(v.sides[0].name);
  const sidesLabel = v.sides.length > 1 ? t("meetingrec.save_chat_transcript") : onlyTranscript ? t("meetingrec.save_transcript") : t("meetingrec.save_chat");
  const muted = onDark ? "text-white/80" : "text-muted";

  const share = async (files: File[], withSides: boolean, sidesOnly = false) => {
    const n = nav();
    if (!n?.share) { setForceDownload(true); return; }
    setBusy(true);
    try {
      // Called straight from the tap: phone browsers only open the share sheet for one.
      await n.share({ files, title: v.name });
      if (sidesOnly) readyVideos.sidesSaved(v.id); else readyVideos.saved(v.id, withSides);
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name !== "AbortError") {
        setForceDownload(true);
        toast.error(t("meetingrec.share_failed"));
      }
    } finally { setBusy(false); }
  };

  const discard = () => {
    if (v.saves === 0 && !confirm) { setConfirm(true); return; }
    readyVideos.remove(v.id);
  };

  return (
    <li className={cn("flex flex-col gap-2 rounded-xl border px-3 py-3 text-[13px] sm:px-4", onDark ? "border-white/20 bg-[#1c1c1e] text-white" : "border-line bg-surface text-fg")} data-testid="video-ready" data-mode={mode} data-saves={v.saves}>
      <div className="flex min-w-0 items-start gap-2">
        {v.saves > 0 ? <IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> : <IconVideo className={cn("mt-0.5 h-4 w-4 shrink-0", muted)} aria-hidden />}
        <p className="min-w-0 flex-1">
          <span className="font-medium">{v.saves > 0 ? t("meetingrec.saved_title") : t("meetingrec.ready_title")}</span>{" "}
          <span className={muted}>{sizeText(v.blob.size)}</span>
          <span className={cn("block truncate", muted)} title={v.name}>{v.name}</span>
          <span className={cn("block", muted)}>{v.saves > 0 ? t("meetingrec.saved_hint") : mode === "share" ? t("meetingrec.share_hint") : t("meetingrec.download_hint")}</span>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {mode === "share"
          ? <Button size="sm" onClick={() => void share(groups.now, groups.now.length > 1)} loading={busy} data-testid="video-ready-save"><IconDownload className="h-4 w-4" aria-hidden />{v.saves > 0 ? t("meetingrec.save_again") : t("meetingrec.save_video")}</Button>
          : <DownloadLink blob={v.blob} name={v.name} primary label={v.saves > 0 ? t("meetingrec.save_again") : t("meetingrec.save_video")} onSaved={() => readyVideos.saved(v.id, false)} testid="video-ready-save" />}
        {v.sides.length > 0 && !v.sidesSaved && groups.later.length > 0 && (mode === "share" && saveMode(nav(), groups.later) === "share"
          ? <Button size="sm" variant="secondary" className={onDark ? "border-white/20 bg-white/15 text-white hover:bg-white/25" : undefined} onClick={() => void share(groups.later, true, true)} disabled={busy} data-testid="video-ready-sides">{sidesLabel}</Button>
          : v.sides.map((s) => <DownloadLink key={s.name} blob={new Blob([s.text], { type: "text/plain;charset=utf-8" })} name={s.name} onDark={onDark} label={/transcript\.txt$/i.test(s.name) ? t("meetingrec.save_transcript") : t("meetingrec.save_chat")} onSaved={() => readyVideos.sidesSaved(v.id)} testid="video-ready-side" />))}
        <Button size="sm" variant="ghost" className={cn("ml-auto", onDark ? "text-white hover:bg-white/10" : undefined)} onClick={discard} data-testid="video-ready-done">
          {v.saves > 0 ? t("meetingrec.done") : confirm ? t("meetingrec.discard_confirm") : t("meetingrec.discard")}
        </Button>
      </div>
    </li>
  );
}

/** Every video this phone recorded that is waiting for the person (empty: nothing shows). */
export function PhoneSaves({ onDark, className }: { onDark?: boolean; className?: string }) {
  const t = useT();
  const list = useReadyVideos();
  if (!list.length) return null;
  return (
    <section aria-label={t("meetingrec.ready_region")} className={cn("w-full", className)} data-testid="video-ready-list">
      <ul className="flex flex-col gap-2">{list.map((v) => <ReadyRow key={v.id} v={v} onDark={onDark} />)}</ul>
    </section>
  );
}
