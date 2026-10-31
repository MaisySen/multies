/**
 * R87: link in bio pages. One for the workspace (admins edit it) and one per person. The brand colour and the avatar
 * address are copied onto the row when it is saved, so the public page is one keyed read by slug.
 */
import { inIds } from "../../lib/sql-chunks";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { linkBioPages, linkClicks, organizations, users } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { badRequest, conflict, forbidden } from "../../lib/errors";
import { getBrand } from "../../routes/branding";
import { BIO_ICONS, MAX_BIO_ITEMS, MAX_SOCIALS, RESERVED_SLUGS, SLUG_RE, SOCIALS, type BioIcon, type BioItem, type BioPageInfo, type BioSocial, type SocialKind } from "@/shared/links";
import { checkDestination, statsFor } from "./core";
import { forgetBio, type ResolvedBio } from "./public";
import { esc } from "../tools/p2-public";
import { BIO_ICON_PATHS } from "@/shared/link-icons";

export type BioScope = "workspace" | "me";
type Row = typeof linkBioPages.$inferSelect;

const appBase = (deps: Deps) => deps.config.appUrl.replace(/\/+$/, "");
const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 30);

async function rowFor(deps: Deps, auth: AuthContext, scope: BioScope): Promise<Row | undefined> {
  return deps.db.select().from(linkBioPages).where(and(eq(linkBioPages.orgId, auth.orgId), scope === "workspace" ? isNull(linkBioPages.userId) : eq(linkBioPages.userId, auth.userId))).get();
}

async function avatarChoices(deps: Deps, auth: AuthContext): Promise<{ logoUrl: string | null; photoUrl: string | null; brandColor: string | null }> {
  const [brand, me] = await Promise.all([getBrand(deps.db, auth.orgId), deps.db.select({ image: users.image }).from(users).where(eq(users.id, auth.userId)).get()]);
  const v = brand.logos.mark_light ?? brand.logos.mark_dark;
  const kind = brand.logos.mark_light ? "mark_light" : "mark_dark";
  const photo = me?.image && /^https:\/\//.test(me.image) ? me.image : null;
  return { logoUrl: v ? `${appBase(deps)}/api/branding/logo/${auth.orgId}/${kind}/${v}` : null, photoUrl: photo, brandColor: brand.primary ?? brand.accent ?? null };
}

function parseList<T>(s: string): T[] { try { const v = JSON.parse(s); return Array.isArray(v) ? v as T[] : []; } catch { return []; } }

export async function getBio(deps: Deps, auth: AuthContext, scope: BioScope): Promise<BioPageInfo> {
  const [row, choices] = await Promise.all([rowFor(deps, auth, scope), avatarChoices(deps, auth)]);
  const canEdit = scope === "me" || auth.role !== "member";
  if (!row) {
    const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, auth.orgId)).get();
    const base = scope === "workspace" ? slugify(org?.name ?? "") : slugify(auth.name || auth.email.split("@")[0]);
    const slug = SLUG_RE.test(base) ? base : `${base || "page"}${auth.userId.slice(-4).toLowerCase()}`.replace(/[^a-z0-9]/g, "").padEnd(3, "0");
    return {
      id: null, scope, slug, url: `${appBase(deps)}/bio/${slug}`, title: scope === "workspace" ? org?.name ?? "Our links" : auth.name || "My links",
      bio: "", avatar: scope === "workspace" ? "logo" : "photo", avatarUrl: null, theme: "brand", items: [], socials: [], published: false, views: 0, canEdit, ...choices,
    };
  }
  const items = parseList<BioItem>(row.items);
  const ids = items.map((i) => i.id).filter(Boolean).slice(0, MAX_BIO_ITEMS);
  const counts = ids.length
    ? await deps.db.select({ id: linkClicks.linkId, n: sql<number>`count(*)` }).from(linkClicks).where(and(eq(linkClicks.orgId, auth.orgId), inIds(linkClicks.linkId, ids))).groupBy(linkClicks.linkId)
    : [];
  const by = new Map(counts.map((c) => [c.id, Number(c.n)]));
  return {
    id: row.id, scope, slug: row.slug, url: `${appBase(deps)}/bio/${row.slug}`, title: row.title, bio: row.bio ?? "", avatar: row.avatar, avatarUrl: row.avatarUrl,
    theme: row.theme, brandColor: choices.brandColor, items: items.map((i) => ({ ...i, clicks: by.get(i.id) ?? 0 })), socials: parseList<BioSocial>(row.socials),
    published: row.published, views: row.views, canEdit, logoUrl: choices.logoUrl, photoUrl: choices.photoUrl,
  };
}

export interface BioInput {
  slug: string; title: string; bio?: string; avatar: "logo" | "photo" | "none"; theme: "brand" | "light" | "dark";
  items: { id?: string; title: string; url: string; icon?: string; on?: boolean }[]; socials: { kind: string; url: string }[]; published: boolean;
}

