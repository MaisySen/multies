/**
 * The base of the one icon set (R35 Premium pass 2). Glyphs are Phosphor (MIT), the family the phone app draws on
 * iOS, kept as plain SVG markup in two weights: regular by default, fill for active nav and selected states. Size
 * tokens 16/20/24 (a Tailwind h-/w- class still wins); colour is currentColor. Decorative unless labelled.
 * The markup is generated at build time from the package (scripts/r35-gen-icons.mjs), never from user input.
 */
import { forwardRef, type ComponentType, type CSSProperties, type SVGProps } from "react";

export type IconWeight = "regular" | "fill" | "thin" | "light" | "bold" | "duotone";

/** Size tokens: 16 inline with text, 20 in rows and buttons, 24 in bars and tiles. */
export const ICON_SIZE = { sm: 16, md: 20, lg: 24 } as const;

export type IconProps = Omit<SVGProps<SVGSVGElement>, "ref" | "fill" | "stroke" | "name" | "dangerouslySetInnerHTML" | "children"> & {
  size?: number | string;
  weight?: IconWeight;
  /** The selected or active state: the fill weight. */
  filled?: boolean;
  /** Kept so older call sites type check; the glyphs draw by weight, not stroke. */
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
  /** A fill other than "none" (the old way to draw a solid star) means the fill weight. */
  fill?: string;
  stroke?: string;
  style?: CSSProperties;
  title?: string;
};

/** What a component that takes an icon expects. */
export type IconComponent = ComponentType<IconProps>;

export function iconWeight(p: { weight?: IconWeight; filled?: boolean; fill?: string }): "regular" | "fill" {
  if (p.weight) return p.weight === "fill" || p.weight === "duotone" ? "fill" : "regular";
  if (p.filled) return "fill";
  if (p.fill && p.fill !== "none" && p.fill !== "transparent") return "fill";
  return "regular";
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function makeIcon(name: string, regular: string, fill: string): IconComponent {
  const C = forwardRef<SVGSVGElement, IconProps>(function GlyphIcon(
    { size = ICON_SIZE.lg, weight, filled, fill: f, stroke: _s, strokeWidth: _w, absoluteStrokeWidth: _a, className, title, ...rest },
    ref,
  ) {
    const labelled = Boolean(rest["aria-label"] || title);
    const body = iconWeight({ weight, filled, fill: f }) === "fill" ? fill : regular;
    return (
      <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 256 256" fill="currentColor"
        className={className ? `mm-icon ${className}` : "mm-icon"} aria-hidden={labelled ? undefined : true} focusable="false"
        role={labelled ? "img" : undefined} data-icon={name} {...rest}
        dangerouslySetInnerHTML={{ __html: (title ? `<title>${esc(title)}</title>` : "") + body }} />
    );
  });
  C.displayName = `Icon(${name})`;
  return C;
}
