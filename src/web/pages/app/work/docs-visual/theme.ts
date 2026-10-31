/**
 * R89: our theme as plain colours for the drawing libraries (they cannot read CSS variables or the newer colour
 * syntax). Brand themes (Forest and the rest) repaint --color-brand, so diagrams and boards follow them.
 */
import { useEffect, useState } from "react";
import type { ThemeTokens } from "@/web/lib/diagram";

let ctx: CanvasRenderingContext2D | null = null;

/** Any CSS colour as an opaque #rrggbb, blended over `over` when it has alpha. */
export function toHex(colour: string, over = "#ffffff"): string {
  if (typeof document === "undefined") return over;
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return over;
  const parse = (c: string): [number, number, number, number] => {
    ctx!.fillStyle = "#000000";
    ctx!.fillStyle = c;
    const v = String(ctx!.fillStyle);
    if (v.startsWith("#")) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1];
    const m = /rgba?\(([^)]+)\)/.exec(v);
    if (!m) return [0, 0, 0, 1];
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  };
  const [r, g, b, a] = parse(colour.trim() || over);
  const [R, G, B] = parse(over);
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a));
  return `#${[mix(r, R), mix(g, G), mix(b, B)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export function isDark(): boolean {
  if (typeof document === "undefined") return false;
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true;
  if (t === "light") return false;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function readTokens(): ThemeTokens {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  const dark = isDark();
  const surface = toHex(v("--color-surface", dark ? "#1c1c1e" : "#ffffff"));
  return {
    dark,
    bg: toHex(v("--color-bg", dark ? "#000000" : "#f5f5f7")),
    surface,
    fg: toHex(v("--color-fg", dark ? "#f5f5f7" : "#1d1d1f")),
    muted: toHex(v("--color-muted", "#5a5a5f"), surface),
    line: toHex(v("--color-line-strong", "rgb(0 0 0 / 0.16)"), surface),
    brand: toHex(v("--color-brand", "#0066cc")),
    brandSoft: toHex(v("--color-brand-soft", "rgb(0 102 204 / 0.1)"), surface),
  };
}

/** A key that changes when the theme or the brand colours change, so drawings repaint. */
export function useThemeKey(): string {
  const [key, setKey] = useState(() => (typeof document === "undefined" ? "" : themeKey()));
  useEffect(() => {
    const update = () => setKey(themeKey());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener("change", update);
    const brand = document.getElementById("mm-brand-css");
    const mo2 = brand ? new MutationObserver(update) : null;
    if (brand) mo2!.observe(brand, { childList: true, characterData: true, subtree: true });
    return () => { mo.disconnect(); mo2?.disconnect(); mq?.removeEventListener("change", update); };
  }, []);
  return key;
}

function themeKey() {
  const s = getComputedStyle(document.documentElement);
  return `${isDark() ? "d" : "l"}|${s.getPropertyValue("--color-brand").trim()}|${s.getPropertyValue("--color-surface").trim()}`;
}
