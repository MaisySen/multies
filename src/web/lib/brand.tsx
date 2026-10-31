/**
 * R77: the workspace brand in the web app. The tokens are a small stylesheet of CSS custom properties; a copy
 * per workspace is kept in local storage so the inline boot script in index.html paints it before React runs
 * (no flash of the default look), then the live brand replaces it once /api/branding answers.
 */
import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { useAppearance } from "@/web/components/theme";
import { cn } from "@/web/lib/cn";
import { logoUrl, logoScheme, pickLogo, type Appearance, type Brand, type ContrastCheck, type Personal } from "@/shared/branding";

export interface BrandingData { orgId: string; brand: Brand; personal: Personal; canEdit: boolean; css: string; checks: ContrastCheck[] }

/** Local storage: the brand in use (read by the boot script) and a copy per workspace. */
export const BRAND_KEY = "multies-brand";
const perOrg = (orgId: string) => `${BRAND_KEY}:${orgId}`;
const STYLE_ID = "brand-tokens";

export const brandQueryKey = ["branding"] as const;
export function useBranding(enabled = true) {
  return useQuery({ queryKey: brandQueryKey, enabled, staleTime: 5 * 60_000, queryFn: () => api.get<BrandingData>("/branding") });
}

function styleEl(): HTMLStyleElement {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) { el = document.createElement("style"); el.id = STYLE_ID; document.head.appendChild(el); }
  return el;
}

/** Paints a brand stylesheet now (used by the live preview too, with persist false). */
export function paintBrandCss(css: string) {
  const el = styleEl();
  if (el.textContent !== css) el.textContent = css;
}

/** The workspace default appearance applies only while the person has not picked light or dark themselves. */
function applyDefaultAppearance(a: Appearance) {
  let own: string | null = null;
  try { own = localStorage.getItem("mymail-theme"); } catch { /* storage blocked */ }
  if (own === "light" || own === "dark") return;
  const root = document.documentElement;
  if (a === "light" || a === "dark") root.dataset.theme = a; else delete root.dataset.theme;
  window.dispatchEvent(new Event("multies-appearance"));
}

export function applyBrand(d: Pick<BrandingData, "orgId" | "css" | "brand">) {
  paintBrandCss(d.css);
  applyDefaultAppearance(d.brand.appearance);
  try {
    const v = JSON.stringify({ o: d.orgId, c: d.css, a: d.brand.appearance });
    localStorage.setItem(BRAND_KEY, v);
    localStorage.setItem(perOrg(d.orgId), v);
  } catch { /* storage blocked or full: the brand still applies for this visit */ }
}

/** Takes the brand off (marketing pages, sign out). The cached copy stays for the next visit to the app. */
export function removeBrand() {
  document.getElementById(STYLE_ID)?.remove();
}

/** The cached brand for a workspace, painted at once when switching (the live one follows). */
export function paintCachedBrand(orgId: string) {
  try {
    const raw = localStorage.getItem(perOrg(orgId));
    if (raw) { const v = JSON.parse(raw) as { c?: string }; if (typeof v.c === "string") paintBrandCss(v.c); }
    else paintBrandCss("");
  } catch { /* ignore */ }
}

/** Mounted once in the app frame: keeps the live brand applied while the app is open. */
export function BrandTokens({ orgId }: { orgId: string | undefined }) {
  const q = useBranding(!!orgId);
  useEffect(() => { if (orgId && q.data && q.data.orgId !== orgId) paintCachedBrand(orgId); }, [orgId, q.data]);
  useEffect(() => { if (q.data) applyBrand(q.data); }, [q.data]);
  useEffect(() => () => removeBrand(), []);
  return null;
}

/** The workspace's square logo, or its initial on the brand colour when there is none. */
export function WorkspaceMark({ name, className, rounded = "rounded-md", onSidebar }: { name: string | undefined; className?: string; rounded?: string; onSidebar?: boolean }) {
  const q = useBranding();
  const { resolved } = useAppearance();
  const b = q.data?.brand;
  const kind = b ? pickLogo(b, "mark", logoScheme(b, resolved, onSidebar)) : null;
  if (b && kind && q.data) {
    return <img src={logoUrl(q.data.orgId, kind, b.logos[kind]!)} alt="" aria-hidden className={cn("shrink-0 object-contain", rounded, className)} />;
  }
  return <span aria-hidden data-initial={name?.[0]?.toUpperCase() ?? ""} className={cn("grid shrink-0 place-items-center bg-brand font-bold text-brand-fg before:content-[attr(data-initial)]", rounded, className)} />;
}

/**
 * The wide logo when the workspace has one (for headers that already exist, like Tools results).
 * R77B: with `markName`, a workspace that uploaded only a square logo gets that logo and its name instead of the
 * fallback, so an upload always shows at the top of the sidebar.
 */
export function WorkspaceWideLogo({ className, fallback = null, onSidebar, markName }: { className?: string; fallback?: ReactNode; onSidebar?: boolean; markName?: string }) {
  const q = useBranding();
  const { resolved } = useAppearance();
  const b = q.data?.brand;
  const scheme = b ? logoScheme(b, resolved, onSidebar) : resolved;
  const kind = b ? pickLogo(b, "wide", scheme) : null;
  if (b && !kind && markName !== undefined && q.data) {
    const mark = pickLogo(b, "mark", scheme);
    if (mark) {
      return (
        <span className="flex min-w-0 items-center gap-2" data-testid="workspace-mark-logo">
          <img src={logoUrl(q.data.orgId, mark, b.logos[mark]!)} alt="" aria-hidden className="h-7 w-7 shrink-0 rounded-md object-contain" />
          <span className="max-w-[140px] truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">{markName}</span>
        </span>
      );
    }
  }
  if (!b || !kind || !q.data) return <>{fallback}</>;
  return <img src={logoUrl(q.data.orgId, kind, b.logos[kind]!)} alt="" aria-hidden className={cn("h-6 w-auto max-w-[160px] object-contain", className)} data-testid="workspace-wide-logo" />;
}
