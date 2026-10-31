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

export function availabilityOf(t: Toolkit): AppAvailability | null {
  const schemes = t.auth_schemes ?? [];
  if (t.no_auth || schemes.length === 0 || (schemes.length === 1 && schemes[0] === "NO_AUTH")) return null;
  if ((t.composio_managed_auth_schemes ?? []).length > 0 || schemes.includes("DCR_OAUTH")) return "ready";
  if (schemes.some((s) => s === "API_KEY" || s === "BEARER_TOKEN" || s === "BASIC")) return "key";
  return "soon";
}

function clean(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").replace(/[\u2013\u2014]/g, ",").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : max).replace(/[,.;:]$/, "") + "…";
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
      description: clean(t.meta?.description ?? "", 140),
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
  const by = (a: AppAvailability) => entries.filter((e) => e.availability === a).length;
  console.log(`apps ${entries.length}: ready ${by("ready")}, key ${by("key")}, soon ${by("soon")}`);
}

if (process.argv[1] && process.argv[1].endsWith("build-connections-catalog.ts")) await main();
