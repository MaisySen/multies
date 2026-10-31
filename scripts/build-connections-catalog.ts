/**
 * R80C: builds the Connections catalog the web app shows (src/shared/connections-catalog.json) from the
 * integration platform's toolkit list. Run when the platform adds apps:
 *   node scripts/creds.mjs run COMPOSIO_API_KEY -- npx tsx scripts/build-connections-catalog.ts
 * The key comes from the environment only; the output holds no secret and no vendor address.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { APP_NAME_OVERRIDES, SOCIAL_FIRST, canPostTo, groupFor, type AppAvailability, type AppGroup } from "../src/shared/integrations";

interface Toolkit { slug: string; name: string; meta?: { description?: string; categories?: { name?: string }[] }; auth_schemes?: string[]; composio_managed_auth_schemes?: string[]; no_auth?: boolean; is_local_toolkit?: boolean }

export interface CatalogEntry { slug: string; name: string; description: string; group: AppGroup; availability: AppAvailability; canPost: boolean; rank: number }

/** R83: our own TikTok and Threads connectors (src/server/services/direct-social) make these two ready on every host. */
export const OWN_CONNECTORS = ["tiktok", "threads"] as const;

export function availabilityOf(t: Toolkit): AppAvailability | null {
  if ((OWN_CONNECTORS as readonly string[]).includes(t.slug)) return "ready";
  const schemes = t.auth_schemes ?? [];
  if (t.no_auth || schemes.length === 0 || (schemes.length === 1 && schemes[0] === "NO_AUTH")) return null;
  if ((t.composio_managed_auth_schemes ?? []).length > 0 || schemes.includes("DCR_OAUTH")) return "ready";
  if (schemes.some((s) => s === "API_KEY" || s === "BEARER_TOKEN" || s === "BASIC")) return "key";
  return "soon";
}

/**
 * R82F (MB-284): our own short lines for the apps people look for first, instead of the platform's raw marketing text
 * (which had a doubled "named for named for" on X and cut off mid sentence).
 */
export const DESCRIPTIONS: Record<string, string> = {
  facebook: "Post to your Facebook Pages and see how each post went.",
  instagram: "Share photos and posts to Instagram business and creator accounts.",
  linkedin: "Post updates to your LinkedIn profile or company page.",
  twitter: "Post to X and keep an eye on replies.",
  youtube: "Manage your channel, videos and playlists on YouTube.",
  tiktok: "Share short videos to your TikTok account.",
  pinterest: "Pin images to your boards and find ideas on Pinterest.",
  threads: "Publish posts and replies on Threads.",
  reddit: "Post to communities and follow discussions on Reddit.",
  google_business_profile: "Keep your business listing, reviews and posts on Google up to date.",
  telegram: "Send messages to your chats and channels through your own bot.",
  discord: "Send messages and updates to your Discord server.",
  whatsapp: "Message customers from your WhatsApp Business number.",
  snapchat: "Share photos and videos to Snapchat.",
  gmail: "Read, send and sort mail in your Gmail account.",
  github: "Work with repositories, issues and pull requests on GitHub.",
  googlecalendar: "See and create events in Google Calendar.",
  notion: "Read and update pages and databases in Notion.",
  googlesheets: "Read and write rows in Google Sheets.",
  slack: "Post messages and read channels in Slack.",
  outlook: "Read and send mail and manage events in Outlook.",
  googledrive: "Find, upload and share files in Google Drive.",
  googledocs: "Create and edit documents in Google Docs.",
  hubspot: "Work with contacts, companies and deals in HubSpot.",
  airtable: "Read and update records in your Airtable bases.",
  jira: "Create and update issues in Jira.",
  googletasks: "See and add tasks in Google Tasks.",
  figma: "Open files and read comments in Figma.",
  microsoft_teams: "Post messages to channels and chats in Microsoft Teams.",
};

