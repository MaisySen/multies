/**
 * ANALYTICS-PH: product usage analytics for the Fintex team (internal only, behind ANALYTICS_PH, off by default).
 *
 * Privacy rules this file enforces for both the browser and the server:
 * - only the events below are ever sent (a fixed allow list), each with a few short enum properties;
 * - never any message, doc, file, form or email content, never names or email addresses, never full URLs;
 * - ids are keyed hashes made on the server (the key never reaches the browser);
 * - Do Not Track and Global Privacy Control turn it off;
 * - the client workspace listed in ANALYTICS_EXCLUDE (vv8k by default) never sends anything.
 */

/** Rail areas, by the first path segment after /app. Anything else is reported as "other". */
export const ANALYTICS_AREAS = [
  "mail", "inbox", "triage", "mailboxes", "domains", "deliverability", "tasks", "my-work", "docs", "files", "chat",
  "meetings", "contacts", "deals", "social", "dashboards", "reports", "goals", "time", "portfolio", "scheduling",
  "forms", "approvals", "automations", "agents", "templates", "activity", "notifications", "tools", "settings", "admin",
  "home", "search", "maps", "calendar",
] as const;

/** Tools by the segment after /app/tools. Anything else is reported as "other". */
export const ANALYTICS_TOOLS = [
  "ai", "convert", "edit-pdf", "links", "merge", "pdf-codes", "pdf-comments", "pdf-fix", "share", "sign", "templates",
  "utilities", "workflows",
] as const;

/** Key actions, recorded by the server when the matching request succeeds (see services/product-analytics.ts). */
export const ANALYTICS_ACTIONS = [
  "mail_sent", "task_created", "doc_created", "social_post_created", "invite_sent", "upgrade_started",
  "upgrade_completed", "mail_account_connected", "social_connect_started",
] as const;

/** The only events the browser may send. */
export const ANALYTICS_CLIENT_EVENTS = ["area_opened"] as const;

export type AnalyticsArea = (typeof ANALYTICS_AREAS)[number] | "other";
export type AnalyticsAction = (typeof ANALYTICS_ACTIONS)[number];
export type AnalyticsEventName = AnalyticsAction | (typeof ANALYTICS_CLIENT_EVENTS)[number];

/** Allowed property names and their allowed values; nothing else survives sanitizeProps. */
const SAFE_VALUE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ANALYTICS_PROP_KEYS = ["area", "tool", "plan", "source", "provider"] as const;

/** The area and tool for an app path. Only names from the lists above; ids and the rest of the path are dropped. */
export function areaFromPath(path: string): { area: AnalyticsArea; tool?: string } | null {
  const m = /^\/app(?:\/([^/?#]*))?(?:\/([^/?#]*))?/.exec(path || "");
  if (!m) return null;
  const first = (m[1] || "home").toLowerCase();
  const area = (ANALYTICS_AREAS as readonly string[]).includes(first) ? (first as AnalyticsArea) : "other";
  if (area !== "tools") return { area };
  const second = (m[2] || "").toLowerCase();
  if (!second) return { area };
  return { area, tool: (ANALYTICS_TOOLS as readonly string[]).includes(second) ? second : "other" };
}

export function isAnalyticsEvent(name: unknown): name is AnalyticsEventName {
  return typeof name === "string" && ((ANALYTICS_ACTIONS as readonly string[]).includes(name) || (ANALYTICS_CLIENT_EVENTS as readonly string[]).includes(name));
}

/** Keeps only allowed keys with short lower case enum values. */
export function sanitizeProps(props: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!props) return out;
  for (const k of ANALYTICS_PROP_KEYS) {
    const v = props[k];
    if (typeof v === "string" && SAFE_VALUE.test(v)) out[k] = v;
  }
  if (out.area && !(ANALYTICS_AREAS as readonly string[]).includes(out.area)) out.area = "other";
  if (out.tool && !(ANALYTICS_TOOLS as readonly string[]).includes(out.tool)) out.tool = "other";
  return out;
}

/** True when the browser asks not to be tracked (Do Not Track or Global Privacy Control). */
export function browserOptedOut(nav: { doNotTrack?: string | null; globalPrivacyControl?: boolean } | undefined, win?: { doNotTrack?: string | null }): boolean {
  const v = (x: unknown) => x === "1" || x === "yes" || x === true;
  return !!nav && (v(nav.doNotTrack) || v(nav.globalPrivacyControl) || v(win?.doNotTrack));
}