/** Bio buttons and socials may also be an email address or a phone number. */
function checkBioUrl(raw: string, appUrl: string, kind?: SocialKind): string {
  const s = raw.trim();
  if (kind === "email" || /^mailto:/i.test(s) || (!/^https?:/i.test(s) && /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(s))) {
    const addr = s.replace(/^mailto:/i, "");
    if (!/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(addr) || addr.length > 254) throw badRequest("That email address doesn't look right.");
    return `mailto:${addr}`;
  }
  if (/^tel:/i.test(s) || /^\+?[0-9 ()]{6,20}$/.test(s)) {
    const n = s.replace(/^tel:/i, "").replace(/[^0-9+]/g, "");
    if (n.length < 6 || n.length > 16) throw badRequest("That phone number doesn't look right.");
    return `tel:${n}`;
  }
  return checkDestination(s, appUrl);
}

export async function saveBio(deps: Deps, auth: AuthContext, scope: BioScope, input: BioInput): Promise<BioPageInfo> {
  if (scope === "workspace" && auth.role === "member") throw forbidden("Only admins can change the workspace page. You can make your own under My page.");
  const slug = String(input.slug ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw badRequest("Use 3 to 40 letters, numbers, _ or - for the page address.");
  if (RESERVED_SLUGS.has(slug)) throw conflict(`“${slug}” is kept for Multies. Try another address.`);
  const title = String(input.title ?? "").trim().slice(0, 80);
  if (!title) throw badRequest("Add a title for the page.");
  const bioText = String(input.bio ?? "").trim().slice(0, 280);
  if (!Array.isArray(input.items) || input.items.length > MAX_BIO_ITEMS) throw badRequest(`Use up to ${MAX_BIO_ITEMS} links.`);
  if (!Array.isArray(input.socials) || input.socials.length > MAX_SOCIALS) throw badRequest(`Use up to ${MAX_SOCIALS} profiles.`);
  const items: BioItem[] = input.items.map((i, n) => {
    const t = String(i.title ?? "").trim().slice(0, 80);
    if (!t) throw badRequest(`Link ${n + 1} needs a title.`);
    let url: string;
    try { url = checkBioUrl(String(i.url ?? ""), deps.config.appUrl); } catch (e) { throw badRequest(`Link ${n + 1}: ${(e as Error).message}`); }
    const icon = (BIO_ICONS as string[]).includes(String(i.icon)) ? (i.icon as BioIcon) : "link";
    const id = i.id && /^bi_[A-Za-z0-9_-]{6,40}$/.test(i.id) ? i.id : newId("bi");
    return { id, title: t, url, icon, on: i.on !== false };
  });
  const kinds = new Set(SOCIALS.map((s) => s.kind));
  const socials: BioSocial[] = input.socials.filter((s) => String(s.url ?? "").trim()).map((s) => {
    if (!kinds.has(s.kind as SocialKind)) throw badRequest("Pick a profile type from the list.");
    try { return { kind: s.kind as SocialKind, url: checkBioUrl(String(s.url), deps.config.appUrl, s.kind as SocialKind) }; } catch (e) { throw badRequest(`${SOCIALS.find((x) => x.kind === s.kind)?.label}: ${(e as Error).message}`); }
  });
  const choices = await avatarChoices(deps, auth);
  const avatar = ["logo", "photo", "none"].includes(input.avatar) ? input.avatar : "none";
  const avatarUrl = avatar === "logo" ? choices.logoUrl : avatar === "photo" ? choices.photoUrl : null;
  const theme = ["brand", "light", "dark"].includes(input.theme) ? input.theme : "brand";
  const now = deps.now();
  const existing = await rowFor(deps, auth, scope);
  const values = { slug, title, bio: bioText || null, avatar, avatarUrl, theme, brandColor: choices.brandColor, items: JSON.stringify(items), socials: JSON.stringify(socials), published: !!input.published, updatedAt: now };
  try {
    if (existing) await deps.db.update(linkBioPages).set(values).where(eq(linkBioPages.id, existing.id));
    else await deps.db.insert(linkBioPages).values({ id: newId("bio"), orgId: auth.orgId, userId: scope === "workspace" ? null : auth.userId, createdAt: now, views: 0, ...values });
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? ""))) throw conflict(`The address /bio/${slug} is taken. Try another.`);
    throw e;
  }
  if (existing && existing.slug !== slug) await forgetBio(existing.slug);
  await forgetBio(slug);
  return getBio(deps, auth, scope);
}

export async function bioStats(deps: Deps, auth: AuthContext, scope: BioScope, days: number) {
  const row = await rowFor(deps, auth, scope);
  const ids = row ? parseList<BioItem>(row.items).map((i) => i.id) : [];
  return statsFor(deps, auth.orgId, ids.length ? ids : ["none"], days);
}

