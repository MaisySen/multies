import { Appearance, Platform } from "react-native";

/**
 * MyMail's design tokens, after Apple's Human Interface Guidelines: the system font, calm neutral
 * greys, one blue accent (the brand tile, #0071E3), and red, amber and green kept for status only.
 * Light and dark follow the phone's setting; the palette is chosen when the app starts.
 */
const light = {
  bg: "#F2F2F7",
  surface: "#FFFFFF",
  elevated: "#E9E9EE",
  hover: "#E5E5EA",
  line: "rgba(60,60,67,0.16)",
  lineStrong: "#C7C7CC",
  fg: "#1D1D1F",
  muted: "#515154",
  subtle: "#6E6E73",
  brand: "#0066CC",
  brandFill: "#0066CC",
  brandHover: "#0058B0",
  brandSoft: "rgba(0,102,204,0.10)",
  brandLine: "rgba(0,102,204,0.35)",
  brandFg: "#FFFFFF",
  neutralSoft: "rgba(60,60,67,0.08)",
  ok: "#1E7A34",
  okSoft: "rgba(36,138,61,0.12)",
  warn: "#B25000",
  warnSoft: "rgba(178,80,0,0.10)",
  bad: "#D70015",
  badSoft: "rgba(215,0,21,0.08)",
  shadow: "rgba(0,0,0,0.08)",
};

const dark: typeof light = {
  bg: "#000000",
  surface: "#1C1C1E",
  elevated: "#2C2C2E",
  hover: "#3A3A3C",
  line: "rgba(84,84,88,0.6)",
  lineStrong: "#48484A",
  fg: "#FFFFFF",
  muted: "#98989F",
  subtle: "#8E8E93",
  brand: "#0A84FF",
  brandFill: "#0071E3",
  brandHover: "#0077ED",
  brandSoft: "rgba(10,132,255,0.16)",
  brandLine: "rgba(10,132,255,0.45)",
  brandFg: "#FFFFFF",
  neutralSoft: "rgba(235,235,245,0.08)",
  ok: "#30D158",
  okSoft: "rgba(48,209,88,0.14)",
  warn: "#FFD60A",
  warnSoft: "rgba(255,214,10,0.12)",
  bad: "#FF453A",
  badSoft: "rgba(255,69,58,0.14)",
  shadow: "rgba(0,0,0,0.4)",
};

export const scheme: "light" | "dark" = Appearance.getColorScheme() === "light" ? "light" : "dark";
export const colors = scheme === "light" ? light : dark;
export const palettes = { light, dark };

/** An 8 point grid, with 4 for tight spots. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

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
  android: { elevation: 1 },
  default: { shadowColor: "#000", shadowOpacity: scheme === "light" ? 0.06 : 0, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
});

/** Motion: short ease out, springs for sheets. Reduce Motion turns these off (lib/motion.ts). */
export const motion = { fast: 150, base: 200, slow: 250, spring: { damping: 22, stiffness: 260, mass: 1 } } as const;

/** Minimum touch target from Apple's HIG and Android's accessibility guidance. */
export const TOUCH = 44;
