/**
 * R131: Home widgets (flag HOME_WIDGETS_R131). The layout a person arranges on Home, Overview: which widgets show,
 * in what order and size, plus their quick links. One shape for the server (validation) and the web app.
 * Widgets read existing data through existing routes and permissions; this file only describes the arrangement.
 */
import { z } from "zod";

export const WIDGET_IDS = ["tasks", "calendar", "inbox", "links", "overview", "social", "feeds", "dashboards"] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];
export const WIDGET_SIZES = ["small", "medium", "wide"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

export const WIDGET_INFO: Record<WidgetId, { title: string; blurb: string; size: WidgetSize }> = {
  tasks: { title: "My tasks", blurb: "Overdue and due today", size: "medium" },
  calendar: { title: "Today and next", blurb: "Your meetings today and the next one", size: "medium" },
  inbox: { title: "Inbox counts", blurb: "Mail, chat, notifications and triage", size: "medium" },
  links: { title: "Quick links", blurb: "Links you open often", size: "medium" },
  overview: { title: "Workspace summary", blurb: "Mail sent, domains and recent activity", size: "wide" },
  social: { title: "Social inbox", blurb: "Comments and messages assigned to you", size: "medium" },
  feeds: { title: "Feeds", blurb: "Latest runs from your page and feed watches", size: "medium" },
  dashboards: { title: "Dashboards", blurb: "Open a dashboard in one click", size: "medium" },
};

export const MAX_LINKS = 12;

/** http and https only; no credentials in the address. Checked again on the server for every save. */
export function isSafeLinkUrl(raw: string): boolean {
  if (raw.length > 500) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  return !!u.hostname;
}

export const QuickLink = z.object({
  id: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().trim().min(1, "Give the link a name").max(60),
  url: z.string().trim().max(500).refine(isSafeLinkUrl, "Use a web address that starts with http or https"),
});
export type QuickLink = z.infer<typeof QuickLink>;

export const LayoutItem = z.object({
  id: z.enum(WIDGET_IDS),
  size: z.enum(WIDGET_SIZES),
  hidden: z.boolean().optional(),
});
export type LayoutItem = z.infer<typeof LayoutItem>;

export const HomeLayout = z.object({
  v: z.literal(1).default(1),
  items: z.array(LayoutItem).max(WIDGET_IDS.length).refine((a) => new Set(a.map((i) => i.id)).size === a.length, "Each widget can appear once"),
  links: z.array(QuickLink).max(MAX_LINKS).default([]),
});
export type HomeLayout = z.infer<typeof HomeLayout>;

export type LayoutSource = "mine" | "workspace" | "builtin";
export interface HomeWidgetsView {
  layout: HomeLayout;
  source: LayoutSource;
  hasWorkspaceDefault: boolean;
  canSetDefault: boolean;
  available: WidgetId[];
}

/** What a first time person sees: their day first, the workspace overview last, the rest one click away. */
export function builtinLayout(): HomeLayout {
  const shown: WidgetId[] = ["tasks", "calendar", "inbox", "links", "overview"];
  return {
    v: 1,
    items: WIDGET_IDS.map((id) => ({ id, size: WIDGET_INFO[id].size, ...(shown.includes(id) ? {} : { hidden: true }) })),
    links: [],
  };
}

/**
 * Fit a stored layout to what this person can use now: unknown or unavailable widgets drop out, available ones
 * the layout does not name join at the end hidden, duplicates keep their first place. Never throws.
 */
export function normalizeLayout(input: unknown, available: readonly WidgetId[]): HomeLayout {
  const parsed = HomeLayout.safeParse(input);
  const base = parsed.success ? parsed.data : builtinLayout();
  const ok = new Set(available);
  const seen = new Set<WidgetId>();
  const items: LayoutItem[] = [];
  for (const it of base.items) {
    if (!ok.has(it.id) || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it.hidden ? { id: it.id, size: it.size, hidden: true } : { id: it.id, size: it.size });
  }
  for (const id of available) if (!seen.has(id)) items.push({ id, size: WIDGET_INFO[id].size, hidden: true });
  return { v: 1, items, links: base.links.slice(0, MAX_LINKS) };
}

/** Move one widget up or down by one place (keyboard and the phone sheet). Out of range is a no change. */
export function moveItem(items: LayoutItem[], id: WidgetId, by: -1 | 1): LayoutItem[] {
  const i = items.findIndex((x) => x.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= items.length) return items;
  const next = items.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
