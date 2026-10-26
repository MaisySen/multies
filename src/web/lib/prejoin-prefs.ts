/**
 * Round 31: the pre-join choices (camera, microphone, speaker, on/off) kept in localStorage so the
 * next call starts the same way, and the small pure helpers the pre-join screen and the call use.
 */
export interface JoinPrefs {
  cam: boolean; mic: boolean;
  videoDeviceId?: string; audioDeviceId?: string; speakerDeviceId?: string;
  /** A guest's display name, remembered for the next guest link. */
  name?: string;
}

export const PREJOIN_KEY = "multies.prejoin.v1";
const DEFAULTS: JoinPrefs = { cam: true, mic: true };

type Store = Pick<Storage, "getItem" | "setItem">;
const store = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 300 ? v : undefined);

export function loadPrefs(s: Store | null = store()): JoinPrefs {
  try {
    const raw = s?.getItem(PREJOIN_KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Record<string, unknown>;
    return {
      cam: p.cam !== false, mic: p.mic !== false,
      videoDeviceId: str(p.videoDeviceId), audioDeviceId: str(p.audioDeviceId), speakerDeviceId: str(p.speakerDeviceId),
      name: typeof p.name === "string" ? p.name.slice(0, 60) : undefined,
    };
  } catch { return { ...DEFAULTS }; }
}

export function savePrefs(p: JoinPrefs, s: Store | null = store()) {
  try { s?.setItem(PREJOIN_KEY, JSON.stringify(p)); } catch { /* private mode: nothing to keep */ }
}

/** What LiveKitRoom takes for the choices: false for off, else the chosen device (or the default). */
export function roomMedia(p: JoinPrefs) {
  return {
    video: p.cam ? (p.videoDeviceId ? { deviceId: p.videoDeviceId } : true) : false,
    audio: p.mic ? (p.audioDeviceId ? { deviceId: p.audioDeviceId } : true) : false,
    options: p.speakerDeviceId ? { audioOutput: { deviceId: p.speakerDeviceId } } : undefined,
  } as const;
}

/** A 0..1 level from analyser time domain bytes (128 is silence). */
export function levelOf(bytes: ArrayLike<number>): number {
  if (!bytes.length) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) { const v = (bytes[i] - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / bytes.length) * 3);
}

/** A device's label, or a plain fallback before permission is given ("Camera 2"). */
export function deviceLabel(d: { label: string; kind: string }, i: number) {
  if (d.label) return d.label;
  return `${d.kind === "videoinput" ? "Camera" : d.kind === "audioinput" ? "Microphone" : "Speaker"} ${i + 1}`;
}

/** The chosen device if it is still plugged in, else the first one. */
export function pickDevice(list: { deviceId: string }[], wanted?: string) {
  return list.find((d) => d.deviceId === wanted)?.deviceId ?? list[0]?.deviceId;
}

/** Whether to open the So far panel on its own: joined this long after the start, and not dismissed for this call. */
export function shouldShowSoFar(startedAt: string, now: number, lateMs: number, dismissed: boolean) {
  const t = Date.parse(startedAt);
  return !dismissed && Number.isFinite(t) && now - t > lateMs;
}

/** "since 9:41" style minutes in the call. */
export function minutesLabel(min: number | null) {
  if (min === null) return "";
  if (min < 1) return "just joined";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}
