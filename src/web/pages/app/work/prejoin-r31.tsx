/**
 * Round 31: the pre-join screen before any call or meeting (chat call dock, meeting page, guest
 * link). Live camera preview (mirrored), a microphone level meter, camera, microphone and speaker
 * pickers (remembered), camera and mic toggles that carry into the call, a generated test tone, the
 * name people will see, who is already in, and Join (Enter joins). A blocked camera or microphone
 * gets plain words and a "Join without camera" path. The preview's tracks stop before the call
 * takes the devices.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { IconMic, IconMicOff, IconTeam, IconVideo, IconVideoOff, IconVolume, type IconComponent } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Input, Select } from "@/web/components/ui/input";
import { cn } from "@/web/lib/cn";
import { deviceLabel, levelOf, loadPrefs, pickDevice, savePrefs, type JoinPrefs } from "@/web/lib/prejoin-prefs";
import { hereText } from "@/shared/meeting-lobby";
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-meetings"; // R104B

export type { JoinPrefs } from "@/web/lib/prejoin-prefs";

type Who = { mode: "member"; name: string } | { mode: "guest" };
type Blocked = null | "denied" | "missing" | "busy";

const BLOCKED_COPY: Record<Exclude<Blocked, null>, string> = {
  denied: "Your browser is blocking the camera or microphone. Allow them from the icon at the left of the address bar, then press Try again. You can also join without them.",
  missing: "No camera or microphone was found. Plug one in and press Try again, or join without them.",
  busy: "Another app is using the camera or microphone. Close it and press Try again, or join without them.",
};

function blockedOf(err: unknown): Blocked {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "missing";
  return "busy";
}

/** A short two note tone through the chosen speaker, made with WebAudio (no sound file). */
async function playTone(speakerId?: string) {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const sink = (ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
  if (speakerId && sink) await sink.call(ctx, speakerId).catch(() => undefined);
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  const t = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
  for (const [freq, at] of [[660, 0], [880, 0.22]] as const) {
    const o = ctx.createOscillator();
    o.type = "sine"; o.frequency.value = freq; o.connect(gain);
    o.start(t + at); o.stop(t + at + 0.45);
  }
  window.setTimeout(() => void ctx.close().catch(() => undefined), 1200);
}

export interface PreJoinProps {
  title: string;
  who: Who;
  /** Names already in the call, when known. */
  inCall?: string[];
  /** Round 32: how many are in the call when inCall lists only some (the guest page gets first names and the count). */
  inCallCount?: number;
  busy?: boolean;
  compact?: boolean;
  /** Leave out the "Ready to join?" heading (the page already shows the title). */
  bare?: boolean;
  joinLabel?: string;
  footnote?: string;
  onJoin: (prefs: JoinPrefs) => void;
  onCancel?: () => void;
}

export function PreJoin({ title, who, inCall, inCallCount, busy, compact, bare, joinLabel = "Join", footnote = "Press Enter to join.", onJoin, onCancel }: PreJoinProps) {
  const [prefs, setPrefs] = useState<JoinPrefs>(() => loadPrefs());
  const [name, setName] = useState(() => (who.mode === "guest" ? loadPrefs().name ?? "" : ""));
  // Round 32: a member's name for this call only (not remembered).
  const [callName, setCallName] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [blocked, setBlocked] = useState<Blocked>(null);
  const [level, setLevel] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ids = useId();
  const unsupported = typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia;

  const stop = useCallback(() => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; }, []);

  // One stream for the preview and the meter, opened again when a device or toggle changes.
  useEffect(() => {
    if (unsupported) return;
    let cancelled = false;
    let raf = 0;
    let audioCtx: AudioContext | null = null;
    stop();
    setLevel(0);
    if (!prefs.cam && !prefs.mic) { if (videoRef.current) videoRef.current.srcObject = null; return; }
    void (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: prefs.cam ? (prefs.videoDeviceId ? { deviceId: { exact: prefs.videoDeviceId } } : true) : false,
          audio: prefs.mic ? (prefs.audioDeviceId ? { deviceId: { exact: prefs.audioDeviceId } } : true) : false,
        });
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = s;
        setBlocked(null);
        if (videoRef.current) { videoRef.current.srcObject = prefs.cam ? s : null; void videoRef.current.play?.().catch(() => undefined); }
        const list = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
        if (!cancelled) setDevices(list);
        if (prefs.mic && s.getAudioTracks().length && window.AudioContext) {
          audioCtx = new AudioContext();
          const an = audioCtx.createAnalyser();
          an.fftSize = 512;
          audioCtx.createMediaStreamSource(s).connect(an);
          const buf = new Uint8Array(an.fftSize);
          let last = 0;
          const tick = (now: number) => {
            if (now - last > 80) { an.getByteTimeDomainData(buf); setLevel(levelOf(buf)); last = now; }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        }
      } catch (err) {
        if (!cancelled) setBlocked(blockedOf(err));
      }
    })();
    return () => { cancelled = true; cancelAnimationFrame(raf); void audioCtx?.close().catch(() => undefined); stop(); };
  }, [prefs.cam, prefs.mic, prefs.videoDeviceId, prefs.audioDeviceId, attempt, unsupported, stop]);

  const cams = devices.filter((d) => d.kind === "videoinput");
  const mics = devices.filter((d) => d.kind === "audioinput");
  const speakers = devices.filter((d) => d.kind === "audiooutput");
  const set = (patch: Partial<JoinPrefs>) => setPrefs((p) => { const n = { ...p, ...patch }; savePrefs({ ...n, name: loadPrefs().name }); return n; });
  const nameOk = who.mode === "member" ? callName === null || callName.trim().length > 0 : name.trim().length > 0;
  const join = (override?: Partial<JoinPrefs>) => {
    if (!nameOk || busy) return;
    const final: JoinPrefs = {
      ...prefs, ...override,
      videoDeviceId: pickDevice(cams, prefs.videoDeviceId) ?? prefs.videoDeviceId,
      audioDeviceId: pickDevice(mics, prefs.audioDeviceId) ?? prefs.audioDeviceId,
      ...(who.mode === "guest" ? { name: name.trim().slice(0, 60) } : {}),
    };
    savePrefs(final);
    stop(); // free the camera before the call opens it
    const forCall = who.mode === "member" && callName !== null && callName.trim() && callName.trim() !== who.name ? callName.trim().slice(0, 60) : undefined;
    onJoin(forCall ? { ...final, name: forCall } : final);
  };

  // Enter joins from anywhere on the screen that isn't a control of its own (a toggle, picker or field).
  const joinRef = useRef(join);
  joinRef.current = join;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && t.closest("button, select, input, textarea, a, [contenteditable]")) return;
      e.preventDefault();
      joinRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = (on: boolean, label: string, onIcon: IconComponent, offIcon: IconComponent, flip: () => void, testId: string) => {
    const Icon = on ? onIcon : offIcon;
    return (
      <button type="button" onClick={flip} aria-pressed={on} aria-label={`${label} ${on ? "on" : "off"}`} data-testid={testId}
        className={cn("inline-flex h-10 w-10 items-center justify-center rounded-full border max-sm:h-12 max-sm:w-12 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none",
          on ? "border-white/30 bg-black/40 text-white hover:bg-black/55" : "border-transparent bg-bad text-white hover:bg-bad/90")}>
        <Icon className="h-4.5 w-4.5" aria-hidden />
      </button>
    );
  };

  return (
    <form className={cn("mx-auto w-full", compact ? "p-3" : "max-w-3xl")} data-testid="prejoin" aria-label={tr("meetings.get_ready_to_join_title", { title })}
      onSubmit={(e) => { e.preventDefault(); join(); }}>
      {!compact && !bare && <h1 className="mb-1 text-xl font-semibold tracking-tight">{tr("meetings.ready_to_join")}</h1>}
      {!compact && !bare && <p className="mb-4 text-[13px] text-muted">{title}</p>}
      <div className={cn("grid gap-4", compact ? "" : "md:grid-cols-[1.4fr_1fr]")}>
        <div className="relative aspect-video overflow-hidden rounded-2xl bg-[#1c1c1e]">
          <video ref={videoRef} muted playsInline autoPlay aria-label={tr("meetings.your_camera_preview")} data-testid="prejoin-preview"
            className={cn("h-full w-full -scale-x-100 object-cover", (!prefs.cam || blocked) && "invisible")} />
          {(!prefs.cam || blocked) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80">
              <IconVideoOff className="h-6 w-6" aria-hidden />
              <span className="text-[12.5px]">{blocked ? tr("meetings.camera_unavailable") : tr("meetings.camera_is_off")}</span>
            </div>
          )}
          <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-3">
            {toggle(prefs.mic, "Microphone", IconMic, IconMicOff, () => set({ mic: !prefs.mic }), "prejoin-mic")}
            {toggle(prefs.cam, "Camera", IconVideo, IconVideoOff, () => set({ cam: !prefs.cam }), "prejoin-cam")}
          </div>
          {prefs.mic && !blocked && (
            <div className="absolute left-3 top-3 flex h-6 items-end gap-0.5 rounded-md bg-black/40 px-1.5 py-1" role="meter" aria-label={tr("meetings.microphone_level")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} data-testid="prejoin-meter">
              {[0.1, 0.25, 0.45, 0.65, 0.85].map((t) => <span key={t} className={cn("w-1 rounded-sm transition-[height,background-color] duration-100 motion-reduce:transition-none", level > t ? "bg-ok" : "bg-white/35")} style={{ height: `${6 + t * 12}px` }} />)}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          {unsupported && <p role="alert" className="rounded-xl bg-fill p-3 text-[12.5px] text-muted">{tr("meetings.this_browser_can_t_show_a_camera_preview_you_can")}</p>}
          {blocked && (
            <div role="alert" className="rounded-xl border border-line bg-elevated p-3 text-[12.5px] text-fg" data-testid="prejoin-blocked">
              <p>{BLOCKED_COPY[blocked]}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>{tr("common.try_again")}</Button>
                <Button size="sm" variant="ghost" onClick={() => join({ cam: false, mic: blocked === "denied" ? false : prefs.mic })} data-testid="prejoin-without-camera">{tr("meetings.join_without_camera")}</Button>
              </div>
            </div>
          )}
          {!compact && (
            <>
              <label className="block text-[12px] font-medium text-muted" htmlFor={`${ids}-cam`}>{tr("meetings.camera")}</label>
              <Select id={`${ids}-cam`} value={pickDevice(cams, prefs.videoDeviceId) ?? ""} onChange={(e) => set({ videoDeviceId: e.target.value })} disabled={!cams.length} data-testid="prejoin-camera-select">
                {cams.length ? cams.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{deviceLabel(d, i)}</option>) : <option value="">{tr("meetings.no_camera_found")}</option>}
              </Select>
              <label className="block text-[12px] font-medium text-muted" htmlFor={`${ids}-mic`}>{tr("meetings.microphone")}</label>
              <Select id={`${ids}-mic`} value={pickDevice(mics, prefs.audioDeviceId) ?? ""} onChange={(e) => set({ audioDeviceId: e.target.value })} disabled={!mics.length} data-testid="prejoin-mic-select">
                {mics.length ? mics.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{deviceLabel(d, i)}</option>) : <option value="">{tr("meetings.no_microphone_found")}</option>}
              </Select>
              <label className="block text-[12px] font-medium text-muted" htmlFor={`${ids}-spk`}>{tr("meetings.speaker")}</label>
              <div className="flex gap-2">
                <Select id={`${ids}-spk`} className="min-w-0 flex-1" value={pickDevice(speakers, prefs.speakerDeviceId) ?? ""} onChange={(e) => set({ speakerDeviceId: e.target.value })} disabled={!speakers.length} data-testid="prejoin-speaker-select">
                  {speakers.length ? speakers.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{deviceLabel(d, i)}</option>) : <option value="">{tr("meetings.system_default")}</option>}
                </Select>
                <Button variant="secondary" onClick={() => void playTone(prefs.speakerDeviceId)} aria-label={tr("meetings.test_speaker")} data-testid="prejoin-test-speaker"><IconVolume className="h-4 w-4" aria-hidden />{tr("meetings.test")}</Button>
              </div>
            </>
          )}
          {who.mode === "guest" ? (
            <div>
              <label className="block text-[12px] font-medium text-muted" htmlFor={`${ids}-name`}>{tr("auth.your_name")}</label>
              <Input id={`${ids}-name`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={60} className="mt-1" data-testid="prejoin-name" />
            </div>
          ) : (
            callName === null ? (
              <p className="flex items-center gap-2 text-[12.5px] text-muted" data-testid="prejoin-joining-as">
                <span>{tr("meetings.joining_as")} <span className="font-medium text-fg">{who.name}</span></span>
                <button type="button" onClick={() => setCallName(who.name)} className="rounded text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center max-sm:justify-center max-sm:px-1" data-testid="prejoin-change-name">{tr("meetings.change")}</button>
              </p>
            ) : (
              <div>
                <label className="block text-[12px] font-medium text-muted" htmlFor={`${ids}-callname`}>{tr("meetings.your_name_in_this_call")}</label>
                <Input id={`${ids}-callname`} value={callName} onChange={(e) => setCallName(e.target.value)} autoComplete="name" required maxLength={60} autoFocus className="mt-1" data-testid="prejoin-member-name" />
              </div>
            )
          )}
          {inCall && (
            <p className="flex items-start gap-1.5 text-[12.5px] text-muted" data-testid="prejoin-in-call">
              <IconTeam className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{hereText(inCall, inCallCount ?? inCall.length)}</span>
            </p>
          )}
          <div className={cn("mt-auto flex gap-2", compact && "justify-end")}>
            {onCancel && <Button variant="ghost" onClick={onCancel}>{tr("common.cancel")}</Button>}
            <Button type="submit" size={compact ? "md" : "lg"} className={compact ? "" : "flex-1"} loading={busy} disabled={!nameOk} autoFocus={who.mode === "member"} data-testid="prejoin-join">
              <IconVideo className="h-4 w-4" aria-hidden />{joinLabel}
            </Button>
          </div>
          {!compact && <p className="text-[11.5px] text-subtle">{footnote}</p>}
        </div>
      </div>
    </form>
  );
}
