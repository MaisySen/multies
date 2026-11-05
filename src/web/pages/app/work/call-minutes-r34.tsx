import { useQuery } from "@tanstack/react-query";
import { IconClock } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { LOCALE } from "@/shared/locale";
import { cn } from "@/web/lib/cn";
import { tr, uiLocale } from "@/web/i18n"; // POL5 (MB-363)
import "@/web/i18n/w2/en-meetings";

/** R34 (MB-171): the workspace's call minutes, as the server sends them on a live call or from /chat/call-minutes. */
export interface CallMinutes { used: number; cap: number | null; remaining?: number; percent?: number; warn?: null | "eighty" | "last_minutes" | "used_up"; period: string; resetsOn: string }

const loc = () => uiLocale() ?? LOCALE;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(loc(), { day: "numeric", month: "long", timeZone: "UTC" });

/** Pure: the words for the in-call warning, or null when there is nothing to say. */
export function minutesBannerText(m: CallMinutes | null | undefined): string | null {
  if (!m || m.cap === null || !m.warn) return null;
  const cap = m.cap.toLocaleString(loc());
  if (m.warn === "used_up") return tr("meetings.minutes_used_up", { cap, day: day(m.resetsOn) });
  if (m.warn === "last_minutes") return tr("meetings.minutes_last", { count: m.remaining ?? 0, day: day(m.resetsOn) });
  return tr("meetings.minutes_percent", { percent: m.percent ?? 80, cap });
}

/** Pure: a short line for the meetings page ("320 of 1,000 call minutes used in October"). Null when there is no cap. */
export function minutesUsageLine(m: CallMinutes | null | undefined): string | null {
  if (!m || m.cap === null) return null;
  const month = new Date(`${m.period}-01T00:00:00Z`).toLocaleDateString(loc(), { month: "long", timeZone: "UTC" });
  return tr("meetings.minutes_usage", { used: m.used.toLocaleString(loc()), cap: m.cap.toLocaleString(loc()), month, day: day(m.resetsOn) });
}

/** In a call (members): polls the call status once a minute and shows the warning at 80% and in the last 5 minutes. */
export function CallMinutesBanner({ meetingId, className }: { meetingId?: string; className?: string }) {
  const q = useQuery({
    queryKey: ["call-minutes", meetingId], enabled: !!meetingId, refetchInterval: 60_000, refetchIntervalInBackground: false,
    queryFn: () => api.get<{ minutes?: CallMinutes }>(`/chat/calls/${meetingId}`),
  });
  const text = minutesBannerText(q.data?.minutes);
  if (!text) return null;
  const urgent = q.data?.minutes?.warn !== "eighty";
  return (
    <div role="status" data-testid="call-minutes-banner"
      className={cn("pointer-events-auto flex max-w-md items-start gap-2 rounded-xl border p-3 text-[12.5px] shadow-pop", urgent ? "border-bad/30 bg-elevated text-fg" : "border-line bg-elevated text-fg", className)}>
      <IconClock className={cn("mt-0.5 h-4 w-4 shrink-0", urgent ? "text-bad" : "text-warn")} aria-hidden />
      <p>{text}</p>
    </div>
  );
}

/** The meetings page line, for capped workspaces only. */
export function CallMinutesUsage({ className }: { className?: string }) {
  const q = useQuery({ queryKey: ["call-minutes", "usage"], queryFn: () => api.get<CallMinutes>("/chat/call-minutes"), staleTime: 60_000 });
  const line = minutesUsageLine(q.data);
  if (!line) return null;
  return <p className={cn("text-[12.5px] text-muted", className)} data-testid="call-minutes-usage">{line}</p>;
}
