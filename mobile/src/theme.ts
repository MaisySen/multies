import { Appearance, Platform } from "react-native";

/**
 * Multies' design tokens, after Apple's Human Interface Guidelines: the system font, calm neutral
 * greys, one blue accent (the brand tile, #0071E3), and red, amber and green kept for status only.
 * Light and dark follow the phone's setting; the palette is chosen when the app starts.
 * Values mirror the shared brand tokens (brand/tokens.json in the web app repo).
 */
const light = {
  bg: "#F2F2F7",
  surface: "#FFFFFF",
  elevated: "#E8E8ED",
  hover: "#EBEBEF",
  line: "rgba(0,0,0,0.09)",
  lineStrong: "rgba(0,0,0,0.16)",
  fg: "#1D1D1F",
  muted: "#5F5F64",
  subtle: "#6A6A6F",
  brand: "#0066CC",
  brandFill: "#0066CC",
  brandHover: "#0058B0",
  brandSoft: "rgba(0,102,204,0.10)",
  brandLine: "rgba(0,102,204,0.35)",
  brandFg: "#FFFFFF",
  neutralSoft: "rgba(0,0,0,0.05)",
  ok: "#1B7A33",
  okSoft: "rgba(36,138,61,0.12)",
  warn: "#995400",
  warnSoft: "rgba(255,159,10,0.16)",
  bad: "#C4001A",
  badSoft: "rgba(215,0,21,0.10)",
  /** M5: count badges (white text, 4.5:1 or better in both modes). */
  badge: "#C4001A",
  shadow: "rgba(0,0,0,0.04)",
};

const dark: typeof light = {
  bg: "#000000",
  surface: "#1C1C1E",
  elevated: "#2C2C2E",
  hover: "#2A2A2D",
  line: "rgba(255,255,255,0.09)",
  lineStrong: "rgba(255,255,255,0.16)",
  fg: "#F5F5F7",
  muted: "#AEAEB2",
  subtle: "#9A9A9F",
  brand: "#4C9AFF",
  brandFill: "#0071E3",
  brandHover: "#4C9AFF",
  brandSoft: "rgba(10,132,255,0.16)",
  brandLine: "rgba(76,154,255,0.45)",
  brandFg: "#FFFFFF",
  neutralSoft: "rgba(255,255,255,0.06)",
  ok: "#30D158",
  okSoft: "rgba(48,209,88,0.14)",
  warn: "#FFB340",
  warnSoft: "rgba(255,179,64,0.14)",
  bad: "#FF6961",
  badSoft: "rgba(255,105,97,0.14)",
  badge: "#D70015",
  shadow: "rgba(0,0,0,0.4)",
};

export const scheme: "light" | "dark" = Appearance.getColorScheme() === "light" ? "light" : "dark";
export const colors = scheme === "light" ? light : dark;
export const palettes = { light, dark };

/** An 8 point grid, with 4 for tight spots. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
/** M4: softer, rounder corners (cards 18, sheets 24). */
export const radius = { sm: 8, md: 12, lg: 18, xl: 24, pill: 999 } as const;

/** Apple's text styles, in the system font (San Francisco on iPhone, Roboto on Android). */
export const font = {
  largeTitle: { fontSize: 34, fontWeight: "700" as const, color: colors.fg, letterSpacing: 0.37 },
  title: { fontSize: 28, fontWeight: "700" as const, color: colors.fg, letterSpacing: 0.36 },
  heading: { fontSize: 20, fontWeight: "600" as const, color: colors.fg, letterSpacing: 0.38 },
  headline: { fontSize: 17, fontWeight: "600" as const, color: colors.fg, letterSpacing: -0.41 },
  body: { fontSize: 17, color: colors.fg, lineHeight: 22, letterSpacing: -0.41 },
  small: { fontSize: 15, color: colors.muted, lineHeight: 20, letterSpacing: -0.24 },
  tiny: { fontSize: 12, color: colors.subtle },
};

/** A soft card shadow. Android uses elevation. */
export const shadow = Platform.select({
  android: { elevation: scheme === "light" ? 2 : 0 },
  default: { shadowColor: "#000", shadowOpacity: scheme === "light" ? 0.06 : 0, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } },
});

/** M4: a raised shadow for heroes, sheets and the pressed state's lift. */
export const raised = Platform.select({
  android: { elevation: scheme === "light" ? 6 : 0 },
  default: { shadowColor: "#000", shadowOpacity: scheme === "light" ? 0.12 : 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 10 } },
});

/** M4: gradient stops for hero cards (brand blue to indigo), and a hairline only where depth cannot show (dark mode). */
export const gradient = { brand: scheme === "light" ? ["#0A84FF", "#5E5CE6"] : ["#0A60D0", "#4B3FC4"], warm: ["#FF9F0A", "#FF375F"] } as const;
export const hairline = scheme === "dark" ? 1 : 0;

/** Motion: short ease out, springs for sheets. Reduce Motion turns these off (lib/motion.ts). */
export const motion = { fast: 150, base: 200, slow: 250, sheet: 280, spring: { damping: 22, stiffness: 260, mass: 1 } } as const;

/** Minimum touch target from Apple's HIG and Android's accessibility guidance. */
export const TOUCH = 44;
