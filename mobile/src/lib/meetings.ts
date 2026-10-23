import { Linking, Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Clipboard from "expo-clipboard";
import type { Meeting } from "@/api/types";

/**
 * Video runs on the web meeting page, so joining opens it in the in-app browser (the system
 * browser if that fails). On the web preview it opens a new tab.
 */
export async function openMeeting(url: string): Promise<void> {
  if (Platform.OS === "web") {
    globalThis.open?.(url, "_blank", "noopener");
    return;
  }
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    await Linking.openURL(url);
  }
}

export async function copyGuestLink(m: Pick<Meeting, "guestUrl">): Promise<void> {
  await Clipboard.setStringAsync(m.guestUrl);
}

/** "Tue 27 Oct, 2:30 pm, 30 min" */
export function meetingWhen(m: Pick<Meeting, "startsAt" | "durationMin">): string {
  const d = new Date(m.startsAt);
  const day = d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}, ${m.durationMin} min`;
}

/** Whether a meeting is on now or starts within the next 10 minutes. */
export function isLive(m: Pick<Meeting, "startsAt" | "endsAt" | "status">, now: number): boolean {
  if (m.status === "ended" || m.status === "cancelled") return false;
  return Date.parse(m.startsAt) - 10 * 60_000 <= now && now < Date.parse(m.endsAt);
}
