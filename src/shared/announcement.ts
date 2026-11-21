/**
 * OPS1: the one in-app announcement operators publish from the console (Announcements section). Stored in
 * app_settings under one key (services/console/announcements.ts), served on /api/config while it is live, and
 * shown by web/components/announcement-banner.tsx. Shared so the server validates and the web app decides what
 * to show with the same rules.
 */
import { z } from "zod";

export const ANNOUNCEMENT_TONES = ["info", "warning", "critical"] as const;
export const ANNOUNCEMENT_AUDIENCES = ["all", "admins"] as const;
export const ANNOUNCEMENT_TEXT_MAX = 240;
export const ANNOUNCEMENT_LINK_LABEL_MAX = 40;
export const ANNOUNCEMENT_LINK_URL_MAX = 500;

export type AnnouncementTone = (typeof ANNOUNCEMENT_TONES)[number];
/** "all": everyone signed in. "admins": workspace owners and admins only. */
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

/** The stored announcement (console and audit rows). */
export interface Announcement {
  id: string;
  text: string;
  tone: AnnouncementTone;
  audience: AnnouncementAudience;
  linkLabel: string | null;
  linkUrl: string | null;
  /** ISO time it starts showing; null = at once. */
  startsAt: string | null;
  /** ISO time it stops showing; null = until cleared. */
  endsAt: string | null;
  dismissible: boolean;
  /** User id of the operator who published it. */
  updatedBy: string;
  updatedAt: string;
}

/** What /api/config carries: no operator id, no edit time. */
export type PublicAnnouncement = Omit<Announcement, "updatedBy" | "updatedAt">;

// Plain text only: no markup characters, no control characters or line breaks.
const hasControl = (s: string) => [...s].some((ch) => { const c = ch.charCodeAt(0); return c < 32 || c === 127; });
const plain = (max: number, what: string) =>
  z.string().trim().min(1, `Add the ${what}.`).max(max, `Keep the ${what} under ${max} characters.`)
    .refine((s) => !/[<>]/.test(s), `The ${what} must be plain text (no < or >).`)
    .refine((s) => !hasControl(s), `The ${what} must be one line of plain text.`);

/** An https address with no user name or password in it. */
export const httpsUrl = z.string().trim().max(ANNOUNCEMENT_LINK_URL_MAX, `Keep the link under ${ANNOUNCEMENT_LINK_URL_MAX} characters.`).refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}, "The link must be a full https:// address.");

const isoTime = z.string().trim().refine((s) => !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s), "Use a date and time like 2026-12-01T09:00:00Z.")
  .transform((s) => new Date(s).toISOString());

/** What an operator sends to publish. Strict: unknown fields are refused. */
export const announcementInput = z.object({
  text: plain(ANNOUNCEMENT_TEXT_MAX, "text"),
  tone: z.enum(ANNOUNCEMENT_TONES).default("info"),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).default("all"),
  linkLabel: plain(ANNOUNCEMENT_LINK_LABEL_MAX, "link label").nullable().optional(),
  linkUrl: httpsUrl.nullable().optional(),
  startsAt: isoTime.nullable().optional(),
  endsAt: isoTime.nullable().optional(),
  dismissible: z.boolean().default(true),
}).strict().superRefine((v, ctx) => {
  if (!!v.linkLabel !== !!v.linkUrl) ctx.addIssue({ code: "custom", path: [v.linkUrl ? "linkLabel" : "linkUrl"], message: "Give both a link label and a link, or neither." });
  if (v.startsAt && v.endsAt && Date.parse(v.endsAt) <= Date.parse(v.startsAt)) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end must be after the start." });
});

export type AnnouncementInput = z.input<typeof announcementInput>;

/** The public shape, for reading /api/config defensively on the client. */
export const publicAnnouncementSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  tone: z.enum(ANNOUNCEMENT_TONES),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES),
  linkLabel: z.string().nullable(),
  linkUrl: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  dismissible: z.boolean(),
});

/** The fields safe for /api/config. */
export function toPublicAnnouncement(a: Announcement | PublicAnnouncement): PublicAnnouncement {
  return { id: a.id, text: a.text, tone: a.tone, audience: a.audience, linkLabel: a.linkLabel, linkUrl: a.linkUrl, startsAt: a.startsAt, endsAt: a.endsAt, dismissible: a.dismissible };
}

/** The audience a viewer belongs to, from their workspace role: owners and admins also see "admins" announcements. */
export function viewerAudience(role: string | null | undefined): AnnouncementAudience {
  return role === "owner" || role === "admin" ? "admins" : "all";
}

/**
 * Whether the announcement shows at `now`. With `audience` (the viewer's, see viewerAudience) an "admins"
 * announcement shows only to an "admins" viewer; without it only the time window is checked.
 */
export function isAnnouncementActive(a: Pick<Announcement, "audience" | "startsAt" | "endsAt"> | null | undefined, now: Date, audience?: AnnouncementAudience): boolean {
  if (!a) return false;
  const t = now.getTime();
  if (a.startsAt && Date.parse(a.startsAt) > t) return false;
  if (a.endsAt && Date.parse(a.endsAt) <= t) return false;
  if (audience && a.audience === "admins" && audience !== "admins") return false;
  return true;
}