/** Tidies a platform description: one line, no long dashes, no doubled words, a whole first sentence when it fits. */
export function tidyDescription(s: string, max = 140): string {
  let t = s.replace(/\s+/g, " ").replace(/[\u2013\u2014]/g, ",").replace(/\s[+-]\s/g, ", ").trim();
  // "named for named for", "the the": a phrase of up to three words said twice in a row.
  t = t.replace(/\b((?:[\p{L}\p{N}']+\s){0,2}[\p{L}\p{N}']+)\s+\1\b/giu, "$1");
  t = t.replace(/…$/, "").replace(/\s+$/, "");
  const first = t.match(/^(.{30,}?[.!?])(\s|$)/u)?.[1];
  if (first && first.length <= max) return first;
  if (t.length <= max && !/…$/.test(s)) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : max).replace(/[,.;:]$/, "") + "…";
}

const clean = (s: string, max: number) => tidyDescription(s, max);

/**
 * R82F (MB-280): the first screen of Connections loads only this short list (the social networks, then the most used
 * apps that connect in one step), and the whole catalog follows when you search, filter or scroll. Same order as the
 * full list, so the first page looks the same either way.
 */
export function topEntries<T extends { slug: string; availability: AppAvailability }>(all: T[], n = 72): T[] {
  const social = all.filter((e) => (SOCIAL_FIRST as readonly string[]).includes(e.slug));
  const rest = all.filter((e) => !(SOCIAL_FIRST as readonly string[]).includes(e.slug) && e.availability === "ready").slice(0, n);
  return [...social, ...rest];
}

export function toEntries(items: Toolkit[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  items.forEach((t, i) => {
    if (t.is_local_toolkit) return;
    const availability = availabilityOf(t);
    if (!availability) return;
    const cats = (t.meta?.categories ?? []).map((c) => c.name ?? "").filter(Boolean);
    const social = (SOCIAL_FIRST as readonly string[]).indexOf(t.slug);
    out.push({
      slug: t.slug,
      name: APP_NAME_OVERRIDES[t.slug] ?? t.name,
      description: DESCRIPTIONS[t.slug] ?? clean(t.meta?.description ?? "", 140),
      group: social >= 0 ? "social" : groupFor(cats),
      availability,
      canPost: canPostTo(t.slug),
      // The platform lists by popularity; social networks we lead with come first.
      rank: social >= 0 ? social : 100 + i,
    });
  });
  return out.sort((a, b) => a.rank - b.rank);
}

async function main() {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new Error("COMPOSIO_API_KEY is not set");
  const items: Toolkit[] = [];
  let cursor = "";
  for (let p = 0; p < 5; p++) {
    const u = new URL("https://backend.composio.dev/api/v3/toolkits");
    u.searchParams.set("limit", "1000");
    if (cursor) u.searchParams.set("cursor", cursor);
    const r = await fetch(u, { headers: { "x-api-key": key } });
    if (!r.ok) throw new Error(`toolkits ${r.status}`);
    const j = (await r.json()) as { items: Toolkit[]; next_cursor?: string };
    items.push(...j.items);
    cursor = j.next_cursor ?? "";
    if (!cursor || !j.items.length) break;
  }
  const entries = toEntries(items);
  const file = path.resolve(import.meta.dirname, "../src/shared/connections-catalog.json");
  writeFileSync(file, JSON.stringify({ builtAt: new Date().toISOString().slice(0, 10), apps: entries.map(({ rank: _r, ...e }) => e) }) + "\n");
  const top = topEntries(entries);
  writeFileSync(file.replace(/\.json$/, "-top.json"), JSON.stringify({ builtAt: new Date().toISOString().slice(0, 10), total: entries.length, apps: top.map(({ rank: _r, ...e }) => e) }) + "\n");
  const by = (a: AppAvailability) => entries.filter((e) => e.availability === a).length;
  console.log(`apps ${entries.length}: ready ${by("ready")}, key ${by("key")}, soon ${by("soon")}`);
}

if (process.argv[1] && process.argv[1].endsWith("build-connections-catalog.ts")) await main();
