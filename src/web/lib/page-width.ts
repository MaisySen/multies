/**
 * R75: how wide a page's content runs next to the sidebar.
 * - full: data views (task views, dashboards, reports, tables, chat) use all the room next to the sidebar.
 * - wide: lists and card grids fill the room up to 1600 px, so a 4K screen does not stretch a card to a banner.
 * - reading: settings, forms and single item pages keep a comfortable line length (1120 px), aligned left.
 * Every width starts right next to the sidebar (no centring in an empty gutter), with the same side padding.
 */
export type PageWidth = "full" | "wide" | "reading";

const FULL = [
  /^\/app\/(tasks|dashboards|reports|portfolio|time|triage|chat|inbox|deals|contacts|my-work|goals|meetings|automations|forms|templates)(\/|$)/,
  /^\/app\/?$/,
];
const READING = [
  /^\/app\/settings(\/|$)/,
  /^\/app\/(docs|contacts|meetings|domains|agents)\/[^/]+$/,
  /^\/app\/(integrations|deliverability|notifications|activity|approvals|admin|scheduling|mailboxes|domains|agents)(\/|$)/,
];
/** Tools editors and docs pages that are themselves wide surfaces stay full even under a reading prefix. */
const FULL_EXCEPTIONS = [/^\/app\/tools\/(pages|forms|compare|merge|workflows|sign)$/, /^\/app\/meetings\/[^/]+$/];

export function pageWidth(pathname: string): PageWidth {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (FULL_EXCEPTIONS.some((r) => r.test(p))) return "full";
  if (READING.some((r) => r.test(p))) return "reading";
  if (FULL.some((r) => r.test(p))) return "full";
  return "wide";
}

export const PAGE_WIDTH_CLASS: Record<PageWidth, string> = {
  full: "max-w-none",
  wide: "max-w-[1600px]",
  reading: "max-w-[1120px]",
};

/** The page frame: the same side padding on every page (16 px phone, 24 px tablet, 32 px desktop), on the 8 px grid. */
export const pageFrameClass = (pathname: string) => `route-in w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-8 ${PAGE_WIDTH_CLASS[pageWidth(pathname)]}`;
