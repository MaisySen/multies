import { calFmt } from "./mpar3";
import { Platform } from "react-native";
import { appPathOf, openInSystemBrowser, signedInUrl } from "./web-link";
import { webTransport } from "./web-transport";
import * as Clipboard from "expo-clipboard";
import type { Meeting } from "@/api/types";
import { LOCALE } from "./format";
import { tr } from "@/i18n";

/**
 * MFIX1 (1.10.16): joining opens the meeting in the phone's own browser (Safari or Chrome), signed in with a one time
 * link when it is this server's meeting page, so a recording can be saved and shared there. The in-app browser could
 * not hand the recorded file to the phone and stayed on "Saving the video". If the phone will not open it, the in-app
 * browser is the fallback. On the web preview it opens a new tab.
 */
export async function openMeeting(url: string): Promise<void> {
  if (Platform.OS === "web") {
    globalThis.open?.(url, "_blank", "noopener");
    return;
  }
  await openInSystemBrowser(await meetingTarget(url));
}

/** The URL a meeting opens at: this server's meeting page gets the one time sign in link, any other link as given. */
export async function meetingTarget(url: string, transport = webTransport()): Promise<string> {
  const path = appPathOf(url);
  return path && transport ? signedInUrl(transport, path) : url;
}

export async function copyGuestLink(m: Pick<Meeting, "guestUrl">): Promise<void> {
  await Clipboard.setStringAsync(m.guestUrl);
}

/** "Tue 27 Oct, 2:30 pm, 30 min" */
export function meetingWhen(m: Pick<Meeting, "startsAt" | "durationMin">): string {
  const d = new Date(m.startsAt);
  const day = calFmt(d, { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}, ${m.durationMin} min`;
}

/** Whether a meeting is on now or starts within the next 10 minutes. */
export function isLive(m: Pick<Meeting, "startsAt" | "endsAt" | "status">, now: number): boolean {
  if (m.status === "ended" || m.status === "cancelled") return false;
  return Date.parse(m.startsAt) - 10 * 60_000 <= now && now < Date.parse(m.endsAt);
}

/** R36: meetings grouped by local day, soonest first, labelled Today, Tomorrow or "Tue 27 Oct". */
export function meetingDays<M extends Pick<Meeting, "startsAt">>(list: M[], now: number): { key: string; label: string; today: boolean; items: M[] }[] {
  const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(now + 86_400_000);
  const out: { key: string; label: string; today: boolean; items: M[] }[] = [];
  for (const m of [...list].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const t = Date.parse(m.startsAt);
    const key = dayKey(t);
    let g = out.find((x) => x.key === key);
    if (!g) {
      const label = key === todayKey ? tr("m.today.today") : key === tomorrowKey ? tr("m.today.tomorrow") : calFmt(new Date(t), { weekday: "short", day: "numeric", month: "short" });
      g = { key, label, today: key === todayKey, items: [] };
      out.push(g);
    }
    g.items.push(m);
  }
  return out;
}

/** "2:30 pm" */
export function meetingTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
}
