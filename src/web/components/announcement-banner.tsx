/**
 * OPS1: the in-app announcement operators publish from the console (served on /api/config as `announcement`).
 * A slim strip under the top bar, in the same tones as the badges: info blue, warning amber, critical red.
 * Shows only while its window is open and to its audience; a dismissible one stays hidden in this browser once
 * closed (per announcement id, so a new one shows again).
 */
import { useState } from "react";
import { IconClose, IconInfo, IconWarning } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { isAnnouncementActive, viewerAudience, type AnnouncementTone, type PublicAnnouncement } from "@/shared/announcement";

export const ANNOUNCEMENT_DISMISSED_KEY = "multies.announcement.dismissed";

function readDismissed(): string | null {
  try {
    return globalThis.localStorage?.getItem(ANNOUNCEMENT_DISMISSED_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeDismissed(id: string) {
  try {
    globalThis.localStorage?.setItem(ANNOUNCEMENT_DISMISSED_KEY, id);
  } catch { /* private mode or blocked storage: it stays hidden until the page reloads */ }
}

const toneClass: Record<AnnouncementTone, string> = {
  info: "bg-brand-soft border-brand/25",
  warning: "bg-warn-soft border-warn/20",
  critical: "bg-bad-soft border-bad/20",
};
const iconClass: Record<AnnouncementTone, string> = { info: "text-brand", warning: "text-warn", critical: "text-bad" };

/**
 * `preview` (the console's live preview): always draws the strip, whatever its window, audience or an earlier
 * dismissal, and the close button does nothing, so the operator sees exactly what customers will see.
 */
export function AnnouncementBanner({ announcement, role, now, preview }: { announcement: PublicAnnouncement | null | undefined; role: string | null | undefined; now?: Date; preview?: boolean }) {
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  if (!announcement) return null;
  if (!preview && !isAnnouncementActive(announcement, now ?? new Date(), viewerAudience(role))) return null;
  if (!preview && announcement.dismissible && dismissed === announcement.id) return null;
  const a = announcement;
  const Icon = a.tone === "info" ? IconInfo : IconWarning;
  const link = a.linkUrl && a.linkLabel && a.linkUrl.startsWith("https://") ? { href: a.linkUrl, label: a.linkLabel } : null;
  return (
    <div
      role={a.tone === "critical" ? "alert" : "status"}
      data-testid="announcement-banner"
      data-tone={a.tone}
      className={cn("flex items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-2 text-[13px] text-fg", toneClass[a.tone])}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", iconClass[a.tone])} aria-hidden="true" />
        <span className="min-w-0">{a.text}</span>
        {link && (
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-fg underline underline-offset-2 transition-colors duration-150 hover:text-brand focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
            data-testid="announcement-link"
          >
            {link.label}
          </a>
        )}
      </div>
      {a.dismissible && (
        <button
          type="button"
          onClick={() => { if (preview) return; writeDismissed(a.id); setDismissed(a.id); }}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-fg/70 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
          aria-label="Dismiss announcement"
          data-testid="announcement-dismiss"
        >
          <IconClose className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