const SOCIAL_LABEL: Record<string, string> = Object.fromEntries(SOCIALS.map((s) => [s.kind, s.label]));
const icon = (name: string, size = 20) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 256 256" fill="currentColor"><path d="${BIO_ICON_PATHS[name] ?? BIO_ICON_PATHS.link}"/></svg>`;

/** Readable text on a colour: WCAG relative luminance. */
export function inkOn(hex: string): "#ffffff" | "#111111" {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return (1.05) / (L + 0.05) >= (L + 0.05) / 0.05 ? "#ffffff" : "#111111";
}

/** The public page: no script, one column, big tap targets, the brand colour on the buttons. */
export function renderBio(b: ResolvedBio, base: string): string {
  const brand = b.brandColor && /^#[0-9a-f]{6}$/i.test(b.brandColor) ? b.brandColor : "#0066cc";
  const ink = inkOn(brand);
  const scheme = b.theme === "dark" ? "dark" : b.theme === "light" ? "light" : "light dark";
  const initials = b.title.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
  const avatar = b.avatar !== "none" && b.avatarUrl
    ? `<img class="av" src="${esc(b.avatarUrl)}" alt="" width="96" height="96">`
    : b.avatar !== "none" ? `<div class="av ini" aria-hidden="true">${esc(initials)}</div>` : "";
  const items = b.items.filter((i) => i.on).map((i) => `<li><a class="btn" href="${esc(base)}/bio/${esc(b.slug)}/go/${esc(i.id)}" rel="noopener">${icon(i.icon)}<span>${esc(i.title)}</span></a></li>`).join("");
  const socials = b.socials.map((s) => `<li><a href="${esc(s.url)}" rel="noopener me" aria-label="${esc(SOCIAL_LABEL[s.kind] ?? s.kind)}" title="${esc(SOCIAL_LABEL[s.kind] ?? s.kind)}">${icon(s.kind, 24)}</a></li>`).join("");
  const dark = `--bg:#0c0c0d;--fg:#f5f5f7;--muted:#a1a1a6;--card:#1c1c1e;--line:#38383a`;
  const light = `--bg:#f5f5f7;--fg:#1d1d1f;--muted:#6e6e73;--card:#ffffff;--line:#d2d2d7`;
  const css = `:root{color-scheme:${scheme};${b.theme === "dark" ? dark : light};--brand:${brand};--ink:${ink}}
${b.theme === "brand" ? `@media (prefers-color-scheme:dark){:root{${dark}}}` : ""}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:560px;margin:0 auto;padding:48px 20px 40px;text-align:center}
.av{width:96px;height:96px;border-radius:50%;object-fit:cover;display:block;margin:0 auto 16px;background:var(--card);border:1px solid var(--line)}
.ini{display:grid;place-items:center;font-weight:600;font-size:32px;color:var(--ink);background:var(--brand);border:0}
h1{font-size:24px;line-height:1.25;margin:0 0 8px;letter-spacing:-.01em;word-break:break-word}
.bio{color:var(--muted);margin:0 auto 24px;max-width:440px;white-space:pre-line;word-break:break-word}
ul{list-style:none;margin:0;padding:0}
.links li{margin:0 0 12px}
.btn{display:flex;align-items:center;gap:12px;min-height:56px;padding:14px 20px;border-radius:14px;background:var(--brand);color:var(--ink);text-decoration:none;font-weight:600;transition:transform .15s ease,opacity .15s ease}
.btn span{flex:1;text-align:center;margin-right:20px;word-break:break-word}
.btn:hover{opacity:.92}.btn:active{transform:scale(.99)}
a:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.soc{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin:24px 0 0}
.soc a{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;color:var(--fg);text-decoration:none}
.soc a:hover{background:var(--card)}
footer{margin-top:40px;font-size:13px;color:var(--muted)}footer a{color:var(--muted)}
.empty{color:var(--muted);border:1px dashed var(--line);border-radius:14px;padding:20px}
@media (prefers-reduced-motion:reduce){.btn{transition:none}}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(b.title)}</title>
<meta name="description" content="${esc((b.bio ?? b.title).slice(0, 160))}"><meta property="og:title" content="${esc(b.title)}"><meta property="og:description" content="${esc((b.bio ?? "").slice(0, 160))}">${b.avatarUrl ? `<meta property="og:image" content="${esc(b.avatarUrl)}">` : ""}
<meta name="theme-color" content="${esc(brand)}"><style>${css}</style></head><body><main>
${avatar}<h1>${esc(b.title)}</h1>${b.bio ? `<p class="bio">${esc(b.bio)}</p>` : ""}
${items ? `<ul class="links">${items}</ul>` : `<p class="empty">No links here yet.</p>`}
${socials ? `<ul class="soc">${socials}</ul>` : ""}
<footer>Made with <a href="${esc(base)}/" rel="noopener">Multies</a></footer>
</main></body></html>`;
}
