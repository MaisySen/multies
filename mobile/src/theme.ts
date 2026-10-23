/** MyMail's dark theme, taken from the web app (src/web/index.css). Vermilion is the brand. */
export const colors = {
  bg: "#08080a",
  surface: "#0f0f12",
  elevated: "#16161a",
  hover: "#1c1c21",
  line: "rgba(255,255,255,0.08)",
  lineStrong: "rgba(255,255,255,0.14)",
  fg: "#f4f4f5",
  muted: "#a1a1aa",
  subtle: "#86868f",
  brand: "#ff6a3d",
  brandHover: "#ff8459",
  brandSoft: "rgba(255,106,61,0.13)",
  brandFg: "#170a05",
  ok: "#34d399",
  okSoft: "rgba(52,211,153,0.12)",
  warn: "#fbbf24",
  warnSoft: "rgba(251,191,36,0.12)",
  bad: "#fb7185",
  badSoft: "rgba(251,113,133,0.12)",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;
export const font = {
  title: { fontSize: 28, fontWeight: "700" as const, color: colors.fg, letterSpacing: -0.4 },
  heading: { fontSize: 20, fontWeight: "600" as const, color: colors.fg },
  body: { fontSize: 16, color: colors.fg, lineHeight: 23 },
  small: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  tiny: { fontSize: 12, color: colors.subtle },
};
/** Minimum touch target from Apple's HIG and Android's accessibility guidance. */
export const TOUCH = 44;
