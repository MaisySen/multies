/**
 * R77: workspace branding and personal themes. Pure functions shared by the API (validation) and the web app
 * (design tokens). A brand is a few choices; everything the UI paints is derived here so every colour pair
 * stays readable (WCAG AA, 4.5:1 for text) whatever colour a workspace picks.
 */
import { z } from "zod";

export const HEX = /^#[0-9a-fA-F]{6}$/;
export type Radius = "sharp" | "default" | "round";
export type Density = "comfortable" | "compact";
export type FontId = "system" | "humanist" | "geometric" | "rounded" | "serif" | "mono";
export type Appearance = "system" | "light" | "dark";
export type LogoKind = "mark_light" | "mark_dark" | "wide_light" | "wide_dark";
export const LOGO_KINDS: LogoKind[] = ["mark_light", "mark_dark", "wide_light", "wide_dark"];
/** Logos are small images kept with the workspace (the same storage as attachments): 512 KB each at most. */
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export interface Brand {
  primary: string | null;
  accent: string | null;
  sidebar: string | null;
  radius: Radius;
  density: Density;
  font: FontId;
  appearance: Appearance;
  /** Members cannot pick their own accent while this is on. */
  locked: boolean;
  preset: string | null;
  /** Logo versions (a short hash per kind) so a logo URL changes when the image does. */
  logos: Partial<Record<LogoKind, string>>;
}

export const DEFAULT_BRAND: Brand = { primary: null, accent: null, sidebar: null, radius: "default", density: "comfortable", font: "system", appearance: "system", locked: false, preset: null, logos: {} };

/** Multies' own colours, the base every derived token starts from. */
export const BASE = { light: { brand: "#0066cc", surface: "#ffffff", bg: "#f5f5f7", fg: "#1d1d1f" }, dark: { brand: "#0071e3", surface: "#161618", bg: "#0c0c0d", fg: "#f5f5f7" } } as const;

/** The neutral tokens for each scheme (index.css), so a preview can show dark while the app is light. */
export const NEUTRALS: Record<"light" | "dark", Tokens> = {
  light: { "--color-bg": "#f5f5f7", "--color-surface": "#ffffff", "--color-elevated": "#ffffff", "--color-hover": "#ebebef", "--color-fill": "#e8e8ed", "--color-line": "rgb(0 0 0 / 0.09)", "--color-line-strong": "rgb(0 0 0 / 0.16)", "--color-fg": "#1d1d1f", "--color-muted": "#5a5a5f", "--color-subtle": "#606065", "--color-glass-sidebar": "rgb(245 245 247 / 0.78)", "--color-brand": "#0066cc", "--color-brand-hover": "#0058b0", "--color-brand-soft": "rgb(0 102 204 / 0.1)", "--color-brand-fg": "#ffffff", "--color-accent": "#0066cc", "--color-accent-fg": "#ffffff" },
  dark: { "--color-bg": "#0c0c0d", "--color-surface": "#161618", "--color-elevated": "#1f1f22", "--color-hover": "#2a2a2d", "--color-fill": "#2c2c2f", "--color-line": "rgb(255 255 255 / 0.09)", "--color-line-strong": "rgb(255 255 255 / 0.16)", "--color-fg": "#f5f5f7", "--color-muted": "#aeaeb2", "--color-subtle": "#9a9a9f", "--color-glass-sidebar": "rgb(18 18 20 / 0.78)", "--color-brand": "#0071e3", "--color-brand-hover": "#5ea4ff", "--color-brand-soft": "rgb(10 132 255 / 0.16)", "--color-brand-fg": "#ffffff", "--color-accent": "#0071e3", "--color-accent-fg": "#ffffff" },
};

/** Every token for one scheme, for a scoped live preview (style attribute on the preview root). */
export function previewTokens(b: Brand, scheme: "light" | "dark", personal: Personal | null = null): { root: Tokens; sidebar: Tokens } {
  const { primary, accent } = effectiveColours(b, personal);
  return { root: { ...NEUTRALS[scheme], ...shapeTokens(b), ...colourTokens(primary, accent, scheme) }, sidebar: sidebarTokens(b.sidebar) };
}

export const FONTS: { id: FontId; label: string; stack: string }[] = [
  { id: "system", label: "System", stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI Variable Text", "Segoe UI", Roboto, Inter, system-ui, sans-serif` },
  { id: "humanist", label: "Humanist", stack: `Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif` },
  { id: "geometric", label: "Geometric", stack: `Avenir, "Avenir Next LT Pro", Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif` },
  { id: "rounded", label: "Rounded", stack: `ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT", Calibri, source-sans-pro, sans-serif` },
  { id: "serif", label: "Serif", stack: `Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif` },
  { id: "mono", label: "Mono", stack: `ui-monospace, "SF Mono", "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace` },
];

export interface Preset { id: string; name: string; primary: string; accent: string; sidebar: string | null }
/** Ready made themes. Each primary passes AA as a button colour with its own text colour. */
export const PRESETS: Preset[] = [
  { id: "multies", name: "Multies", primary: "#0066cc", accent: "#0066cc", sidebar: null },
  { id: "ocean", name: "Ocean", primary: "#0e7490", accent: "#06b6d4", sidebar: null },
  { id: "forest", name: "Forest", primary: "#15803d", accent: "#65a30d", sidebar: null },
  { id: "indigo", name: "Indigo", primary: "#4f46e5", accent: "#8b5cf6", sidebar: null },
  { id: "berry", name: "Berry", primary: "#be185d", accent: "#db2777", sidebar: null },
  { id: "sunset", name: "Sunset", primary: "#c2410c", accent: "#f59e0b", sidebar: null },
  { id: "graphite", name: "Graphite", primary: "#3f3f46", accent: "#71717a", sidebar: null },
  { id: "midnight", name: "Midnight", primary: "#2563eb", accent: "#38bdf8", sidebar: "#0f172a" },
  { id: "aubergine", name: "Aubergine", primary: "#7e22ce", accent: "#c084fc", sidebar: "#3b0764" },
  { id: "evergreen", name: "Evergreen", primary: "#047857", accent: "#10b981", sidebar: "#052e2b" },
  { id: "gold", name: "Gold", primary: "#a16207", accent: "#eab308", sidebar: null },
  { id: "crimson", name: "Crimson", primary: "#b91c1c", accent: "#f43f5e", sidebar: "#1c1917" },
];

const hex = z.string().trim().regex(HEX, "Pick a colour as #rrggbb.").transform((s) => s.toLowerCase());
export const BrandPatchSchema = z.object({
  primary: hex.nullable().optional(),
  accent: hex.nullable().optional(),
  sidebar: hex.nullable().optional(),
  radius: z.enum(["sharp", "default", "round"]).optional(),
  density: z.enum(["comfortable", "compact"]).optional(),
  font: z.enum(["system", "humanist", "geometric", "rounded", "serif", "mono"]).optional(),
  appearance: z.enum(["system", "light", "dark"]).optional(),
  locked: z.boolean().optional(),
  preset: z.string().trim().max(32).nullable().optional(),
}).strict();
export type BrandPatch = z.infer<typeof BrandPatchSchema>;

export const PersonalSchema = z.object({ followBrand: z.boolean(), accent: hex.nullable() }).strict();
export type Personal = z.infer<typeof PersonalSchema>;
export const DEFAULT_PERSONAL: Personal = { followBrand: true, accent: null };

/** A stored JSON brand, read leniently: anything unknown or invalid falls back to the default. */
export function readBrand(json: string | null | undefined, logos: Partial<Record<LogoKind, string>> = {}): Brand {
  let raw: unknown;
  try { raw = json ? JSON.parse(json) : null; } catch { raw = null; }
  const p = BrandPatchSchema.safeParse(raw && typeof raw === "object" ? raw : {});
  return { ...DEFAULT_BRAND, ...(p.success ? stripUndef(p.data) : {}), logos };
}
function stripUndef<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ------------------------------------------------------------------ colour maths (sRGB, WCAG 2.x)

type RGB = [number, number, number];
export function toRgb(h: string): RGB {
  const s = h.replace("#", "");
  const n = parseInt(s.length === 3 ? s.split("").map((c) => c + c).join("") : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function toHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
export function luminance(h: string): number {
  const [r, g, b] = toRgb(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
/** Mixes a towards b by t (0..1). */
export function mix(a: string, b: string, t: number): string {
  const [p, q] = [toRgb(a), toRgb(b)];
  return toHex([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
}
/** White or near black, whichever reads better on bg. */
export function readableOn(bg: string): string {
  return contrast(bg, "#ffffff") >= contrast(bg, "#111113") ? "#ffffff" : "#111113";
}
/** Moves colour towards black (on a light ground) or white (on a dark one) until it reaches ratio against ground. */
export function ensureContrast(color: string, ground: string, ratio = 4.5): string {
  if (contrast(color, ground) >= ratio) return color;
  const towards = luminance(ground) > 0.4 ? "#000000" : "#ffffff";
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(color, towards, t);
    if (contrast(c, ground) >= ratio) return c;
  }
  return towards;
}
const rgbList = (h: string) => toRgb(h).join(" ");

export interface ContrastCheck { id: string; label: string; ratio: number; ok: boolean; fixed: boolean }
/** The colour pairs a brand creates, before any adjustment, for the settings page warning. */
export function checkBrand(b: Pick<Brand, "primary" | "accent" | "sidebar">): ContrastCheck[] {
  const out: ContrastCheck[] = [];
  const p = b.primary ?? BASE.light.brand;
  const fg = readableOn(p);
  const r1 = contrast(p, fg);
  out.push({ id: "button", label: "Button text", ratio: r1, ok: r1 >= 4.5, fixed: r1 < 4.5 });
  const r2 = contrast(p, BASE.light.surface);
  out.push({ id: "link-light", label: "Links in light mode", ratio: r2, ok: r2 >= 4.5, fixed: r2 < 4.5 });
  const r3 = contrast(p, BASE.dark.surface);
  out.push({ id: "link-dark", label: "Links in dark mode", ratio: r3, ok: r3 >= 4.5, fixed: r3 < 4.5 });
  if (b.sidebar) {
    const r4 = contrast(b.sidebar, readableOn(b.sidebar));
    out.push({ id: "sidebar", label: "Sidebar text", ratio: r4, ok: r4 >= 4.5, fixed: r4 < 4.5 });
  }
  return out;
}

const RADIUS_SCALE: Record<Radius, number> = { sharp: 0.4, default: 1, round: 1.5 };
const RADII: [string, number][] = [["--radius-sm", 6], ["--radius-md", 8], ["--radius-lg", 10], ["--radius-xl", 14], ["--radius-2xl", 16], ["--radius-r10", 10], ["--radius-r14", 14], ["--radius-r20", 20]];

export type Tokens = Record<string, string>;

/** Brand colour tokens for one scheme. Null means Multies' own colours (nothing to override). */
export function colourTokens(primary: string | null, accent: string | null, scheme: "light" | "dark"): Tokens {
  if (!primary && !accent) return {};
  const base = BASE[scheme];
  const p = primary ?? base.brand;
  const a = accent ?? p;
  const t: Tokens = {};
  // A filled button: the brand colour, darkened only if no text colour can reach AA on it.
  let fill = p;
  if (contrast(fill, readableOn(fill)) < 4.5) fill = ensureContrast(fill, readableOn(fill), 4.5);
  t["--color-brand"] = fill;
  t["--color-brand-fg"] = readableOn(fill);
  // brand-hover doubles as the brand coloured text colour (links, active labels): AA against the surface.
  const textish = scheme === "light" ? mix(p, "#000000", 0.12) : mix(p, "#ffffff", 0.28);
  t["--color-brand-hover"] = ensureContrast(ensureContrast(textish, base.surface, 4.5), base.bg, 4.5);
  t["--color-brand-soft"] = `rgb(${rgbList(a)} / ${scheme === "light" ? 0.12 : 0.18})`;
  t["--color-accent"] = a;
  t["--color-accent-fg"] = readableOn(a);
  return t;
}

/** Sidebar tokens: the sidebar paints its own ground and the text colours inside it follow. */
export function sidebarTokens(sidebar: string | null): Tokens {
  if (!sidebar) return {};
  const fg = readableOn(sidebar);
  const dark = fg === "#ffffff";
  return {
    "--color-glass-sidebar": sidebar,
    "--color-fg": fg,
    "--color-muted": ensureContrast(mix(fg, sidebar, 0.3), sidebar, 4.5),
    "--color-subtle": ensureContrast(mix(fg, sidebar, 0.38), sidebar, 4.5),
    "--color-hover": mix(sidebar, dark ? "#ffffff" : "#000000", 0.1),
    "--color-fill": mix(sidebar, dark ? "#ffffff" : "#000000", 0.14),
    "--color-line": dark ? "rgb(255 255 255 / 0.12)" : "rgb(0 0 0 / 0.1)",
    "--color-brand-soft": dark ? "rgb(255 255 255 / 0.14)" : "rgb(0 0 0 / 0.08)",
    // Menus that open inside the sidebar keep readable text on a ground of the same family.
    "--color-surface": mix(sidebar, fg, 0.05),
    "--color-elevated": mix(sidebar, fg, 0.08),
  };
}

/** Tokens that do not depend on light or dark. */
export function shapeTokens(b: Pick<Brand, "radius" | "density" | "font">): Tokens {
  const t: Tokens = {};
  if (b.radius !== "default") for (const [k, px] of RADII) t[k] = `${Math.round(px * RADIUS_SCALE[b.radius])}px`;
  if (b.density === "compact") t["--spacing"] = "0.21rem";
  if (b.font !== "system") t["--font-sans"] = FONTS.find((f) => f.id === b.font)?.stack ?? FONTS[0].stack;
  return t;
}

/** The effective colours: a person's own accent replaces the workspace colours unless the brand is locked. */
export function effectiveColours(b: Brand, personal: Personal | null): { primary: string | null; accent: string | null } {
  if (personal && !personal.followBrand && personal.accent && !b.locked) return { primary: personal.accent, accent: personal.accent };
  return { primary: b.primary, accent: b.accent };
}

const block = (sel: string, t: Tokens) => {
  const body = Object.entries(t).map(([k, v]) => `${k}:${v}`).join(";");
  return body ? `${sel}{${body}}` : "";
};

/**
 * The stylesheet for a brand: light tokens on :root, dark tokens for an explicit dark choice and for the
 * system setting, and the sidebar block. Values come only from validated hex colours and fixed tables, so the
 * output cannot carry anything but CSS custom properties.
 */
export function brandCss(b: Brand, personal: Personal | null = null): string {
  const { primary, accent } = effectiveColours(b, personal);
  const shape = shapeTokens(b);
  const light = { ...shape, ...colourTokens(primary, accent, "light") };
  const dark = colourTokens(primary, accent, "dark");
  const side = sidebarTokens(b.sidebar);
  return [
    block(":root", light),
    block(':root[data-theme="dark"]', dark),
    Object.keys(dark).length ? `@media (prefers-color-scheme:dark){${block(':root:not([data-theme="light"])', dark)}}` : "",
    block(".glass-sidebar,[data-brand-sidebar]", side),
    // Text that inherits its colour (no text class of its own) follows the sidebar too.
    b.sidebar ? `.glass-sidebar,[data-brand-sidebar]{color:${readableOn(b.sidebar)}}` : "",
  ].join("");
}

/** Is this brand Multies' own look (nothing to apply)? */
export function isDefaultBrand(b: Brand): boolean {
  return !b.primary && !b.accent && !b.sidebar && b.radius === "default" && b.density === "comfortable" && b.font === "system" && b.appearance === "system" && !Object.keys(b.logos).length;
}

/** The logo URL for a workspace (public, cached for good: the version changes with the image). */
export function logoUrl(orgId: string, kind: LogoKind, version: string): string {
  return `/api/branding/logo/${encodeURIComponent(orgId)}/${kind}/${version}`;
}

/** The best logo for a scheme: the variant for that scheme, then the other one. */
export function pickLogo(b: Brand, shape: "mark" | "wide", scheme: "light" | "dark"): LogoKind | null {
  const order: LogoKind[] = shape === "mark"
    ? (scheme === "dark" ? ["mark_dark", "mark_light"] : ["mark_light", "mark_dark"])
    : (scheme === "dark" ? ["wide_dark", "wide_light"] : ["wide_light", "wide_dark"]);
  return order.find((k) => b.logos[k]) ?? null;
}

/** The logo variant for a place: on a coloured sidebar the sidebar's own lightness decides, elsewhere the scheme. */
export function logoScheme(b: Pick<Brand, "sidebar">, scheme: "light" | "dark", onSidebar = false): "light" | "dark" {
  if (onSidebar && b.sidebar) return readableOn(b.sidebar) === "#ffffff" ? "dark" : "light";
  return scheme;
}

/** Sniffs the real image type from the first bytes (the browser's word is not trusted). */
export function sniffImage(bytes: Uint8Array): (typeof LOGO_TYPES)[number] | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/**
 * "Use my logo colours": the most common saturated colours in an image's pixels (RGBA bytes), most used first.
 * Near white, near black and transparent pixels are skipped; similar colours are bucketed together.
 */
export function paletteFromPixels(data: ArrayLike<number>, max = 5): string[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 160) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 28 || mn > 232 || mx - mn < 24) continue; // greys
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    buckets.set(key, e);
  }
  return [...buckets.values()].sort((x, y) => y.n - x.n).slice(0, max).map((e) => toHex([e.r / e.n, e.g / e.n, e.b / e.n]));
}
